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

export interface AppActionResult {
  ok: boolean;
  data?: unknown;
  err?: string;
}

const PRESETS: WorkspacePreset[] = ["proto", "analyze", "attitude", "console", "video"];

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
