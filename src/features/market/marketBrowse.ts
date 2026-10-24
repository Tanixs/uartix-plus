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
import { tx, type Locale } from "../../i18n/strings";
import { autoEnableBlockedCaps, CAP_LABEL, type PluginCap } from "../plugins/pluginManifest";
import {
  categoryLabel, compat, hostAllowed, isBundledPath, isHttpUrl, urlHost, packageOrigin,
  MARKET_BUNDLED_INDEX_URL,
  type InstallState, type MarketEntry, type MarketIndex,
} from "./marketIndex";
// 只引类型：判定与表都在 `marketPending`/`marketInstall`，这一层不认识它们（type-only 边，不进依赖图）
import type { PendingPhase, PendingView } from "./marketPending";
// 同样只引类型：`offShelfOf` 的入/出参带的是**状态枚举本身**，显示名归界面与终端各自渲染
import type { PluginState } from "../plugins/pluginStore";

/**
 * P99b-N5：`appearance` 是"主题那一类的装机面"，不是又一个分类筛选——
 * 判据用**能力** `theme.tokens` 而不是 `entry.category`：分类 id 是作者自填的（未登记也要照实显示），
 * 能力声明才是索引里被对账过的那一项。
 */
export type MarketTab = "discover" | "favorites" | "installed" | "appearance";
export const MARKET_TABS = ["discover", "favorites", "installed", "appearance"] as const;
/**
 * 页签名。**为什么是 `switch` 而不是原来那张 `Record<MarketTab, string>`**：
 * 表在模块求值期就把语言钉死了（切了语言也不重取），而 `tx()` 要在渲染那一刻才读语言；
 * 穷举那条守卫没丢 —— 声明了返回 `string` 又不写 default，少一个取值就是
 * TS2366「Function lacks ending return statement」（反证做过：抽掉一个 case 当场红）。
 */
export function tabLabel(t: MarketTab): string {
  switch (t) {
    case "discover":
      return tx("发现", "Discover");
    case "favorites":
      return tx("收藏", "Favourites");
    case "installed":
      return tx("已装", "Installed");
    case "appearance":
      return tx("外观", "Appearance");
  }
}

export type MarketSort = "updated" | "name" | "category";
export const MARKET_SORTS = ["updated", "name", "category"] as const;
export function sortLabel(s: MarketSort): string {
  switch (s) {
    case "updated":
      return tx("最新更新", "Recently updated");
    case "name":
      return tx("名称", "Name");
    case "category":
      return tx("分类", "Category");
  }
}

/** 「列表 ≠ 背书」只此一份：货架页脚、详情、N6 的帮助第 12 页都引它（引的是这一个函数，不是一句抄本） */
export function marketNoEndorse(): string {
  return tx(
    "列表不等于背书：条目来自当前这份索引，不代表内容安全。装之前看能力清单与来源，装完默认不启用。",
    "Listing is not endorsing: entries come from this index and the content isn't vetted. Check the capability list and the origin before installing, and nothing enables itself after install.",
  );
}

/** C1c 起装包能走了（命令行），N4 起这一页自己也有一颗按钮，所以那句"只能浏览"的旧话已经整条删掉了。 */
export function marketInstallNote(): string {
  return tx(
    "点「安装」= 把它取回并校验，装进来是停用态：还要你去插件库启用才会生效，覆盖本机已有版本的那种会停在右下角那张确认卡上等你点「装入」。",
    "Pressing Install fetches and validates it; it lands disabled — you still enable it in the plugin library. Anything that would overwrite an installed version waits on the confirmation card at the bottom right for you to press Install.",
  );
}

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
  const extra = installs > 1 ? tx(`；这个包还带 ${installs - 1} 项别的东西，会一起装载`, `; this package also carries ${installs - 1} other artifact(s), which load together`) : "";
  switch (state) {
    case "drawn":
      return { state, label: tx("停用", "Disable"), talk: tx(`「${name}」正在画；停用后回到当前选中的内置主题`, `“${name}” is on screen; disabling it returns to the selected built-in theme`), show: true };
    case "enabled-hidden":
      return {
        state,
        label: tx("启用这颗", "Enable this one"),
        talk: tx(`已启用但没在画（现在是「${drawnName ?? "?"}」）；点它会把它换上${extra}`, `Enabled but not on screen (currently “${drawnName ?? "?"}”); clicking swaps it in${extra}`),
        show: true,
      };
    case "installed-off":
      return { state, label: tx("启用这颗", "Enable this one"), talk: tx(`装上后「${name}」会挤掉现在在画的「${drawnName ?? "内置主题"}」${extra}`, `Enabling “${name}” takes over from “${drawnName ?? tx("内置主题", "the built-in theme")}”${extra}`), show: true };
    default:
      return { state, label: "", talk: tx("还没装：先用上面的「装入」按钮，装完默认不启用", "Not installed yet: use the Install button above; it lands disabled"), show: false };
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

export function installLabel(state: InstallState): string {
  switch (state) {
    case "absent":
      return tx("未安装", "Not installed");
    case "same":
      return tx("已装同名版本", "Same version installed");
    case "update":
      return tx("有更新", "Update available");
    case "newer-than-shelf":
      return tx("本机比货架新", "Local is newer than the shelf");
  }
}

export function compatLabel(c: "yes" | "no" | "unknown"): string {
  switch (c) {
    case "yes":
      return tx("与本机版本兼容", "Compatible with this build");
    case "no":
      return tx("要求更高版本", "Requires a newer build");
    case "unknown":
      return tx("未标明适配版本", "No minimum version declared");
  }
}

/** 字节数要能核对，不是"挺小的" */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return tx("未知大小", "unknown size");
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
  return packageOrigin(entry) === "npm"
    ? tx(`npm 官方源 · ${entry.npm!.name}@${entry.npm!.version}`, `npm registry · ${entry.npm!.name}@${entry.npm!.version}`)
    : tx("自建货架直链", "direct link from this shelf");
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
    screenshotHint: shots === 0 ? tx("作者没给预览图", "No preview images from the author") : tx(`${shots} 张预览图`, `${shots} preview image(s)`),
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

/**
 * 按钮的话术全部在**调用那一刻**才翻（`rowFor` 由 `cardAction` 在渲染期调）。
 * 原来这三句是模块级 `const`：import 时就定成中文了，之后切语言也不会重取 —— 和标签表同一个坑。
 */
function noAutoEnable(): string {
  return tx(
    "去插件库启用才会生效：这一步不替你启用，也没有哪条命令能替你点右下角那张卡的「装入」。",
    "It only takes effect once you enable it in the plugin library: this step never enables it for you, and no command can press that card's Install button on your behalf.",
  );
}
function newerHint(): string {
  return tx(
    "货架这条比本机旧，装它等于回退；要退回旧版去插件库的版本历史，那里才有本机留着的那份。",
    "This shelf entry is older than what you have — installing it is a downgrade. Roll back from the plugin library's version history instead; that's where your own copies live.",
  );
}
function cardOnly(): string {
  return tx(
    "动作只在右下角那张确认卡上——这里点不动是有意的：两个入口做同一件事，早晚各说一套。",
    "The action lives on the confirmation card at the bottom right — this button being inert is deliberate: two places doing one thing drift apart eventually.",
  );
}

function rowFor(state: InstallState, version: string): ActionRow {
  const waitingYou = tx("等你在右下角确认", "Waiting for you at the bottom right");
  if (state === "update") {
    return {
      none: { label: tx(`更新到 v${version}`, `Update to v${version}`), enabled: true, tone: "idle", hint: tx("覆盖本机已有版本：点完会停在右下角等你点「装入」，这一页不自己动你的东西", "Overwrites the installed version: pressing it leaves a card at the bottom right for you to confirm — this page never touches your stuff by itself") },
      working: { label: tx("正在取回与校验…", "Fetching and validating…"), enabled: false, tone: "busy", hint: "" },
      awaiting_you: { label: waitingYou, enabled: false, tone: "you", hint: cardOnly() },
      done: { label: tx("已切到新版", "Switched to the new version"), enabled: false, tone: "done", hint: "" },
      failed: { label: tx("重试更新", "Retry update"), enabled: true, tone: "bad", hint: "" },
      rejected: { label: tx(`再更新一次 v${version}`, `Update to v${version} again`), enabled: true, tone: "idle", hint: tx("上一次点的是「不装」，本机没动", "You pressed Don't install last time; nothing changed here") },
    };
  }
  if (state === "absent") {
    return {
      none: { label: tx("安装", "Install"), enabled: true, tone: "idle", hint: tx("装进来是停用态，还要启用才生效", "It lands disabled — enable it for anything to change") },
      working: { label: tx("正在装入…", "Installing…"), enabled: false, tone: "busy", hint: "" },
      // 新装本来不会停在等你确认（内核只在覆盖时停）。真到了这一格就是口径不一致，照实说出来
      awaiting_you: { label: waitingYou, enabled: false, tone: "you", hint: tx(`这一条本来不该停在这儿（只有覆盖已有版本才会等你），${cardOnly()}`, `This one shouldn't be waiting (only overwrites wait for you). ${cardOnly()}`) },
      done: { label: tx("已装（未启用）", "Installed (not enabled)"), enabled: false, tone: "done", hint: "" },
      failed: { label: tx("重试", "Retry"), enabled: true, tone: "bad", hint: "" },
      rejected: { label: tx("再装一次", "Install again"), enabled: true, tone: "idle", hint: "" },
    };
  }
  if (state === "same") {
    return {
      none: { label: installLabel("same"), enabled: false, tone: "idle", hint: tx("货架与本机是同一个版本，没有可装的东西（不重装、不覆盖）", "Same version on the shelf and on this machine — nothing to install (no reinstall, no overwrite)") },
      working: { label: tx("正在处理…", "Working…"), enabled: false, tone: "busy", hint: "" },
      awaiting_you: { label: waitingYou, enabled: false, tone: "you", hint: cardOnly() },
      done: { label: installLabel("same"), enabled: false, tone: "done", hint: noAutoEnable() },
      failed: { label: tx("重试", "Retry"), enabled: true, tone: "bad", hint: "" },
      rejected: { label: installLabel("same"), enabled: false, tone: "idle", hint: "" },
    };
  }
  // newer-than-shelf：任何一相都不给按（界面与内核同向，内核那边叫 downgrade 直接拒）
  return {
    none: { label: tx("不装（本机更新）", "Won't install (local is newer)"), enabled: false, tone: "idle", hint: newerHint() },
    working: { label: tx("正在处理…", "Working…"), enabled: false, tone: "busy", hint: "" },
    awaiting_you: { label: waitingYou, enabled: false, tone: "you", hint: cardOnly() },
    done: { label: tx("不装（本机更新）", "Won't install (local is newer)"), enabled: false, tone: "done", hint: newerHint() },
    failed: { label: tx("不装（本机更新）", "Won't install (local is newer)"), enabled: false, tone: "bad", hint: "" },
    rejected: { label: tx("不装（本机更新）", "Won't install (local is newer)"), enabled: false, tone: "idle", hint: "" },
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
  return count > 0 ? tx(`全部更新 ${count} 条`, `Update all ${count}`) : tx("没有可更新的", "Nothing to update");
}

/** 排完之后的那一句人话（数量都在这算，组件不拼数字） */
export function queueAllLine(plan: QueuePlan): string {
  const bits: string[] = [];
  if (plan.ids.length) bits.push(tx(`已排入 ${plan.ids.length} 条`, `Queued ${plan.ids.length}`));
  if (plan.overCap > 0) bits.push(tx(`表一次装不下，还有 ${plan.overCap} 条没排上（等前面的落地再点一次）`, `the table fits ${plan.ids.length} at a time — ${plan.overCap} left out (click again once these land)`));
  if (plan.skippedInFlight > 0) bits.push(tx(`${plan.skippedInFlight} 条已在途中没重排`, `${plan.skippedInFlight} already in flight, not re-queued`));
  if (!bits.length) bits.push(tx("没有可更新的条目（只处理「有更新」的那几条）", "No entries were updatable (this only handles the ones marked Update available)"));
  return bits.join(tx("；", "; "));
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
  /**
   * 枚举本身，不是显示名。这份数据同时喂 `--json`（机器）与货架页/CLI 终端（人）：
   * 机器契约里放本地化散文，用户一改语言脚本就碎；名字由各自那面渲染
   * （界面 `pluginUiNames.stateName()`，终端 `plugin-cli-core`）。P105-F T3b 顺带纠正的一处。
   */
  state: PluginState;
}

export function offShelfOf(
  index: MarketIndex | null,
  local: readonly { id: string; name: string; version: string; state: PluginState }[],
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
    return { kind: "index-empty", text: tx("这份索引里一条都没有（货架本身是空的，不是你筛没了什么）。", "This index has no entries at all — the shelf is empty, you didn't filter everything away.") };
  }
  if (input.tab === "favorites") {
    const missing = missingFavorites(input.index, input.favorites).length;
    return {
      kind: "no-favorites",
      text: tx(
        `还没有收藏：点卡片右上角的「收藏」即可（货架上有 ${shelf} 条）${missing ? `；另有 ${missing} 条收藏已下架，上方可一键清掉` : ""}。`,
        `Nothing favourited yet — use the Favourite button on a card (${shelf} entries on the shelf)${missing ? `; ${missing} favourite(s) have been delisted, clear them with the button above` : ""}.`,
      ),
    };
  }
  if (input.tab === "installed") {
    return {
      kind: "nothing-installed",
      text: tx(
        `按 id 与本机插件库对照，货架上这 ${shelf} 条都还没装（装过的会在这里，并写明"当前 v / 货架 v"）。`,
        `Matched against your library by id: none of these ${shelf} entries is installed (installed ones show up here with "local v / shelf v").`,
      ),
    };
  }
  if (input.tab === "appearance") {
    return {
      kind: "no-themes",
      text: tx(
        `这份索引里没有声明 ${THEME_CAP} 能力的条目（货架共 ${shelf} 条）——不是被筛掉了，是这类东西本来就没上架。`,
        `No entry in this index declares the ${THEME_CAP} capability (${shelf} entries total) — not filtered out, this kind simply isn't on the shelf.`,
      ),
    };
  }
  const q = input.query.trim();
  const why = [
    q ? tx(`搜索「${q}」`, `query “${q}”`) : "",
    input.category !== "all" && input.index
      ? tx(`分类「${categoryLabel(input.index, input.category)}」`, `category “${categoryLabel(input.index, input.category)}”`)
      : "",
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    kind: "no-match",
    text: tx(
      `按${why || "当前筛选"}没有命中，货架上其实有 ${shelf} 条——换个词或点「全部」取消筛选。`,
      `Nothing matches ${why || "the current filters"}, though the shelf has ${shelf} entries — try another word or press All to clear the filter.`,
    ),
  };
}

/** 详情里的"更新历史"一行：契约只给当前版本，就不假装能列历史。 */
export function versionHistoryText(entry: MarketEntry, ctx: BrowseContext): string {
  const state = ctx.installOf(entry);
  return tx(
    `索引只提供当前版本 v${entry.version}，更早的版本要回来源仓库看。本机：${state === "absent" ? "未装" : installLabel(state)}。`,
    `The index only carries the current version v${entry.version}; older ones live in the source repo. Local: ${state === "absent" ? tx("未装", "not installed") : installLabel(state)}.`,
  );
}

/** 货架状态那一行：走了镜像、耗时、被剔除几条都要读出来（不是"加载成功"就完事） */
export function shelfLine(index: MarketIndex, state: { viaMirror: boolean; elapsedMs: number }): string {
  const parts = [
    tx(`${index.entries.length} 条`, `${index.entries.length} entries`),
    index.dropped.length
      ? tx(`${index.dropped.length} 条被货架剔除`, `${index.dropped.length} dropped by the index`)
      : tx("无剔除条目", "nothing dropped"),
    tx(`生成于 ${index.generatedAt || "未标明"}`, `generated ${index.generatedAt || tx("未标明", "unknown")}`),
    `${(state.elapsedMs / 1000).toFixed(1)} s`,
  ];
  if (state.viaMirror) parts.push(tx("走的镜像", "via mirror"));
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
  if (!v) return rejected("unset", tx("不用镜像：直连取回失败时没有第二条路可走。", "No mirror: if the direct fetch fails there is no second route."));
  if (!isHttpUrl(v)) {
    // `http://…` 与 `//host/…` 看着像地址，但它们会跟着网页走；其余连地址形状都不是
    if (v.includes("://") || v.startsWith("//")) {
      return rejected("not-https", tx(`镜像前缀只走 https（填的是「${v}」），已按不用镜像继续`, `A mirror prefix must be https (“${v}” was entered); continuing without a mirror`));
    }
    return rejected("not-a-url", tx(`镜像前缀不成一个地址（填的是「${v}」），已按不用镜像继续`, `That mirror prefix isn't a URL (“${v}” was entered); continuing without a mirror`));
  }
  const host = urlHost(v);
  if (!host) return rejected("no-host", tx(`镜像前缀解析不出域名（填的是「${v}」），已按不用镜像继续`, `That mirror prefix yields no hostname (“${v}” was entered); continuing without a mirror`));
  if (!hostAllowed(host, allowHosts)) {
    return rejected(
      "host-blocked",
      tx(
        `镜像的域 ${host} 不在放行清单（当前放行：${allowHosts.join("、")}），已按不用镜像继续`,
        `The mirror host ${host} isn't on the allowlist (currently: ${allowHosts.join(", ")}); continuing without a mirror`,
      ),
    );
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
    return {
      ok: false,
      tone: "unset",
      say: tx(`没填：用应用自带的那份示例货架（${MARKET_BUNDLED_INDEX_URL}）。`, `Empty: the app's bundled sample shelf is used (${MARKET_BUNDLED_INDEX_URL}).`),
    };
  }
  if (isBundledPath(v)) {
    return {
      ok: true,
      tone: "bundled",
      say: tx("同源包内文件：打开市场页时向应用自己要，不出网、也不看镜像。", "Same-origin file in the package: the market page asks the app for it — no network, no mirror."),
    };
  }
  if (!isHttpUrl(v)) {
    return {
      ok: false,
      tone: "invalid",
      say: tx(
        "外部索引地址只走 https：http 明文与协议相对地址都会被拒，打开市场页时照实报错。",
        "External index URLs must be https: plain http and protocol-relative URLs are refused, and the market page says so when it opens.",
      ),
    };
  }
  const host = urlHost(v);
  if (!host) {
    return { ok: false, tone: "invalid", say: tx("这个地址解析不出域名，取回那一步会直接失败。", "This URL yields no hostname; the fetch step will fail outright.") };
  }
  if (!hostAllowed(host, allowHosts)) {
    return {
      ok: false,
      tone: "blocked",
      say: tx(
        `域 ${host} 不在放行清单（当前放行：${allowHosts.join("、")}）：打开市场页时会照实报错，不会偷偷改用应用自带的那份。`,
        `Host ${host} isn't on the allowlist (currently: ${allowHosts.join(", ")}): the market page will report the failure instead of quietly falling back to the bundled index.`,
      ),
    };
  }
  return {
    ok: true,
    tone: "remote",
    say: tx(
      `会去 ${host} 取索引：走带白名单的取回通道（https、拒重定向、硬字节上限）。`,
      `The index will be fetched from ${host} through the allowlisted channel (https, no redirects, hard byte cap).`,
    ),
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
    say: tx(
      `直连失败时改从这里取（${urlHost(got.prefix)}${got.slashed ? "；末尾的 / 由我们补上" : ""}）。只换下载来源：内容仍按索引里声明的 sha256 与字节数逐条比对，装前还要过一遍生产校验器。npm 官方源那些条目不走这里——换了域就等于换了信任来源。`,
      `If the direct fetch fails it comes from here instead (${urlHost(got.prefix)}${got.slashed ? "; we append the trailing /" : ""}). Only the download source changes: content is still checked entry by entry against the sha256 and byte count the index declares, and it goes through the production validator before install. npm-registry entries don't use this — changing the host would mean changing who you trust.`,
    ),
  };
}

export function marketEndpointTalk(
  url: string,
  mirror: string,
  allowHosts: readonly string[],
): { index: EndpointTalk; mirror: EndpointTalk } {
  return { index: indexEndpointTalk(url, allowHosts), mirror: mirrorEndpointTalk(mirror, allowHosts) };
}
