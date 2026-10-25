/**
 * P174-R15：插件**按产物分类**（不是按技术形态）。
 *
 * 用户的原话："上面这个分类为什么只有代码插件啊？不应该按主题、小部件、浮窗、面板，或者其他复合插件分类吗？"
 * 他是对的：v3 里每个插件都是"代码插件"（一个目录 + 一份清单），所以那个筛选等于没有筛选。
 * 人想找的是"哪个能给我一块面板""哪个换主题""哪个是我装的小部件"，那是 `contributes` 里的事实。
 *
 * 三条约定：
 *  1. **一枚插件可以属于多类**。它本来就同时贡献面板与命令——所以这里返回的是**集合**，
 *     筛选时"属于"而不是"等于"。≥2 类在界面上读作「复合」，但它不是第七种插件。
 *  2. **顺序固定**（面板→主题→小部件→预设→模板→命令）：同一枚插件在两处（列表徽标、详情）读起来一致。
 *  3. **「浮窗」不单列一类**：它是小部件的一种表现形态（`transparent` / `clickThrough`），
 *     拆成第七类就等于在小部件之外又造一个概念。筛选里的「小部件」标题会写明这一点。
 */

import type { PluginManifest } from "./manifest";

export type PluginKind = "panel" | "theme" | "widget" | "preset" | "task" | "command";

export const KIND_LABEL: Record<PluginKind, { zh: string; en: string }> = {
  panel: { zh: "面板", en: "Panel" },
  theme: { zh: "主题", en: "Theme" },
  widget: { zh: "小部件", en: "Widget" },
  preset: { zh: "预设", en: "Preset" },
  task: { zh: "任务模板", en: "Task template" },
  command: { zh: "命令", en: "Command" },
};

/** 固定顺序：列表徽标与筛选器都按它排，读者不用在两个地方各认一次顺序。 */
const ORDER: readonly PluginKind[] = ["panel", "theme", "widget", "preset", "task", "command"];

export function pluginKinds(m: Pick<PluginManifest, "contributes">): PluginKind[] {
  const c = m.contributes;
  const has: Record<PluginKind, boolean> = {
    panel: (c.panels?.length ?? 0) > 0,
    theme: (c.themes?.length ?? 0) > 0,
    widget: (c.widgets?.length ?? 0) > 0,
    preset: (c.presets?.length ?? 0) > 0,
    task: (c.tasks?.length ?? 0) > 0,
    command: (c.commands?.length ?? 0) > 0,
  };
  return ORDER.filter((k) => has[k]);
}

/** ≥2 类 = 复合。它不是第七种插件，只是"一枚包装了好几种产物"的读法。 */
export function isComposite(kinds: readonly PluginKind[]): boolean {
  return kinds.length >= 2;
}

export type PluginFilter = "all" | PluginKind | "composite";

/**
 * 筛选器条目的顺序。「预设与模板」在 UI 里是一枚 chip（两件事对用户是同一类"配置"），
 * 所以 `preset` 这个筛选值同时匹配 preset 与 task——判据在 `matchesFilter`，不靠调用方记。
 */
export const FILTERS: readonly PluginFilter[] = ["all", "panel", "theme", "widget", "preset", "command", "composite"];

export function filterLabel(f: PluginFilter): { zh: string; en: string } {
  if (f === "all") return { zh: "全部", en: "All" };
  if (f === "composite") return { zh: "复合", en: "Composite" };
  if (f === "preset") return { zh: "预设与模板", en: "Presets & tasks" };
  return KIND_LABEL[f];
}

export function matchesFilter(kinds: readonly PluginKind[], f: PluginFilter): boolean {
  if (f === "all") return true;
  if (f === "composite") return isComposite(kinds);
  if (f === "preset") return kinds.includes("preset") || kinds.includes("task");
  return kinds.includes(f);
}

/**
 * 列表行上的那枚徽标：`面板 · 命令`。
 *
 * 超过三类别再省略——筛选器里能看全，徽标只负责"扫一眼知道它是什么"。
 */
export function kindSummary(kinds: readonly PluginKind[]): PluginKind[] {
  return kinds.slice(0, 3);
}

/** 一枚插件都没贡献任何东西（只有 main 或什么都没有）：界面上如实说，不留空徽标。 */
export function kindsOrFallback(kinds: readonly PluginKind[]): { zh: string; en: string }[] {
  if (kinds.length) return kinds.map((k) => KIND_LABEL[k]);
  return [{ zh: "无产物", en: "No contributions" }];
}
