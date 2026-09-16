/**
 * App Action API：给 AI 扩展（脚本/小部件/面板/自定义卡片）的受控操作接口。
 * - 每个动作做白名单枚举校验；非法值直接报错。
 * - highPriv=false（小部件/面板/自定义卡片）只允许非破坏性动作。
 * - openPort/closePort 额外受「小部件可发送数据」权限门控。
 * - 破坏性动作（清空/删除）每次调用都会 toast 告知。
 */
import { PANEL_TITLES } from "../../panels/panels";
import type { PanelId } from "../../ipc/types";
import {
  THEME_LIST,
  patch as patchSettings,
  getSnapshot as getSettings,
  type ThemeMode,
  type WorkspacePreset,
} from "../settings/settingsStore";
import * as templateStore from "../protocol/templateStore";
import * as commandStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";
import * as ucStore from "../console/userCodecStore";
import * as plotStore from "../plot/plotStore";
import * as xferStore from "../xfer/xferStore";
import { openPort, closePort } from "../serial/serialStore";
import { requestOpenPanel, requestApplyPreset } from "./appBus";
import { toast } from "./extRuntime";
import {
  getSnapshot as getExts,
  removeExt,
  setOpen as setWidgetOpen,
  type AiExtension,
} from "./extensionStore";
import { popWidgetToDesktop } from "./widgetShell";
import * as mbSlave from "../modbus/slaveStore";
import * as mbPoll from "../modbus/pollStore";
import * as sentinelStore from "../sentinel/sentinelStore";
import * as chatStore from "./chatStore";
import { lastXray } from "../xray/xrayShared";
import { buildEvidence } from "../xray/xrayEvidence";
import { AREA_LABEL, type MbArea } from "../modbus/mb";
import {
  writeTemplateFromAiJson,
  writeCommandFromAiJson,
  writeCardFromAiJson,
  writeCodecFromAiJson,
} from "./aiActions";
import { isGroup } from "../controls/commandStore";
import { ORCH_LIMITS } from "../orchestrator/types";

export interface AppActionResult {
  ok: boolean;
  data?: unknown;
  err?: string;
}

const PRESETS: WorkspacePreset[] = ["proto", "analyze", "attitude", "console", "video", "calib", "auto", "modbus", "vdev"];

/** 需要脚本高权限的动作（MCP 桥 run_action 门控复用同一集合） */
export const HIGH_ONLY = new Set([
  "clearPage",
  "patchCard",
  "removeCard",
  "removeProtocol",
  "removeCommand",
  "removeCodec",
  "addPage",
  "openPort",
  "closePort",
  "removeWidget",
  // 从站/轮询会主动占用总线发数据，等同发送权限
  "modbus",
  // 哨兵可暂停监测/清报警，属全局控制
  "sentinel",
  // 考古报告会驱动模型长输出并代表「分析结论」，限脚本高权限
  "xrayReport",
  // P74c C2：编排器可向设备发数据（等同 send），且写入口会改自动化逻辑
  "orchestrator",
  // P74c C2：3D 轴绑定/显示设置决定「数据口径」（看哪三个通道），属配置写入
  "plot3d",
  // P78c：虚拟设备占据数据管线（与真实接口互斥、接管发送路由），等同发送权限
  "vdev",
]);

export const APP_ACTION_KINDS = [
  "openPanel",
  "applyPreset",
  "setTheme",
  "listProtocols",
  "listCommands",
  "listCards",
  "addChannel",
  "clearChannels",
  "writeCard",
  "writeCommand",
  "writeTemplate",
  "writeCodec",
  "clearPage",
  "patchCard",
  "addPage",
  "removeCard",
  "removeProtocol",
  "removeCommand",
  "removeCodec",
  "openPort",
  "closePort",
  "modbus",
  "xferStart",
  "readPlot",
  "sentinel",
  "xrayEvidence",
  "xrayCrack",
  "xrayReport",
  "orchestratorRead",
  "orchestrator",
  "plot3dRead",
  "plot3d",
  "vdev",
  "toast",
  "listWidgets",
  "openWidget",
  "closeWidget",
  "popWidget",
  "removeWidget",
] as const;

export type AppActionKind = (typeof APP_ACTION_KINDS)[number];

export async function runAppAction(
  kind: string,
  args: Record<string, unknown>,
  opts: { highPriv: boolean },
): Promise<AppActionResult> {
  if (!(APP_ACTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, err: `未知动作：${kind}` };
  }
  if (HIGH_ONLY.has(kind) && !opts.highPriv) {
    return { ok: false, err: `动作「${kind}」需要脚本高权限（小部件/卡片不可调用）` };
  }
  try {
    const data = await exec(kind, args);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, err: String(e).replace(/^Error:\s*/, "").slice(0, 160) };
  }
}

/** 截取 2D 曲线面板：合成 .plot-chart 内全部 canvas（含坐标轴/覆盖层）。
 *  坐标换算兼容 DPR 与全局 CSS zoom（以「设备像素/屏幕像素」比统一缩放），
 *  背景取面板 CSS 背景色（透明则白）。返回 JPEG data URL（0.85，控制请求体积）。 */
function capturePlotCanvas(): string {
  const chart = document.querySelector<HTMLElement>(".plot-chart");
  if (!chart) throw new Error("未找到 2D 曲线面板（可先执行 openPanel plot2d）");
  const canvases = Array.from(chart.querySelectorAll("canvas"));
  const visible = canvases.filter((c) => c.width > 0 && c.height > 0);
  if (!visible.length) throw new Error("2D 曲线面板暂无渲染内容（等收到数据后再试）");
  const base = chart.getBoundingClientRect();
  if (base.width < 8 || base.height < 8) throw new Error("2D 曲线面板不可见或尺寸过小");
  const r0 = visible[0].getBoundingClientRect();
  const sx = visible[0].width / Math.max(r0.width, 1);
  const sy = visible[0].height / Math.max(r0.height, 1);
  const fullW = Math.round(base.width * sx);
  const fullH = Math.round(base.height * sy);
  const out = document.createElement("canvas");
  out.width = Math.min(fullW, 2400);
  out.height = Math.min(fullH, 1600);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("无法创建截图画布");
  const bg = getComputedStyle(chart).backgroundColor;
  ctx.fillStyle = bg && bg !== "transparent" ? bg : "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  const kx = out.width / fullW;
  const ky = out.height / fullH;
  for (const c of visible) {
    const r = c.getBoundingClientRect();
    ctx.drawImage(
      c,
      (r.left - base.left) * sx * kx,
      (r.top - base.top) * sy * ky,
      c.width * kx,
      c.height * ky,
    );
  }
  return out.toDataURL("image/jpeg", 0.85);
}

async function exec(kind: string, a: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
    case "readPlot": {
      // AI 主动读图（P51）：截 2D 曲线面板给模型。面板未开时自动打开并等待渲染。
      let chart = document.querySelector<HTMLElement>(".plot-chart");
      if (!chart || chart.querySelectorAll("canvas").length === 0) {
        requestOpenPanel("plot2d");
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 200));
          chart = document.querySelector<HTMLElement>(".plot-chart");
          if (chart && chart.querySelectorAll("canvas").length > 0) break;
        }
      }
      if (chatStore.getSnapshot().streaming) {
        throw new Error("AI 正在回复中，读图需等本轮结束后再试");
      }
      const dataUrl = capturePlotCanvas();
      const ask = String(a.ask ?? "").trim() || "请分析这张 2D 曲线面板截图：描述趋势、异常点与需要关注的特征。";
      await chatStore.sendText(`（AI 读图）${ask}`, "qa", undefined, [dataUrl]);
      return "已截取 2D 曲线面板并发送给模型分析，分析结果在聊天区";
    }
    case "xrayEvidence":
    case "xrayCrack": {
      // 协议考古（P63d）：结构发现冻结快照 → 确定性证据链（含校验爆破/序列分析）。
      // evidence 全量（含爆破+序列）；crack 只回爆破部分（更小载荷）。
      const pub = lastXray();
      if (!pub) {
        throw new Error("结构发现面板尚无分析结果：请先 openPanel xray，等面板累积样本后点「采样分析」");
      }
      const ev = buildEvidence(pub.analysis, pub.cluster);
      if (kind === "xrayCrack") {
        return {
          meta: ev.meta,
          crack: ev.evidence.filter((e) => e.text.startsWith("校验爆破") || e.text.startsWith("轮询循环")),
        };
      }
      return ev;
    }
    case "xrayReport": {
      // 协议考古报告：证据链 → 聊天区让模型写 Markdown 报告（引用证据编号，禁无证据断言）
      const pub = lastXray();
      if (!pub) {
        throw new Error("结构发现面板尚无分析结果：请先 openPanel xray，等面板累积样本后点「采样分析」");
      }
      if (chatStore.getSnapshot().streaming) {
        throw new Error("AI 正在回复中，报告生成需等本轮结束");
      }
      const ev = buildEvidence(pub.analysis, pub.cluster);
      const ask = [
        "请基于以下「协议考古学家」证据链 JSON 生成一份 Markdown 推理报告，结构固定为：",
        "## 结论（当前协议最可能的结构）",
        "## 证据（逐条引用证据编号 E1、E2…，说明每条证据支持什么结论）",
        "## 置信度（每个结论标注高/中/低及理由）",
        "## 建议模板结构（帧头/长度域/字段排布/校验算法，可直接照此在帧画布定义）",
        "## 下一步（还需要什么样本或操作来提高置信度）",
        "铁律：每个结论必须引用证据编号；禁止编造证据里不存在的数值；证据不足就明说。",
        "证据链：",
        JSON.stringify(ev),
      ].join("\n");
      await chatStore.sendText(`（AI 协议考古）${ask}`, "qa");
      return "协议考古报告已生成在聊天区；可直接按「建议模板结构」让 AI 写模板或手动在帧画布定义";
    }
    case "openPanel": {
      const panel = String(a.panel ?? "");
      const titles = PANEL_TITLES();
      if (!Object.keys(titles).includes(panel)) {
        throw new Error(`未知面板：${panel}（可选：${Object.keys(titles).join("/")}）`);
      }
      requestOpenPanel(panel);
      return `已打开面板「${titles[panel as PanelId]}」`;
    }
    case "applyPreset": {
      const preset = String(a.preset ?? "");
      if (!PRESETS.includes(preset as WorkspacePreset)) {
        throw new Error(`未知预设：${preset}（可选：${PRESETS.join("/")}）`);
      }
      requestApplyPreset(preset);
      return `已切换工作区预设「${preset}」`;
    }
    case "setTheme": {
      const theme = String(a.theme ?? "");
      if (!THEME_LIST.includes(theme as ThemeMode)) {
        throw new Error(`未知主题：${theme}（可选：${THEME_LIST.join("/")}）`);
      }
      patchSettings({ theme: theme as ThemeMode });
      document.documentElement.dataset.theme =
        theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : theme;
      return `主题已切换为「${theme}」`;
    }
    case "listProtocols": {
      const proto = templateStore.getSnapshot();
      return proto.rules.templates.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        fields: t.fields.map((f) => f.name),
      }));
    }
    case "listCommands": {
      const out: { name: string; template?: string; group: string }[] = [];
      const walk = (nodes: commandStore.CommandNode[], group: string) => {
        for (const n of nodes) {
          if (isGroup(n)) walk(n.items, n.name);
          else out.push({ name: n.name, template: n.template, group });
        }
      };
      walk(commandStore.getSnapshot().groups, "");
      return out;
    }
    case "listCards": {
      return controlsStore.getSnapshot().pages.map((p) => ({
        page: p.name,
        active: p.id === controlsStore.getSnapshot().activePageId,
        cards: p.cards.map((c) => ({ name: c.name, type: c.type })),
      }));
    }
    case "addChannel": {
      const tplName = String(a.tpl ?? "");
      const fieldName = String(a.field ?? "");
      const tpl = templateStore
        .getSnapshot()
        .rules.templates.find(
          (t) => t.name === tplName || t.id === tplName,
        );
      if (!tpl) throw new Error(`协议模板「${tplName}」不存在`);
      const field = tpl.fields.find((f) => f.name === fieldName);
      if (!field) {
        throw new Error(
          `字段「${fieldName}」不存在（可用：${tpl.fields.map((f) => f.name).join("、") || "无"}）`,
        );
      }
      const ok = plotStore.addChannel({
        tplId: tpl.id,
        fieldId: field.id,
        name: field.name,
        color: plotStore.nextColor(),
      });
      if (!ok) return "该通道已存在";
      requestOpenPanel("plot2d");
      return `通道「${field.name}」已加入 2D 曲线（面板已打开）`;
    }
    case "clearChannels": {
      plotStore.clearChannels();
      return "2D 曲线通道已清空";
    }
    case "writeCard": {
      return writeCardFromAiJson(String(a.json ?? "{}")).msg;
    }
    case "writeCommand": {
      return writeCommandFromAiJson(String(a.json ?? "{}")).msg;
    }
    case "writeTemplate": {
      return writeTemplateFromAiJson(String(a.json ?? "{}")).msg;
    }
    case "writeCodec": {
      return writeCodecFromAiJson(String(a.json ?? "{}")).msg;
    }
    case "clearPage": {
      const page = controlsStore.activePage();
      if (!page) throw new Error("无活动控制页");
      const n = page.cards.length;
      for (const c of [...page.cards]) controlsStore.removeCard(page.id, c.id);
      toast(`控制页「${page.name}」已清空（${n} 张卡片）`);
      return `控制页「${page.name}」已清空（${n} 张卡片）`;
    }
    case "patchCard": {
      const name = String(a.name ?? "");
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      const hit = controlsStore.findCardByName(name);
      if (!hit) throw new Error(`卡片「${name}」不存在`);
      controlsStore.patchCard(hit.pageId, hit.card.id, patch);
      return `卡片「${name}」已更新`;
    }
    case "addPage": {
      controlsStore.addPage();
      const page = controlsStore.activePage();
      const name = String(a.name ?? "").trim();
      if (page && name) controlsStore.renamePage(page.id, name.slice(0, 24));
      return `已新建控制页「${page?.name ?? name}」`;
    }
    case "removeCard": {
      const name = String(a.name ?? "");
      const hit = controlsStore.findCardByName(name);
      if (!hit) throw new Error(`卡片「${name}」不存在`);
      controlsStore.removeCard(hit.pageId, hit.card.id);
      toast(`卡片「${name}」已删除`);
      return `卡片「${name}」已删除`;
    }
    case "removeProtocol": {
      const name = String(a.name ?? "");
      const tpl = templateStore
        .getSnapshot()
        .rules.templates.find((t) => t.name === name || t.id === name);
      if (!tpl) throw new Error(`协议模板「${name}」不存在`);
      templateStore.removeTemplate(tpl.id);
      toast(`协议模板「${tpl.name}」已删除`);
      return `协议模板「${tpl.name}」已删除`;
    }
    case "removeCommand": {
      const name = String(a.name ?? "");
      let hit: string | null = null;
      let hitGroup = "";
      const walk = (nodes: commandStore.CommandNode[], group: string) => {
        for (const n of nodes) {
          if (hit) return;
          if (isGroup(n)) walk(n.items, n.name);
          else if (n.name === name) {
            hit = n.id;
            hitGroup = group;
            return;
          }
        }
      };
      walk(commandStore.getSnapshot().groups, "");
      if (!hit) throw new Error(`命令「${name}」不存在`);
      commandStore.removeNode(hit);
      toast(`命令「${name}」已删除`);
      return `命令「${name}」已删除${hitGroup ? `（原属分组：${hitGroup}）` : ""}`;
    }
    case "removeCodec": {
      const name = String(a.name ?? "");
      const def = ucStore
        .getSnapshot()
        .codecs.find((c) => c.name === name || c.id === name);
      if (!def) throw new Error(`自定义协议「${name}」不存在`);
      ucStore.remove(def.id);
      toast(`指令工厂协议「${def.name}」已删除`);
      return `指令工厂协议「${def.name}」已删除`;
    }
    case "openPort": {
      if (!getSettings().aiWidgetSend) {
        throw new Error("连接操作需要「小部件可发送数据」权限");
      }
      await openPort();
      return "连接已建立";
    }
    case "closePort": {
      if (!getSettings().aiWidgetSend) {
        throw new Error("连接操作需要「小部件可发送数据」权限");
      }
      await closePort();
      return "连接已断开";
    }
    case "modbus": {
      return runModbusAction(a);
    }
    case "orchestratorRead": {
      return orchestratorStatus();
    }
    case "orchestrator": {
      return runOrchestratorAction(a);
    }
    case "plot3dRead": {
      return plot3dStatus();
    }
    case "plot3d": {
      return runPlot3dAction(a);
    }
    case "xferStart": {
      // path 支持字符串或字符串数组（多文件按队列顺序传输）
      const raw = a.paths ?? a.path;
      const paths = (Array.isArray(raw) ? raw : [raw])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean);
      if (!paths.length) throw new Error("缺少文件路径 path（可传字符串数组实现多文件顺序传输）");
      const proto = String(a.proto ?? "ymodem").trim();
      if (!["ymodem", "ymodemg", "xmodem1k", "xmodem"].includes(proto)) {
        throw new Error(`未知传输协议：${proto}（可选：ymodem/ymodemg/xmodem1k/xmodem）`);
      }
      requestOpenPanel("console");
      xferStore.requestAiPrefill(paths, proto);
      const names = paths.map((x) => x.split(/[\\/]/).pop() ?? x);
      const list = names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 个` : names.join("、");
      return `已打开文件传输对话框并预填「${list}」（${proto.toUpperCase()}），请在对话框中确认开始发送`;
    }
    case "vdev": {
      const op = String(a.op ?? "status").trim();
      const vs = await import("../vdev/vdevStore");
      switch (op) {
        case "status": {
          const snap = vs.getSnapshot();
          return {
            running: snap.running,
            device: snap.device,
            library: snap.specs.map((x) => ({ name: x.spec.name, desc: x.spec.desc, periodMs: x.spec.periodMs })),
          };
        }
        case "list":
          return { devices: vs.getSnapshot().specs.map((x) => x.spec.name) };
        case "create": {
          // normalizeSpec 抛错由上层执行器统一捕获展示（错误已用户可读中文）
          const spec = vs.normalizeSpec(a.spec);
          vs.saveToLibrary(spec);
          vs.setEditing(spec);
          void import("../ai/extRuntime").then(({ toast }) => toast(`虚拟设备「${spec.name}」已入库（未运行）`));
          return { ok: true, name: spec.name, saved: true, hint: "对 AI 说「启动设备」或到虚拟设备工坊点启动" };
        }
        case "start": {
          let spec = a.spec as Record<string, unknown> | undefined;
          if (!spec && typeof a.name === "string") {
            const found = vs.getSnapshot().specs.find((x) => x.spec.name === a.name);
            if (!found) throw new Error(`设备库里没有名为「${a.name}」的设备`);
            spec = found.spec as unknown as Record<string, unknown>;
          }
          if (!spec) throw new Error("start 需要 spec 或 name 参数");
          const name = await vs.startDevice(spec as never);
          return name ? { ok: true, running: name } : { ok: false };
        }
        case "stop":
          await vs.stopDevice();
          return { ok: true };
        default:
          throw new Error(`未知 vdev op：${op}（可用 status/list/create/start/stop）`);
      }
    }
    case "sentinel": {
      const op = String(a.op ?? "status").trim();
      const s = sentinelStore.getSnapshot();
      switch (op) {
        case "status": {
          return {
            enabled: s.cfg.enabled,
            running: s.running,
            health: s.health,
            activeCrit: s.activeCrit,
            activeWarn: s.activeWarn,
            unack: s.unack,
            conn: s.conn,
            silenceMs: s.silenceMs,
            sensitivity: s.cfg.sensitivity,
            mutedKeys: s.cfg.mutedKeys,
            recent: s.alerts.slice(0, 10).map((x) => ({ ts: x.ts, kind: x.kind, level: x.level, msg: x.msg, count: x.count })),
          };
        }
        case "enable": {
          const on = a.on !== false;
          if (s.cfg.enabled === on) return `哨兵已是${on ? "启用" : "停用"}状态`;
          sentinelStore.setEnabled(on);
          return on ? "已启用哨兵监测（面板或浮球需在打开状态才会运行，可提示用户打开）" : "已停用哨兵监测";
        }
        case "ackAll": {
          sentinelStore.ackAll();
          return "已确认全部未读报警";
        }
        case "mute": {
          const key = String(a.key ?? "").trim();
          if (!key) throw new Error("mute 需要 key（如 spike:<通道名> / silence / errrate / newframe:<帧型>）");
          sentinelStore.mute(key);
          return `已静音报警类型「${key}」（可在哨兵面板底栏解除）`;
        }
        case "clear": {
          sentinelStore.clearAlerts();
          return "已清空报警历史";
        }
        default:
          throw new Error(`未知 op：${op}（可用：status/enable/ackAll/mute/clear）`);
      }
    }
    case "toast": {
      const msg = String(a.msg ?? "（空通知）");
      toast(msg.slice(0, 200));
      return msg;
    }
    case "listWidgets": {
      const snap = getExts();
      return snap.exts
        .filter((e) => e.type === "widget")
        .map((e) => ({
          name: e.name,
          enabled: e.enabled,
          open: snap.openIds.includes(e.id),
          chrome: e.chrome ?? "default",
        }));
    }
    case "openWidget": {
      const w = findWidget(a);
      if (!w.enabled) throw new Error(`挂件「${w.name}」未启用（请在设置→扩展管理启用）`);
      setWidgetOpen(w.id, true);
      return `挂件「${w.name}」浮窗已打开`;
    }
    case "closeWidget": {
      const w = findWidget(a);
      setWidgetOpen(w.id, false);
      return `挂件「${w.name}」浮窗已关闭`;
    }
    case "popWidget": {
      const w = findWidget(a);
      popWidgetToDesktop({ id: w.id, name: w.name, chrome: w.chrome });
      return `挂件「${w.name}」已弹出为桌面小窗`;
    }
    case "removeWidget": {
      const w = findWidget(a);
      removeExt(w.id);
      toast(`AI 挂件「${w.name}」已删除`);
      return `挂件「${w.name}」已删除`;
    }
    default:
      throw new Error(`未知动作：${kind}`);
  }
}

/** 按名称/id 查找 widget 扩展 */
function findWidget(a: Record<string, unknown>): AiExtension {
  const name = String(a.name ?? "");
  const w = getExts().exts.find(
    (e) => e.type === "widget" && (e.name === name || e.id === name),
  );
  if (!w) throw new Error(`挂件「${name}」不存在（可先 listWidgets 查询）`);
  return w;
}

/* ================= Modbus 工作台动作（M2-e） ================= */

const MB_AREAS = ["coil", "disc", "holding", "input"] as const;
const MB_FAULTS = ["none", "noReply", "exception", "everyOther"] as const;

const mbNum = (v: unknown, label: string): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数「${label}」需为数字`);
  return n;
};

const mbArea = (v: unknown): MbArea => {
  const s = String(v ?? "") as MbArea;
  if (!MB_AREAS.includes(s)) {
    throw new Error(`数据区「${String(v)}」不存在（可选：${MB_AREAS.join("/")}）`);
  }
  return s;
};

/** Modbus 从站 / 主站轮询的受控操作（脚本高权限：会主动占用总线发数据） */
function runModbusAction(a: Record<string, unknown>): unknown {
  const op = String(a.op ?? "").trim();
  const sl = mbSlave.getSnapshot();
  const pl = mbPoll.getSnapshot();
  switch (op) {
    case "status":
      return {
        slave: {
          running: sl.running,
          address: sl.address,
          anyAddress: sl.anyAddress,
          delayMs: sl.delayMs,
          fault: sl.fault,
          counters: sl.counters,
        },
        poll: {
          running: pl.running,
          transport: pl.transport,
          timeouts: pl.timeouts,
          errs: pl.errs,
          lastError: pl.lastError,
          rows: pl.rows.map((r) => ({
            slave: r.slave,
            fn: r.fn,
            addr: r.addr,
            qty: r.qty,
            periodMs: r.periodMs,
            varName: r.varName,
            last: r.last,
            ok: r.ok,
            timeout: r.timeout,
          })),
        },
      };

    case "slave.start": {
      const err = mbSlave.start();
      if (err) throw new Error(err);
      requestOpenPanel("modbus");
      return `模拟从站已启动（地址 ${mbSlave.getSnapshot().address}），开始应答总线请求`;
    }
    case "slave.stop":
      mbSlave.stop();
      return "模拟从站已停止";
    case "slave.configure": {
      const p: Parameters<typeof mbSlave.patch>[0] = {};
      if (a.address !== undefined) p.address = mbNum(a.address, "address");
      if (a.anyAddress !== undefined) p.anyAddress = !!a.anyAddress;
      if (a.delayMs !== undefined) p.delayMs = mbNum(a.delayMs, "delayMs");
      if (a.fault !== undefined) {
        const f = String(a.fault);
        if (!(MB_FAULTS as readonly string[]).includes(f)) {
          throw new Error(`故障注入「${f}」无效（可选：${MB_FAULTS.join("/")}）`);
        }
        p.fault = f as mbSlave.FaultMode;
      }
      if (a.faultCode !== undefined) p.faultCode = mbNum(a.faultCode, "faultCode");
      mbSlave.patch(p);
      const s2 = mbSlave.getSnapshot();
      return `从站已设置：地址 ${s2.address}，延时 ${s2.delayMs}ms，故障 ${s2.fault}${s2.fault === "none" ? "" : ` 码 ${s2.faultCode}`}`;
    }
    case "slave.write": {
      const area = mbArea(a.area);
      const index = mbNum(a.index, "index");
      const value = mbNum(a.value, "value");
      const ok =
        area === "coil" || area === "disc"
          ? mbSlave.setBit(area, index, !!value)
          : mbSlave.setWord(area, index, value);
      if (!ok) throw new Error(`${AREA_LABEL[area]} 地址 ${index} 超出数据区范围`);
      return `${AREA_LABEL[area]}[${index}] = ${value}`;
    }
    case "slave.writeMany": {
      const area = mbArea(a.area);
      const from = mbNum(a.from, "from");
      const to = mbNum(a.to, "to");
      const start = mbNum(a.value ?? a.start ?? 0, "value");
      const step = a.step === undefined ? 0 : mbNum(a.step, "step");
      const n = mbSlave.fill(area, from, to, step === 0 ? "same" : "ramp", start, step);
      return `${AREA_LABEL[area]} ${from}~${to} 共 ${n} 点已填充`;
    }
    case "slave.resize": {
      const bits = a.bits === undefined ? sl.bitSize : mbNum(a.bits, "bits");
      const words = a.words === undefined ? sl.wordSize : mbNum(a.words, "words");
      mbSlave.resize(bits / 8, words);
      const s2 = mbSlave.getSnapshot();
      return `数据区容量：位区 ${s2.bitSize * 8} 点、字区 ${s2.wordSize} 寄存器`;
    }

    case "poll.add": {
      const varName =
        a.varName === undefined ? "" : String(a.varName).trim().slice(0, 32);
      mbPoll.addRow({
        slave: a.slave === undefined ? 1 : mbNum(a.slave, "slave"),
        fn: a.fn === undefined ? 3 : mbNum(a.fn, "fn"),
        addr: a.addr === undefined ? 0 : mbNum(a.addr, "addr"),
        qty: a.qty === undefined ? 1 : mbNum(a.qty, "qty"),
        periodMs: a.periodMs === undefined ? 500 : mbNum(a.periodMs, "periodMs"),
        elem: a.elem === undefined ? 0 : mbNum(a.elem, "elem"),
        scale: a.scale === undefined ? 1 : Number(a.scale) || 1,
        varName,
      });
      const rows = mbPoll.getSnapshot().rows;
      const row = rows[rows.length - 1];
      if (!row) throw new Error("轮询项添加失败");
      return `已加轮询项：从站 ${row.slave} 功能码 ${row.fn} 起始 ${row.addr} 数量 ${row.qty} 周期 ${row.periodMs}ms → 变量「${row.varName}」`;
    }
    case "poll.remove": {
      const name = String(a.varName ?? "").trim();
      const row = mbPoll.getSnapshot().rows.find((r) => r.varName === name);
      if (!row) throw new Error(`变量「${name}」不在轮询表里（可先 status 查询）`);
      mbPoll.removeRow(row.id);
      return `已删除轮询项「${name}」`;
    }
    case "poll.clear":
      mbPoll.clearRows();
      return "轮询表已清空";
    case "poll.configure": {
      if (a.transport !== undefined) {
        const tp = String(a.transport);
        if (tp !== "rtu" && tp !== "tcp") throw new Error('transport 只能是 "rtu" 或 "tcp"');
        mbPoll.setTransport(tp);
      }
      return `轮询帧格式：${mbPoll.transport()}`;
    }
    case "poll.start": {
      const err = mbPoll.start();
      if (err) throw new Error(err);
      requestOpenPanel("modbus");
      const n = mbPoll.getSnapshot().rows.filter((r) => r.enabled).length;
      return `主站轮询已启动（${n} 项）`;
    }
    case "poll.stop":
      mbPoll.stop();
      return "主站轮询已停止";
    case "poll.reset":
      mbPoll.resetStats();
      return "轮询统计已清零";

    default:
      throw new Error(
        `未知 modbus 动作 op：${op || "（空）"}（可选：status / slave.start / slave.stop / slave.configure / slave.write / slave.writeMany / slave.resize / poll.add / poll.remove / poll.clear / poll.configure / poll.start / poll.stop / poll.reset）`,
      );
  }
}

/* ================= P74c C2：编排器 / 3D 轨迹接入 AI 与 MCP ================= */

/**
 * 编排器与 3D 的模块延迟加载。
 * 为什么不静态 import：orchestratorBind 在**模块求值期**就订阅事件源并同步一次 store
 * （P74 TDZ 白屏的现场）；把它塞进 appActions 的静态图会在既有的
 * `extRuntime ↔ appActions` 循环上再叠一层求值顺序依赖。动作真被调用时再加载，
 * 代价只有一次 await，且启动路径零增重（与 mcpServer 延迟加载 appActions 同一策略）。
 */
async function orchMods() {
  const [bind, store, build] = await Promise.all([
    import("../orchestrator/orchestratorBind"),
    import("../orchestrator/orchestratorStore"),
    import("../orchestrator/orchAiBuild"),
  ]);
  return { bind, store, build };
}

/** 块树规模统计（AI 读摘要用；不递归进容器内部细节，只报数量与类型直方图） */
function orchBlockBrief(nodes: unknown[]): { blocks: number; kinds: Record<string, number> } {
  let blocks = 0;
  const kinds: Record<string, number> = {};
  const walk = (list: unknown[]) => {
    for (const raw of list) {
      const n = raw as { kind?: string; then?: unknown[]; els?: unknown[]; body?: unknown[]; children?: unknown[] };
      if (!n || typeof n.kind !== "string") continue;
      blocks++;
      kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      if (Array.isArray(n.then)) walk(n.then);
      if (Array.isArray(n.els)) walk(n.els);
      if (Array.isArray(n.body)) walk(n.body);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
  return { blocks, kinds };
}

/** 编排器只读快照：总开关 / 组（含事件与运行统计）/ 变量现值 / 最近日志 */
async function orchestratorStatus(): Promise<unknown> {
  const { bind, store } = await orchMods();
  const doc = store.getSnapshot().doc;
  const eng = bind.orchEngine;
  const events = (g: { events: { kind: string }[] }) => g.events.map((e) => e.kind);
  return {
    masterOn: doc.settings.masterOn,
    runningInstances: eng.runningCount(),
    groupCount: doc.groups.length,
    groupCap: ORCH_LIMITS.groupCap,
    queueCap: ORCH_LIMITS.queueCap,
    groups: doc.groups.map((g) => {
      const st = eng.statsOf(g.id);
      return {
        id: g.id,
        name: g.name,
        enabled: g.enabled,
        events: events(g),
        autoTriggers: g.events.length > 0,
        cooldownMs: g.cooldownMs ?? 0,
        queuePolicy: g.queuePolicy ?? "dropNew",
        note: g.note,
        ...orchBlockBrief(g.children),
        runs: st.total,
        fails: st.fail,
        lastAt: st.lastTs ? new Date(st.lastTs).toISOString() : null,
        lastDetail: st.lastDetail,
      };
    }),
    vars: eng.listVars().map((v) => ({ name: v.name, type: v.type, value: v.value, default: v.def, persist: v.persist })),
    recentLogs: eng
      .getLogs()
      .slice(-10)
      .map((l) => ({ at: new Date(l.ts).toISOString(), groupId: l.groupId, phase: l.phase, detail: l.detail })),
  };
}

/** 编排器写操作（高权限）：总开关 / 手动跑组 / 组增删改 / 事件与块增删 / 写变量现值 */
async function runOrchestratorAction(a: Record<string, unknown>): Promise<unknown> {
  const { bind, store, build } = await orchMods();
  const eng = bind.orchEngine;
  const op = String(a.op ?? "").trim();
  const needLocked = "Operator 只读模式下不能改编排结构（可运行、可查看）";
  /** groupId 或组名定位（多处复用；找不到就抛，避免静默失败） */
  const findGroup = () => {
    const gid = String(a.groupId ?? a.name ?? "").trim();
    if (!gid) throw new Error("需要 groupId（或组名 name，可用 orchestratorRead 取）");
    const doc = store.getSnapshot().doc;
    const g = doc.groups.find((x) => x.id === gid) ?? doc.groups.find((x) => x.name === gid);
    if (!g) throw new Error(`找不到编排组：${gid}`);
    return g;
  };
  switch (op) {
    case "enable": {
      const on = a.on !== false;
      store.setMasterOn(on);
      return on
        ? "编排总开关已打开（组满足事件条件即自动执行）"
        : "编排总开关已关闭（自动事件与手动运行都停止）";
    }
    case "stopAll": {
      eng.stopAll();
      return "已停止全部在跑与排队的组实例";
    }
    case "run": {
      const gid = String(a.groupId ?? a.name ?? "").trim();
      if (!gid) throw new Error("run 需要 groupId（或组名 name）");
      const doc = store.getSnapshot().doc;
      const g = doc.groups.find((x) => x.id === gid) ?? doc.groups.find((x) => x.name === gid);
      if (!g) throw new Error(`找不到编排组：${gid}`);
      const ok = eng.runManual(g.id);
      return ok
        ? `已手动触发「${g.name}」（豁免熔断与静默期；实际执行结果见 recentLogs）`
        : `触发未生效：组被禁用、不允许手动触发（事件槽非空但未挂「手动」事件块）或队列已满（上限 ${ORCH_LIMITS.queueCap}）`;
    }
    case "groupAdd": {
      const id = store.addGroup(typeof a.name === "string" ? a.name : undefined);
      if (!id) {
        throw new Error(
          store.atGroupCap() ? `编排组已达上限 ${ORCH_LIMITS.groupCap}` : needLocked,
        );
      }
      return { id, msg: "已新建空组（未挂事件 → 只能手动运行或被其他组调用）" };
    }
    case "groupUpdate": {
      const doc = store.getSnapshot().doc;
      const g = doc.groups.find((x) => x.id === String(a.groupId ?? "")) ?? doc.groups.find((x) => x.name === String(a.name ?? ""));
      if (!g) throw new Error("groupUpdate 需要 groupId（可用 orchestratorRead 取）");
      const patch: Record<string, unknown> = {};
      if (typeof a.groupName === "string") patch.name = a.groupName;
      if (typeof a.enabled === "boolean") patch.enabled = a.enabled;
      if (typeof a.cooldownMs === "number") patch.cooldownMs = a.cooldownMs;
      if (typeof a.note === "string") patch.note = a.note;
      if (a.queuePolicy === "dropNew" || a.queuePolicy === "dropOld" || a.queuePolicy === "stopOld") {
        patch.queuePolicy = a.queuePolicy;
      }
      if (!Object.keys(patch).length) throw new Error("没有可更新的字段（groupName/enabled/cooldownMs/note/queuePolicy）");
      store.updateGroup(g.id, patch as Parameters<typeof store.updateGroup>[1]);
      return `已更新组「${g.name}」：${Object.keys(patch).join(" / ")}`;
    }
    case "groupRemove": {
      const doc = store.getSnapshot().doc;
      const g = doc.groups.find((x) => x.id === String(a.groupId ?? ""));
      if (!g) throw new Error("groupRemove 需要 groupId");
      store.removeGroup(g.id);
      toast(`AI 删除编排组「${g.name}」`);
      return `已删除组「${g.name}」`;
    }
    case "eventAdd": {
      const g = findGroup();
      if (g.events.length >= 8) throw new Error(`组「${g.name}」事件槽已满（每组事件上限 8 个）`);
      const { node: ev, applied } = build.buildAiEvent(a.eventKind ?? a.evKind, a);
      store.addEvent(g.id, ev);
      const after = store.getSnapshot().doc.groups.find((x) => x.id === g.id);
      if (!after || after.events.length <= g.events.length) throw new Error(needLocked);
      const hints = build.pendingHints(ev);
      return {
        eventId: ev.id,
        kind: ev.kind,
        applied,
        hints,
        msg: `已给组「${g.name}」挂上「${ev.kind}」事件${hints.length ? `；注意：${hints.join("、")}` : ""}`,
      };
    }
    case "eventRemove": {
      const g = findGroup();
      const evId = String(a.eventId ?? "").trim();
      if (!evId) throw new Error("eventRemove 需要 eventId（可用 orchestratorRead 取）");
      const before = g.events.length;
      store.removeEvent(g.id, evId);
      const after = store.getSnapshot().doc.groups.find((x) => x.id === g.id);
      if (!after || after.events.length === before) throw new Error(`未找到事件 ${evId}（或${needLocked}）`);
      toast(`AI 移除编排事件（组「${g.name}」）`);
      return `已从组「${g.name}」移除该事件`;
    }
    case "blockAdd": {
      const g = findGroup();
      const parentId = typeof a.parentId === "string" && a.parentId ? a.parentId : null;
      const which = a.which === "then" || a.which === "els" ? a.which : undefined;
      const index = typeof a.index === "number" && Number.isFinite(a.index) ? a.index : null;
      const { node, applied } = build.buildAiBlock(a.blockKind ?? a.block, a);
      const id = store.addBlock(g.id, parentId, index, node, which);
      if (!id) throw new Error(`${needLocked}；或父块不存在/该层已达 200 块上限`);
      const hints = build.pendingHints(node);
      return {
        blockId: id,
        kind: node.kind,
        applied,
        hints,
        msg: `已在组「${g.name}」${parentId ? "的容器内" : "顶层"}插入「${node.kind}」块${hints.length ? `；注意：${hints.join("、")}` : ""}（未启用——检查后手动启用/挂事件）`,
      };
    }
    case "blockRemove": {
      const g = findGroup();
      const blockId = String(a.blockId ?? "").trim();
      if (!blockId) throw new Error("blockRemove 需要 blockId（可用 orchestratorRead 取）");
      store.removeBlock(g.id, blockId);
      toast(`AI 删除编排块（组「${g.name}」）`);
      return `已从组「${g.name}」删除块 ${blockId}`;
    }
    case "varsSet": {
      const name = String(a.name ?? "").trim();
      if (!name) throw new Error("varsSet 需要 name 与 value");
      if (a.value === undefined) throw new Error("varsSet 需要 value");
      const before = eng.listVars().find((v) => v.name === name);
      if (!before) throw new Error(`变量不存在：${name}（变量必须先由用户在变量库中声明）`);
      eng.setVar(name, a.value as number | string | boolean);
      const after = eng.listVars().find((v) => v.name === name)?.value;
      return `变量 ${name}：${JSON.stringify(before.value)} → ${JSON.stringify(after)}（注意：会触发 varChanged 事件链）`;
    }
    default:
      throw new Error(
        `未知 orchestrator 动作 op：${op || "（空）"}（可选：enable / run / stopAll / groupAdd / groupUpdate / groupRemove / eventAdd / eventRemove / blockAdd / blockRemove / varsSet）`,
      );
  }
}

/** 3D 轨迹只读快照（P87a 三组化）：各组绑定/显示 + 全局视图设置 + 校准采样/拟合/六面状态 */
async function plot3dStatus(): Promise<unknown> {
  const s3d = await import("../plot3d/plot3dStore");
  const st = s3d.getSnapshot().settings;
  const cal = s3d.calibSnapshot();
  const fit = s3d.getCalibFit();
  const six = s3d.accel6Snapshot();
  return {
    groups: st.groups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      visible: g.visible,
      axes: { x: g.chX, y: g.chY, z: g.chZ, bound: !!(g.chX && g.chY && g.chZ) },
      mode: g.mode,
      colorBy: g.colorBy,
      colorCh: g.colorCh,
      fadeSec: g.fade,
      density: g.density,
      smooth: g.smooth,
      smoothWin: g.smoothWin,
      maxPoints: g.maxPoints,
      pairMode: g.pairMode,
      pairTolMs: g.pairTolMs,
      notes: g.notes,
    })),
    view: {
      axisScale: st.axisScale,
      showGrid: st.showGrid,
      gridDensity: st.gridDensity,
      follow: st.follow,
      autoRotate: st.autoRotate,
      zoomToCursor: st.zoomToCursor,
      keyFlight: st.keyFlight,
    },
    calibMode: st.calibMode,
    /** P87a：校准采样源固定 = 组1 三通道 */
    calibSource: "g1",
    sampling: { capturing: cal.capturing, points: cal.count, cap: s3d.CALIB_CAP, octantCoverage: cal.coverage },
    fit: fit
      ? {
          ok: true,
          offset: fit.offset,
          gains: fit.gains,
          axes: fit.axes,
          meanR: fit.meanR,
          /** 半径变异系数（越小越圆；软磁校正效果） */
          cv: fit.cv,
          /** 归一化半径残差 RMS（8 参数拟合质量） */
          rms: fit.rms,
          samples: fit.n,
        }
      : null,
    accel6: {
      collecting: six.collecting,
      currentFace: six.idx,
      facesDone: six.faces.filter((f) => f !== null).length,
      minSamples: six.minSamples,
      result: six.result,
    },
  };
}

/** P87a：AI 侧组参数（缺省组 = g1，与 v0.4.1 时代单轨迹语义一致） */
function plot3dGidOf(a: Record<string, unknown>): "g1" | "g2" | "g3" {
  return a.gid === "g2" || a.gid === "g3" ? a.gid : "g1";
}

/** 3D 写操作（高权限）：组绑定 / 显示设置（组级或全局）/ 清空 / 撤销重做 / 校准会话 */
async function runPlot3dAction(a: Record<string, unknown>): Promise<unknown> {
  const s3d = await import("../plot3d/plot3dStore");
  const op = String(a.op ?? "").trim();
  if (op === "bind") {
    const gid = plot3dGidOf(a);
    const patch: Record<string, string> = {};
    if (typeof a.axisX === "string" || typeof a.chX === "string")
      patch.chX = String((a.chX ?? a.axisX) as string);
    if (typeof a.axisY === "string" || typeof a.chY === "string")
      patch.chY = String((a.chY ?? a.axisY) as string);
    if (typeof a.axisZ === "string" || typeof a.chZ === "string")
      patch.chZ = String((a.chZ ?? a.axisZ) as string);
    if (typeof a.colorCh === "string") patch.colorCh = String(a.colorCh);
    if (!Object.keys(patch).length) throw new Error("bind 需要 axisX / axisY / axisZ（通道 id，可用 get_plot_stats 或 listChannels 取；gid 可选 g1/g2/g3，缺省 g1）");
    s3d.updateGroup(gid, patch as Parameters<typeof s3d.updateGroup>[1]);
    const g = s3d.getGroup(gid);
    return {
      gid,
      axes: { x: g.chX, y: g.chY, z: g.chZ, bound: !!(g.chX && g.chY && g.chZ) },
      msg: `已更新 ${g.name} 轴绑定（换绑定会清空该组历史并重灌；组1 换绑连带清空校准采样与拟合）`,
    };
  }
  if (op === "set") {
    const gid = plot3dGidOf(a);
    const groupKeys = ["colorBy", "colorCh", "fade", "density", "mode", "pointSize", "opacity", "showDots", "maxPoints", "smooth", "smoothWin", "pairMode", "pairTolMs", "name", "color", "notes"] as const;
    const viewKeys = ["axisScale", "showGrid", "gridDensity", "autoRotate", "follow", "keyFlight", "zoomToCursor"] as const;
    const gpatch: Record<string, unknown> = {};
    for (const k of groupKeys) if (a[k] !== undefined) gpatch[k] = a[k];
    // 旧 style 键兼容：line+points/line/points → mode + showDots（落 gid 组）
    if (typeof a.style === "string") {
      gpatch.mode = a.style === "points" ? "points" : "line";
      gpatch.showDots = a.style === "line+points";
    }
    const vpatch: Record<string, unknown> = {};
    for (const k of viewKeys) if (a[k] !== undefined) vpatch[k] = a[k];
    if (!Object.keys(gpatch).length && !Object.keys(vpatch).length)
      throw new Error(`set 需要至少一个字段（组级 ${groupKeys.join(" / ")}；全局 ${viewKeys.join(" / ")}；gid 可选 g1/g2/g3）`);
    if (Object.keys(vpatch).length) s3d.setSetting(vpatch as Parameters<typeof s3d.setSetting>[0]);
    if (Object.keys(gpatch).length) s3d.updateGroup(gid, gpatch as Parameters<typeof s3d.updateGroup>[1]);
    return `已更新 3D 设置：${[...Object.keys(vpatch), ...Object.keys(gpatch)].join(" / ")}（组级写入 gid=${gid}）`;
  }
  if (op === "clear") {
    const gid = a.gid === undefined ? undefined : plot3dGidOf(a);
    s3d.requestClearData(gid);
    return gid ? `已清空 ${gid} 组轨迹（不可撤销；校准采样不受影响）` : "已清空三组轨迹（不可撤销；校准采样不受影响）";
  }
  if (op === "undo" || op === "redo") {
    const ok = op === "undo" ? s3d.undo() : s3d.redo();
    return ok ? `已${op === "undo" ? "撤销" : "重做"}一步 3D 组配置` : "3D 撤销/重做栈为空";
  }
  if (op === "calib") {
    const sub = String(a.calib ?? "").trim();
    switch (sub) {
      case "enter":
        s3d.setSetting({ calibMode: true });
        return "已进入椭球校准模式（轨迹隐藏、切换为点云采样；采样源=组1；需先在画布上操作时用户可见）";
      case "exit":
        s3d.setSetting({ calibMode: false });
        return "已退出椭球校准模式";
      case "start":
        s3d.startCalibCapture();
        return "已开始椭球采样（让设备在八个姿态上缓慢转动，覆盖度越高拟合越准）";
      case "stop":
        s3d.stopCalibCapture();
        return `已停止采样，共 ${s3d.calibSnapshot().count} 点`;
      case "clear":
        s3d.clearCalib();
        return "已清空校准采样与拟合结果";
      case "solve6":
        return s3d.accel6Solve(typeof a.gRef === "number" ? a.gRef : 1);
      default:
        throw new Error(`未知 calib 子动作：${sub || "（空）"}（可选：enter / exit / start / stop / clear / solve6）`);
    }
  }
  throw new Error(`未知 plot3d 动作 op：${op || "（空）"}（可选：bind / set / clear / undo / redo / calib）`);
}
