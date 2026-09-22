/**
 * P99b-N2：市场浏览的**派生层**（纯函数）。
 *
 * 为什么单独一个文件：卡片上每一个字都必须能指回索引里的某个字段。
 * 筛选/排序/文案放进组件就没法测，而市场页最坏的失败模式正是
 * **界面显示的比货架上有的多**——用户会把它当事实。
 *
 * 三条口径写死在这里：
 *  1. 未登记的分类照实显示 id（不塞进别的桶、也不藏条目），与 `categoryLabel` 同源；
 *  2. **只有"确认装不上"才灰显**（Q5）：`minAppVersion` 缺/格式怪一律 `unknown`，照实排在前面；
 *  3. 空态**四种说法分立**：共用一张"暂无内容"等于骗人——"货架是空的"与"你筛没了"是两件事。
 */
import type { Locale } from "../../i18n/strings";
import { autoEnableBlockedCaps, CAP_LABEL, type PluginCap } from "../plugins/pluginManifest";
import { categoryLabel, compat, type InstallState, type MarketEntry, type MarketIndex } from "./marketIndex";

export type MarketTab = "discover" | "favorites" | "installed";
export const MARKET_TABS = ["discover", "favorites", "installed"] as const;
/** 穷举 Record：加一个页签忘了配名字，编译期就红 */
export const TAB_LABEL: Record<MarketTab, string> = {
  discover: "发现",
  favorites: "收藏",
  installed: "已装",
};

export type MarketSort = "updated" | "name" | "category";
export const MARKET_SORTS = ["updated", "name", "category"] as const;
export const SORT_LABEL: Record<MarketSort, string> = {
  updated: "最新更新",
  name: "名称",
  category: "分类",
};

/** 「列表 ≠ 背书」只此一份：货架页脚、详情、N6 的帮助第 12 页都引它 */
export const MARKET_NO_ENDORSE =
  "列表不等于背书：条目来自当前这份索引，不代表内容安全。装之前看能力清单与来源，装完默认不启用。";

/** N2 只到"看得清"，安装链在 N4 接通。这句话现在是真的；N4 要删掉它，而不是留着说谎。 */
export const MARKET_BROWSE_ONLY =
  "本页当前只浏览与收藏：下载与安装还没接通，所以卡片上没有安装按钮（没有按钮，比一个点了没反应的按钮诚实）。";

const BLOCKED_CAPS = new Set<string>(autoEnableBlockedCaps());

export interface BrowseContext {
  /** 描述取哪一语：跟界面语言走，缺另一种就回落（不猜、不替作者补写） */
  lang: Locale;
  appVersion: string;
  favorites: readonly string[];
  installOf: (entry: MarketEntry) => InstallState;
}

const INSTALL_LABEL: Record<InstallState, string> = {
  absent: "未安装",
  same: "已装同名版本",
  update: "有更新",
  "newer-than-shelf": "本机比货架新",
};

const COMPAT_LABEL: Record<"yes" | "no" | "unknown", string> = {
  yes: "与本机版本兼容",
  no: "要求更高版本",
  unknown: "未标明适配版本",
};

export function installLabel(state: InstallState): string {
  return INSTALL_LABEL[state];
}

export function compatLabel(c: "yes" | "no" | "unknown"): string {
  return COMPAT_LABEL[c];
}

/** 字节数要能核对，不是"挺小的" */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "未知大小";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** 一张卡片要显示的全部内容——每个字段都从条目/索引派生，不接收手抄常量。 */
export interface MarketCard {
  id: string;
  name: string;
  author: string;
  categoryId: string;
  category: string;
  version: string;
  updated: string;
  description: string;
  otherLangDescription: string;
  install: InstallState;
  installText: string;
  compatible: "yes" | "no" | "unknown";
  compatText: string;
  favorite: boolean;
  grayed: boolean;
  verified: boolean;
  sizeText: string;
  sha12: string;
  screenshotCount: number;
  screenshotHint: string;
  caps: { id: string; name: string; note: string; blocked: boolean }[];
}

export function pickDescription(entry: MarketEntry, lang: Locale): { text: string; other: string } {
  const zh = entry.description.zh;
  const en = entry.description.en ?? "";
  if (lang === "en") return { text: en || zh, other: en ? zh : "" };
  return { text: zh, other: en };
}

/**
 * 能力角标的派生（中文名与"不会自动生效"标记都引插件白名单那一份）。
 * 卡片、详情、装链确认框三处共用——**装包要点名的能力与货架上显示的不是两张表**（§6-3）。
 */
export function capFacts(caps: readonly string[]): { id: string; name: string; note: string; blocked: boolean }[] {
  return caps.map((c) => {
    const label = CAP_LABEL[c as PluginCap];
    return { id: c, name: label.name, note: label.note, blocked: BLOCKED_CAPS.has(c) };
  });
}

export function cardFacts(index: MarketIndex, entry: MarketEntry, ctx: BrowseContext): MarketCard {
  const { text, other } = pickDescription(entry, ctx.lang);
  const install = ctx.installOf(entry);
  const compatible = compat(entry, ctx.appVersion);
  const shots = entry.screenshots.length;
  return {
    id: entry.id,
    name: entry.name,
    author: entry.author,
    categoryId: entry.category,
    category: categoryLabel(index, entry.category),
    version: entry.version,
    updated: entry.updated,
    description: text,
    otherLangDescription: other,
    install,
    installText: installLabel(install),
    compatible,
    compatText: compatLabel(compatible),
    favorite: ctx.favorites.includes(entry.id),
    // Q5：只有"确认装不上"才灰；字段缺失照实显示
    grayed: compatible === "no",
    verified: entry.verified === true,
    sizeText: formatBytes(entry.bytes),
    sha12: entry.sha256.slice(0, 12),
    screenshotCount: shots,
    screenshotHint: shots === 0 ? "作者没给截图" : `${shots} 张截图`,
    caps: capFacts(entry.capabilities),
  };
}

export interface BrowseInput extends BrowseContext {
  index: MarketIndex | null;
  tab: MarketTab;
  query: string;
  /** "all" 或某个分类 id */
  category: string;
  sort: MarketSort;
}

function matchesQuery(index: MarketIndex, entry: MarketEntry, q: string): boolean {
  if (!q) return true;
  return [
    entry.name,
    entry.id,
    entry.author,
    entry.description.zh,
    entry.description.en ?? "",
    categoryLabel(index, entry.category),
    entry.category,
  ]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

function inTab(entry: MarketEntry, tab: MarketTab, ctx: BrowseContext): boolean {
  if (tab === "favorites") return ctx.favorites.includes(entry.id);
  if (tab === "installed") return ctx.installOf(entry) !== "absent";
  return true;
}

/** 次序必须可复现：同值一律以 id 收尾，否则同一份货架两次打开顺序不同（§3-1 同族） */
function compareBy(sort: MarketSort, index: MarketIndex) {
  return (a: MarketEntry, b: MarketEntry): number => {
    const byKey =
      sort === "updated"
        ? b.updated.localeCompare(a.updated)
        : sort === "name"
          ? a.name.localeCompare(b.name, "zh")
          : categoryLabel(index, a.category).localeCompare(categoryLabel(index, b.category), "zh")
            || a.name.localeCompare(b.name, "zh");
    return byKey || a.id.localeCompare(b.id);
  };
}

/** 页签 + 搜索之后的条目（**不含**分类筛选）：分类计数要用它，不然筛完别的桶全变 0，看着像坏了 */
export function tabEntries(input: BrowseInput): MarketEntry[] {
  const index = input.index;
  if (!index) return [];
  const q = input.query.trim().toLowerCase();
  return index.entries.filter((e) => inTab(e, input.tab, input) && matchesQuery(index, e, q));
}

export function browseEntries(input: BrowseInput): MarketEntry[] {
  const index = input.index;
  if (!index) return [];
  const list = tabEntries(input);
  const filtered = input.category === "all" ? list : list.filter((e) => e.category === input.category);
  return [...filtered].sort(compareBy(input.sort, index));
}

/** 分类筹码：登记过的 ＋ 条目里出现但没登记的（标签回落 id）；有内容的排前面 */
export function facetCategories(index: MarketIndex, scope: readonly MarketEntry[]): { id: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of scope) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const ids = new Set<string>([...Object.keys(index.categories), ...counts.keys()]);
  return [...ids]
    .map((id) => ({ id, label: categoryLabel(index, id), count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh"));
}

/** 收藏里已经不在货架上的：照实列出来，一键清（不静默删用户的收藏） */
export function missingFavorites(index: MarketIndex | null, favorites: readonly string[]): string[] {
  const onShelf = new Set((index?.entries ?? []).map((e) => e.id));
  return favorites.filter((id) => !onShelf.has(id));
}

export interface EmptyFacts {
  kind: "index-empty" | "no-match" | "no-favorites" | "nothing-installed";
  text: string;
}

/**
 * 四种空态四种说法（详设 §5.2 明令不许共用）。每条都带**该带的数**：
 * 货架几条 / 命中条件是什么 / 收藏里下架几条，用户据此一眼分清"没东西"与"我没看见"。
 */
export function emptyTalk(input: BrowseInput, visibleCount: number): EmptyFacts | null {
  if (visibleCount > 0) return null;
  const shelf = input.index?.entries.length ?? 0;
  if (shelf === 0) {
    return { kind: "index-empty", text: "这份索引里一条都没有（货架本身是空的，不是你筛没了什么）。" };
  }
  if (input.tab === "favorites") {
    const missing = missingFavorites(input.index, input.favorites).length;
    return {
      kind: "no-favorites",
      text: `还没有收藏：点卡片右上角的「收藏」即可（货架上有 ${shelf} 条）${missing ? `；另有 ${missing} 条收藏已下架，上方可一键清掉` : ""}。`,
    };
  }
  if (input.tab === "installed") {
    return { kind: "nothing-installed", text: `按 id 与本机插件库对照，货架上这 ${shelf} 条都还没装（装过的会在这里，并写明"当前 v / 货架 v"）。` };
  }
  const q = input.query.trim();
  const why = [
    q ? `搜索「${q}」` : "",
    input.category !== "all" && input.index ? `分类「${categoryLabel(input.index, input.category)}」` : "",
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    kind: "no-match",
    text: `按${why || "当前筛选"}没有命中，货架上其实有 ${shelf} 条——换个词或点「全部」取消筛选。`,
  };
}

/** 详情里的"更新历史"一行：契约只给当前版本，就不假装能列历史。 */
export function versionHistoryText(entry: MarketEntry, ctx: BrowseContext): string {
  const state = ctx.installOf(entry);
  return `索引只提供当前版本 v${entry.version}，更早的版本要回来源仓库看。本机：${state === "absent" ? "未装" : installLabel(state)}。`;
}

/** 货架状态那一行：走了镜像、耗时、被剔除几条都要读出来（不是"加载成功"就完事） */
export function shelfLine(index: MarketIndex, state: { viaMirror: boolean; elapsedMs: number }): string {
  const parts = [
    `${index.entries.length} 条`,
    index.dropped.length ? `${index.dropped.length} 条被货架剔除` : "无剔除条目",
    `生成于 ${index.generatedAt || "未标明"}`,
    `${(state.elapsedMs / 1000).toFixed(1)} s`,
  ];
  if (state.viaMirror) parts.push("走的镜像");
  return parts.join(" · ");
}
