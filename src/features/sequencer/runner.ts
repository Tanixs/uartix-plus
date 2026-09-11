/**
 * 测试序列执行引擎（T1）。
 *
 * 纯逻辑模块：不 import React / IPC / localStorage，与外部世界只通过
 * SequencerDeps 注入（发送、发送解析、帧流、变量、时钟）。UI 端（T3）注入
 * Tauri 实现，CLI（T5）注入 Node 实现，两边跑同一份引擎。
 *
 * 性能要点：
 * - 帧等待是事件驱动（单 waiter + notify），不轮询；
 * - 帧到达缓冲定长（frameBufCap），超出丢最旧，绝无无界数组；
 * - 结果树节点数有上限（resultCap），group 大循环不会撑爆内存；
 * - 控制流用返回值短路，不用异常做分支。
 */

import type { FrameRow } from "../../ipc/types";
import {
  LIMITS,
  type AssertVarStep,
  type CmpOp,
  type ExpectVal,
  type FrameMatch,
  type GroupStep,
  type RunProgress,
  type RunResult,
  type SendPayload,
  type SendStep,
  type Step,
  type StepResult,
  type StepStatus,
  type Suite,
  type WaitForFrameStep,
  type WaitStep,
} from "./types";

/* ================= 依赖注入 ================= */

export interface SequencerDeps {
  /** 最终发送（与 serialStore.sendData 同参） */
  send(mode: "ascii" | "hex", text: string): void | Promise<void>;
  /** 把 send 载荷解析成实际发送内容；null = 解析失败（如 cmdId 不存在） */
  resolveSend(payload: SendPayload): { mode: "ascii" | "hex"; text: string } | null;
  /** 订阅解码后帧流；返回取消订阅函数 */
  onFrames(cb: (rows: FrameRow[]) => void): () => void;
  getVar(name: string): number | string | undefined;
  now(): number;
}

export interface RunOptions {
  /** 单步调试：每步完成挂起，等 resume() */
  stepMode?: boolean;
  /** 覆盖 Suite 级 failFast */
  failFast?: boolean;
  onProgress?(p: RunProgress): void;
}

export interface RunHandle {
  stop(): void;
  /** 单步模式下放行下一步 */
  resume(): void;
  done: Promise<RunResult>;
}

type StartResult = { ok: true; handle: RunHandle } | { ok: false; error: string };

/* ================= 运行上下文 ================= */

interface FrameArrival {
  row: FrameRow;
  /** deps.now() 基准：waitForFrame 只认步骤开始之后到达的帧，不依赖设备时间戳 */
  arrivedAt: number;
}

interface Ctx {
  deps: SequencerDeps;
  suiteId: string;
  token: { cancelled: boolean };
  failFast: boolean;
  /** 单步调试：每步完成挂起等 resume */
  stepMode: boolean;
  frameBuf: FrameArrival[];
  /** 唤醒源：帧到达 / 超时 / 停止 / resume 都 resolve 它，醒来后重查条件 */
  wake: (() => void) | null;
  /** 单步闸门 */
  gate: (() => void) | null;
  stack: StepResult[][];
  resultCount: number;
  /** changed 断言的基准：每个变量上次被断言到的值 */
  lastAsserted: Map<string, number | string>;
  onProgress?: RunOptions["onProgress"];
}

const capDetail = (s: string) =>
  s.length > LIMITS.detailCap ? s.slice(0, LIMITS.detailCap) + "…" : s;

/* ================= 互斥与入口 ================= */

let active: { ctx: Ctx; suiteId: string } | null = null;

export function isRunning(): boolean {
  return active !== null;
}

export function startRun(suite: Suite, deps: SequencerDeps, opts: RunOptions = {}): StartResult {
  if (active) return { ok: false, error: "已有序列在运行，先停止当前序列" };

  const token = { cancelled: false };
  const ctx: Ctx = {
    deps,
    suiteId: suite.id,
    token,
    failFast: opts.failFast ?? suite.failFast,
    stepMode: opts.stepMode ?? false,
    frameBuf: [],
    wake: null,
    gate: null,
    stack: [],
    resultCount: 0,
    lastAsserted: new Map(),
    onProgress: opts.onProgress,
  };

  const topResults: StepResult[] = [];
  ctx.stack.push(topResults);

  const unsub = deps.onFrames((rows) => {
    for (const row of rows) {
      ctx.frameBuf.push({ row, arrivedAt: deps.now() });
    }
    if (ctx.frameBuf.length > LIMITS.frameBufCap) {
      ctx.frameBuf.splice(0, ctx.frameBuf.length - LIMITS.frameBufCap);
    }
    ctx.wake?.();
  });

  const startedAt = deps.now();
  const done = (async (): Promise<RunResult> => {
    let status: RunResult["status"] = "done";
    try {
      const failed = await runSteps(suite.steps, ctx, 1);
      if (token.cancelled) status = "aborted";
      else if (failed) status = "failed";
    } finally {
      unsub();
      active = null;
    }
    const result: RunResult = {
      suiteId: suite.id,
      suiteName: suite.name,
      startedAt,
      finishedAt: deps.now(),
      status,
      steps: topResults,
    };
    ctx.onProgress?.({
      status: "finished",
      suiteId: suite.id,
      currentStepId: null,
      results: topResults,
      result,
    });
    return result;
  })();

  const handle: RunHandle = {
    stop() {
      token.cancelled = true;
      ctx.wake?.();
      ctx.gate?.();
    },
    resume() {
      ctx.gate?.();
    },
    done,
  };
  active = { ctx, suiteId: suite.id };
  ctx.onProgress?.({ status: "running", suiteId: suite.id, currentStepId: null, results: topResults, result: null });
  return { ok: true, handle };
}

/** 不持有 handle 的全局停止入口（如后台徽标、AI 动作用） */
export function stopRun(): void {
  if (!active) return;
  active.ctx.token.cancelled = true;
  active.ctx.wake?.();
  active.ctx.gate?.();
}

/** 全局放行入口：单步模式下放行下一步（UI「继续」按钮用） */
export function resumeRun(): void {
  active?.ctx.gate?.();
}

/* ================= 唤醒原语 ================= */

/** 等待任意唤醒（帧到达 / 超时 / 停止 / resume）。返回时必须重查自己的条件。 */
function waitWake(ctx: Ctx, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fin = () => {
      ctx.wake = null;
      if (timer) clearTimeout(timer);
      resolve();
    };
    ctx.wake = fin;
    if (ms > 0 && Number.isFinite(ms)) timer = setTimeout(fin, ms);
  });
}

function waitGate(ctx: Ctx): Promise<void> {
  return new Promise((resolve) => {
    ctx.gate = () => {
      ctx.gate = null;
      resolve();
    };
  });
}

/* ================= 步骤执行 ================= */

/** 执行一组步骤。返回值 = 本组是否出现「按当前策略需要向上报告」的失败 */
async function runSteps(steps: Step[], ctx: Ctx, depth: number): Promise<boolean> {
  let failed = false;
  for (const step of steps) {
    if (ctx.token.cancelled) {
      // 中止后未执行的步骤记 skipped，报告完整
      pushResult(ctx, skippedResult(step));
      failed = failed || true;
      continue;
    }
    if (depth > LIMITS.groupDepthMax) {
      pushResult(ctx, {
        stepId: step.id,
        kind: step.kind,
        label: stepLabel(step),
        status: "fail",
        startedAt: ctx.deps.now(),
        durationMs: 0,
        detail: `嵌套超过 ${LIMITS.groupDepthMax} 层，拒绝执行`,
      });
      failed = true;
      continue;
    }
    if (!step.enabled) {
      pushResult(ctx, skippedResult(step));
      continue;
    }

    const startedAt = ctx.deps.now();
    let result: StepResult;
    try {
      result = await execStep(step, ctx, startedAt, depth);
    } catch (e) {
      result = {
        stepId: step.id,
        kind: step.kind,
        label: stepLabel(step),
        status: "fail",
        startedAt,
        durationMs: ctx.deps.now() - startedAt,
        detail: capDetail(String(e)),
      };
    }

    // 单步调试：每步完成后挂起（停止时 gate 被唤醒，下一轮顶部检测 cancelled）
    if (ctx.stepMode && !ctx.token.cancelled) {
      ctx.onProgress?.({
        status: "awaitingStep",
        suiteId: ctx.suiteId,
        currentStepId: step.id,
        results: ctx.stack[0],
        result: null,
      });
      await waitGate(ctx);
    }

    pushResult(ctx, result);
    const bad = result.status !== "pass" && result.status !== "skipped";
    if (bad) failed = true;
    // failFast：任何失败立刻短路本组（aborted 时也要把剩余步骤标 skipped 后退出）
    if (bad && (ctx.failFast || ctx.token.cancelled)) {
      // 剩余未跑的步骤标 skipped，报告完整
      const idx = steps.indexOf(step);
      for (const rest of steps.slice(idx + 1)) pushResult(ctx, skippedResult(rest));
      return failed;
    }
  }
  return failed;
}

function stepLabel(step: Step): string {
  if (step.kind === "group") return step.name || "分组";
  if (step.kind === "note") return "备注";
  return step.kind;
}

function skippedResult(step: Step): StepResult {
  return {
    stepId: step.id,
    kind: step.kind,
    label: stepLabel(step),
    status: "skipped",
    startedAt: 0,
    durationMs: 0,
    detail: step.enabled ? "因中止/失败短路而未执行" : "已禁用",
  };
}

function pushResult(ctx: Ctx, r: StepResult) {
  const list = ctx.stack[ctx.stack.length - 1];
  // 结果树节点上限：超大循环只计数不记录，防内存失守
  if (ctx.resultCount >= LIMITS.resultCap) {
    if (list.length === 0 || list[list.length - 1].detail !== "（结果已截断）") {
      list.push({
        stepId: "_truncated",
        kind: "note",
        label: "结果截断",
        status: "skipped",
        startedAt: 0,
        durationMs: 0,
        detail: "（结果已截断）",
      });
    }
    return;
  }
  ctx.resultCount++;
  list.push(r);
}

async function execStep(step: Step, ctx: Ctx, startedAt: number, depth: number): Promise<StepResult> {
  const base = { stepId: step.id, kind: step.kind, label: stepLabel(step), startedAt };
  switch (step.kind) {
    case "send":
      return await execSend(step, ctx, base);
    case "wait":
      return await execWait(step, ctx, base);
    case "waitForFrame":
      return await execWaitFrame(step, ctx, base);
    case "assertVar":
      return execAssert(step, ctx, base);
    case "note":
      return { ...base, status: "pass", durationMs: 0, detail: step.text };
    case "group":
      return await execGroup(step, ctx, base, depth);
  }
}

type ResultBase = Pick<StepResult, "stepId" | "kind" | "label" | "startedAt">;

async function execSend(step: SendStep, ctx: Ctx, base: ResultBase): Promise<StepResult> {
  const resolved = ctx.deps.resolveSend(step.payload);
  if (!resolved) {
    return { ...base, status: "fail", durationMs: 0, detail: "发送内容解析失败（命令不存在或载荷无效）" };
  }
  try {
    await ctx.deps.send(resolved.mode, resolved.text);
    return {
      ...base,
      status: "pass",
      durationMs: ctx.deps.now() - base.startedAt,
      detail: `${resolved.mode === "hex" ? "HEX" : "TXT"} ${resolved.text}`,
    };
  } catch (e) {
    return {
      ...base,
      status: "fail",
      durationMs: ctx.deps.now() - base.startedAt,
      detail: capDetail(`发送失败：${String(e)}`),
    };
  }
}

async function execWait(step: WaitStep, ctx: Ctx, base: ResultBase): Promise<StepResult> {
  const ms = Math.min(Math.max(Math.round(step.ms), LIMITS.waitMinMs), LIMITS.waitMaxMs);
  const until = ctx.deps.now() + ms;
  for (;;) {
    if (ctx.token.cancelled) {
      return { ...base, status: "aborted", durationMs: ctx.deps.now() - base.startedAt, detail: "已停止" };
    }
    const remain = until - ctx.deps.now();
    if (remain <= 0) {
      return { ...base, status: "pass", durationMs: ctx.deps.now() - base.startedAt, detail: `${ms}ms` };
    }
    await waitWake(ctx, remain);
  }
}

async function execWaitFrame(
  step: WaitForFrameStep,
  ctx: Ctx,
  base: ResultBase,
): Promise<StepResult> {
  const stepStart = ctx.deps.now();
  const timeoutMs = Math.max(0, Math.min(Math.round(step.timeoutMs), LIMITS.frameTimeoutMaxMs));
  const deadline = timeoutMs > 0 ? stepStart + timeoutMs : Number.POSITIVE_INFINITY;

  for (;;) {
    if (ctx.token.cancelled) {
      return { ...base, status: "aborted", durationMs: ctx.deps.now() - base.startedAt, detail: "已停止" };
    }
    // 从缓冲找步骤开始后到达的第一条匹配帧
    const hitIdx = ctx.frameBuf.findIndex((f) => f.arrivedAt >= stepStart && matchFrame(f.row, step.match, ctx.deps.getVar));
    if (hitIdx >= 0) {
      const hit = ctx.frameBuf[hitIdx];
      // 消费掉这条及更早的帧（旧帧不再参与后续匹配）
      ctx.frameBuf.splice(0, hitIdx + 1);
      return {
        ...base,
        status: "pass",
        durationMs: ctx.deps.now() - base.startedAt,
        detail: capDetail(describeFrame(hit.row)),
      };
    }
    if (ctx.deps.now() >= deadline) {
      return {
        ...base,
        status: "timeout",
        durationMs: ctx.deps.now() - base.startedAt,
        detail: timeoutMs > 0 ? `${timeoutMs}ms 内未等到匹配帧` : "无限等待被停止",
      };
    }
    await waitWake(ctx, deadline - ctx.deps.now());
  }
}

function describeFrame(row: FrameRow): string {
  const fields = row.fields.length
    ? " " + row.fields.map((f) => `${f.name}=${f.text ?? f.value}`).join(" ")
    : "";
  return `[${row.tplName}] len=${row.len}${fields}`;
}

/** hex 字符串 → 字节数组（去空白，非法字符返回 null） */
function hexToBytes(hex: string): number[] | null {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const b = Number.parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return null;
    out.push(b);
  }
  return out;
}

function matchFrame(
  row: FrameRow,
  match: FrameMatch,
  getVar: SequencerDeps["getVar"],
): boolean {
  if (match.by === "raw") {
    const pat = hexToBytes(match.hex);
    if (!pat || !row.bytes || row.bytes.length < pat.length) return false;
    outer: for (let i = 0; i <= row.bytes.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (row.bytes[i + j] !== pat[j]) continue outer;
      return true;
    }
    return false;
  }
  if (row.tplId !== match.tplId || !row.valid) return false;
  if (match.by === "tpl") return true;
  // field
  const f = row.fields.find((x) => x.name === match.fieldName || x.id === match.fieldName);
  if (!f) return false;
  const e = resolveExpected(match.expected, getVar);
  if (e === null) return false;
  return compareValues(f.value, match.op, e, 0);
}

/** 触发器/外部判断用：与执行期 waitForFrame 同一匹配语义 */
export function testFrameMatch(
  row: FrameRow,
  match: FrameMatch,
  getVar: SequencerDeps["getVar"],
): boolean {
  return matchFrame(row, match, getVar);
}

/* ================= 变量断言 ================= */

/** 返回 null = 期望解析失败（变量不存在），调用方区分处理 */
function resolveExpected(e: ExpectVal | undefined, getVar: SequencerDeps["getVar"]): number | string | null {
  if (e === undefined || typeof e === "number") return e ?? null;
  const v = getVar(e.var);
  return v === undefined ? null : v;
}

/**
 * 值比较。eq/ne 直接比较（字符串可参与）；数值运算符把两侧转数字，
 * 任一侧转出 NaN 即视为不成立（类型不符也是一种 fail，detail 会带原值）。
 */
function compareValues(
  v: number | string,
  op: CmpOp,
  e: number | string | null,
  tolerance: number,
): boolean {
  if (op === "eq") return v === e;
  if (op === "ne") return v !== e;
  const n = typeof v === "number" ? v : Number(v);
  const en = typeof e === "number" ? e : e === null ? Number.NaN : Number(e);
  if (Number.isNaN(n) || Number.isNaN(en)) return false;
  return compareNum(n, op, en, tolerance);
}

function compareNum(v: number, op: CmpOp, e: number, tolerance: number): boolean {
  switch (op) {
    case "gt":
      return v > e;
    case "lt":
      return v < e;
    case "ge":
      return v >= e;
    case "le":
      return v <= e;
    case "approx":
      return Math.abs(v - e) <= tolerance;
    case "changed":
      return v !== e;
    default:
      return v === e;
  }
}

function execAssert(step: AssertVarStep, ctx: Ctx, base: ResultBase): StepResult {
  const cur = ctx.deps.getVar(step.varName);
  if (cur === undefined) {
    return { ...base, status: "fail", durationMs: 0, detail: `变量 ${step.varName} 不存在` };
  }
  const prevAsserted = ctx.lastAsserted.get(step.varName);

  let ok: boolean;
  let expectText: string;
  if (step.op === "changed") {
    // changed = 与本序列上一次断言到的值不同（首次断言时只记录基准并判 fail）
    ok = prevAsserted !== undefined && cur !== prevAsserted;
    expectText = `≠ 上次值 ${prevAsserted === undefined ? "（无基准）" : String(prevAsserted)}`;
  } else {
    const expected = resolveExpected(step.expected, ctx.deps.getVar);
    if (expected === null) {
      return { ...base, status: "fail", durationMs: 0, detail: "期望引用的变量不存在" };
    }
    ok = compareValues(cur, step.op, expected, step.tolerance ?? 0);
    expectText = `${opText(step.op)} ${String(expected)}`;
  }
  // 断言后更新基准（无论成败，基准跟随最新值，连续 changed 才有意义）
  ctx.lastAsserted.set(step.varName, cur);
  return {
    ...base,
    status: ok ? "pass" : "fail",
    durationMs: ctx.deps.now() - base.startedAt,
    detail: `${step.varName} = ${String(cur)} 期望${expectText}${ok ? "" : " ✗"}`,
  };
}

function opText(op: CmpOp): string {
  switch (op) {
    case "eq": return "=";
    case "ne": return "≠";
    case "gt": return ">";
    case "lt": return "<";
    case "ge": return "≥";
    case "le": return "≤";
    case "approx": return "≈";
    case "changed": return "";
  }
}

/* ================= 分组 ================= */

async function execGroup(
  step: GroupStep,
  ctx: Ctx,
  base: ResultBase,
  depth: number,
): Promise<StepResult> {
  const repeats = Math.min(Math.max(Math.round(step.repeats), 1), LIMITS.groupRepeatsMax);
  const children: StepResult[] = [];
  let attempts = 0;
  let sawFail = false;

  ctx.stack.push(children);
  try {
    for (let round = 0; round < repeats; round++) {
      if (ctx.token.cancelled) break;
      attempts++;
      const roundFailed = await runSteps(step.children, ctx, depth + 1);
      if (roundFailed) {
        sawFail = true;
        if (step.onFailure === "abort") break;
      }
    }
  } finally {
    ctx.stack.pop();
  }

  const status: StepStatus = ctx.token.cancelled
    ? "aborted"
    : sawFail
      ? "fail"
      : attempts < repeats
        ? "skipped"
        : "pass";
  return {
    ...base,
    status,
    durationMs: ctx.deps.now() - base.startedAt,
    detail:
      `${attempts}/${repeats} 轮` +
      (sawFail ? `（${step.onFailure === "abort" ? "失败短路" : "失败续跑"}）` : "") +
      (attempts < repeats && !ctx.token.cancelled && step.onFailure === "abort"
        ? "，剩余轮次未执行"
        : ""),
    children,
    attempts,
  };
}
