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

/** 需要脚本高权限的动作 */
const HIGH_ONLY = new Set([
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

async function exec(kind: string, a: Record<string, unknown>): Promise<unknown> {
  switch (kind) {
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
