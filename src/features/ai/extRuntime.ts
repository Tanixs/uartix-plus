import { onFrames } from "../../ipc/framesBus";
import { getVar, listVars } from "../controls/variableStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import * as serialStore from "../serial/serialStore";
import { buildSnap } from "./widgetHub";
import { getChatFeed, type AiChatFeed } from "./aiChatFeed";
import { subscribe as subChatStore } from "./chatStore";
import { runAppAction, APP_ACTION_KINDS, type AppActionKind } from "./appActions";
import type { AiExtension } from "./extensionStore";
import { getSnapshot as getExts } from "./extensionStore";

/* ---------------- 样式层：主题变量 + 自定义 CSS ---------------- */

let styleEl: HTMLStyleElement | null = null;
let previewEl: HTMLStyleElement | null = null;
let appliedVars: string[] = [];

function ensureStyleEl(): HTMLStyleElement {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.aiExt = "1";
    document.head.appendChild(styleEl);
  }
  return styleEl;
}

function ensurePreviewEl(): HTMLStyleElement {
  if (!previewEl) {
    previewEl = document.createElement("style");
    previewEl.dataset.aiExtPreview = "1";
    document.head.appendChild(previewEl);
  }
  return previewEl;
}

/** 根据启用中的扩展重建主题变量与 CSS 样式层 */
export function applyStyleExts() {
  const root = document.documentElement;
  for (const k of appliedVars) root.style.removeProperty(k);
  appliedVars = [];
  const cssParts: string[] = [];
  for (const e of getExts().exts) {
    if (!e.enabled) continue;
    if (e.type === "theme") {
      for (const [k, v] of Object.entries(e.vars ?? {})) {
        root.style.setProperty(k, v);
        appliedVars.push(k);
      }
      if (e.css) cssParts.push(`/* theme: ${e.name} */\n${e.css}`);
    } else if (e.type === "style") {
      if (e.css) cssParts.push(`/* style: ${e.name} */\n${e.css}`);
    }
  }
  ensureStyleEl().textContent = cssParts.join("\n\n");
}

/** 预览临时 CSS（不持久化）；传 null 清除预览 */
export function previewCss(css: string | null) {
  ensurePreviewEl().textContent = css ?? "";
}

/** 主题桥：沙箱组件（iframe）拿不到主文档 CSS 变量，需显式采集注入 */
export const THEME_VAR_KEYS = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--border",
  "--border-soft",
  "--text",
  "--text-dim",
  "--accent",
  "--accent-soft",
  "--danger",
  "--shadow",
  "--scrollbar",
  "--scrollbar-hover",
];

export function collectThemeVars(): { vars: Record<string, string>; theme: string } {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of THEME_VAR_KEYS) {
    const v = cs.getPropertyValue(k).trim();
    if (v) vars[k] = v.slice(0, 200);
  }
  return { vars, theme: document.documentElement.dataset.theme || "dark" };
}

/* ---------------- 行为脚本运行时 ---------------- */

export interface ScriptApi {
  getField(name: string): number | string | undefined;
  listFields(): string[];
  onFrame(cb: (fields: Record<string, number | string>) => void): () => void;
  send(mode: "ascii" | "hex", text: string): Promise<void>;
  toast(msg: string): void;
  getInfo(): ReturnType<typeof buildSnap>;
  /** 感知 AI 助手对话状态（phase/思维链尾部/正文尾部），订阅即回当前值 */
  onChat(cb: (feed: AiChatFeed) => void): () => void;
  /** 向 AI 助手提问（回答经 onChat 流式回来） */
  ask(text: string): Promise<void>;
  /** 应用控制 API：openPanel/applyPreset/setTheme/writeCard/clearPage/removeXxx 等 */
  app: Record<
    AppActionKind,
    (args?: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; err?: string }>
  >;
}

const runningScripts = new Map<string, () => void>();

let toastHost: HTMLDivElement | null = null;
export function toast(msg: string) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "ai-toast-host";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = "ai-toast";
  el.textContent = String(msg).slice(0, 200);
  toastHost.appendChild(el);
  window.setTimeout(() => el.remove(), 2600);
}

function makeApi(): ScriptApi {
  const app = {} as ScriptApi["app"];
  for (const kind of APP_ACTION_KINDS) {
    app[kind] = (args?: Record<string, unknown>) =>
      runAppAction(kind, args ?? {}, { highPriv: true });
  }
  return {
    getField: (name) => getVar(name),
    listFields: () => listVars().map((v) => v.name),
    onFrame: (cb) =>
      onFrames((p) => {
        const fields: Record<string, number | string> = {};
        for (const r of p.rows) {
          for (const f of r.fields) fields[f.name] = f.text ?? f.value;
        }
        cb(fields);
      }),
    send: async (mode, text) => {
      if (!getSettings().aiWidgetSend) {
        throw new Error("发送权限未开启（设置 → AI 服务 → 小部件可发送数据）");
      }
      await serialStore.sendData(mode, text);
    },
    toast,
    getInfo: () => buildSnap(),
    onChat: (cb) => {
      let lastKey = "";
      const fire = () => {
        const f = getChatFeed();
        const key = `${f.phase}|${f.reasoningTail}|${f.textTail}`;
        if (key !== lastKey) {
          lastKey = key;
          cb(f);
        }
      };
      fire();
      return subChatStore(fire);
    },
    ask: async (text) => {
      if (!getSettings().aiWidgetSend) {
        throw new Error("发送权限未开启（设置 → AI 服务 → 小部件可发送数据）");
      }
      const m = await import("./chatStore");
      const r = m.requestAsk(text);
      if (!r.ok) throw new Error(r.err ?? "提交失败");
    },
    app,
  };
}

/** 启用单个行为脚本扩展（重复启用先停止旧实例） */
export function startScript(ext: AiExtension) {
  stopScript(ext.id);
  try {
    const api = makeApi();
    const fn = new Function("api", `"use strict";\n${ext.code ?? ""}`);
    const ret = fn(api);
    const cleanup = typeof ret === "function" ? ret : undefined;
    runningScripts.set(ext.id, () => cleanup?.());
  } catch (e) {
    toast(`脚本「${ext.name}」启动失败：${String(e).slice(0, 120)}`);
  }
}

export function stopScript(id: string) {
  const stop = runningScripts.get(id);
  if (stop) {
    try {
      stop();
    } catch {
      /* 忽略清理异常 */
    }
    runningScripts.delete(id);
  }
}

export function isScriptRunning(id: string): boolean {
  return runningScripts.has(id);
}

/* ---------------- 总控：随扩展启停同步运行时 ---------------- */

let started = false;

export function startExtRuntime() {
  if (started) return;
  started = true;
  applyStyleExts();
  // 启动时运行所有已启用的脚本扩展
  for (const e of getExts().exts) {
    if (e.type === "script" && e.enabled) startScript(e);
  }
  // 面板扩展无需常驻运行时（挂载时按需渲染）
}
