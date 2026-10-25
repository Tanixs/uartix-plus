/**
 * P174-B4：插件变更日志（append-only）与「可从日志重建」的校验。
 *
 * 为什么要有它：账本（index/trust）记的是"现在是什么"，一旦被手改、被别的程序截断、
 * 被某次写失败弄丢一半，界面只能说"对不上"，说不出**哪一步**对不上。变更日志记的是
 * "发生过什么"：装了什么版本、谁点了启用、什么时候换了主题。把它从头重放一遍，
 * 应当得到与当前账本**逐字段相同**的状态——对不上，就说明磁盘被人动过，或者某条写路径忘了记账。
 *
 * 三条边界：
 * 1. **只追加**。除封顶折叠（把已发生的事实并进新的起点快照）外，不改写历史事件；
 * 2. 日志**不是**执行来源。加载时以账本为准，日志只用于核对（重建是判据，不是启动路径）；
 * 3. 命令执行也记一条（`command`），但它不改变账本状态——重建时跳过，只作审计。
 *
 * 判据全在这个文件里（纯函数），IO 在 `store.ts` / `pluginEngine.ts`。
 */

import { ROOT_SPEC_RE } from "./manifest";
import type { PluginIndex, PluginIndexItem, TrustBook, TrustRecord } from "./repo";

export const JOURNAL_VERSION = 1;

/**
 * 事件上限。超过就折叠一次：把当前状态算成新的起点快照，事件清零重来。
 * 不设上限的话，一个天天切主题的用户会把账本目录养成一个无限增长的文件；
 * 而"折叠后再也重建不出来"是不可接受的——折叠本身就是一次重放，事实一条没丢。
 */
export const JOURNAL_MAX_EVENTS = 500;

/** 插件在日志里的样子（去掉绝对路径这类环境事实，目录由 id 推出）。 */
export interface JournalIndexItem {
  version: string;
  digest: string;
  installedAt: number;
  source: PluginIndexItem["source"];
  enabled: boolean;
  origin?: string;
}

/** 信任记录在日志里的样子：批准证据要能逐字复现，不能只留摘要。 */
export interface JournalTrustItem {
  version: string;
  digest: string;
  grantedAt: number;
  grantedSummary: string[];
}

/** 一份可直接与 `index + trust + activeTheme` 对照的逻辑状态。 */
export interface JournalState {
  index: Record<string, JournalIndexItem>;
  trust: Record<string, JournalTrustItem>;
  activeTheme: string;
}

export type JournalEvent =
  | { t: "install"; at: number; id: string; item: JournalIndexItem; trust?: JournalTrustItem }
  | { t: "uninstall"; at: number; id: string }
  | { t: "enable"; at: number; id: string }
  | { t: "disable"; at: number; id: string }
  | { t: "theme"; at: number; key: string }
  | { t: "approve"; at: number; id: string; trust: JournalTrustItem }
  /** 只审计，不改变状态。`ok` 是"这次执行有没有结果"，不是"插件逻辑成不成功"。 */
  | { t: "command"; at: number; id: string; command: string; ok: boolean }
  /** 工作场景的应用/回退：只审计，状态变化由上面的 enable/disable/theme 等事件负责。 */
  | { t: "profile"; at: number; id: string; name: string; action: "apply" | "revert" }
  /**
   * R7③：一次目录绑定（`$WS` 或 `$EXT:<key>` → 某个绝对路径）。
   *
   * 为什么值得进账本：绑定表是进程写笼子的来源，"谁在什么时候把哪个目录给了哪个插件"
   * 与"谁批准了哪一版权限"是同一类的决定。只审计——绑定不在 index/trust 里，
   * 它在 `settings` 账本里，重建不靠事件恢复它（靠事件恢复一份有两个落点的状态才是错）。
   */
  | { t: "root"; at: number; id: string; spec: string; path: string; forWrite: boolean };

export interface JournalBaseline {
  at: number;
  state: JournalState;
}

export interface JournalBook {
  version: number;
  baseline?: JournalBaseline;
  events: JournalEvent[];
}

/* ============================ 组装与重放 ============================ */

export function emptyJournalState(): JournalState {
  return { index: {}, trust: {}, activeTheme: "" };
}

export function journalIndexItemOf(item: PluginIndexItem): JournalIndexItem {
  return {
    version: item.version,
    digest: item.digest,
    installedAt: item.installedAt,
    source: item.source,
    enabled: item.enabled,
    ...(item.origin ? { origin: item.origin } : {}),
  };
}

export function journalTrustItemOf(rec: TrustRecord): JournalTrustItem {
  return {
    version: rec.version,
    digest: rec.digest,
    grantedAt: rec.grantedAt,
    grantedSummary: [...rec.grantedSummary],
  };
}

/**
 * 安装事件。`trust` 只在**这次真的写了信任库**时给（`applyInstall` 的判据：
 * 权限面与上次批准的一致就不重写，`grantedAt` 不能被悄悄改成今天）。
 */
export function installJournalEvent(
  id: string,
  item: PluginIndexItem,
  trust: TrustRecord | undefined,
  at: number,
): JournalEvent {
  return {
    t: "install",
    at,
    id,
    item: journalIndexItemOf(item),
    ...(trust ? { trust: journalTrustItemOf(trust) } : {}),
  };
}

export function approveJournalEvent(rec: TrustRecord): JournalEvent {
  return { t: "approve", at: rec.grantedAt, id: rec.id, trust: journalTrustItemOf(rec) };
}

/** 把账本投影成可重放的状态。日志只记逻辑事实，不记 `dir` 这类环境事实。 */
export function toJournalState(index: PluginIndex, trust: TrustBook, activeTheme: string): JournalState {
  const out = emptyJournalState();
  for (const [id, item] of Object.entries(index.items)) out.index[id] = journalIndexItemOf(item);
  for (const [id, rec] of Object.entries(trust.items)) out.trust[id] = journalTrustItemOf(rec);
  out.activeTheme = activeTheme;
  return out;
}

function cloneState(s: JournalState): JournalState {
  const out = emptyJournalState();
  for (const [id, item] of Object.entries(s.index)) out.index[id] = { ...item };
  for (const [id, rec] of Object.entries(s.trust)) out.trust[id] = { ...rec, grantedSummary: [...rec.grantedSummary] };
  out.activeTheme = s.activeTheme;
  return out;
}

function applyEvent(s: JournalState, ev: JournalEvent): void {
  switch (ev.t) {
    case "install":
      s.index[ev.id] = { ...ev.item };
      // 没带 trust = 这次没写信任库，账上原来那条（同一份权限面的批准）继续有效。
      if (ev.trust) s.trust[ev.id] = { ...ev.trust, grantedSummary: [...ev.trust.grantedSummary] };
      return;
    case "uninstall":
      delete s.index[ev.id];
      delete s.trust[ev.id];
      return;
    case "enable":
    case "disable": {
      // 账本里没有的 id 不会产生这两种事件（`setEnabled` 在入口就返回了）。
      // 真出现了也只认账本——重建不是"凭日志造一个插件"。
      const cur = s.index[ev.id];
      if (cur) s.index[ev.id] = { ...cur, enabled: ev.t === "enable" };
      return;
    }
    case "theme":
      s.activeTheme = ev.key;
      return;
    case "approve":
      s.trust[ev.id] = { ...ev.trust, grantedSummary: [...ev.trust.grantedSummary] };
      return;
    case "command":
      return;
    case "profile":
      return;
    case "root":
      // 绑定不在 index/trust 里（它在 settings 账本），重放时没有状态可改
      return;
  }
}

/** 从起点快照 + 全部事件重放出逻辑状态。不改动入参。 */
export function rebuildFromJournal(book: JournalBook): JournalState {
  const state = book.baseline ? cloneState(book.baseline.state) : emptyJournalState();
  for (const ev of book.events) applyEvent(state, ev);
  return state;
}

export function createJournalBook(state: JournalState, at: number): JournalBook {
  return { version: JOURNAL_VERSION, baseline: { at, state: cloneState(state) }, events: [] };
}

export function appendJournalEvent(
  book: JournalBook | null,
  ev: JournalEvent,
  max = JOURNAL_MAX_EVENTS,
): JournalBook {
  const cur: JournalBook =
    book && book.version === JOURNAL_VERSION ? book : { version: JOURNAL_VERSION, events: [] };
  const merged = [...cur.events, ev];
  if (merged.length <= Math.max(1, max)) {
    return {
      version: JOURNAL_VERSION,
      ...(cur.baseline ? { baseline: cur.baseline } : {}),
      events: merged,
    };
  }
  // 折叠：已发生的事实一条不丢地并进起点，再把新事件接在空日志后面。
  return {
    version: JOURNAL_VERSION,
    baseline: { at: ev.at, state: rebuildFromJournal(cur) },
    events: [ev],
  };
}

/* ============================ 校验 ============================ */

const INDEX_FIELDS: { key: keyof JournalIndexItem; label: string }[] = [
  { key: "version", label: "版本" },
  { key: "digest", label: "权限摘要" },
  { key: "installedAt", label: "安装时间" },
  { key: "source", label: "来源" },
  { key: "enabled", label: "启用状态" },
  { key: "origin", label: "来源标记" },
];

function show(v: unknown): string {
  return v === undefined ? "无" : JSON.stringify(v);
}

/**
 * 重建结果与当前账本的逐字段比对。
 *
 * 返回人话而不是布尔：这条消息会进插件面板的 issues，用户得知道是**哪个插件的哪一格**对不上。
 * 超过 8 条就截断——一次坏账可能同时差几十格，把面板刷满等于什么也没说。
 */
export function verifyJournal(book: JournalBook, actual: JournalState): string[] {
  const rebuilt = rebuildFromJournal(book);
  const issues: string[] = [];
  const prefix = "变更日志与账本对不上";

  for (const id of new Set([...Object.keys(rebuilt.index), ...Object.keys(actual.index)])) {
    const a = rebuilt.index[id];
    const b = actual.index[id];
    if (!a || !b) {
      issues.push(`${prefix}：插件「${id}」${a ? "账本里没有，日志里却有" : "在账本里，日志里没有"}`);
      continue;
    }
    for (const { key, label } of INDEX_FIELDS) {
      if (a[key] !== b[key]) {
        issues.push(`${prefix}：插件「${id}」的${label} 日志=${show(a[key])} / 账本=${show(b[key])}`);
      }
    }
  }

  for (const id of new Set([...Object.keys(rebuilt.trust), ...Object.keys(actual.trust)])) {
    const a = rebuilt.trust[id];
    const b = actual.trust[id];
    if (!a || !b) {
      issues.push(`${prefix}：信任记录「${id}」${a ? "账本里没有，日志里却有" : "在日志里没有，账本里却有"}`);
      continue;
    }
    if (a.version !== b.version) {
      issues.push(`${prefix}：信任记录「${id}」的版本 日志=${show(a.version)} / 账本=${show(b.version)}`);
    }
    if (a.digest !== b.digest) issues.push(`${prefix}：信任记录「${id}」的权限摘要不同`);
    if (a.grantedAt !== b.grantedAt) {
      issues.push(`${prefix}：信任记录「${id}」的批准时间 日志=${show(a.grantedAt)} / 账本=${show(b.grantedAt)}`);
    }
    if (a.grantedSummary.join("\n") !== b.grantedSummary.join("\n")) {
      issues.push(`${prefix}：信任记录「${id}」的批准范围不同`);
    }
  }

  if (rebuilt.activeTheme !== actual.activeTheme) {
    issues.push(
      `${prefix}：当前主题 日志=${show(rebuilt.activeTheme)} / 设置=${show(actual.activeTheme)}`,
    );
  }

  if (issues.length > 8) return [...issues.slice(0, 8), `${prefix}：还有 ${issues.length - 8} 处差异未列出`];
  return issues;
}

/* ============================ 归一（磁盘上的普通 JSON） ============================ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SOURCES: readonly string[] = ["market", "local", "ai", "import"];

function normalizeIndexItem(raw: unknown): JournalIndexItem | null {
  if (!isObj(raw)) return null;
  if (typeof raw.version !== "string" || typeof raw.digest !== "string") return null;
  return {
    version: raw.version,
    digest: raw.digest,
    installedAt: typeof raw.installedAt === "number" ? raw.installedAt : 0,
    source: SOURCES.includes(raw.source as string) ? (raw.source as PluginIndexItem["source"]) : "import",
    enabled: raw.enabled !== false,
    ...(typeof raw.origin === "string" && raw.origin ? { origin: raw.origin } : {}),
  };
}

function normalizeTrustItem(raw: unknown): JournalTrustItem | null {
  if (!isObj(raw)) return null;
  if (typeof raw.version !== "string" || typeof raw.digest !== "string" || !raw.digest) return null;
  return {
    version: raw.version,
    digest: raw.digest,
    grantedAt: typeof raw.grantedAt === "number" ? raw.grantedAt : 0,
    grantedSummary: Array.isArray(raw.grantedSummary)
      ? raw.grantedSummary.filter((s): s is string => typeof s === "string")
      : [],
  };
}

function normalizeState(raw: unknown): JournalState | null {
  if (!isObj(raw) || !isObj(raw.index) || !isObj(raw.trust)) return null;
  const out = emptyJournalState();
  for (const [id, item] of Object.entries(raw.index)) {
    const norm = normalizeIndexItem(item);
    if (norm) out.index[id] = norm;
  }
  for (const [id, rec] of Object.entries(raw.trust)) {
    const norm = normalizeTrustItem(rec);
    if (norm) out.trust[id] = norm;
  }
  out.activeTheme = typeof raw.activeTheme === "string" ? raw.activeTheme : "";
  return out;
}

function normalizeEvent(raw: unknown, pos: number, issues: string[]): JournalEvent | null {
  const bad = (why: string): null => {
    issues.push(`变更日志第 ${pos + 1} 条事件${why}，已跳过（重建校验会因此报差异）`);
    return null;
  };
  if (!isObj(raw)) return bad("不是对象");
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return bad("缺时间");
  if (typeof raw.t !== "string") return bad("缺类型");
  const at = raw.at;

  switch (raw.t) {
    case "install": {
      if (typeof raw.id !== "string" || !raw.id) return bad("缺插件 id");
      const item = normalizeIndexItem(raw.item);
      if (!item) return bad("的条目形状不对");
      if (raw.trust === undefined) return { t: "install", at, id: raw.id, item };
      const trust = normalizeTrustItem(raw.trust);
      if (!trust) return bad("的信任记录形状不对");
      return { t: "install", at, id: raw.id, item, trust };
    }
    case "uninstall":
    case "enable":
    case "disable":
      if (typeof raw.id !== "string" || !raw.id) return bad("缺插件 id");
      return { t: raw.t, at, id: raw.id };
    case "theme":
      if (typeof raw.key !== "string") return bad("缺主题键");
      return { t: "theme", at, key: raw.key };
    case "approve": {
      if (typeof raw.id !== "string" || !raw.id) return bad("缺插件 id");
      const trust = normalizeTrustItem(raw.trust);
      if (!trust) return bad("的信任记录形状不对");
      return { t: "approve", at, id: raw.id, trust };
    }
    case "command":
      if (typeof raw.id !== "string" || !raw.id) return bad("缺插件 id");
      if (typeof raw.command !== "string" || !raw.command) return bad("缺命令 id");
      if (typeof raw.ok !== "boolean") return bad("缺执行结果");
      return { t: "command", at, id: raw.id, command: raw.command, ok: raw.ok };
    case "profile":
      if (typeof raw.id !== "string" || !raw.id) return bad("缺场景 id");
      if (typeof raw.name !== "string" || !raw.name) return bad("缺场景名");
      if (raw.action !== "apply" && raw.action !== "revert") return bad("缺场景动作");
      return { t: "profile", at, id: raw.id, name: raw.name, action: raw.action };
    case "root":
      // `id` 允许是空串：设置页与场景改动没有"请求方插件"，那也是一条要能回放的绑定
      if (typeof raw.id !== "string") return bad("缺请求方 id");
      if (typeof raw.spec !== "string" || !ROOT_SPEC_RE.test(raw.spec)) return bad("的路径变量形状不对");
      if (typeof raw.path !== "string") return bad("缺目录路径");
      if (typeof raw.forWrite !== "boolean") return bad("缺写权限标记");
      return { t: "root", at, id: raw.id, spec: raw.spec, path: raw.path, forWrite: raw.forWrite };
    default:
      return bad(`的类型「${raw.t}」不认识`);
  }
}

/**
 * 归一。**读不懂就返回 null**（调用方按当前账本重新起底），并说清楚为什么——
 * 半懂不懂地留一部分事件，会让重建校验报出一串与真正原因无关的差异。
 */
export function normalizeJournal(raw: unknown): { journal: JournalBook | null; issues: string[] } {
  const issues: string[] = [];
  if (raw === null || raw === undefined) return { journal: null, issues };
  if (!isObj(raw)) {
    return { journal: null, issues: ["变更日志不是预期形状，已按当前账本重新起底"] };
  }
  if (raw.version !== JOURNAL_VERSION) {
    return {
      journal: null,
      issues: [`变更日志版本是 ${show(raw.version)}，当前只认 ${JOURNAL_VERSION}，已按当前账本重新起底`],
    };
  }
  if (!Array.isArray(raw.events)) {
    return { journal: null, issues: ["变更日志缺事件表，已按当前账本重新起底"] };
  }

  let baseline: JournalBaseline | undefined;
  if (raw.baseline !== undefined) {
    if (!isObj(raw.baseline)) {
      return { journal: null, issues: ["变更日志的起点快照不是对象，已按当前账本重新起底"] };
    }
    const state = normalizeState(raw.baseline.state);
    if (!state) {
      return { journal: null, issues: ["变更日志的起点快照读不出来，已按当前账本重新起底"] };
    }
    baseline = { at: typeof raw.baseline.at === "number" ? raw.baseline.at : 0, state };
  }

  const events: JournalEvent[] = [];
  raw.events.forEach((e, i) => {
    const ev = normalizeEvent(e, i, issues);
    if (ev) events.push(ev);
  });
  return { journal: { version: JOURNAL_VERSION, ...(baseline ? { baseline } : {}), events }, issues };
}
