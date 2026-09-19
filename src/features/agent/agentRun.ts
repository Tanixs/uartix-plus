/**
 * P88b-2：Agent 运行宿主——本机任务 UI 的单一数据源。
 * - 首版一个活动 run；事件台账有界（每 run 200 条）；
 * - 持久化脱敏台账到 localStorage（大 data 丢弃）：重启后未终止 run 标记
 *   interrupted 可回看，不复活执行、批准令牌与撤销令牌不跨重启（§5.4）；
 * - 数据订阅租约随 run 终止释放（§6.1）；run 活动期间保持本地任务轮询（§6）；
 * - 审批卡经 ApprovalGate 绑定 (tool, argsHash)，批准/拒绝/过期由宿主裁决（§7）。
 */
import { runAgent, DEFAULT_BUDGET } from "./loop";
import { invokeAgentProvider } from "./provider";
import { createLocalAgentAdapter, type ApprovalGate, type ApprovalRequest } from "./agentAdapter";
import { releaseDataLease } from "../plot/dataLease";
import { setLocalJobInterest } from "../mcp/jobExecutor";
import { undoSettingsDetailed, type UndoResult } from "./settingsTools";
import { undoOverlayDetailed } from "./appearanceStore";
import type { AgentResult, RunEvent, RunStatus } from "./types";

const EVENTS_CAP = 200;
const RUNS_KEPT = 20;
const STORE_KEY = "vs.agentRuns.v1";
const PERSIST_MS = 2000;

export interface AgentRunView {
  runId: string;
  goal: string;
  scope: "preview" | "create" | "custom";
  /** P88e B3：自定义档位勾选的授权域（续跑时原样继承） */
  allowed?: string[];
  status: RunStatus;
  rounds: number;
  calls: number;
  caps: { maxRounds: number; maxCalls: number; deadlineAt: number };
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** P88d：Agent 集成进 AI 对话——任务归属的会话 id（内联时间线按会话过滤） */
  sessionId?: string;
  events: RunEvent[];
  pending: ApprovalRequest | null;
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

/** P88e A2：被 Agent 任务占用的会话 id 集合。任何 run 关联的会话都算占用——任务过程在
 *  AgentInline 展示且不写聊天消息（messages 为空），若被 newSession 的空会话复用逻辑选中，
 *  用户点"新建"会原样切回旧任务视图（"新建还是显示之前的对话"）。终态 run 也计入：
 *  会话仍展示任务记录，同样不该被复用。 */
export function occupiedSessionIds(): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    if (typeof r.sessionId === "string" && r.sessionId) out.add(r.sessionId);
  }
  return out;
}

/* ================= 持久化（脱敏、有界） ================= */

function trimEvent(e: RunEvent): RunEvent {
  if (e.kind !== "receipt" || !e.receipt || e.receipt.data === undefined) return e;
  if (JSON.stringify(e.receipt.data).length <= 2048) return e;
  return { ...e, receipt: { ...e.receipt, data: undefined } };
}

function persist() {
  try {
    const payload = runs.slice(0, RUNS_KEPT).map((r) => ({
      ...r,
      events: r.events.slice(-EVENTS_CAP).map(trimEvent),
      pending: null,
    }));
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    /* 配额满/隐私模式：台账仅会话内可见 */
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
    scope,
    allowed: Array.isArray(o.allowed) ? o.allowed.filter((x): x is string => typeof x === "string") : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    status: o.status === "running" ? "interrupted" : (o.status ?? "interrupted"),
    rounds: typeof o.rounds === "number" ? o.rounds : 0,
    calls: typeof o.calls === "number" ? o.calls : 0,
    caps: o.caps,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : undefined,
    events: Array.isArray(o.events) ? o.events : [],
    pending: null,
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
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* 忽略 */ }
  notify();
}

/* ================= 审批门（§7） ================= */

interface ApprovalToken { token: string; exp: number }
const approved = new Map<string, ApprovalToken>(); // key = `${runId}|${tool}|${hash}`
const rejected = new Set<string>();

function makeGate(runId: string): ApprovalGate {
  return {
    request(req) {
      // 用户已明确拒绝的同参请求不再重复弹卡（模型重试由连续失败暂停兜底）
      if (rejected.has(`${runId}|${req.tool}|${req.argsHash}`)) return;
      const view = find(runId);
      if (!view) return;
      view.pending = req;
      notify();
      schedulePersist();
    },
    takeToken(rid, tool, hash, now) {
      const key = `${rid}|${tool}|${hash}`;
      const t = approved.get(key);
      if (!t) return null;
      approved.delete(key);
      if (now >= t.exp) return null; // 过期令牌作废，重新评估
      return t.token;
    },
    reject(req) {
      rejected.add(`${runId}|${req.tool}|${req.argsHash}`);
      const view = find(runId);
      if (view?.pending?.id === req.id) {
        view.pending = null;
        notify();
      }
    },
  };
}

export function approve(runId: string, approvalId: string): boolean {
  const view = find(runId);
  const req = view?.pending;
  if (!view || !req || req.id !== approvalId) return false;
  if (Date.now() >= req.expiresAt) {
    view.pending = null;
    notify();
    return false;
  }
  approved.set(`${runId}|${req.tool}|${req.argsHash}`, { token: crypto.randomUUID(), exp: req.expiresAt });
  rejected.delete(`${runId}|${req.tool}|${req.argsHash}`);
  view.pending = null;
  notify();
  return true;
}

export function reject(runId: string, approvalId: string): boolean {
  const view = find(runId);
  const req = view?.pending;
  if (!view || !req || req.id !== approvalId) return false;
  rejected.add(`${runId}|${req.tool}|${req.argsHash}`);
  view.pending = null;
  notify();
  return true;
}

/* ================= 撤销（§5.4：仅会话内有效，如实三态） ================= */

export function undoReceipt(runId: string, seq: number): UndoResult | null {
  const view = find(runId);
  const ev = view?.events.find((e) => e.seq === seq);
  const token = ev?.receipt?.undoToken;
  if (!view || !token) return null;
  // P88b-4：外观工具的撤销令牌路由到覆盖层（settings 与 appearance 的 token 空间互不相交）
  const result = ev?.tool?.startsWith("theme_") || ev?.tool === "save_theme_extension"
    ? undoOverlayDetailed(token)
    : undoSettingsDetailed(token);
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
  scope: "preview" | "create" | "custom";
  /** 自定义档位勾选的授权域（config/plugins/device）；scope 非 custom 时忽略 */
  allowed?: string[];
  /** P88d：任务归属的 AI 会话 id（内联时间线按会话过滤） */
  sessionId?: string;
  maxRounds?: number;
  maxCalls?: number;
  timeoutMs?: number;
}): Promise<string> {
  if (controller) throw new RunBusyError();
  const goal = options.goal.trim();
  if (!goal) throw new Error("任务目标不能为空");
  const runId = crypto.randomUUID();
  const now = Date.now();
  const maxRounds = Math.min(options.maxRounds ?? DEFAULT_BUDGET.maxRounds, DEFAULT_BUDGET.maxRounds);
  const maxCalls = Math.min(options.maxCalls ?? DEFAULT_BUDGET.maxCalls, DEFAULT_BUDGET.maxCalls);
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_BUDGET.timeoutMs, DEFAULT_BUDGET.timeoutMs);
  const view: AgentRunView = {
    runId, goal, scope: options.scope, status: "running", rounds: 0, calls: 0,
    ...(options.scope === "custom" ? { allowed: options.allowed ?? [] } : {}),
    sessionId: options.sessionId,
    caps: { maxRounds, maxCalls, deadlineAt: now + timeoutMs },
    createdAt: now, updatedAt: now, events: [], pending: null, undoState: {},
  };
  runs = [view, ...runs.filter((r) => r.runId !== runId)].slice(0, RUNS_KEPT);
  activeRunId = runId;
  notify();
  persist(); // 启动即落盘：首个事件前强关也能恢复 interrupted 记录（修"重启后啥也没有"）

  const gate = makeGate(runId);
  const adapter = createLocalAgentAdapter({ runId, gate });
  controller = new AbortController();
  const ctrl = controller;
  setLocalJobInterest(true);
  try {
    const result = await runAgent({
      goal,
      provider: invokeAgentProvider,
      adapter,
      context: {
        source: "local_agent", runId, signal: ctrl.signal, scope: options.scope,
        ...(options.scope === "custom" ? { allowed: options.allowed ?? [] } : {}),
      },
      maxRounds, maxCalls, timeoutMs,
      onEvent: (e) => pushEvent(runId, e),
    });
    finalize(runId, result);
  } catch {
    finalize(runId, null, "run_crashed");
  } finally {
    if (controller === ctrl) controller = null;
    releaseDataLease(runId); // §6.1：run 终止即回收租约
    if (!runs.some((r) => r.status === "running")) setLocalJobInterest(false);
    activeRunId = runs.find((r) => r.status === "running")?.runId ?? null;
    persist();
    notify();
  }
  return runId;
}

function pushEvent(runId: string, e: RunEvent) {
  const view = find(runId);
  if (!view) return;
  view.events = [...view.events.slice(-EVENTS_CAP + 1), e];
  view.rounds = Math.max(view.rounds, 0);
  view.updatedAt = Date.now();
  notify();
  schedulePersist();
}

/** 用 loop 真实结果回填终态；counts 取自 result，不采信模型自述（§5.2）。 */
function finalize(runId: string, result: AgentResult | null, crashCode?: string) {
  const view = find(runId);
  if (!view) return;
  if (result) {
    view.status = result.status;
    view.rounds = result.rounds;
    view.calls = result.calls;
    view.events = result.events.slice(-EVENTS_CAP).map(trimEvent);
  } else {
    view.status = "failed";
    // 宿主级崩溃也要留痕（P88d：失败必有原因）
    view.events = [
      ...view.events,
      { seq: view.events.length + 1, ts: Date.now(), kind: "turn", text: `执行出错：${crashCode ?? "未知错误"}` },
    ];
  }
  view.pending = null;
  view.finishedAt = Date.now();
  view.updatedAt = view.finishedAt;
}

export function stopRun(runId: string): void {
  const view = find(runId);
  if (!view || view.status !== "running" || !controller) return;
  controller.abort(); // §5.3 停止顺序：先停模型流，未执行调用由 loop 丢弃
  notify();
}

/**
 * P88e B3：暂停续跑——paused（预算耗尽/连续失败）不是可恢复的挂起态，续跑 =
 * 用原任务的 goal/scope/授权域/会话重新发起一个新 run；原 run 保留为台账，
 * 在会话时间线里折叠为更早记录。仅 paused 可续跑；interrupted（重启）不复活执行（§5.4）。
 */
export function resumeRun(runId: string): Promise<string> {
  const view = find(runId);
  if (!view) return Promise.reject(new Error("任务不存在"));
  if (view.status !== "paused") return Promise.reject(new Error("仅「已暂停」的任务可以继续"));
  return startRun({
    goal: view.goal,
    scope: view.scope,
    ...(view.scope === "custom" && view.allowed ? { allowed: view.allowed } : {}),
    sessionId: view.sessionId,
  });
}

/** 测试隔离：清空内存态与持久化（生产代码不调用）。 */
export function resetForTests(): void {
  controller?.abort();
  controller = null;
  runs = [];
  activeRunId = null;
  approved.clear();
  rejected.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* 忽略 */ }
  notify();
}
