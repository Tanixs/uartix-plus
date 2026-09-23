// P99a-D1c：这里曾经 import 了 framesBus / variableStore / serialStore / widgetHub / aiChatFeed /
// appActions 六组模块，只为喂给主世界 `new Function` 的 ScriptApi。脚本通道删掉后它们全部无用了——
// 少一批静态边也意味着 extRuntime 这条曾经的环边更薄（§8-33）。
import { getSnapshot as getExts } from "./extensionStore";
import { setStyleApplier } from "../plugins/pluginStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { ROOT_LAYER, submitRootVars } from "../../styles/rootVars";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_ERRORS,
  baselineFor,
} from "../../styles/builtinThemes";
import {
  resolveActiveTheme,
  resolveScheme,
  themeCoverage,
  type ThemeScheme,
  type ThemeSource,
} from "../../styles/themeCore";
/**
 * 「在画哪枚」的事实表住在零 import 的叶子（`styles/themeFacts`），本文件是它**唯一的写者**。
 * 为什么不放这儿让所有人 import：`features/plugins/` 全目录都不准静态依赖样式运行时
 * （P92-F 整窗白屏那条禁止边），而插件库那颗开关也要读这份事实说出"启用这颗会挤掉谁"。
 */
import { notifyStyleApply, setActiveThemeFacts, type ActiveThemeFacts } from "../../styles/themeFacts";

/**
 * 在画的那枚主题占的合成器层（外观来源面板按 id 报告）。
 * P99b-N5：旧名 `plugin-theme` 说的是"插件主题叠出来的那一层"，而这批之后这一层里
 * **内置与插件走的是同一条路**（详设 S2/S3），旧名字会指错东西。
 */
export const ACTIVE_THEME_LAYER_ID = "active-theme";
/** 兜底层：暗/亮两张表二选一（详设 S1）。它由本文件按明暗归属提交，别处不许自己垫 */
export const THEME_BASELINE_LAYER_ID = "theme-baseline";

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

/** 上一次算出的明暗归属：差量主题没给 `--bg` 也没声明时沿用它的（详设 S4 的 ③），要连同出处一起报出去 */
let lastScheme: ThemeScheme | null = null;

/** 一条出声的通道：装载期的解析错误只报一次，不静默用半张表（G12 的运行期那一半） */
let builtinErrorsReported = false;

/** 插件投影记录 → 主题源（`scheme` 只有显式声明才算声明，缺省一律交给"按 --bg 算"） */
function themeSourceFromExt(e: {
  id: string;
  name: string;
  vars?: Record<string, string>;
  css?: string;
  pluginRef?: string;
  createdAt?: number;
  scheme?: string;
}): ThemeSource {
  return {
    id: e.id,
    name: e.name,
    builtin: false,
    scheme: e.scheme === "dark" || e.scheme === "light" ? e.scheme : null,
    vars: e.vars ?? {},
    ...(e.css ? { css: e.css } : {}),
    ...(e.pluginRef ? { pluginId: e.pluginRef } : {}),
    createdAt: e.createdAt ?? 0,
  };
}

// 事实表的形状与读写口都在 `styles/themeFacts`（见文件头那条注释）。

function sysPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * 重建主题层与 CSS 样式层。**这里是"哪枚主题在画"唯一的落地出口**（详设 R1/R7）。
 *
 * P99b-N5 改的是什么（详设 §2）：
 *  - 旧写法把**所有**启用中的插件主题按 createdAt 合并成一层、CSS 拼接（源码注释自己写着
 *    "后装的赢"），于是启用三枚就得到一个没人同意过的混血主题；内置那八枚则走样式表
 *    `:root[data-theme]` 垫在下面。**两套机制画一个界面**。
 *  - 现在内置与插件是同一种东西（一张 token 表），一次只有一枚进 `active-theme` 层；
 *    底下垫的是**兜底层**（暗/亮两张表，按引用取自内置 dark/light，不是第三份抄本）。
 *  - `data-theme` 属性留着但换了语义：它是"在画那枚的 id"这个事实的投影，
 *    六个画布的 MutationObserver 因此一行不改就能跟插件主题同步（旧版启用插件主题时
 *    属性不变 ⇒ 画布停在启动时的配色上，那是张真账，详设 §1-7）。
 *
 * P98-M0 那条还在：变量一律交给 `styles/rootVars` 合成器按固定层序算有效值，
 * 本文件不碰 `root.style` 的删除——两套 applied* 记账互相抹就是当初"停用撤不回去"的根因。
 */
export function applyStyleExts() {
  if (!builtinErrorsReported && BUILTIN_THEME_ERRORS.length) {
    builtinErrorsReported = true;
    console.error(`[theme] 内置主题装载有 ${BUILTIN_THEME_ERRORS.length} 处问题：${BUILTIN_THEME_ERRORS.slice(0, 3).join("；")}`);
  }
  const exts = getExts().exts;
  const enabledThemes = exts
    .filter((e) => e.enabled && e.type === "theme")
    .map((e) => themeSourceFromExt(e));
  const settings = getSettings();
  const decision = resolveActiveTheme({
    settingsTheme: settings.theme,
    sysDark: sysPrefersDark(),
    builtins: BUILTIN_THEMES,
    enabledThemePlugins: enabledThemes,
  });
  const pickedSource: ThemeSource | null = decision.active
    ? enabledThemes.find((t) => t.id === decision.active!.id) ?? BUILTIN_THEMES.find((t) => t.id === decision.active!.id) ?? null
    : null;
  const vars = pickedSource?.vars ?? {};
  const { scheme, origin } = resolveScheme({ scheme: pickedSource?.scheme ?? null, vars }, lastScheme);
  lastScheme = scheme;
  const baseline = baselineFor(scheme);
  const { inherited } = themeCoverage(vars, baseline);

  submitRootVars(THEME_BASELINE_LAYER_ID, ROOT_LAYER.baseline, baseline);
  submitRootVars(ACTIVE_THEME_LAYER_ID, ROOT_LAYER.activeTheme, vars);

  // CSS 只跟在画那一枚后面走：两枚主题的 CSS 拼接出来的东西没有任何一处能解释
  const cssParts: string[] = [];
  if (pickedSource?.css) cssParts.push(`/* theme: ${pickedSource.name} */\n${pickedSource.css}`);
  for (const e of exts) {
    if (!e.enabled || e.type !== "style") continue;
    if (e.css) cssParts.push(`/* style: ${e.name} */\n${e.css}`);
  }

  const facts: ActiveThemeFacts = {
    id: decision.active?.id ?? "",
    name: decision.active?.name ?? "未装载",
    builtin: decision.active?.builtin ?? true,
    pluginId: decision.active?.pluginId ?? null,
    scheme,
    schemeOrigin: origin,
    overrides: Object.keys(vars).length,
    inherited: inherited.length,
    baseline: scheme,
    fallbackId: decision.builtinDrawn?.id ?? null,
    conflicts: decision.conflicts.map((c) => c.name),
    fellBack: decision.fellBack,
  };

  if (typeof document !== "undefined") {
    ensureStyleEl().textContent = cssParts.join("\n\n");
    const root = document.documentElement;
    if (facts.id) root.dataset.theme = facts.id;
    /**
     * `data-scheme` 是明暗归属的**唯一可读投影**（详设 S4 算完才写到这）。
     * 画布类组件一律读它，别再按主题**名字**判暗不暗——同级之后 id 可能是
     * `plg:...:main`，按名字判会把暗色插件主题当亮色画（本批实测第四条账）。
     */
    root.dataset.scheme = scheme;
    root.style.colorScheme = scheme;
  }
  setActiveThemeFacts(facts);
  notifyStyleApply();
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
export function collectThemeVars(keys: readonly string[] = THEME_VAR_KEYS): { vars: Record<string, string>; theme: string; scheme: string } {
  if (typeof document === "undefined") return { vars: {}, theme: "dark", scheme: "dark" };
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k).trim();
    if (v) vars[k] = v.slice(0, 200);
  }
  return { vars, theme: document.documentElement.dataset.theme || "dark", scheme: document.documentElement.dataset.scheme || "dark" };
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
