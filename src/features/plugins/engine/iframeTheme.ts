/**
 * P174-R18：把宿主主题桥接进插件 iframe。
 *
 * 不透明源 iframe 拿不到父文档的 CSS 变量，所以"面板自己写死一套灰白按钮"不是设计选择，
 * 而是缺一座桥。这里做两件事：
 *  1. 从宿主根上读**合成后的有效值**，改名成 `--uartix-*`（避免和插件自己的 `--bg` 撞名）；
 *  2. 生成一份**零特异性**（`:where()`）的基础样式：body、输入框、按钮、`.btn`/`.input`/`.card`
 *     都先用宿主主题画。插件自己的规则仍然优先，想自定义就照旧覆盖。
 *
 * 值一律过 `safeCssValue`：主题 token 是用户/插件可写的，绝不能让一个 `;` 或 `</style>`
 * 把注入块截断成第二条样式表。
 */

export interface IframeTheme {
  /** 已经改名的 `--uartix-*` 变量（值来自宿主 getComputedStyle）。 */
  vars: Record<string, string>;
  scheme: "light" | "dark";
  font: string;
}

/** 从宿主根上取的 token；顺序只影响可读性。 */
const HOST_VAR_KEYS = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--raise-1",
  "--raise-2",
  "--border",
  "--border-soft",
  "--line-strong",
  "--text",
  "--text-dim",
  "--text-faint",
  "--accent",
  "--accent-text",
  "--accent-soft",
  "--on-accent",
  "--danger",
  "--danger-text",
  "--ok",
  "--warn",
  "--warn-fg",
  "--ring",
  "--scrim",
  "--shadow",
  "--shadow-pop",
  "--scrollbar",
  "--scrollbar-hover",
  "--radius-s",
  "--radius-m",
  "--radius-l",
  "--radius-pill",
  "--fs-xs",
  "--fs-body",
  "--fs-sm",
  "--fs-md",
  "--fs-lg",
  "--font-mono",
  "--sp-1",
  "--sp-2",
  "--sp-3",
  "--sp-4",
  "--ctl-h-2",
  "--dur-fast",
  "--ease",
] as const;

/** CSS 值里出现这些字符就不再注入：它们能截断规则或开新的样式/标签。 */
export function safeCssValue(raw: string, max = 220): string {
  const v = String(raw ?? "").trim();
  if (!v || v.length > max) return "";
  if (/[;{}<>]/.test(v)) return "";
  if (/url\s*\(|@import|expression\s*\(/i.test(v)) return "";
  return v;
}

const FALLBACK_FONT = '"Segoe UI", system-ui, "Microsoft YaHei", sans-serif';

/** 读宿主当前**合成后**的主题；document 不在时返回空壳（Node 测试/首帧前）。 */
export function readHostTheme(): IframeTheme {
  const empty: IframeTheme = { vars: {}, scheme: "dark", font: FALLBACK_FONT };
  if (typeof document === "undefined") return empty;
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const key of HOST_VAR_KEYS) {
    const v = safeCssValue(cs.getPropertyValue(key));
    if (v) vars[`--uartix-${key.slice(2)}`] = v;
  }
  // 和宿主同一条口径：只有显式 light 才算亮底，缺省按暗（themeCore.isDarkScheme）
  const scheme: "light" | "dark" = root.dataset.scheme === "light" ? "light" : "dark";
  const font = safeCssValue((document.body ? getComputedStyle(document.body).fontFamily : "") || "") || FALLBACK_FONT;
  return { vars, scheme, font };
}

/**
 * iframe 里的一段初始样式：变量 + 宿主基础控件。
 *
 * 全部选择器都包在 `:where()` 里（特异性 0）：插件写 `input { … }` 就能覆盖；
 * 不写的，就得到宿主同一套底色、描边、圆角、焦点环与按钮高度。
 *
 * `paintPage: false` 是给小部件的：透明无边框的小部件靠"页面没有底色"才透明，
 * 给它刷一层宿主底色等于把"浮窗"变成"贴了一块面板"。变量与控件照旧桥过去，
 * 页面底色留给插件自己决定（要跟主题就写 `var(--bg)`，要悬浮就自己写 transparent）。
 */
export function iframeThemeCss(theme: IframeTheme, opts?: { paintPage?: boolean }): string {
  const paintPage = opts?.paintPage !== false;
  const bg = theme.scheme === "dark" ? "#16181c" : "#fbfbfc";
  const panel = theme.scheme === "dark" ? "#1c1f24" : "#f4f5f7";
  const inset = theme.scheme === "dark" ? "#121417" : "#ffffff";
  const text = theme.scheme === "dark" ? "#e6e8eb" : "#1c1f23";
  const dim = theme.scheme === "dark" ? "#9aa0a6" : "#5a616b";
  const faint = theme.scheme === "dark" ? "#6b7178" : "#8b929b";
  const border = theme.scheme === "dark" ? "#2b3036" : "#e1e4e8";
  const accent = theme.scheme === "dark" ? "#7cb3ef" : "#29589c";
  const onAccent = theme.scheme === "dark" ? "#0f1115" : "#ffffff";
  const ok = theme.scheme === "dark" ? "#3fb950" : "#1a7f37";
  const warn = theme.scheme === "dark" ? "#d29922" : "#9a6700";
  const bad = theme.scheme === "dark" ? "#f85149" : "#cf222e";
  const vars = Object.entries(theme.vars)
    // 这里再过一次：变量正常来自 readHostTheme（那里已经滤过），但 buildSrcdoc 的调用方
    // 不止一处，而这段文本是直接落进 <style> 的——注入面在写的那一刹那收口，不在读的那一侧指望别人。
    .filter(([k, v]) => /^--uartix-[a-z0-9-]+$/.test(k) && !!safeCssValue(v))
    .map(([k, v]) => `  ${k}: ${safeCssValue(v)};`)
    .join("\n");
  const font = safeCssValue(theme.font) || FALLBACK_FONT;

  return `:where(:root) {
  color-scheme: ${theme.scheme};
  --uartix-font: ${font};
${vars}
  /* 宿主变量别名：让老面板常用的 --bg / --fg / --line 等名字也跟主题走 */
  --bg: var(--uartix-bg, ${bg});
  --panel: var(--uartix-bg-panel, ${panel});
  --inset: var(--uartix-bg-inset, ${inset});
  --fg: var(--uartix-text, ${text});
  --dim: var(--uartix-text-dim, ${dim});
  --faint: var(--uartix-text-faint, ${faint});
  --line: var(--uartix-border, ${border});
  --accent: var(--uartix-accent, ${accent});
  --on-accent: var(--uartix-on-accent, ${onAccent});
  --ok: var(--uartix-ok, ${ok});
  --warn: var(--uartix-warn, ${warn});
  --bad: var(--uartix-danger, ${bad});
}
:where(html) { background: ${paintPage ? `var(--uartix-bg, ${bg})` : "transparent"}; color-scheme: ${theme.scheme}; }
:where(body) {
  margin: 0;
  background: ${paintPage ? `var(--uartix-bg, ${bg})` : "transparent"};
  color: var(--uartix-text, ${text});
  font-family: var(--uartix-font, ${font});
  font-size: var(--uartix-fs-body, 12px);
  line-height: 1.5;
}
:where(button, input, select, textarea) {
  box-sizing: border-box;
  font: inherit;
  color: var(--uartix-text, ${text});
  background: var(--uartix-bg-inset, ${inset});
  border: 1px solid var(--uartix-border, ${border});
  border-radius: var(--uartix-radius-m, 6px);
}
:where(input, select, textarea) { padding: 3px 6px; }
:where(button) {
  min-height: var(--uartix-ctl-h-2, 24px);
  padding: 2px 10px;
  cursor: pointer;
}
:where(button:hover:not(:disabled)) { border-color: var(--uartix-accent, ${accent}); color: var(--uartix-accent-text, ${accent}); }
:where(button:disabled) { opacity: 0.5; cursor: default; }
:where(button, input, select, textarea):focus-visible { outline: 2px solid var(--uartix-ring, ${accent}); outline-offset: 1px; }
:where(.btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: var(--uartix-ctl-h-2, 24px);
  padding: 2px 10px;
  border: 1px solid var(--uartix-border, ${border});
  border-radius: var(--uartix-radius-m, 6px);
  background: var(--uartix-bg-panel, ${panel});
  color: var(--uartix-text, ${text});
  font: inherit;
  cursor: pointer;
}
:where(.btn:hover:not(:disabled)) { border-color: var(--uartix-accent, ${accent}); color: var(--uartix-accent-text, ${accent}); }
:where(.btn.primary) { background: var(--uartix-accent, ${accent}); border-color: var(--uartix-accent, ${accent}); color: var(--uartix-on-accent, ${onAccent}); }
:where(.btn.danger) { color: var(--uartix-danger-text, ${bad}); border-color: var(--uartix-danger, ${bad}); background: transparent; }
:where(.input) {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--uartix-ctl-h-2, 24px);
  padding: 3px 6px;
  font: inherit;
  color: var(--uartix-text, ${text});
  background: var(--uartix-bg-inset, ${inset});
  border: 1px solid var(--uartix-border, ${border});
  border-radius: var(--uartix-radius-m, 6px);
}
:where(.card) {
  background: var(--uartix-bg-panel, ${panel});
  border: 1px solid var(--uartix-border, ${border});
  border-radius: var(--uartix-radius-l, 8px);
}
:where(a) { color: var(--uartix-accent-text, ${accent}); }
:where(code, kbd, pre) { font-family: var(--uartix-font-mono, "Cascadia Mono", Consolas, monospace); }
::selection { background: var(--uartix-accent-soft, ${inset}); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--uartix-scrollbar, ${border}); border-radius: var(--uartix-radius-pill, 999px); }
::-webkit-scrollbar-track { background: var(--uartix-bg-inset, ${inset}); }`;
}
