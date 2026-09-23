/**
 * P99b-N5：内置主题的**装载层**——八份 CSS 文件从"运行时样式"降级成"数据"。
 *
 * 为什么还留着 CSS 文件（详设 §6-Q1）：`.tools/check-contrast.cjs`（`npm run check:theme`）
 * 逐主题验对比度时读的就是这批字节。把它们搬进 TS 常量表要么让门禁换个解析入口，
 * 要么在 TS 里再抄一份色值——两种都是多出来的第二真相。留文件 ⇒ 门禁一行不改继续吃同一份源。
 *
 * 代价与它的守卫：`?raw` 读进来的东西由本模块自己解析，**文件里任何一条真样式规则都不会再生效**。
 * 所以两件事同时成立才算安全：`parseThemeBlock` 对畸形输入出声（G12），
 * 以及 `.tools/check-theme-files.cjs` 钉住"块外不许有内容、theme.css 不许再 @import 它们"（R8/G7）。
 *
 * 兜底也在这里出（详设 S1）：暗/亮两张表**按引用取自内置 dark/light 两枚主题**，不另抄数值——
 * 新写一张"中性表"等于凭空造 17 组色值，而那组数字从没被对比度门禁看过。
 */
import { parseThemeBlock, type ThemeScheme, type ThemeSource } from "./themeCore";
import amberRaw from "./themes/amber.css?raw";
import begoniaRaw from "./themes/begonia.css?raw";
import darkRaw from "./themes/dark.css?raw";
import glazeRaw from "./themes/glaze.css?raw";
import lightRaw from "./themes/light.css?raw";
import matchaRaw from "./themes/matcha.css?raw";
import navyRaw from "./themes/navy.css?raw";
import oceanRaw from "./themes/ocean.css?raw";

const RAW: Record<string, string> = {
  dark: darkRaw,
  light: lightRaw,
  navy: navyRaw,
  glaze: glazeRaw,
  ocean: oceanRaw,
  matcha: matchaRaw,
  amber: amberRaw,
  begonia: begoniaRaw,
};

/** 选择器与回落都要用的固定次序（与设置页那套 `THEME_LIST` 的对应关系由测试钉住） */
export const BUILTIN_THEME_IDS: readonly string[] = [
  "light",
  "dark",
  "ocean",
  "navy",
  "matcha",
  "amber",
  "begonia",
  "glaze",
];

/** 装载期解析错误：非空就是真故障（启动时出声，不静默用半张表） */
export const BUILTIN_THEME_ERRORS: string[] = [];

function load(id: string): ThemeSource {
  const r = parseThemeBlock(RAW[id] ?? "", id);
  if (!r.ok) BUILTIN_THEME_ERRORS.push(...r.errors);
  return { id, name: id, builtin: true, scheme: r.scheme, vars: r.vars };
}

export const BUILTIN_THEMES: ThemeSource[] = BUILTIN_THEME_IDS.map(load);

const BY_ID = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));

export function builtinTheme(id: string): ThemeSource | null {
  return BY_ID.get(id) ?? null;
}

export function isBuiltinThemeId(id: string): boolean {
  return BY_ID.has(id);
}

/** 暗/亮两层兜底（详设 S1）。按引用取，不改写、不复制 */
export const BASELINE_VARS: Record<ThemeScheme, Record<string, string>> = {
  dark: BY_ID.get("dark")?.vars ?? {},
  light: BY_ID.get("light")?.vars ?? {},
};

export function baselineFor(scheme: ThemeScheme): Record<string, string> {
  return BASELINE_VARS[scheme];
}
