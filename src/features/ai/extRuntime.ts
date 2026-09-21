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
import { setStyleApplier } from "../plugins/pluginStore";
import { ROOT_LAYER, submitRootVars } from "../../styles/rootVars";

/** 插件主题层在合成器里的身份（外观来源面板按这个 id 报告） */
export const PLUGIN_THEME_LAYER_ID = "plugin-theme";

/* ---------------- 样式层：主题变量 + 自定义 CSS ---------------- */

let styleEl: HTMLStyleElement | null = null;

function ensureStyleEl(): HTMLStyleElement {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.aiExt = "1";
    document.head.appendChild(styleEl);
  }
  return styleEl;
}

/**
 * 重建主题变量与 CSS 样式层。
 * P91 D1：主题层按**安装顺序显式合成**（createdAt 升序，后装的赢）——旧实现直接吃
 * 数组顺序，"谁覆盖谁"成了投影写入的巧合，用户无法预期。内置主题走样式表
 * `:root[data-theme]`，内联层恒压过它。
 * P98-M0：变量不再自己写 `root.style`——整份提交给 `styles/rootVars` 合成器，
 * 由它按固定层序（插件主题 < Agent 覆盖层）算出有效值再落地。旧版这里开头就是
 * `for (const k of appliedVars) root.style.removeProperty(k)`，会把覆盖层写在同名键上的值
 * 一并删掉（两套 applied* 记账互相抹），所以 `appliedVars` 连同那圈删除一起删除。
 */
export function applyStyleExts() {
  const exts = getExts().exts;
  const themes = exts
    .filter((e) => e.enabled && e.type === "theme")
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const vars: Record<string, string> = {};
  const cssParts: string[] = [];
  for (const e of themes) {
    for (const [k, v] of Object.entries(e.vars ?? {})) {
      vars[k] = v;
    }
    if (e.css) cssParts.push(`/* theme: ${e.name} */\n${e.css}`);
  }
  for (const e of exts) {
    if (!e.enabled || e.type !== "style") continue;
    if (e.css) cssParts.push(`/* style: ${e.name} */\n${e.css}`);
  }
  submitRootVars(PLUGIN_THEME_LAYER_ID, ROOT_LAYER.pluginTheme, vars);
  if (typeof document !== "undefined") ensureStyleEl().textContent = cssParts.join("\n\n");
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
  "--warn",
  "--ok",
  "--shadow",
  "--scrollbar",
  "--scrollbar-hover",
];

/**
 * 采集主文档上生效的 CSS 变量（iframe/小部件主题桥，以及"保存为完整主题"的数据源）。
 * P98-M0：读的是 `getComputedStyle` ⇒ 天然就是合成器算完的**有效值**，与哪一层供的值无关。
 * `keys` 可换清单：默认 16 个色板键（iframe 桥够用），存主题时传全量 `APPEARANCE_TOKENS`
 * ——否则 radius/fs/dur/ease 只能靠覆盖层恰好还在才补齐（旧版 `save_theme_extension` 的坑）。
 */
export function collectThemeVars(keys: readonly string[] = THEME_VAR_KEYS): { vars: Record<string, string>; theme: string } {
  if (typeof document === "undefined") return { vars: {}, theme: "dark" };
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of keys) {
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
        throw new Error("发送权限未开启（设置 → AI 服务 → 权限与安全 → 允许向设备发送）");
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
        throw new Error("发送权限未开启（设置 → AI 服务 → 权限与安全 → 允许向设备发送）");
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
  // 启动时运行所有已启用的脚本扩展（旧扩展已废弃，运行时仅承载插件库投影）
  for (const e of getExts().exts) {
    if (e.type === "script" && e.enabled) startScript(e);
  }
  // 面板扩展无需常驻运行时（挂载时按需渲染）
}

/* P92-F：把样式层应用者交给 pluginStore（单向 extRuntime → pluginStore，**不再有反向静态边**）。
 * 注册即补跑：pluginStore 在模块求值期重建 theme 投影时若样式层还没人接（脏标记），到这里一次
 * 性贴上——所以既不需要 App 按顺序调，也不会在求值期撞进对方未初始化的模块状态（那是上次
 * dev 整窗白屏的直接原因：TDZ `appliedVars`）。 */
setStyleApplier(applyStyleExts);
