/**
 * P88b-2 §12：本机 Agent 适配器的**装配层**。
 *
 * P99a-A2/A3 之后这里不再有派发 `if` 链，也不再手写工具定义：本文件只做四件事——
 *  1. 取宿主工具清单（`hostEntries`）拼上本 run 新增的插件工具，建**一条注册表**并冻结快照；
 *  2. 提供管线需要的宿主侧挂钩：策略上下文（串口/Operator）、按引用裁剪出口、审批门；
 *  3. 按授权域裁剪"发给模型的定义"（与执行拒绝同一处判定，不再有两套词汇）；
 *  4. 把 `agentRun` 需要的两张派生表（撤销路由）投影出去。
 *
 * 门禁（abort → 域 → 策略 → 人工批准 → 执行 → 裁剪）全在 `toolRegistry.runToolCall`，
 * 不在任何 handler 里——这是"忘记检查不再可能"的那处结构保证（详设 §4.2）。
 */
import { getSnapshot as getOperator } from "../operator/operatorStore";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { hasDataLease } from "../plot/dataLease";
import { shrinkByShape } from "./shrink";
import { RECEIPT_DATA_LIMIT } from "./context";
import { ARTIFACT_PAGE_BYTES } from "./localEntries";
import { hasDomain, type Domain } from "./scopeTiers";
import { hostEntryNames, hostToolEntries } from "./hostEntries";
import {
  buildToolCtx,
  createToolRegistry,
  runToolCall,
  newRunScratch,
  type AgentToolEntry,
  type ApprovalGate,
  type PipelineHooks,
  type ToolCtx,
} from "./toolRegistry";
import type { TaskAdapter, TaskContext, ToolReceipt } from "./types";

export function deviceContext(): "real" | "sim" | "unknown" {
  const s = getSerial();
  // 无法判定是否实车时按 unknown 处理，不猜成仿真（HANDOVER §6.3）
  return s.status === "connected" ? "real" : "unknown";
}

function operatorLocked(): boolean {
  return getOperator().pkg !== null;
}

export interface LocalAgentAdapterOpts {
  runId: string;
  gate: ApprovalGate;
  /** P93-A6：本任务的档位与授权域。缺省按 create（与旧行为一致），用于**裁剪下发**与**执行拒绝**（同一处判定）。 */
  scope?: TaskContext["scope"];
  allowed?: string[];
  /** P99a-B：插件注册进来的工具。缺省不取（测试与 MCP 走不到插件面） */
  extraEntries?: readonly AgentToolEntry[];
}

export function createLocalAgentAdapter(opts: LocalAgentAdapterOpts): TaskAdapter & {
  artifacts: Map<string, unknown>;
  leaseActive: () => boolean;
} {
  const { runId, gate } = opts;
  const scope = opts.scope ?? "create";
  const allowed = opts.allowed ?? [];
  const scratch = newRunScratch();

  const registry = createToolRegistry([...hostToolEntries(), ...(opts.extraEntries ?? [])]);

  /**
   * 回执裁剪的唯一入口（P94-G3 + P95-H3）。顺序：**未超限原样**（不能为了"压得更聪明"而销毁逐点保真度）；
   * 超限才**先按形态压缩**（`shrinkByShape`），并且**先把原文存进 artifacts 再发引用** ⇒ `artifactRef` 一定取得回来
   * （红线：压缩不能等于销毁）。压完仍 >8 KiB 才退化成"预览占位"。
   * 不可存的（read_artifact 自己的分页结果）走 entry.truncate:false 跳过这里。
   */
  const rememberArtifact = (receipt: ToolReceipt): ToolReceipt => {
    if (receipt.data === undefined) return receipt;
    const original = receipt.data;
    const originalBytes = JSON.stringify(original).length;
    if (originalBytes <= RECEIPT_DATA_LIMIT) return receipt;
    const shaped = shrinkByShape(receipt);
    // 只要超限就先存原文再发 ref：压缩不能等于销毁
    const ref = `call:${receipt.callId}`;
    scratch.artifacts.set(ref, original);
    const meta = {
      shrunk: { shape: shaped.shape, dropped: shaped.dropped, fullBytes: originalBytes },
      artifactRef: ref,
      fullBytes: originalBytes,
      note: `完整内容已缓存，用 read_artifact { ref: "${ref}" } 分页取回（每页 ${ARTIFACT_PAGE_BYTES} 字节）`,
    };
    const shapedBytes = JSON.stringify(shaped.data).length;
    // 数组型 data 不能 spread 成对象（会把 `[a,b]` 变成 `{0:a,1:b}`）——引用走回执自带的 artifactRefs
    if (Array.isArray(shaped.data)) {
      return { ...receipt, artifactRefs: [ref], data: shaped.data };
    }
    if (shapedBytes <= RECEIPT_DATA_LIMIT && shaped.data !== null && typeof shaped.data === "object") {
      return { ...receipt, data: { ...(shaped.data as Record<string, unknown>), ...meta } };
    }
    const preview = typeof shaped.data === "string"
      ? shaped.data.slice(0, 2000)
      : JSON.stringify(shaped.data).slice(0, 2000);
    return { ...receipt, data: { truncated: true, preview, ...meta } };
  };

  const hooks: PipelineHooks = {
    truncate: rememberArtifact,
    gate,
    now: () => Date.now(),
    newRequestId: () => crypto.randomUUID(),
  };

  const makeCtx = (t: TaskContext): ToolCtx => buildToolCtx(t, {
    scope: t.scope,
    // 授权判定统一走 hasDomain（P92-C）：create 档=config+plugins 两域；custom 档=勾选集；preview 恒否
    authorized: (key) => hasDomain(t.scope, t.allowed, key as Domain),
    operatorLocked: operatorLocked(),
    deviceContext: deviceContext(),
  }, scratch);

  return {
    artifacts: scratch.artifacts,
    leaseActive: () => hasDataLease(runId),
    // 每 run 冻结一次：本任务可见的工具面＝建适配器那一刻的快照（详设 §4.5-2）
    definitions: registry.modelDefinitions(scope, allowed),
    execute: (call, ctx) => runToolCall(registry, call, makeCtx(ctx), hooks),
  };
}

/** 自省用：当前宿主工具面上有哪些工具（C1 的 app_catalog 与运行时上下文快照同源） */
export function hostToolNames(): string[] {
  return hostEntryNames();
}
