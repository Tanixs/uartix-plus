/**
 * P99c-C1c：装包请求的那张**异步小表**（命令行发起，应用内落地）。
 *
 * 为什么不复用 P91 的 jobs 任务面（这是本批最关键的一条判断）：
 * `create_job` **本身就在 MCP 工具清单里**（`mcpTools.ts:150`），而任务类型的真正门禁是
 * Rust `bridge_jobs.rs` 里 `prepare()` 的显式白名单——`taskType` 那个 enum 只是发给客户端的
 * JSON Schema，服务端不校验。所以往 `prepare()` 里加一种"取回外部代码"的类型，
 * **等于给模型开一条它本来够不到的路**（Q7：陌生人的代码进本机由人批准）。
 * 于是慢的一半留在这里，走 `cli.` 那族——它已被两条相反的钉证明模型进不来
 * （`ALL_TOOL_DEFS` 里没有 `cli.`；`plugin-cli` 只发 `cli.`）。
 *
 * 与 jobs 平面并存的是**两份"活跑到哪一步"的簿子**，不是两份安装判定：判定只有 `marketInstall` 一处。
 * 表里的东西一律**不落盘**：重启后没点完的安装不该假装记得。
 */
import { getPlugin } from "../plugins/pluginStore";
import { applyMarketStage, describePlan, planMarketInstall, stageMarketPlan, type StagedHandle } from "./marketInstall";
import type { InstallCode, MarketEntry } from "./marketIndex";
import { getMarketSnapshot } from "./marketStore";

/** 表最多留这么几条（超了淘汰最旧的，淘汰要说出来而不是静默丢）。界面排队也要按这个数报"还剩几条没排" */
export const PENDING_CAP = 8;
const CAP = PENDING_CAP;
/** 等确认的窗口：过期就作废，不无限占着候选 */
const TTL_MS = 10 * 60 * 1000;

export type PendingPhase = "working" | "awaiting_you" | "done" | "failed" | "rejected";

/** 状态机自己的码 + 内核透传的码（后者的中文说法在契约层 `marketIndex.INSTALL_CODE_ZH`，AI 时间线的徽章按它渲染） */
export type PendingCode = InstallCode | "no_entry" | "no_index" | "expired" | "not_awaiting" | "internal";

export interface PendingView {
  token: string;
  entryId: string;
  phase: PendingPhase;
  /** 给终端与人看的那句中文状态（单源在这里，CLI 只照印） */
  phaseText: string;
  /** 这次请求会碰到什么／最后怎么收场——成功路径来自 `describePlan` */
  text: string;
  code: PendingCode | "";
  createdAt: number;
  expiresAt: number;
}

interface Rec {
  token: string;
  entryId: string;
  phase: PendingPhase;
  text: string;
  code: PendingCode | "";
  createdAt: number;
  expiresAt: number;
  /** 覆盖路径的候选与暂存句柄（内存里，重载即失） */
  handle?: StagedHandle;
}

const queue = new Map<string, Rec>();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` 要的是**同一引用**（每调每次新数组＝无限重渲染），所以缓存一份 */
let cache: PendingView[] | null = null;
let awaitingCache: PendingView[] = [];
let workingCache: PendingView[] = [];
let liveCache: PendingView[] = [];
/** 缓存最早到几点就作废——过期是"时间到了"而非"有人改了表"，不会有人来 notify */
let cacheExpiry = Infinity;

function invalidate(): void {
  cache = null;
  awaitingCache = [];
  workingCache = [];
  liveCache = [];
  cacheExpiry = Infinity;
}

function emit(): void {
  invalidate();
  for (const l of [...listeners]) l();
}

export function subscribeMarketPending(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const PHASE_TEXT: Record<PendingPhase, string> = {
  working: "正在应用里取回并校验",
  awaiting_you: "等你在应用里确认（覆盖已有版本）",
  done: "已完成",
  failed: "没成",
  rejected: "你拒了",
};

function view(r: Rec): PendingView {
  return {
    token: r.token, entryId: r.entryId, phase: r.phase, phaseText: PHASE_TEXT[r.phase],
    text: r.text, code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt,
  };
}

/** 只按 id 找货架条目：**不猜**。索引没拉来就说没拉来，不去翻旧名单挑相近的。 */
function shelfEntry(id: string): { entry?: MarketEntry; why: string } {
  const snap = getMarketSnapshot();
  if (!snap.index) return { why: "索引还没拿到（桥只等 3 秒，我不挂着）：先 `status` 问一次，或在应用里打开市场页" };
  const hit = snap.index.entries.find((e) => e.id === id);
  if (hit) return { entry: hit, why: "" };
  return { why: `货架上没有「${id}」（当前 ${snap.index.entries.length} 条）：用 list --query 关键字 找` };
}

function finish(r: Rec, phase: PendingPhase, code: PendingCode | "", text: string): void {
  r.phase = phase;
  r.code = code;
  if (text) r.text = text;
  if (phase !== "working" && phase !== "awaiting_you") r.handle = undefined;
  emit();
}

/** 淘汰过期项。被淘汰那条之后问 token 会得到 `expired` + 「请重跑」——这句话就是它的交代 */
function prune(now: number): void {
  for (const [k, r] of queue) {
    if (r.expiresAt <= now) queue.delete(k);
  }
  invalidate();
}

export interface RequestResult {
  ok: boolean;
  token: string;
  msg: string;
}

/**
 * 起一次装包请求。**这个函数同步返回**——慢的一半在后台跑，调用方（CLI）拿 token 去轮。
 * 桥那侧一次调用只等 3 秒，把网络往返塞进返回值里就是"CLI 说超时、应用还在装"那种悬案。
 */
export function requestMarketInstall(entryId: string): RequestResult {
  const id = entryId.trim();
  if (!id) return { ok: false, token: "", msg: "没给货架条目 id：先 `list --query 关键字` 找" };
  const { entry, why } = shelfEntry(id);
  if (!entry) return { ok: false, token: "", msg: why };
  const now = Date.now();
  prune(now);
  while (queue.size >= CAP) {
    const oldest = [...queue.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    queue.delete(oldest.token);
  }
  const rec: Rec = {
    token: crypto.randomUUID(),
    entryId: id,
    phase: "working",
    text: `已受理：${entry.name} v${entry.version}（本机 ${getPlugin(id)?.pkg.version ?? "未装"}）`,
    code: "",
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  queue.set(rec.token, rec);
  emit();
  void run(rec, entry);
  return { ok: true, token: rec.token, msg: `${rec.text}｜进度与结果问 ${rec.token}` };
}

async function run(rec: Rec, entry: MarketEntry): Promise<void> {
  try {
    const plan = await planMarketInstall(entry);
    rec.text = describePlan(plan);
    if (!plan.ok) return finish(rec, "failed", plan.code, plan.msg);
    const staged = stageMarketPlan(plan);
    if (!staged.ok || !staged.handle) return finish(rec, "failed", staged.code, staged.msg);
    rec.handle = staged.handle;
    // 覆盖已有内容才停下来等人点（§8-44）；装新包是停用态、可卸载，不弹卡
    if (staged.handle.action === "update") return finish(rec, "awaiting_you", "", rec.text);
    const done = applyMarketStage(staged.handle, rec.text);
    finish(rec, done.ok ? "done" : "failed", done.code, done.msg);
  } catch (e) {
    finish(rec, "failed", "internal", `这一步自己崩了：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 整表快照（同一引用直到有人改动或某条到点过期）。横幅与测试都读这一份。 */
export function listMarketPending(): PendingView[] {
  const now = Date.now();
  if (cache && now < cacheExpiry) return cache;
  prune(now);
  cache = [...queue.values()].map(view);
  awaitingCache = cache.filter((v) => v.phase === "awaiting_you");
  workingCache = cache.filter((v) => v.phase === "working");
  liveCache = [...workingCache, ...awaitingCache];
  cacheExpiry = cache.reduce((m, r) => Math.min(m, r.expiresAt), Infinity);
  return cache;
}

export function readMarketPending(token: string): PendingView | { code: "expired"; msg: string } {
  const r = queue.get(token);
  if (!r || r.expiresAt <= Date.now()) {
    return { code: "expired", msg: "这个 token 不在了（过期、被淘汰或应用重启过）：请重跑一次命令" };
  }
  return view(r);
}

/** 等确认的那几条（横幅、`cli.plugin_status` 的计数、确认卡都读这一个函数，不各算一遍）。
 * 返回的是缓存引用——`useSyncExternalStore` 拿到新数组会当成"变了"而无限重渲染。 */
export function awaitingMarketInstalls(): PendingView[] {
  listMarketPending();
  return awaitingCache;
}

/** 正在应用里跑的那几条（横幅要出声，但入口徽标不数它们——见 `awaitingMarketInstalls` 的口径）。 */
export function workingMarketInstalls(): PendingView[] {
  listMarketPending();
  return workingCache;
}

/** 还没到终态的那些（在飞 + 等你）。「全部更新」按这个跳过重复排队，判定不在界面里重述一遍。 */
export function liveMarketInstalls(): PendingView[] {
  listMarketPending();
  return liveCache;
}

/** 记录是否已过期（`accept`/`reject` 都要先看一眼，别让过期那条悄悄落地） */
function live(token: string): Rec | null {
  const r = queue.get(token);
  if (!r || r.expiresAt <= Date.now()) return null;
  return r;
}

export interface ResolveResult {
  ok: boolean;
  code: PendingCode | "";
  msg: string;
}

/** 人在确认卡上点了「装入」。**这是市场链唯一的落地入口**（G3 钉着：别处不许自己 stage/apply）。 */
export function acceptMarketInstall(token: string): ResolveResult {
  const r = live(token);
  if (!r) return { ok: false, code: "expired", msg: "这条请求已经不在应用里了（过期或重启过），本机没有被动过：请重跑一次命令" };
  if (r.phase !== "awaiting_you" || !r.handle) {
    return { ok: false, code: "not_awaiting", msg: `这条现在不是"等你确认"状态（当前：${PHASE_TEXT[r.phase]}），没有覆盖本机` };
  }
  const out = applyMarketStage(r.handle, r.text);
  finish(r, out.ok ? "done" : "failed", out.code, out.msg);
  return out;
}

export function rejectMarketInstall(token: string): ResolveResult {
  const r = live(token);
  if (!r) return { ok: false, code: "expired", msg: "这条请求已经不在应用里了，本机没动过" };
  if (r.phase !== "awaiting_you") {
    return { ok: false, code: "not_awaiting", msg: `这条现在不是"等你确认"状态（当前：${PHASE_TEXT[r.phase]}）` };
  }
  finish(r, "rejected", "", "你拒了这次覆盖：本机版本没动，候选随这条记录一起丢掉");
  return { ok: true, code: "ok", msg: r.text };
}

/** 自省面/测试用的整表快照（顺序＝发起顺序） */
export function marketPendingSnapshot(): PendingView[] {
  return listMarketPending();
}

/** 给单测清场用（模块级表在 vitest 里跨用例存活）。 */
export function __resetMarketPendingForTest(): void {
  queue.clear();
  invalidate();
}
