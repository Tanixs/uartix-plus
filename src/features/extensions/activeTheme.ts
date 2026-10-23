/**
 * P174：**插件主题 → 界面** 的那一步（零依赖的小桥）。
 *
 * 为什么单独一个文件：主题的应用路径在 `features/ai/extRuntime.ts`（`applyStyleExts` 是
 * 整张界面配色的唯一出口），而"当前在画哪一枚插件主题"这件事归插件子系统管。
 * 两边直接互相 import 会成环（`extStore` 已经 import 了 `extRuntime` 的状态机），
 * 而环是门禁会拦的东西。所以中间放一个**谁都能读、只有插件侧能写**的寄存器：
 *
 * - 插件侧（`extStore.ts`）在每次读盘后调 `setActiveExtTheme(...)`；
 * - 主题出口（`extRuntime.applyStyleExts`）调 `getActiveExtTheme()` 并把它当成
 *   `enabledThemePlugins` 的最后一项（旧的判定是"最后启用的一枚在画"）。
 *
 * 这个文件**不许 import 任何东西**：它是叶子，一旦它开始依赖谁，环就回来了。
 */

/** 一枚"在画的插件主题"。字段对齐 `ThemeSource` 的用法（id/name/scheme/css/pluginId）。 */
export interface ActiveExtTheme {
  /** `plg:<pluginId>:<themeId>`。带 `plg:` 前缀是为了让 `data-theme` 的观察者一眼看出不是内置。 */
  id: string;
  name: string;
  scheme: "dark" | "light" | null;
  css: string;
  pluginId: string;
}

let current: ActiveExtTheme | null = null;

export function setActiveExtTheme(t: ActiveExtTheme | null): void {
  current = t;
}

export function getActiveExtTheme(): ActiveExtTheme | null {
  return current;
}

/** 主题键：`plg:<pluginId>:<themeId>`。插件 id 与主题 id 的字符集里都不含 `:`，所以可以反解。 */
export function themeKey(pluginId: string, themeId: string): string {
  return `plg:${pluginId}:${themeId}`;
}

export function parseThemeKey(key: string): { pluginId: string; themeId: string } | null {
  if (!key.startsWith("plg:")) return null;
  const rest = key.slice(4);
  const i = rest.indexOf(":");
  if (i <= 0 || i === rest.length - 1) return null;
  return { pluginId: rest.slice(0, i), themeId: rest.slice(i + 1) };
}
