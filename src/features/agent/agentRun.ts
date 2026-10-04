/**
 * P88b-2：Agent 运行宿主——本机任务 UI 的单一数据源。
 * - 首版一个活动 run；事件台账有界（每 run 200 条）；
 * - 持久化脱敏台账到 localStorage（大 data 丢弃）：重启后未终止 run 标记
 *   interrupted 可回看，不复活执行、批准令牌与撤销令牌不跨重启（§5.4）；
 * - 数据订阅租约随 run 终止释放（§6.1）；run 活动期间保持本地任务轮询（§6）；
 * - 审批卡经 ApprovalGate 绑定 (tool, argsHash)，批准/拒绝/过期由宿主裁决（§7）。
 */
import { runAgent, resolveBudget, ARGS_LEDGER_CAP } from "./loop";
import { RUN_PERSIST_BUDGET, TOTAL_PERSIST_BUDGET, excerptForStorage, storageChars, readDroppedPlaceholder, droppedPlaceholder, markStaleArtifacts, interruptedReceipt } from "./context";
import { clearPlan } from "./planLedger";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { parseFsRoots } from "./generalTools";
import { invokeAgentProvider } from "./provider";
import { activeRef } from "../ai/aiProfileStore";
import { createLocalAgentAdapter, createReadOnlyAgentAdapter } from "./agentAdapter";
import { SUBAGENT_CAPS, subagentCaps } from "./subagent";
import { pluginToolEntries } from "./pluginTools";
import { runtimeFacts } from "./hostCatalog";
import { armEnabledModules } from "../plugins/pluginStore";
import { undoRouteOf } from "./hostEntries";
import type { ApprovalGate, ApprovalRequest, WaitOutcome } from "./toolRegistry";
import { releaseDataLease } from "../plot/dataLease";
import { setLocalJobInterest } from "../mcp/jobExecutor";
import type { UndoResult } from "./settingsTools";
import { normalizeAllowed, type Domain } from "./scopeTiers";
import type { AgentMessage, AgentResult, ContextStat, PauseReason, RunEvent, RunScope, RunStatus, SubagentDispatch, ToolReceipt } from "./types";

const EVENTS_CAP = 200;
/** 留多少条任务记录。P138-B 从 20 抬到 40：记录条数不是配额主项（正文才是），
 *  而"上个任务我怎么找回来"是真实需求；主项由 `TOTAL_PERSIST_BUDGET` 管着。 */
const RUNS_KEPT = 40;
const STORE_KEY = "vs.agentRuns.v1";
const PERSIST_MS = 2000;

/** P91 A1：流式增量缓冲——只活在内存里，不进事件台账也不持久化，run 终态即清。
 *  （台账记"发生过什么"，live 记"此刻正在冒出什么"，两者语义不同不能混存。） */
export interface LiveBuffer { reasoning: string; text: string; startedAt: number; updatedAt: number }
const liveBuffers = new Map<string, LiveBuffer>();
let liveNotifyAt = 0;

export function getLive(runId: string): LiveBuffer | null {
  return liveBuffers.get(runId) ?? null;
}

function appendLive(runId: string, kind: "text" | "reasoning", chunk: string) {
  const now = Date.now();
  const cur = liveBuffers.get(runId) ?? { reasoning: "", text: "", startedAt: now, updatedAt: now };
  cur[kind] += chunk;
  cur.updatedAt = now;
  liveBuffers.set(runId, cur);
  // 增量每个 chunk 来一次，10Hz 重渲染就够看；其余靠下一条事件顺带刷新
  if (now - liveNotifyAt >= 100) {
    liveNotifyAt = now;
    notify();
  }
}

/**
 * P137：子任务（只读子代理）的**实时过程**——与 `liveBuffers` 同一族：只活在内存里，
 * 不进父台账、不持久化（详设 C1/C2）。
 *
 * 为什么要有这张表：`makeSubagentDispatch` 原先一个回调都不传（详设 F1），子的逐轮事件
 * 在 `runAgent` 返回后就地蒸发——于是"子代理在查"与"子代理挂了"在屏幕上长得一样。
 * 为什么不塞进 `view.events`：一次派发上界约 22 条事件（6 轮 + ≤16 回执），五次就是
 * 父台账 200 条上限的 55%（F4/F5）——那才是 P135-B §6 真正拒绝的东西。
 * ⚠ **刷新即没**：这条事实由界面上那句说明承担（`AgentInline` 的展开区），别在这里加
 * 任何"看起来像台账"的持久化——`persist()` 的配额失败是静默 `catch`（F6），多塞一份
 * 逐轮就是在赌它不炸。
 */
export interface SubRunLive {
  /** 父侧那次调用的 callId——键，也是渲染层找回它的唯一入口 */
  callId: string;
  /** 父 runId（`removeRun` / 记录挤出 / `clearHistory` 按它清理） */
  parentId: string;
  goal: string;
  caps: { maxRounds: number; maxCalls: number; timeoutMs: number };
  events: RunEvent[];
  rounds: number;
  calls: number;
  startedAt: number;
  endedAt?: number;
  status?: RunStatus;
  done: boolean;
}
const subRuns = new Map<string, SubRunLive>();

export function getSubRun(callId: string): SubRunLive | null {
  return subRuns.get(callId) ?? null;
}

/** 某个父 run 名下**还在跑**的派发（渲染实时行用；已完成的走卡片找回，不从这里出）。 */
export function liveSubRunsOf(parentId: string): SubRunLive[] {
  return [...subRuns.values()].filter((s) => s.parentId === parentId && !s.done);
}

function makeSubRun(callId: string, parentId: string, goal: string, caps: SubRunLive["caps"]): SubRunLive {
  const live: SubRunLive = { callId, parentId, goal, caps, events: [], rounds: 0, calls: 0, startedAt: Date.now(), done: false };
  subRuns.set(callId, live);
  return live;
}

/** 子的一条事件外发到这里。条数不需要自己的环：一次派发的量被 `SUBAGENT_CAPS`
 *  夹死在"≤6 轮 + ≤16 次"这个上界里（详设 F5），而条目本身随父记录的生命周期走。 */
function pushSubRunEvent(live: SubRunLive, e: RunEvent) {
  live.events.push(e);
  notify();
}

/** 随父任务消失：删记录时它名下的派发过程一起走（不留"点开是空的"的壳）。 */
function dropSubRunsOf(parentId: string) {
  for (const s of [...subRuns.values()]) if (s.parentId === parentId) subRuns.delete(s.callId);
}

/** 展示用目标：附件全文会拼进 goal 给模型，卡片/摘要只显示用户原话首行（P90 A2）。 */
function briefOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export interface AgentRunView {
  runId: string;
  goal: string;
  /** P90 A2：单行展示用目标（用户原话首行）；goal 才是发给模型的完整文本 */
  goalBrief: string;
  scope: RunScope;
  /** P88e B3：本档位勾选的授权域（续跑时原样继承；清单见 scopeTiers.DOMAINS） */
  allowed?: string[];
  status: RunStatus;
  rounds: number;
  calls: number;
  caps: { maxRounds: number; maxCalls: number; deadlineAt: number };
  /** P109-B：`status === "paused"` 时的真实成因。四种暂停的**正确动作不一样**，
   *  所以不能像以前那样全塌成一句"预算耗尽或连续失败"。 */
  pauseReason?: PauseReason;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** P88d：Agent 集成进 AI 对话——任务归属的会话 id（内联时间线按会话过滤） */
  sessionId?: string;
  events: RunEvent[];
  /** P95-H2：本次任务实际送入模型的上下文用量（最后一轮快照 + 峰值字节）。
   *  旧实现把 loop 的 messages 快照丢掉，"当时带了多少"事后无从得知。 */
  ctx?: { last?: ContextStat; peakBytes: number };
  /**
   * P133-D：待批**队列**，不是单槽。旧实现一张卡一个槽，模型在同一轮里提两个编辑时
   * 第二个把第一个静默顶掉——用户看到的"两条都要批"实际只有一条能批，
   * 而点了的那张如果已被顶掉，`approve()` 返回 false 却没人读它（那就是"我明明点了批准"）。
   * UI 渲染队首；批准/拒绝各消费自己那一张。
   */
  pending: ApprovalRequest[];
  /** seq → 撤销结果（仅会话内；重启后条目消失=令牌失效） */
  undoState: Record<number, UndoResult>;
}

interface Snapshot {
  runs: AgentRunView[];
  activeRunId: string | null;
}

let runs: AgentRunView[] = loadSaved();
let activeRunId: string | null = runs.find((r) => r.status === "running")?.runId ?? null;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把一个 run 发布为 running 的**同一刻**立起它的控制器。
 * 不变式：`视图状态 === "running"` ⇔ `controller !== null`。以前控制器到 executeRun 里才 new，
 * 而它前面还压着 `await armEnabledModules()`——那段窗口里 `stopRun` 会静默早退（任务照跑、
 * 界面停不掉）。C1 又在 run 起点加了 await，窗口从"几乎碰不到"变成"每次必撞"，所以把
 * 控制器改成发布前置、并由 `executeRun(view, ctrl, …)` 的签名强制（缺控制器就编译不过）。
 */
function armController(): AbortController {
  const ctrl = new AbortController();
  controller = ctrl;
  return ctrl;
}

/** 快照引用缓存：useSyncExternalStore 要求同一次变更内 getSnapshot 返回同一引用，
 *  否则 React 判定快照恒变 → 无限重渲染（白屏根因）。仅在 notify 时整体替换。 */
let snapshot: Snapshot = { runs, activeRunId };

function notify() {
  snapshot = { runs, activeRunId };
  for (const l of listeners) l();
}

function find(runId: string): AgentRunView | undefined {
  return runs.find((r) => r.runId === runId);
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

/** P89 A4：会话标题写入钩子。由 chatStore 注册（chatStore→agentRun 单向，
 *  agentRun 反向静态 import chatStore 会成环=§16 P89 红线 R1）。 */
let sessionTitleCb: ((sessionId: string, goal: string) => void) | null = null;

export function setSessionTitleCb(cb: ((sessionId: string, goal: string) => void) | null): void {
  sessionTitleCb = cb;
}

/**
 * P92 A4：任务结论回写会话的钩子（同 setSessionTitleCb 的理由：agentRun 不能静态引
 * chatStore，否则 chatStore→agentRun→…→chatStore 成环，红线 R1）。
 * 终态时把最终答复交回会话，普通聊天与 Agent 任务从此共享同一份记忆；
 * 重试/续跑再次终态时按 runId 覆盖同一条，不堆重复气泡。
 */
type ConclusionCb = (sessionId: string, runId: string, text: string) => void;
let conclusionCb: ConclusionCb | null = null;
export function setRunConclusionCb(cb: ConclusionCb | null): void {
  conclusionCb = cb;
}

/** 台账里最后一条真实叙述 = 任务结论（心跳/失败叙述/结束行都不算） */
function conclusionOf(events: RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "turn") continue;
    const t = (e.text ?? "").trim();
    if (!t || /^〔第 \d+ 轮〕$/.test(t) || t.startsWith("执行出错：") || t.startsWith("任务结束：")) continue;
    return t;
  }
  return "";
}

/** P88e A2：被 Agent 任务占用的会话 id 集合。任何 run 关联的会话都算占用——任务过程在
 *  AgentInline 展示且不写聊天消息（messages 为空），若被空会话清理逻辑误删，用户会丢掉任务记录。 */
export function occupiedSessionIds(): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    if (typeof r.sessionId === "string" && r.sessionId) out.add(r.sessionId);
  }
  return out;
}

/* ================= 持久化（脱敏、有界） ================= */

/**
 * 落盘副本削短。P138-B 之前这里是**一把尺量两样东西**：`ARGS_PERSIST_CAP = 2048`（名字与注释都写着
 * ARGS，本是量参数的尺）被拿去量 `receipt.data`，且一超就**整份丢掉**——于是一份子代理报告、
 * 一次 `fs_read` 的正文，在磁盘上那本台账里是空的，而「导出对话为 md」正是用户拿去离线提问的文件。
 *
 * 现在三件事分开：
 *  ① 参数只有一把尺——照内存台账那把 `ARGS_LEDGER_CAP`（`loop.ts:63`，8192），不再自带第二把
 *     （§8-36：一份东西两套口径迟早漂移，旧写法是"内存 8192、落盘 2048"两个答案）；
 *  ② 正文先**逐字段摘录**（只削超长字符串叶子，结构、计数、状态、其余正文都留着），
 *     实在削不动才退回整份占位——档位记在 `receiptTrim` 上，因为"被削过"和"没了"是两句不同的话（§8-41）；
 *  ③ 配额是**硬边界但有预算**：`persist()` 逐 run 夹、全局夹，且丢了什么必须出声（见 `getPersistStatus`）。
 */
function clipArgs(s: string): string {
  return s.length > ARGS_LEDGER_CAP ? `${s.slice(0, ARGS_LEDGER_CAP - 1)}…` : s;
}

/** 整份占位：保留控制字段与"原本多大"，必要时把可取回引用留在壳上 */
function droppedData(e: RunEvent): RunEvent {
  const { data, ...rest } = e.receipt!;
  const ref = data !== null && typeof data === "object" ? (data as { artifactRef?: string }).artifactRef : undefined;
  const chars = storageChars(data);
  return {
    ...e,
    receiptTruncated: true,
    receiptTrim: "dropped",
    receipt: { ...rest, data: { ...droppedPlaceholder(chars), ...(ref ? { artifactRef: ref } : {}) } },
  };
}

function trimEvent(e: RunEvent): RunEvent {
  let out = e;
  if (out.args) out = { ...out, args: clipArgs(out.args), ...(out.args.length > ARGS_LEDGER_CAP ? { argsTruncated: true } : {}) };
  // P134-B：turn 事件带"声明过的调用"，长串同样按这把尺夹（持久化配额是硬边界）
  if (out.calls?.length) {
    out = { ...out, calls: out.calls.map((c) => (c.args ? { ...c, args: clipArgs(c.args), ...(c.args.length > ARGS_LEDGER_CAP ? { argsTruncated: true } : {}) } : c)) };
  }
  // 正文不在这里按"单条上限"削：进台账那层已经有 `RECEIPT_DATA_LIMIT` 管着单条大小，
  // 落盘再设一把更宽的尺就是永远不可达的死代码（§8-54②）。落盘只管两件事：本 run 多大、
  // 所有 run 合计多大——那是 `withinRunBudget` 与 `persist` 的活。
  return out;
}

/** 落盘削短的两档额度：先给到 8k/条，还超再给到 2k/条，最后才整份换占位 */
const PERSIST_ROOMS = [8_192, 2_048];

/** 逐 run 预算：从**尾部**（最旧的事件）开始让位，用户当下正在看的这条最后才动。
 *  ⚠ 记账必须是**增量**的：以前每削一条都把整个 events 数组重新 stringify 一遍，
 *  40 条 200 KB 的回执就足以把测试 worker 顶到 4 GB 堆溢出（本批实测撞到的）。
 *  总量只算一次，之后每次替换只加减那一条的差值。 */
function withinRunBudget(events: RunEvent[]): { events: RunEvent[]; trimmed: number } {
  const out = [...events];
  let total = storageChars(out);
  if (total <= RUN_PERSIST_BUDGET) return { events: out, trimmed: 0 };
  let trimmed = 0;
  const swap = (i: number, next: RunEvent) => {
    total += storageChars(next) - storageChars(out[i]);
    out[i] = next;
    trimmed++;
  };
  for (const room of PERSIST_ROOMS) {
    for (let i = out.length - 1; i >= 0 && total > RUN_PERSIST_BUDGET; i--) {
      const e = out[i];
      if (e.kind !== "receipt" || !e.receipt || e.receipt.data === undefined) continue;
      if (readDroppedPlaceholder(e.receipt.data) !== null || storageChars(e.receipt.data) <= room) continue;
      const cut = excerptForStorage(e.receipt.data, room);
      swap(i, cut.mode === "excerpt" && cut.data !== null && typeof cut.data === "object"
        ? { ...e, receiptTruncated: true, receiptTrim: "excerpt", receipt: { ...e.receipt, data: cut.data } }
        : droppedData(e));
    }
  }
  for (let i = out.length - 1; i >= 0 && total > RUN_PERSIST_BUDGET; i--) {
    const e = out[i];
    if (e.kind !== "receipt" || !e.receipt || e.receipt.data === undefined || readDroppedPlaceholder(e.receipt.data) !== null) continue;
    swap(i, droppedData(e));
  }
  return { events: out, trimmed };
}

/**
 * P138-B：落盘这件事的**可观察结果**。以前 `persist()` 的失败是一句 `catch { /* 忽略 *\/ }`——
 * 配额满了没人知道自己丢过东西（§8-46：兜底不是错，"兜底 + 没人盯着覆盖度"才是错）。
 * 现在三档都出声：削了多少条 data、掉了多少个 run、写盘到底成没成。
 */
export interface PersistStatus { chars: number; trimmedDatas: number; droppedRuns: number; failed: boolean; at: number }
let persistStatus: PersistStatus | null = null;
export function getPersistStatus(): PersistStatus | null {
  return persistStatus;
}

function persist() {
  let trimmedDatas = 0;
  // 每个 run 的字节数只量一次（同样是 O(n²) 的坑：以前每次判断都 stringify 整包）
  const rows = runs.slice(0, RUNS_KEPT).map((r) => {
    const capped = withinRunBudget(r.events.slice(-EVENTS_CAP).map(trimEvent));
    trimmedDatas += capped.trimmed;
    const row = { ...r, events: capped.events, pending: [] };
    return { row, chars: storageChars(row) };
  });
  let chars = rows.reduce((n, x) => n + x.chars, 0);
  let droppedRuns = 0;
  // 全局预算：`runs[0]` 是最新（startRun 用 unshift），所以从尾部丢起 = 先丢最旧的整条记录
  while (chars > TOTAL_PERSIST_BUDGET && rows.length > 1) {
    const gone = rows.pop();
    if (!gone) break;
    chars -= gone.chars;
    droppedRuns++;
  }
  const payload = rows.map((x) => x.row);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    persistStatus = trimmedDatas || droppedRuns ? { chars, trimmedDatas, droppedRuns, failed: false, at: Date.now() } : null;
    if (trimmedDatas || droppedRuns) {
      console.warn(`[agentRun] 台账落盘被削：${trimmedDatas} 条回执正文降档、${droppedRuns} 条记录未落盘（现约 ${chars} 字符）`);
    }
  } catch (e) {
    persistStatus = { chars, trimmedDatas, droppedRuns, failed: true, at: Date.now() };
    console.warn(`[agentRun] 台账落盘失败（${String((e as Error)?.name ?? e).slice(0, 40)}）：本次仅会话内可见，重启后回看不了`);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_MS);
}

/** 校验并补全单条持久化 run；缺关键字段的脏记录返回 null 丢弃（防渲染期 TypeError 白屏）。 */
function reviveRun(r: unknown): AgentRunView | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Partial<AgentRunView>;
  if (typeof o.runId !== "string" || typeof o.goal !== "string") return null;
  if (!o.caps || typeof o.caps.maxRounds !== "number" || typeof o.caps.maxCalls !== "number" || typeof o.caps.deadlineAt !== "number") return null;
  const scope: AgentRunView["scope"] = o.scope === "preview" || o.scope === "custom" ? o.scope : "create";
  return {
    runId: o.runId,
    goal: o.goal,
    goalBrief: typeof o.goalBrief === "string" && o.goalBrief ? o.goalBrief : briefOf(o.goal),
    scope,
    allowed: Array.isArray(o.allowed) ? o.allowed.filter((x): x is string => typeof x === "string") : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    status: o.status === "running" ? "interrupted" : (o.status ?? "interrupted"),
    rounds: typeof o.rounds === "number" ? o.rounds : 0,
    calls: typeof o.calls === "number" ? o.calls : 0,
    caps: o.caps,
    // P109-B：`reviveRun` 是逐字段白名单重建，不在这里出现的新字段重启后会静默消失
    pauseReason:
      o.pauseReason === "rounds" || o.pauseReason === "calls" || o.pauseReason === "deadline" || o.pauseReason === "no-progress"
        ? o.pauseReason
        : undefined,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : undefined,
    events: Array.isArray(o.events) ? o.events : [],
    // P95-H2：`reviveRun` 是逐字段白名单重建——新字段不在这里出现，重启后就静默消失
    ctx: o.ctx && typeof o.ctx === "object" ? o.ctx : undefined,
    pending: [],
    undoState: {},
  };
}

function loadSaved(): AgentRunView[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // §5.4：重启不复活执行——未终止 run 标记 interrupted，仅可回看
    return parsed.slice(0, RUNS_KEPT).map(reviveRun).filter((r): r is AgentRunView => r !== null);
  } catch {
    return [];
  }
}

export function clearHistory(): void {
  if (controller) return;
  runs = [];
  subRuns.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* 忽略 */ }
  notify();
}

/** P89 A2：删除单条任务记录（台账 + 持久化原子剔除）。运行中的 run 不可删——
 *  UI 只在终态折叠行上给删除入口，返回值供调用方与测试判定。 */
export function removeRun(runId: string): boolean {
  const view = find(runId);
  if (!view || view.status === "running") return false;
  runs = runs.filter((r) => r.runId !== runId);
  liveBuffers.delete(runId);
  dropSubRunsOf(runId);
  if (activeRunId === runId) activeRunId = null;
  persist();
  notify();
  return true;
}

/* ================= 审批门（§7） ================= */

interface ApprovalToken { token: string; exp: number }
const approved = new Map<string, ApprovalToken>(); // key = `${runId}|${tool}|${hash}`
const rejected = new Set<string>();

/** P133-D：正在等用户点的调用。一个 key 最多挂一个等待者（同参重试只留最新那个）。 */
type Waiter = (outcome: WaitOutcome) => void;
const waiters = new Map<string, Waiter>();

const keyOf = (runId: string, tool: string, hash: string) => `${runId}|${tool}|${hash}`;

/** 叫醒等待者。没有等待者就是空操作——独立适配器那条门从不 waitFor，那条路保持旧行为。 */
function wake(key: string, outcome: WaitOutcome) {
  const w = waiters.get(key);
  if (!w) return;
  waiters.delete(key);
  w(outcome); // 定时器由它自己的 done 清，这里不越俎代庖
}

/** 把 run 的所有等待者一次性收尾（停止/收工时用，不留悬着的 Promise） */
function wakeRun(runId: string, outcome: WaitOutcome) {
  for (const key of [...waiters.keys()]) if (key.startsWith(`${runId}|`)) wake(key, outcome);
}

function dropPending(view: AgentRunView, id: string): boolean {
  const i = view.pending.findIndex((p) => p.id === id);
  if (i < 0) return false;
  view.pending.splice(i, 1);
  notify();
  schedulePersist();
  return true;
}

function makeGate(runId: string): ApprovalGate {
  return {
    request(req) {
      const key = keyOf(runId, req.tool, req.argsHash);
      // 用户已明确拒绝的同参请求不再重复弹卡（模型重试由连续失败暂停兜底）
      if (rejected.has(key)) return;
      const view = find(runId);
      if (!view) return;
      // 同参只留一张：模型重试同一个调用不该把队列刷成一叠重复卡
      if (view.pending.some((p) => p.tool === req.tool && p.argsHash === req.argsHash)) return;
      view.pending.push(req);
      notify();
      schedulePersist();
    },
    takeToken(rid, tool, hash, now) {
      const key = keyOf(rid, tool, hash);
      const t = approved.get(key);
      if (!t) return null;
      approved.delete(key);
      if (now >= t.exp) return null; // 过期令牌作废，重新评估
      return t.token;
    },
    reject(req) {
      rejected.add(keyOf(runId, req.tool, req.argsHash));
      const view = find(runId);
      if (view) dropPending(view, req.id);
      wake(keyOf(runId, req.tool, req.argsHash), "rejected");
    },
    /**
     * P133-D：批准门真的等人。旧实现不等人——弹完卡立刻回 `needs_local_approval`，
     * 模型在同一轮里连刷三次重试，而卡片在刷轮次途中被 finalize 清掉，
     * 用户点下去时落在一张已消失的卡上（第一次真跑实录）。
     * 到点自动把那张卡从队列里摘掉并回 `expired`：留一张点不动的卡比没有卡更坏。
     */
    waitFor(rid, tool, hash, expiresAt, signal) {
      const key = keyOf(rid, tool, hash);
      return new Promise<WaitOutcome>((resolve) => {
        // 用 holder 而不是 `let timer`：done 要在定时器建好之前就能取消它，而 eslint 的
        // prefer-const 不许"声明后只赋值一次"的 let（这里确实是先声明后赋值）
        const holder: { timer?: ReturnType<typeof setTimeout> } = {};
        const done = (outcome: WaitOutcome) => {
          if (waiters.get(key) === done) waiters.delete(key);
          clearTimeout(holder.timer);
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = () => done("aborted");
        holder.timer = setTimeout(() => {
          const view = find(rid);
          if (view) {
            const i = view.pending.findIndex((p) => p.tool === tool && p.argsHash === hash);
            if (i >= 0) view.pending.splice(i, 1);
            notify();
          }
          done("expired");
        }, Math.max(0, expiresAt - Date.now()));
        const prev = waiters.get(key);
        if (prev) {
          waiters.delete(key);
          prev("aborted"); // 它自己的 done 会清掉它的定时器
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.set(key, done);
      });
    },
  };
}

/**
 * 一次点击的结果。**故意不再返回 boolean**：旧实现返回 `false` 而界面把返回值丢掉，
 * 于是"点了批准但那张卡早已被顶掉/已过期"与"点成功了"在屏幕上长得一模一样——
 * 用户看到的就是一句"我明明点了批准"。
 */
export type ApprovalOutcome = "approved" | "rejected" | "expired" | "stale";

export function approve(runId: string, approvalId: string): ApprovalOutcome {
  const view = find(runId);
  const req = view?.pending.find((p) => p.id === approvalId);
  if (!view || !req) return "stale";
  const key = keyOf(runId, req.tool, req.argsHash);
  if (Date.now() >= req.expiresAt) {
    dropPending(view, req.id);
    wake(key, "expired");
    return "expired";
  }
  approved.set(key, { token: crypto.randomUUID(), exp: req.expiresAt });
  rejected.delete(key);
  dropPending(view, req.id);
  wake(key, "approved");
  return "approved";
}

export function reject(runId: string, approvalId: string): ApprovalOutcome {
  const view = find(runId);
  const req = view?.pending.find((p) => p.id === approvalId);
  if (!view || !req) return "stale";
  rejected.add(keyOf(runId, req.tool, req.argsHash));
  dropPending(view, req.id);
  wake(keyOf(runId, req.tool, req.argsHash), "rejected");
  return "rejected";
}

/* ================= 撤销（§5.4：仅会话内有效，如实三态） ================= */

/**
 * 撤销处理器：**从注册表按工具名现查**（`hostEntries.undoRouteOf`，P99a-A5）。
 * 保留这段注释是为了说清为什么这里不再有一张表——撤销路由写在工具的 entry 上，
 * 漏写 undoRoute 的新工具会走下面的 `unrouted_tool` 分支**如实出声**，
 * 而不是像旧 if 链那样被静默路由到设置撤销、回一句假的 `token_expired`（§8-35）。
 */

/**
 * 撤销态的展示口径与路由表放在一起：加一条撤销路由时必须同时加它的用户可见说法，
 * 否则漏登记的工具会显示成一个按了没反应的「撤销」按钮（§8-35 的"回执不许声称做不到的事"）。
 */
export const UNDO_STATE_UI: Record<Exclude<UndoResult, "undone">, { label: string; tip: string }> = {
  token_expired: { label: "撤销已失效", tip: "撤销仅本次运行内有效" },
  revision_conflict: { label: "已被新改动覆盖", tip: "该设置之后又被修改，撤销会覆盖新改动" },
  unrouted_tool: { label: "无法撤销", tip: "这个改动没有可用的撤销路径（程序缺陷，已在控制台留痕）" },
  // P133-H：写回磁盘要等 IPC。没有这一态，按钮按下去会真的没反应（假开关）。
  restoring: { label: "正在写回…", tip: "要把文件的旧内容写回去，稍等" },
  restore_failed: { label: "撤销失败", tip: "旧内容没能写回（文件被别的程序占用、或已被移走）；请手动核对这个文件" },
};

export function undoReceipt(runId: string, seq: number): UndoResult | null {
  const view = find(runId);
  const ev = view?.events.find((e) => e.seq === seq);
  const token = ev?.receipt?.undoToken;
  if (!view || !token) return null;
  const handler = ev.tool ? undoRouteOf(ev.tool) : undefined;
  if (!handler) console.warn(`[Agent撤销] 工具「${ev.tool}」发了 undoToken 却没登记撤销路由，回执不会被撤掉`);
  const result = handler ? handler(token) : "unrouted_tool";
  if (typeof result !== "string") {
    // 异步撤销：先占住按钮，回来再落最终态。中间态本身就是"我听见了"的证据。
    view.undoState[seq] = "restoring";
    notify();
    result.then(
      (r) => { view.undoState[seq] = r; notify(); },
      () => { view.undoState[seq] = "restore_failed"; notify(); },
    );
    return "restoring";
  }
  view.undoState[seq] = result;
  notify();
  return result;
}

/* ================= 运行 ================= */

export class RunBusyError extends Error {
  constructor() {
    super("已有 Agent 任务在运行，请先停止或等待完成");
  }
}

export async function startRun(options: {
  goal: string;
  /** P90 A2：展示用目标（用户原话）；缺省时从 goal 派生 */
  goalBrief?: string;
  scope: RunScope;
  /** 本档位勾选的授权域（scope 非 custom 时由 hasDomain 忽略；清单见 scopeTiers.DOMAINS） */
  allowed?: string[];
  /** P88d：任务归属的 AI 会话 id（内联时间线按会话过滤） */
  sessionId?: string;
  /** P90 B6：随目标附带的图片（data URL，前端已压缩）。仅本次运行使用，
   *  不进台账与持久化（localStorage 容量与隐私），续跑不继承。 */
  images?: string[];
  /** P92 A2：会话先前上下文（由调用方用 sessionLog 投影好传进来）。
   *  不进台账也不持久化——它是派生视图，存下来就造出第三份真相。 */
  history?: AgentMessage[];
  /** P95-H2：投影阶段遮蔽了多少条（只随本次运行传用，同样不落台账） */
  historyShadowed?: number;
  maxRounds?: number;
  maxCalls?: number;
  timeoutMs?: number;
}): Promise<string> {
  if (controller) throw new RunBusyError();
  const goal = options.goal.trim();
  if (!goal) throw new Error("任务目标不能为空");
  const runId = crypto.randomUUID();
  const now = Date.now();
  // P109-A：预算的**唯一出处是设置**（`0 = 不限制`，2026-09-26 用户裁决）。
  // 原来这里是两处 `Math.min(..., DEFAULT_BUDGET.*)` 把 24/64/10min 焊成天花板，
  // 而那句"允许收紧，不允许放宽"从来不是用户裁决 —— 详设 docs/P109-…md §1-8、§6-1。
  // 调用方显式传参仍然优先（续跑与测试要能注入）。
  const st = getSettings();
  const budget = resolveBudget({
    maxRounds: options.maxRounds ?? st.agentMaxRounds,
    maxCalls: options.maxCalls ?? st.agentMaxCalls,
    timeoutMs: options.timeoutMs ?? st.agentTimeoutMins * 60_000,
  });
  const { maxRounds, maxCalls, timeoutMs } = budget;
  const brief = briefOf(options.goalBrief?.trim() || goal);
  const view: AgentRunView = {
    runId, goal, goalBrief: brief, scope: options.scope, status: "running", rounds: 0, calls: 0,
    ...(options.scope === "custom" ? { allowed: normalizeAllowed("custom", options.allowed) } : {}),
    sessionId: options.sessionId,
    // `deadlineAt: 0` = 没有截止时间（不能写 Infinity：caps 要经 JSON 落盘，Infinity 会变 null）
    caps: { maxRounds, maxCalls, deadlineAt: timeoutMs > 0 ? now + timeoutMs : 0 },
    createdAt: now, updatedAt: now, events: [], pending: [], undoState: {},
  };
  const kept = runs.filter((r) => r.runId !== runId);
  // 被 RUNS_KEPT 挤出去的那几条记录，名下的派发过程要一起走（否则内存表只进不出）
  for (const r of kept.slice(RUNS_KEPT - 1)) dropSubRunsOf(r.runId);
  runs = [view, ...kept].slice(0, RUNS_KEPT);
  activeRunId = runId;
  // P99a-C1：控制器与 `running` 状态**同时**成立。以前它到 executeRun 里才 new，而 executeRun
  // 前面还压着 `await armEnabledModules()`——于是存在"任务已是 running、控制器还不存在"的窗口，
  // `stopRun` 对着它静默早退（界面上停止按了没反应，测试里表现为 await 到天亮）。C1 给 run 起点
  // 多加了一次 await，这个窗口从"几乎碰不到"变成"每次必撞"，所以在这儿焊死。
  const ctrl = armController();
  // P89 A4：Agent 任务会话不写聊天消息、永远无标题 → 侧栏全是「新对话」无法分辨。
  // P90 A2：标题取展示用目标（用户原话），不带附件全文。
  if (options.sessionId) sessionTitleCb?.(options.sessionId, brief);
  notify();
  persist(); // 启动即落盘：首个事件前强关也能恢复 interrupted 记录（修"重启后啥也没有"）
  await executeRun(view, ctrl, {
    timeoutMs,
    ...(options.images?.length ? { images: options.images } : {}),
    ...(options.history?.length ? { history: options.history } : {}),
    ...(options.historyShadowed ? { historyShadowed: options.historyShadowed } : {}),
  });
  return runId;
}

/**
 * P135-B：只读子代理的装配（详设 §2-§6）。三件事各自的落点：
 *  - **只读** ⇒ `createReadOnlyAgentAdapter` 那张点名白名单（不是按 effect 反射筛的，
 *    `run_app_action` 会按内层 kind 升档、plot_* 申请的租约没人替子任务回收、task_plan 写父台账）；
 *  - **同一总预算** ⇒ 上限从 loop 交下来的 `ctx.remaining` 折算（`subagentCaps`），
 *    用量交回 `ctx.chargeNested` 记进父账；父额度用尽时是**就地拒**，不是"0=不限"；
 *  - **不能再扩权** ⇒ 档位与授权域照抄父任务那份 `(scope, allowed)` 再裁一次。
 *
 * 子的逐轮过程**不进父台账**：`EVENTS_CAP = 200`，把子的每一轮塞进来等于把父任务可复盘的
 * 深度砍一半（P134-B 量的就是同一件事）。父台账里只留一条派发回执。
 * P137 补上另一半：过程不是不给看，是**换个位置给**——`subRuns` 那张内存表接 `onEvent`/`onProgress`
 * （详设 §3-D1 甲），于是派发期间界面有实时行、派发完展开有逐轮简表，而父台账一格没多占。
 */
function makeSubagentDispatch(view: AgentRunView, allowed: readonly Domain[]): SubagentDispatch {
  return async (goal, ctxIn) => {
    const caps = subagentCaps(ctxIn.remaining) ?? { ...SUBAGENT_CAPS };
    const live = makeSubRun(ctxIn.callId, view.runId, goal, caps);
    const subRunId = crypto.randomUUID();
    const adapter = createReadOnlyAgentAdapter({ runId: subRunId, scope: view.scope, allowed });
    const activeAi = activeRef();
    const res = await runAgent({
      goal,
      provider: invokeAgentProvider,
      adapter,
      // 父任务的 signal 原样透传：点了停止，子的下一轮请求根本发不出去
      context: {
        source: "local_agent", runId: subRunId, signal: ctxIn.signal, scope: view.scope,
        ...(view.scope === "custom" ? { allowed: [...allowed] } : {}),
      },
      liveFacts: ({ count, bytes }) => runtimeFacts({
        scope: view.scope, allowed, toolCount: count, toolBytes: bytes,
        fsRoots: parseFsRoots(getSettings().agentFsRoots),
      }),
      maxRounds: caps.maxRounds, maxCalls: caps.maxCalls, timeoutMs: caps.timeoutMs,
      ...(activeAi ? { maxOutputTokens: activeAi.model.maxOutputTokens } : {}),
      onEvent: (e) => pushSubRunEvent(live, e),
      onProgress: (rounds, calls) => { live.rounds = rounds; live.calls = calls; },
    });
    const tools = [...new Set(res.events.filter((e) => e.kind === "receipt" && e.tool).map((e) => e.tool as string))];
    const text = [...res.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const elapsedMs = Date.now() - live.startedAt;
    live.done = true;
    live.endedAt = Date.now();
    live.status = res.status;
    notify();
    return { status: res.status, rounds: res.rounds, calls: res.calls, tools, text, caps, elapsedMs };
  };
}

/** 跑一个 run（首发与续跑共用一套控制器/租约/收尾语义）。
 *  控制器**由调用方在发布任务时 arm 并传入**：没有控制器的 run 不允许开跑，
 *  于是"running 但 stop 不掉"这类窗口在类型上就不存在（P99a-C1）。 */
async function executeRun(
  view: AgentRunView,
  ctrl: AbortController,
  opts: { timeoutMs: number; images?: string[]; history?: AgentMessage[]; historyShadowed?: number; resumeFrom?: AgentMessage[]; priorEvents?: RunEvent[] },
): Promise<void> {
  const runId = view.runId;
  const prior = opts.priorEvents ?? [];
  const gate = makeGate(runId);
  // P93-A6：档位与授权域传进 adapter，用于**裁剪发给模型的工具定义**（未授权的主机工具不发）
  const allowed = normalizeAllowed(view.scope, view.allowed);
  /**
   * P99a-B2：run 起点先把"已启用且带逻辑模块"的包臂起来（幂等，已在线的直接返回），
   * 然后**取一次插件工具快照**传给 adapter。两件事的顺序是有意的：
   * 工具面在本 run 内就此冻结，run 中途启用带工具的插件要到下一个任务才看得见（详设 §4.5-2 / Q2
   * "自扩展不等于自提权"）。臂失败的包不注册工具，但必须出声——静默少工具只会让人去怀疑模型。
   */
  const armed = await armEnabledModules();
  if (armed.blocked.length) {
    console.warn(`[agentRun] ${armed.blocked.length} 个包的逻辑模块未就绪：${armed.blocked.map((b) => `${b.id}（${b.msg}）`).join("；")}`);
  }
  const adapter = createLocalAgentAdapter({
    runId, gate, scope: view.scope, allowed,
    extraEntries: pluginToolEntries(),
    // P135-B：只读子代理的装配（开关在设置里，关着时工具自己会如实拒）
    subagent: makeSubagentDispatch(view, allowed),
  });
  setLocalJobInterest(true);
  try {
    // P110-B5：输出预算的顶取自当前模型档案（provider 实发时用的是同一个数）。
    // 取一次存局部变量：`activeRef()` 每次都过一遍筛选，写在对象字面量里连着调两次就是
    // 既浪费又可能在中间被改 —— 那会撒一次非空断言的谎。
    const activeAi = activeRef();
    const result = await runAgent({
      goal: view.goal,
      provider: invokeAgentProvider,
      adapter,
      context: {
        source: "local_agent", runId, signal: ctrl.signal, scope: view.scope,
        ...(view.scope === "custom" ? { allowed } : {}),
      },
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.history?.length ? { history: opts.history } : {}),
      ...(opts.historyShadowed ? { historyShadowed: opts.historyShadowed } : {}),
      ...(opts.resumeFrom?.length ? { resumeFrom: opts.resumeFrom } : {}),
      // P99a-C1 §6.2：每轮重算的宿主事实（授权域 / 可见工具面 / 连接现状 / 版本）。
      // 只给读数不给指令——DSH 的 `agent.inject` 那条"每轮往上下文里塞话"的路我们不抄（详设 §6.2）。
      liveFacts: ({ count, bytes }) => runtimeFacts({
        scope: view.scope, allowed, toolCount: count, toolBytes: bytes,
        // P133-C1：把白名单根报给模型（解析只有 parseFsRoots 这一处，不在这里再 split 一遍）
        fsRoots: parseFsRoots(getSettings().agentFsRoots),
      }),
      seqBase: prior.length,
      ...(activeAi ? { maxOutputTokens: activeAi.model.maxOutputTokens } : {}),
      maxRounds: view.caps.maxRounds, maxCalls: view.caps.maxCalls,
      // 续跑给的是**剩余**时间，不是重新发一份完整预算；`deadlineAt === 0` = 无截止 ⇒ 传 0
      timeoutMs: opts.timeoutMs ?? (view.caps.deadlineAt ? view.caps.deadlineAt - Date.now() : 0),
      onDelta: (kind, text) => appendLive(runId, kind, text),
      // P96-K4：每次送请求（含重试）都清掉实时缓冲 ⇒ "正在思考"从本轮重新计时；
      // 上一段已收内容此时已作为「未完成轮」事件进台账，不会凭空消失。
      onAttemptStart: () => liveBuffers.delete(runId),
      onProgress: (rounds, calls) => setProgress(runId, rounds, calls),
      onEvent: (e) => pushEvent(runId, e),
    });
    finalize(runId, result, undefined, prior);
  } catch {
    finalize(runId, null, "run_crashed", prior);
  } finally {
    if (controller === ctrl) controller = null;
    liveBuffers.delete(runId); // 实时缓冲随终态消失（台账里已有全量正文）
    releaseDataLease(runId); // §6.1：run 终止即回收租约
    if (!runs.some((r) => r.status === "running")) setLocalJobInterest(false);
    activeRunId = runs.find((r) => r.status === "running")?.runId ?? null;
    persist();
    notify();
  }
}

function pushEvent(runId: string, e: RunEvent) {
  const view = find(runId);
  if (!view) return;
  view.events = [...view.events.slice(-EVENTS_CAP + 1), e];
  view.updatedAt = Date.now();
  notify();
  schedulePersist();
}

/** P96-K4：轮/调用计数由 loop 实时报（旧实现这里是一行恒等空写 `Math.max(view.rounds, 0)`，
 *  真值只在 finalize 回填 ⇒ 跑满 6 分钟界面仍显示「第 0/24 轮 · 工具 0/64 次」）。 */
function setProgress(runId: string, rounds: number, calls: number) {
  const view = find(runId);
  if (!view || view.status !== "running") return;
  if (view.rounds === rounds && view.calls === calls) return;
  view.rounds = rounds;
  view.calls = calls;
  notify();
}

/** 用 loop 真实结果回填终态；counts 取自 result，不采信模型自述（§5.2）。
 *  priorEvents = 续跑前台账（新事件接在其后，绝不覆盖历史，P91 A4）。 */
function finalize(runId: string, result: AgentResult | null, crashCode?: string, priorEvents: RunEvent[] = []) {
  const view = find(runId);
  if (!view) return;
  if (result) {
    view.status = result.status;
    // P109-B：成因跟着终态走；非 paused 一律清空（续跑成功后不许留着上一次的"无进展"）
    view.pauseReason = result.status === "paused" ? result.pauseReason : undefined;
    view.rounds = result.rounds;
    view.calls = result.calls;
    view.events = [...priorEvents, ...result.events.slice(-EVENTS_CAP).map(trimEvent)].slice(-EVENTS_CAP);
    if (result.ctx) view.ctx = result.ctx;
  } else {
    view.status = "failed";
    // 宿主级崩溃也要留痕（P88d：失败必有原因）
    view.events = [
      ...view.events,
      { seq: view.events.length + 1, ts: Date.now(), kind: "turn", text: `执行出错：${crashCode ?? "未知错误"}` },
    ];
  }
  // P133-D：收工时把还挂在批准门上的调用一次性叫醒（否则那条 Promise 会一直等下去），
  // 并清空队列。这里顺手合并了旧代码里连着写两遍的同一句 `view.pending = null`。
  wakeRun(runId, "aborted");
  view.pending = [];
  // P109-C：计划台账随**真终态**回收。paused 不清——「继续任务」还要靠它判断闭环；
  // running 也不清（finalize 只在终态调用，这层判断是给以后改动留的护栏）。
  if (view.status !== "paused" && view.status !== "running") clearPlan(runId);
  view.finishedAt = Date.now();
  view.updatedAt = view.finishedAt;
  // P92 A4：结论回写会话（气泡=结论、卡片=过程）；无 sessionId 的 run（MCP/Operator）不回写
  if (view.sessionId) {
    const text = conclusionOf(view.events);
    if (text) conclusionCb?.(view.sessionId, view.runId, text);
  }
}

/** 事件台账里的工具参数解析不出来（落盘时被截过、或本身不是对象）→ 归一化为 {} */
function safeArgs(raw: string | undefined): string {
  if (!raw) return "{}";
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? raw : "{}";
  } catch {
    return "{}";
  }
}

/**
 * 事件台账 → 对话骨架（P91 A4）。台账里有每轮模型正文、工具名/参数与完整回执，
 * 足以让模型接着往下想；轮次心跳、失败叙述、续跑标记不回灌（那是给人看的，不是历史）。
 * 已知精度损失：同轮多支调用的顺序按台账顺序还原；参数超出落盘那把尺（P138-B 起与内存台账
 * 同一把 `ARGS_LEDGER_CAP`）
 * 的调用**整对不入历史**（不是退化成 `{}` 假装是原参数），只在末尾如实标注丢了几对。
 */
export function rebuildMessages(view: AgentRunView): AgentMessage[] {
  const out: AgentMessage[] = [{ role: "user", content: view.goal }];
  let pendingText = "";
  let cur: AgentMessage | null = null;
  let droppedTruncated = 0;
  /* P134-B：先收集"有回执的 callId"。turn 事件里声明过、这里却没有回执的调用，
     就是"应用被杀在它执行中途"的那些——不能当没发生（模型会重做写入），
     也不能说没执行（那是假话），只能说：结果未知 + 下一步该怎么判断。 */
  const haveReceipt = new Set<string>();
  for (const e of view.events) if (e.kind === "receipt" && e.receipt?.callId) haveReceipt.add(e.receipt.callId);
  let unknownOutcome = 0;
  const needAssistant = (): AgentMessage => {
    if (!cur) {
      cur = { role: "assistant", content: pendingText, calls: [] };
      out.push(cur);
      pendingText = "";
    }
    return cur;
  };
  for (const e of view.events) {
    if (e.kind === "turn") {
      const t = e.text ?? "";
      if (!t || /^〔第 \d+ 轮〕$/.test(t) || t.startsWith("执行出错：") || t.startsWith("已从中断处继续")) continue;
      cur = null; // 新正文 = 新一轮，其工具调用属于新的 assistant 消息
      pendingText += (pendingText ? "\n" : "") + t;
      for (const c of e.calls ?? []) {
        if (haveReceipt.has(c.callId)) continue; // 有回执的走 receipt 分支（成对下发）
        const a = needAssistant();
        a.calls = [...(a.calls ?? []), { callId: c.callId, name: c.name, arguments: c.argsTruncated ? "{}" : (c.args || "{}") }];
        out.push({ role: "tool", callId: c.callId, content: JSON.stringify(interruptedReceipt(c.callId, c.name)) });
        unknownOutcome++;
      }
    } else if (e.kind === "receipt") {
      // P92 D1：参数被截断过的调用**整对不入历史**。把 `{}` 当"模型当初要的参数"回灌，
      // 等于让模型基于伪造的历史做决策（这是 P91-A4 续跑的真实毒源）。宁可少一段上下文，
      // 也不能有一段假上下文——少的部分在末尾如实标注，用户可「复制日志」核对。
      if (e.argsTruncated) { droppedTruncated++; continue; }
      const callId = e.receipt?.callId ?? `agg_${out.length}`;
      const a = needAssistant();
      a.calls = [...(a.calls ?? []), { callId, name: e.tool ?? "", arguments: safeArgs(e.args) }];
      out.push({ role: "tool", callId, content: JSON.stringify(receiptForReplay(e.receipt)) });
    }
  }
  if (pendingText) out.push({ role: "assistant", content: pendingText, calls: [] });
  if (droppedTruncated > 0) {
    out.push({
      role: "system",
      content: `（续跑说明：先前有 ${droppedTruncated} 次工具调用的参数超出台账上限，未纳入本历史；它们确实已执行过，请勿据此重复写入。需要原文请让用户点「复制日志」。）`,
    });
  }
  if (unknownOutcome > 0) {
    out.push({
      role: "system",
      content: `（续跑说明：有 ${unknownOutcome} 次调用在台账里有声明、没有回执，结果未知——应用很可能是在它们执行到一半时被结束的。`
        + "只读或幂等的可以重试；可能有副作用的先用只读工具核对当前状态，或把情况告诉用户由用户决定，不要盲目重试。）",
    });
  }
  return out;
}

/** 回灌用的回执：剥掉一次性撤销令牌（跨轮/跨重启复用即误撤销），并把"可取回"改成实话 */
function receiptForReplay(rec: ToolReceipt | undefined): unknown {
  if (!rec) return { ok: false, status: "error", code: "ledger_missing_receipt" };
  const { undoToken: _drop, ...rest } = rec;
  return markStaleArtifacts(rest);
}

export function stopRun(runId: string): void {
  const view = find(runId);
  if (!view || view.status !== "running") return;
  // 不变式被破坏时**出声**而不是静默早退（§8-23）：running 却没有可中止的控制器，
  // 表现就是"点了停止但任务还在跑"，而界面上一个字都没有——那次真机排查会一路找到 loop 里去。
  if (!controller || activeRunId !== runId) {
    console.warn(`[agentRun] stopRun(${runId}) 没有该任务的在途控制器可中止（active=${activeRunId ?? "none"}）：任务会以原状态继续跑完`);
    return;
  }
  controller.abort(); // §5.3 停止顺序：先停模型流，未执行调用由 loop 丢弃
  notify();
}

/**
 * P109-B：「已暂停」的继续任务 = 走 `retryRun` 那条**同一个 run 上续跑**的路。
 *
 * 旧实现是"用原 goal/scope/会话重新发起一个新 run"，代价是：新 runId、轮数归零、
 * **不带任何历史**（loop 只拼得出 system + 光秃秃的目标），于是模型既不知道走到哪、
 * 也看不到先前的工具回执，而 `seen` 台账是每 run 重建的 ⇒ **已经生效的写入会被重做一遍**。
 * 用户看到的"继续任务接不上来"就是这一条。正确的重放路径（`rebuildMessages`）一直都在，
 * 只是 `canRetry` 把 `paused` 挡在外面——旧注释甚至写着"paused 不是可恢复的挂起态"。
 */
export function resumeRun(runId: string): Promise<string> {
  const view = find(runId);
  if (!view) return Promise.reject(new Error("任务不存在"));
  if (view.status !== "paused") return Promise.reject(new Error("仅「已暂停」的任务可以继续"));
  // `retryRun` 是同步抛错（忙碌 / 任务不存在），这里统一成 rejection：
  // 调用方只写 `.catch(...)`，不该被一条同步异常打穿
  try {
    return retryRun(runId);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * P91 A4：失败/中断任务的「继续任务」——与 resumeRun 的关键区别是**不从头重做**：
 * 从事件台账重建对话骨架（含已生效步骤的回执），在**同一个 run** 上续跑，
 * 目标/授权域/撤销令牌原样保留，预算刷新。已生效的改动不会被第二次执行。
 * interrupted（重启）在此破例允许续跑：§5.4 禁的是"自动复活执行"，
 * 用户显式点「继续」就是新的授权，批准令牌仍是一次性的。
 */
export async function retryRun(runId: string): Promise<string> {
  const view = find(runId);
  if (!view) throw new Error("任务不存在");
  if (view.status === "running") throw new Error("任务正在运行");
  if (controller) throw new RunBusyError();
  const skeleton = rebuildMessages(view);
  // P109-A：刷新的是**设置里那份预算**（`0 = 不限制`），不再是硬编码的 10 分钟
  const timeoutMs = resolveBudget({ timeoutMs: getSettings().agentTimeoutMins * 60_000 }).timeoutMs;
  const mark: RunEvent = {
    seq: view.events.length + 1,
    ts: Date.now(),
    kind: "status",
    text: `已从中断处继续任务（历史按事件台账重建 · 已生效 ${view.calls} 步不重做）`,
  };
  view.events = [...view.events, mark];
  view.status = "running";
  view.finishedAt = undefined;
  view.rounds = 0;
  view.calls = 0;
  view.caps = { ...view.caps, deadlineAt: timeoutMs > 0 ? Date.now() + timeoutMs : 0 };
  view.updatedAt = Date.now();
  activeRunId = runId;
  const ctrl = armController();
  notify();
  persist();
  await executeRun(view, ctrl, { timeoutMs, resumeFrom: skeleton, priorEvents: view.events.slice() });
  return runId;
}

/**
 * 「继续任务」可用性判定（UI 出不出这个按钮只认这一处，避免各处自说自话）。
 * P109-B：`paused` 现在也走这条路——它与 failed/interrupted 用的是同一套台账重放，
 * 差别只在 `resumeRun` 额外要求"必须是已暂停"这一入口校验。
 */
export function canRetry(runId: string): boolean {
  if (controller) return false;
  const view = find(runId);
  return !!view && (view.status === "paused" || view.status === "failed" || view.status === "interrupted");
}

/** 测试隔离：清空内存态与持久化（生产代码不调用）。 */
export function resetForTests(): void {
  controller?.abort();
  controller = null;
  runs = [];
  activeRunId = null;
  liveBuffers.clear();
  subRuns.clear();
  approved.clear();
  rejected.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* 忽略 */ }
  notify();
}
