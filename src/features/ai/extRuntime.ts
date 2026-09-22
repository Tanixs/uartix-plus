// P99a-D1c：这里曾经 import 了 framesBus / variableStore / serialStore / widgetHub / aiChatFeed /
// appActions 六组模块，只为喂给主世界 `new Function` 的 ScriptApi。脚本通道删掉后它们全部无用了——
// 少一批静态边也意味着 extRuntime 这条曾经的环边更薄（§8-33）。
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

/* ---------------- 扩展 toast（小部件/面板/脚本共用） ----------------
 *
 * P99a-D1c 删除了此处的"行为脚本运行时"：`ScriptApi` + `makeApi()` + `new Function("api", code)`。
 * 那条通道是主世界里的无超时、不可中断 eval，且 `api.app.*` 一律带 `highPriv:true`——
 * 它是全仓最高的一块攻击面，而**没有任何生产者会写它**：`pluginStore` 的投影只产
 * theme/widget/panel 三种，`perms` 字段更是全仓零读取者（M2 清退的那类"假安全控件"）。
 * 零兼容裁决（详设 §13.1）下直接删通道，而不是给它补沙箱：能跑 JS 的合法形态只有
 * 专用 Worker 那一条（`logic.run` + realm 封网 + 探针自证），主世界不留第二个口子。
 */

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

/* ---------------- 总控：随扩展启停同步运行时 ---------------- */

let started = false;

export function startExtRuntime() {
  if (started) return;
  started = true;
  applyStyleExts();
  // 只剩样式层：面板扩展挂载时按需渲染，脚本通道已随 P99a-D1c 删除
}

/* P92-F：把样式层应用者交给 pluginStore（单向 extRuntime → pluginStore，**不再有反向静态边**）。
 * 注册即补跑：pluginStore 在模块求值期重建 theme 投影时若样式层还没人接（脏标记），到这里一次
 * 性贴上——所以既不需要 App 按顺序调，也不会在求值期撞进对方未初始化的模块状态（那是上次
 * dev 整窗白屏的直接原因：TDZ `appliedVars`）。 */
setStyleApplier(applyStyleExts);
