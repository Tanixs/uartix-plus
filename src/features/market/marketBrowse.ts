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
import {
  categoryLabel, compat, hostAllowed, isBundledPath, isHttpUrl, urlHost, packageOrigin,
  MARKET_BUNDLED_INDEX_URL,
  type InstallState, type MarketEntry, type MarketIndex,
} from "./marketIndex";
// 只引类型：判定与表都在 `marketPending`/`marketInstall`，这一层不认识它们（type-only 边，不进依赖图）
import type { PendingPhase, PendingView } from "./marketPending";

/**
 * P99b-N5：`appearance` 是"主题那一类的装机面"，不是又一个分类筛选——
 * 判据用**能力** `theme.tokens` 而不是 `entry.category`：分类 id 是作者自填的（未登记也要照实显示），
 * 能力声明才是索引里被对账过的那一项。
 */
export type MarketTab = "discover" | "favorites" | "installed" | "appearance";
export const MARKET_TABS = ["discover", "favorites", "installed", "appearance"] as const;
/** 穷举 Record：加一个页签忘了配名字，编译期就红 */
export const TAB_LABEL: Record<MarketTab, string> = {
  discover: "发现",
  favorites: "收藏",
  installed: "已装",
  appearance: "外观",
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

/** C1c 起装包能走了（命令行），N4 起这一页自己也有一颗按钮，所以那句"只能浏览"的旧话已经整条删掉了。 */
export const MARKET_INSTALL_NOTE =
  "点「安装」= 把它取回并校验，装进来是停用态：还要你去插件库启用才会生效，覆盖本机已有版本的那种会停在右下角那张确认卡上等你点「装入」。";

const BLOCKED_CAPS = new Set<string>(autoEnableBlockedCaps());

/** 「外观」页签的判据，只此一份（inTab 与空态话术共用它，不许一处按分类一处按能力） */
export const THEME_CAP = "theme.tokens";

/**
 * 一条主题在**本机启用面上**的状态（详设 §4②：市场那颗按钮只准调 `pluginStore.setEnabled`，
 * 判定与投影都不重算第二遍）。
 *
 * 三种说法分立，因为它们是三件不同的事：
 *  - `drawn` 这一枚正在画；
 *  - `enabled-hidden` 已启用但没在画（互斥之下被更晚启用的一枚挤掉——存量数据才会有）；
 *  - `installed-off` 装了但停用（市场装完就是这个态，内核不自动启用）。
 */
export type ThemeEnableState = "drawn" | "enabled-hidden" | "installed-off" | "not-installed";

export interface ThemeEnableFacts {
  state: ThemeEnableState;
  /** 按钮那颗的字；`drawn` 时这颗按钮是"停用" */
  label: string;
  /** 点了会发生什么（挤掉谁 / 会不会带回别的产物） */
  talk: string;
  /** 有没有那颗按钮（没装机就没有——一个点了没反应的按钮比没有按钮更糟） */
  show: boolean;
}

export function themeEnableFacts(
  state: ThemeEnableState,
  opts: { name: string; drawnName: string | null; installs: number },
): ThemeEnableFacts {
  const { name, drawnName, installs } = opts;
  const extra = installs > 1 ? `；这个包还带 ${installs - 1} 项别的东西，会一起装载` : "";
  switch (state) {
    case "drawn":
      return { state, label: "停用", talk: `「${name}」正在画；停用后回到当前选中的内置主题`, show: true };
    case "enabled-hidden":
      return {
        state,
        label: "启用这颗",
        talk: `已启用但没在画（现在是「${drawnName ?? "?"}」）；点它会把它换上${extra}`,
        show: true,
      };
    case "installed-off":
      return { state, label: "启用这颗", talk: `装上后「${name}」会挤掉现在在画的「${drawnName ?? "内置主题"}」${extra}`, show: true };
    default:
      return { state, label: "", talk: "还没装：先用上面的「装入」按钮，装完默认不启用", show: false };
  }
}

/** 这一枚主题在本机是什么状态（唯一判据来源，MarketDialog 不许自己算） */
export function themeStateOf(
  installed: { enabled: boolean } | null,
  drawnId: string | null,
  extIdOf: string | null,
): ThemeEnableState {
  if (!installed) return "not-installed";
  if (installed.enabled && extIdOf && extIdOf === drawnId) return "drawn";
  return installed.enabled ? "enabled-hidden" : "installed-off";
}

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
  /** 这一格要不要用警示色（颜色的判断也在层里，组件不许再比一次 `install === "update"`） */
  installWarn: boolean;
  compatible: "yes" | "no" | "unknown";
  compatText: string;
  favorite: boolean;
  grayed: boolean;
  verified: boolean;
  sizeText: string;
  sha12: string;
  /** 这枚字节的出处（自建货架直链 / npm 官方源）——判定在契约层 `packageOrigin`，这里只说人话 */
  origin: string;
  screenshotCount: number;
  screenshotHint: string;
  /** 卡片首图（没有就空串）：由派生层给，组件不许自己去翻 entry.screenshots */
  firstShot: string;
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

/**
 * 一句"这枚字节从哪儿来"（P99c-R2）。判定只有一条（契约层的 `packageOrigin`），这里只说人话。
 * 出处必须写在明面上：自建货架那条直链与 npm 官方源那枚 tarball，用户看到的"同一颗安装按钮"取的是两种东西。
 */
function originText(entry: MarketEntry): string {
  return packageOrigin(entry) === "npm" ? `npm 官方源 · ${entry.npm!.name}@${entry.npm!.version}` : "自建货架直链";
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
    installWarn: install === "update",
    compatible,
    compatText: compatLabel(compatible),
    favorite: ctx.favorites.includes(entry.id),
    // Q5：只有"确认装不上"才灰；字段缺失照实显示
    grayed: compatible === "no",
    verified: entry.verified === true,
    sizeText: formatBytes(entry.bytes),
    sha12: entry.sha256.slice(0, 12),
    origin: originText(entry),
    screenshotCount: shots,
    firstShot: entry.screenshots[0] ?? "",
    // 说「预览图」不说「运行截图」：我们现在给主题的真的是配色预览，写成截图就是文案与内容不符（§8-49）
    screenshotHint: shots === 0 ? "作者没给预览图" : `${shots} 张预览图`,
    caps: capFacts(entry.capabilities),
  };
}

/* ================= P99b-N4：那颗按钮的全部组合 =================
 *
 * 两个独立轴：货架比对（这台机器上有没有它）× 这一次请求走到哪一相。组件里只准问
 * `cardAction(card, pending)` 要一个格子，**不许自己判相**（判一次就多一份真相，§8-48 同族）。
 * 组合表在 `marketBrowse.test` 里 24 格穷举，缺一格就红。
 */

/** 四种语气，theme.css 一一对应（加第五种要连样式一起加，别在组件里凑） */
export type MarketActionTone = "idle" | "busy" | "you" | "done" | "bad";

export interface MarketAction {
  label: string;
  enabled: boolean;
  tone: MarketActionTone;
  /** 按钮下面那句解释。**空串＝把这一次请求自己的原话抬上来**（`PendingView.text`），界面不复述 */
  hint: string;
  /**
   * 这句话要不要贴在按钮旁边（卡片地方小）。一条规则算在层里：
   * **要么按钮点不动（得说为什么），要么这格在出声（busy/等你/收场）**——两种都别让人猜。
   */
  showHint: boolean;
}

type ActionCell = Omit<MarketAction, "showHint">;
type ActionRow = Record<PendingPhase | "none", ActionCell>;

const NO_AUTO_ENABLE = "去插件库启用才会生效：这一步不替你启用，也没有哪条命令能替你点右下角那张卡的「装入」。";
const NEWER_HINT = "货架这条比本机旧，装它等于回退；要退回旧版去插件库的版本历史，那里才有本机留着的那份。";
const CARD_ONLY = "动作只在右下角那张确认卡上——这里点不动是有意的：两个入口做同一件事，早晚各说一套。";

function rowFor(state: InstallState, version: string): ActionRow {
  if (state === "update") {
    return {
      none: { label: `更新到 v${version}`, enabled: true, tone: "idle", hint: "覆盖本机已有版本：点完会停在右下角等你点「装入」，这一页不自己动你的东西" },
      working: { label: "正在取回与校验…", enabled: false, tone: "busy", hint: "" },
      awaiting_you: { label: "等你在右下角确认", enabled: false, tone: "you", hint: CARD_ONLY },
      done: { label: "已切到新版", enabled: false, tone: "done", hint: "" },
      failed: { label: "重试更新", enabled: true, tone: "bad", hint: "" },
      rejected: { label: `再更新一次 v${version}`, enabled: true, tone: "idle", hint: "上一次点的是「不装」，本机没动" },
    };
  }
  if (state === "absent") {
    return {
      none: { label: "安装", enabled: true, tone: "idle", hint: "装进来是停用态，还要启用才生效" },
      working: { label: "正在装入…", enabled: false, tone: "busy", hint: "" },
      // 新装本来不会停在等你确认（内核只在覆盖时停）。真到了这一格就是口径不一致，照实说出来
      awaiting_you: { label: "等你在右下角确认", enabled: false, tone: "you", hint: `这一条本来不该停在这儿（只有覆盖已有版本才会等你），${CARD_ONLY}` },
      done: { label: "已装（未启用）", enabled: false, tone: "done", hint: "" },
      failed: { label: "重试", enabled: true, tone: "bad", hint: "" },
      rejected: { label: "再装一次", enabled: true, tone: "idle", hint: "" },
    };
  }
  if (state === "same") {
    return {
      none: { label: "已装同名版本", enabled: false, tone: "idle", hint: "货架与本机是同一个版本，没有可装的东西（不重装、不覆盖）" },
      working: { label: "正在处理…", enabled: false, tone: "busy", hint: "" },
      awaiting_you: { label: "等你在右下角确认", enabled: false, tone: "you", hint: CARD_ONLY },
      done: { label: "已装同名版本", enabled: false, tone: "done", hint: NO_AUTO_ENABLE },
      failed: { label: "重试", enabled: true, tone: "bad", hint: "" },
      rejected: { label: "已装同名版本", enabled: false, tone: "idle", hint: "" },
    };
  }
  // newer-than-shelf：任何一相都不给按（界面与内核同向，内核那边叫 downgrade 直接拒）
  return {
    none: { label: "不装（本机更新）", enabled: false, tone: "idle", hint: NEWER_HINT },
    working: { label: "正在处理…", enabled: false, tone: "busy", hint: "" },
    awaiting_you: { label: "等你在右下角确认", enabled: false, tone: "you", hint: CARD_ONLY },
    done: { label: "不装（本机更新）", enabled: false, tone: "done", hint: NEWER_HINT },
    failed: { label: "不装（本机更新）", enabled: false, tone: "bad", hint: "" },
    rejected: { label: "不装（本机更新）", enabled: false, tone: "idle", hint: "" },
  };
}

/**
 * 那颗按钮的全部真相。`pending` 是这一条**当前**的请求（没有就 null）；
 * 同一 id 排过几次都不重要，调用方按发起顺序取最新那一枚传进来。
 */
export function cardAction(
  card: Pick<MarketCard, "install" | "version">,
  pending: PendingView | null,
): MarketAction {
  const cell = rowFor(card.install, card.version)[pending ? pending.phase : "none"];
  const hint = cell.hint || pending?.text || "";
  return {
    label: cell.label,
    enabled: cell.enabled,
    tone: cell.tone,
    hint,
    showHint: hint !== "" && (cell.tone !== "idle" || !cell.enabled),
  };
}

/** 入口那颗的徽标：只数「等你确认」那几条，0 就什么都不出（0 也占位就是噪音） */
export function pendingBadge(awaitingCount: number): string {
  return awaitingCount > 0 ? String(awaitingCount) : "";
}

export interface QueuePlan {
  /** 要按 `requestMarketInstall` 排队的 id（顺序＝货架顺序） */
  ids: string[];
  /** 已经在飞或等你确认，所以没重排 */
  skippedInFlight: number;
  /** 不是「有更新」所以不算（未装/同名/本机更新） */
  skippedNotUpdatable: number;
  /** 表装不下、这次没排上的条数（A7：截断必须报数） */
  overCap: number;
}

/**
 * 「全部更新」的排队口径：只排 `install === "update"`，跳过在飞的，一次最多 `cap` 条。
 * 这里**不做任何装包判定**（判定在 `marketInstall`），也**不碰 pending 表**（那是 `marketPending`）——
 * 它只回答"该发几个请求、有几个没排上"。
 */
export function planQueueAllUpdates(
  cards: readonly MarketCard[],
  live: readonly PendingView[],
  cap: number,
): QueuePlan {
  const busy = new Set(live.map((v) => v.entryId));
  const updatable = cards.filter((c) => c.install === "update");
  const waiting = updatable.filter((c) => !busy.has(c.id));
  const room = Math.max(0, cap);
  const ids = waiting.slice(0, room).map((c) => c.id);
  return {
    ids,
    skippedInFlight: updatable.length - waiting.length,
    skippedNotUpdatable: cards.length - updatable.length,
    overCap: waiting.length - ids.length,
  };
}

/** 「全部更新」那颗的名字：点下去会排几条，事先就写在字上 */
export function updateAllLabel(count: number): string {
  return count > 0 ? `全部更新 ${count} 条` : "没有可更新的";
}

/** 排完之后的那一句人话（数量都在这算，组件不拼数字） */
export function queueAllLine(plan: QueuePlan): string {
  const bits: string[] = [];
  if (plan.ids.length) bits.push(`已排入 ${plan.ids.length} 条`);
  if (plan.overCap > 0) bits.push(`表一次装不下，还有 ${plan.overCap} 条没排上（等前面的落地再点一次）`);
  if (plan.skippedInFlight > 0) bits.push(`${plan.skippedInFlight} 条已在途中没重排`);
  if (!bits.length) bits.push("没有可更新的条目（只处理「有更新」的那几条）");
  return bits.join("；");
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
  if (tab === "appearance") return entry.capabilities.includes(THEME_CAP);
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

/**
 * 本机库里有、这份索引却没有的包（P99b-N6：从"三个名字 + 等"扩成一份点得开的清单）。
 *
 * 这一句要守住的口径是**只按 id 对照，不猜哪个对应哪个**：市场看见的只是"这台机器上多出来这几枚"，
 * 不是"它们该不该在架上"。次序按 id 稳定（同一份库两次打开顺序一样，§3-1）。
 */
export interface OffShelfPackage {
  id: string;
  name: string;
  version: string;
  state: string;
}

export function offShelfOf(
  index: MarketIndex | null,
  local: readonly { id: string; name: string; version: string; state: string }[],
): OffShelfPackage[] {
  const shelf = new Set((index?.entries ?? []).map((e) => e.id));
  return local
    .filter((r) => !shelf.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name, "zh"))
    .map((r) => ({ id: r.id, name: r.name, version: r.version, state: r.state }));
}

export interface EmptyFacts {
  kind: "index-empty" | "no-match" | "no-favorites" | "nothing-installed" | "no-themes";
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
  if (input.tab === "appearance") {
    return {
      kind: "no-themes",
      text: `这份索引里没有声明 ${THEME_CAP} 能力的条目（货架共 ${shelf} 条）——不是被筛掉了，是这类东西本来就没上架。`,
    };
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

/* ================= P99b-N6：那两行地址"会不会被用上"的唯一判据 =================
 *
 * 为什么要有这一层：`applyMirror` 判定不合格时只 `console.warn` 然后按"没有镜像"继续，
 * 而 webview 里根本看不见 console ⇒ 用户填了镜像、界面看不出为什么没走（详设 §1-4）。
 * 光补一句 UI 文案不够——**文案自己判一遍就是第二套判定**，两处早晚各说一套（§8-48 同族），
 * 所以这里放判定内核，`applyMirror` 与设置页回显都从它取字。
 */

/**
 * 镜像前缀的判定内核。规范化只有一处：末尾补 `/` 在这里做，界面要说"这个 / 是我们补的"。
 * `reason` 是给界面分色用的机器码，`why` 是给人看的那一句——两者都出自这里，
 * 组件不许再判一次（判一次就是第二套判定，§8-48 同族）。
 * 分成两个臂是为了让"不可用时才有 reason/why"由类型保证，而不是靠调用方记得看 `usable`。
 */
export type MirrorProblem = "unset" | "not-https" | "not-a-url" | "no-host" | "host-blocked";

export type MirrorVerdict =
  | {
      usable: true;
      /** 规范化后的前缀（末尾已补 `/`） */
      prefix: string;
      /** 末尾那个 `/` 是这一层补的（用户没写） */
      slashed: boolean;
    }
  | { usable: false; reason: MirrorProblem; why: string };

const rejected = (reason: MirrorProblem, why: string): MirrorVerdict => ({ usable: false, reason, why });

export function mirrorEndpointVerdict(raw: string, allowHosts: readonly string[]): MirrorVerdict {
  const v = raw.trim();
  if (!v) return rejected("unset", "不用镜像：直连取回失败时没有第二条路可走。");
  if (!isHttpUrl(v)) {
    // `http://…` 与 `//host/…` 看着像地址，但它们会跟着网页走；其余连地址形状都不是
    if (v.includes("://") || v.startsWith("//")) {
      return rejected("not-https", `镜像前缀只走 https（填的是「${v}」），已按不用镜像继续`);
    }
    return rejected("not-a-url", `镜像前缀不成一个地址（填的是「${v}」），已按不用镜像继续`);
  }
  const host = urlHost(v);
  if (!host) return rejected("no-host", `镜像前缀解析不出域名（填的是「${v}」），已按不用镜像继续`);
  if (!hostAllowed(host, allowHosts)) {
    return rejected("host-blocked", `镜像的域 ${host} 不在放行清单（当前放行：${allowHosts.join("、")}），已按不用镜像继续`);
  }
  return { usable: true, prefix: v.endsWith("/") ? v : `${v}/`, slashed: !v.endsWith("/") };
}

/** 一句回显：`ok`＝**这一条填的值会不会真的被用上**（空、被忽略、被拒都算 false） */
export type EndpointTone = "unset" | "bundled" | "remote" | "blocked" | "invalid";

export interface EndpointTalk {
  ok: boolean;
  tone: EndpointTone;
  say: string;
}

/**
 * 索引地址那一行。六支说法对应六种输入，判据与 `refreshIndex` + Rust `market_fetch` 一致：
 * 空值回落到包内那份、同源相对路径不出网、https 要过域白名单，**过不了是报错而不是偷偷回落**
 * （拉不到就照实说拉不到，这是市场从 N1 起的第一条口径）。
 */
export function indexEndpointTalk(raw: string, allowHosts: readonly string[]): EndpointTalk {
  const v = raw.trim();
  if (!v) {
    return { ok: false, tone: "unset", say: `没填：用应用自带的那份示例货架（${MARKET_BUNDLED_INDEX_URL}）。` };
  }
  if (isBundledPath(v)) {
    return { ok: true, tone: "bundled", say: "同源包内文件：打开市场页时向应用自己要，不出网、也不看镜像。" };
  }
  if (!isHttpUrl(v)) {
    return {
      ok: false,
      tone: "invalid",
      say: "外部索引地址只走 https：http 明文与协议相对地址都会被拒，打开市场页时照实报错。",
    };
  }
  const host = urlHost(v);
  if (!host) {
    return { ok: false, tone: "invalid", say: "这个地址解析不出域名，取回那一步会直接失败。" };
  }
  if (!hostAllowed(host, allowHosts)) {
    return {
      ok: false,
      tone: "blocked",
      say: `域 ${host} 不在放行清单（当前放行：${allowHosts.join("、")}）：打开市场页时会照实报错，不会偷偷改用应用自带的那份。`,
    };
  }
  return {
    ok: true,
    tone: "remote",
    say: `会去 ${host} 取索引：走带白名单的取回通道（https、拒重定向、硬字节上限）。`,
  };
}

const MIRROR_TONE: Record<MirrorProblem, EndpointTone> = {
  unset: "unset",
  "not-https": "invalid",
  "not-a-url": "invalid",
  "no-host": "invalid",
  "host-blocked": "blocked",
};

/** 镜像前缀那一行：与 `applyMirror` 同一个内核，所以这里说"会被用上"就是它真的会被用上 */
export function mirrorEndpointTalk(raw: string, allowHosts: readonly string[]): EndpointTalk {
  const got = mirrorEndpointVerdict(raw, allowHosts);
  if (!got.usable) return { ok: false, tone: MIRROR_TONE[got.reason], say: got.why };
  return {
    ok: true,
    tone: "remote",
    say: `直连失败时改从这里取（${urlHost(got.prefix)}${got.slashed ? "；末尾的 / 由我们补上" : ""}）。只换下载来源：内容仍按索引里声明的 sha256 与字节数逐条比对，装前还要过一遍生产校验器。npm 官方源那些条目不走这里——换了域就等于换了信任来源。`,
  };
}

export function marketEndpointTalk(
  url: string,
  mirror: string,
  allowHosts: readonly string[],
): { index: EndpointTalk; mirror: EndpointTalk } {
  return { index: indexEndpointTalk(url, allowHosts), mirror: mirrorEndpointTalk(mirror, allowHosts) };
}
