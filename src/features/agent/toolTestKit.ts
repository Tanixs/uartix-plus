/**
 * P99a-A7：工具组单测的公共夹具。
 *
 * 只依赖 `toolRegistry` 与类型，**不 import 任何 store 或适配器**——工具组测试因此不必再
 * 为了被拖进 appActions/serialStore 而 mock 六个模块（旧 generalTools.test 就是这么写的）。
 * 生产装配路径（真实 deviceContext / operatorLocked）由 `adapterPipeline.test.ts` 直接跑
 * `createLocalAgentAdapter` 覆盖一次；这里保证的是"工具组跑的确实是同一条管线"。
 */
import {
  buildToolCtx, createToolRegistry, newRunScratch, runToolCall,
  type AgentToolEntry, type ApprovalGate, type RunScratch,
} from "./toolRegistry";
import { hasDomain, type Domain } from "./scopeTiers";
import type { PolicyContext } from "./toolPolicy";
import type { RunScope, TaskContext, ToolCall, ToolReceipt } from "./types";

/** 宿主时钟固定值：批准卡上的 expiresAt = now + TTL，测试要能钉住绝对值 */
export const HARNESS_NOW = 1_700_000_000_000;

export interface HarnessCtxOpts {
  scope?: RunScope;
  allowed?: string[];
  runId?: string;
  signal?: AbortSignal;
}

export interface HarnessOpts {
  /** 只要求 ApprovalGate：要断言批准行为就传 `recordingGate()` 的返回值，自己读它的 requests */
  gate?: ApprovalGate;
  /** 覆盖策略上下文里与档位无关的两项（测 Operator 锁、实车判定） */
  policy?: Partial<Pick<PolicyContext, "operatorLocked" | "deviceContext">>;
}

/** 记录型审批门：request 攒起来供断言，takeToken 只在测试显式 approve 后放行 */
export function recordingGate() {
  const requests: unknown[] = [];
  const granted = new Set<string>();
  return {
    requests,
    /** 模拟"用户点了批准"：按参数哈希放行 */
    approve: (argsHash: string) => granted.add(argsHash),
    /** 只批准第 n 次要批准的这一条（不自己算哈希时用这个） */
    approveLatest: () => {
      const last = requests[requests.length - 1] as { argsHash?: string } | undefined;
      if (!last?.argsHash) throw new Error("还没有任何批准请求");
      granted.add(last.argsHash);
    },
    request: (r: { argsHash: string }) => { requests.push(r); },
    takeToken: (_runId: string, _tool: string, hash: string) => (granted.has(hash) ? "tok" : null),
    reject: () => {},
  };
}
export type RecordingGate = ReturnType<typeof recordingGate> & ApprovalGate;

export function toolHarness(entries: readonly AgentToolEntry[], opts: HarnessOpts = {}) {
  const registry = createToolRegistry(entries);
  const gate = opts.gate ?? (recordingGate() as RecordingGate);
  const scratch: RunScratch = newRunScratch();
  const toCtx = (t: TaskContext) => buildToolCtx(
    t,
    {
      scope: t.scope,
      // 与生产同一实现：authorized 就是 hasDomain，测试里不另造一套授权词汇
      authorized: (key) => hasDomain(t.scope, t.allowed, key as Domain),
      operatorLocked: opts.policy?.operatorLocked ?? false,
      deviceContext: opts.policy?.deviceContext ?? "sim",
    },
    scratch,
  );
  const exec = (call: ToolCall, c: HarnessCtxOpts = {}): Promise<ToolReceipt> => runToolCall(
    registry,
    call,
    toCtx({
      source: "local_agent",
      runId: c.runId ?? "r1",
      signal: c.signal ?? new AbortController().signal,
      scope: c.scope ?? "create",
      allowed: c.allowed ?? [],
    }),
    { truncate: (r) => r, gate, now: () => HARNESS_NOW, newRequestId: () => "req-harness" },
  );
  const run = (name: string, args: Record<string, unknown> = {}, c: HarnessCtxOpts = {}, callId = "c1") =>
    exec({ callId, name, arguments: JSON.stringify(args) }, c);
  /** 坏 JSON 之类的入口行为要能直接喂 ToolCall */
  const runRaw = (name: string, rawArgs: string, c: HarnessCtxOpts = {}, callId = "c1") =>
    exec({ callId, name, arguments: rawArgs }, c);
  return { registry, gate, scratch, run, runRaw, exec };
}
