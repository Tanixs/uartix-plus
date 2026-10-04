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
import { openPlanText } from "./planLedger";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { hasDataLease } from "../plot/dataLease";
import { shrinkByShape } from "./shrink";
import { RECEIPT_DATA_LIMIT } from "./context";
import { ARTIFACT_PAGE_BYTES } from "./localEntries";
import { hasDomain, isFullAuthority, type Domain } from "./scopeTiers";
import { hostEntryNames, hostToolEntries } from "./hostEntries";
import { SUBAGENT_FACE } from "./subagent";
import {
  buildToolCtx,
  createToolRegistry,
  runToolCall,
  newRunScratch,
  type AgentToolEntry,
  type ApprovalGate,
  type PipelineHooks,
  type RunScratch,
  type ToolCtx,
} from "./toolRegistry";
import type { SubagentDispatch, TaskAdapter, TaskContext, ToolReceipt } from "./types";

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
  /** P135-B：只读子代理的派发装配。缺省不接 ⇒ `subagent` 这条工具如实回 `subagent_unavailable` */
  subagent?: SubagentDispatch;
}

/**
 * 超限回执的裁剪 + 原文入库（`createLocalAgentAdapter` 与只读子适配器**共用这一份**）。
 *
 * 顺序（P94-G3 + P95-H3）：**未超限原样**（不能为了"压得更聪明"而销毁逐点保真度）；
 * 超限才**先按形态压缩**（`shrinkByShape`），并且**先把原文存进 artifacts 再发引用** ⇒ `artifactRef`
 * 一定取得回来（红线：压缩不能等于销毁）。压完仍 >8 KiB 才退化成"预览占位"。
 */
function rememberArtifact(scratch: RunScratch, receipt: ToolReceipt): ToolReceipt {
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
}

export function createLocalAgentAdapter(opts: LocalAgentAdapterOpts): TaskAdapter & {
  artifacts: Map<string, unknown>;
  leaseActive: () => boolean;
} {
  const { runId, gate } = opts;
  const scope = opts.scope ?? "create";
  const allowed = opts.allowed ?? [];
  const scratch = newRunScratch(opts.subagent);

  const registry = createToolRegistry([...hostToolEntries(), ...(opts.extraEntries ?? [])]);

  const remember = (receipt: ToolReceipt): ToolReceipt => rememberArtifact(scratch, receipt);

  const hooks: PipelineHooks = {
    truncate: remember,
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
    // P133-H：八域全开＝「全权执行」。策略侧据此跳过那两类"软件内部且宿主留了退路"的批准，
    // 每张批准卡的**产生与跳过**都只由这一个事实决定，模型改不了它。
    fullAuthority: isFullAuthority(t.scope, t.allowed),
  }, scratch);

  return {
    artifacts: scratch.artifacts,
    leaseActive: () => hasDataLease(runId),
    // 每 run 冻结一次：本任务可见的工具面＝建适配器那一刻的快照（详设 §4.5-2）
    definitions: registry.modelDefinitions(scope, allowed),
    execute: (call, ctx) => runToolCall(registry, call, makeCtx(ctx), hooks),
    /**
     * P135-A：压缩时（`pruneToolResults`）交回来的原文进**同一张** artifacts 表
     * ⇒ `read_artifact` 拿那个 ref 一定读得到，裁剪说明才敢承诺"可取回"。
     * 红线"压缩不能等于销毁"在这一层的具体形态：销毁的只是这一轮发出去的字节。
     */
    spill: (ref, original) => {
      scratch.artifacts.set(ref, original);
      return ref;
    },
    // P109-C：完成契约的读数口。loop 在模型想收工时问一次，不自己认计划。
    openPlan: () => openPlanText(runId),
  };
}

/** 自省用：当前宿主工具面上有哪些工具（C1 的 app_catalog 与运行时上下文快照同源） */
export function hostToolNames(): string[] {
  return hostEntryNames();
}

/**
 * 子代理那条通路的批准门：**永不发批准卡**。
 * 只读面本来走不到批准那一步，所以这是二道闸——万一名单里混进一支要批准的，
 * 它的落点是 `needs_local_approval`（"这条通路没有能批准的界面"），
 * 而不是从子任务里冒出一张用户没有预期的卡。
 */
const silentGate: ApprovalGate = { request: () => {}, takeToken: () => null, reject: () => {} };

/**
 * P135-B：只读子代理的适配器。与主适配器**同一条管线**（域裁剪 → 策略 → 执行 → 按引用裁剪 → 盖来源），
 * 差别只有三处，每一处都对应"只读 / 不扩权 / 不递归"里的一件：
 *  1. 工具面是点名白名单（`SUBAGENT_FACE`），不是全量宿主面；
 *  2. 批准门发不出卡（`silentGate`）；
 *  3. 不接子代理装配（`newRunScratch()` 不带 dispatch）⇒ 子里再也派不出子。
 * 授权域**照抄父任务那份** `(scope, allowed)` 再裁一次 `modelDefinitions` ——
 * 父读不到的，子也读不到；这是"不能再扩权"的实现处。
 */
export function createReadOnlyAgentAdapter(opts: {
  runId: string;
  scope?: TaskContext["scope"];
  allowed?: readonly string[];
}): TaskAdapter {
  const scope = opts.scope ?? "create";
  const allowed = opts.allowed ?? [];
  const wanted = new Set<string>(SUBAGENT_FACE);
  const entries = hostToolEntries().filter((e) => wanted.has(e.name));
  // 名单与注册表漂了要出声：静默少一支工具只会让人去怀疑模型，而它是装配缺失
  const missing = [...wanted].filter((n) => !entries.some((e) => e.name === n));
  if (missing.length) console.warn(`[agentAdapter] 子代理名单里 ${missing.length} 支不存在或已改名：${missing.join("、")}`);
  const registry = createToolRegistry(entries);
  const scratch = newRunScratch();
  const hooks: PipelineHooks = {
    truncate: (r) => rememberArtifact(scratch, r),
    gate: silentGate,
    now: () => Date.now(),
    newRequestId: () => crypto.randomUUID(),
  };
  const makeCtx = (t: TaskContext): ToolCtx => buildToolCtx(t, {
    scope: t.scope,
    authorized: (key) => hasDomain(t.scope, t.allowed ?? [], key as Domain),
    operatorLocked: operatorLocked(),
    deviceContext: deviceContext(),
    fullAuthority: isFullAuthority(t.scope, t.allowed ?? []),
  }, scratch);
  return {
    definitions: registry.modelDefinitions(scope, allowed),
    execute: (call, ctx) => runToolCall(registry, call, makeCtx(ctx), hooks),
  };
}
