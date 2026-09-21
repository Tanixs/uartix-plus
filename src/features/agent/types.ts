export interface ToolCall { callId: string; name: string; arguments: string }
/**
 * P99a-A4：这条回执是哪一面提供的。插件注册的工具必须在台账与 UI 上与宿主工具分得开——
 * 否则"第三方代码让模型做了什么"在日志里根本无从回答（详设 §1.2 第 13 号静默点）。
 */
export type ToolProvenance = { kind: "host" } | { kind: "plugin"; pkgId: string; version: string };
export interface ToolReceipt {
  callId: string; ok: boolean; status: "applied" | "read" | "validated" | "not_executed" | "error";
  code?: string; data?: unknown; revision?: string; undoToken?: string; artifactRefs?: string[];
  /** 由管线盖（handler 给不了也不该给） */
  src?: ToolProvenance;
}
export interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string; calls?: ToolCall[]; callId?: string; /** P90 B6：随首条 user 消息附带的图片（data URL，已压缩） */ images?: string[] }
export interface ModelTurn { content: string; calls: ToolCall[]; /** P90 B1：模型思维文本（仅展示，不回灌历史）；不产思考时缺省 */ reasoning?: string }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
/** P91 A1：单轮可选参数（增量回调 + 输出预算）。provider 第三/四参都可忽略，
 *  测试里的假 provider 保持二参签名即可。 */
export interface TurnOptions {
  /** 思维链/正文增量（流式边到边显示；非流式 provider 不调用） */
  onDelta?: (kind: "text" | "reasoning", delta: string) => void;
  /** 单轮输出预算；截断类失败后由 loop 逐级下调重试 */
  maxTokens?: number;
  /** P96-K4：本轮是否让模型"先想后答"。缺省=跟随设置项；loop 在空闲超时重试时显式传 false */
  thinking?: boolean;
}
export type AgentProvider = (messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal, options?: TurnOptions) => Promise<ModelTurn>;
/** P91 A2：宿主回传的结构化单轮错误（IPC 只有 String 通道，故 JSON 传输）。
 *  retryable=可自动退避重试；shrink=重试前应下调**输出**预算；
 *  P95-H1 shrinkInput=是**输入侧**超限，重试前必须收缩上下文（丢历史图/收紧折叠）——
 *  两者不能混用：降 max_tokens 对"发出去的东西太大"一点用都没有，旧实现正是栽在这里。 */
export interface TurnError { agentError: 1; code: string; msg: string; retryable: boolean; shrink: boolean; shrinkInput?: boolean }
/** 自动执行档位（P88b §4.3）。三值是**已持久化**的枚举（台账/MCP/设置都在用），
 *  具名预设见 `scopeTiers.TIERS`：一档 = 一个本枚举值 + 一组授权域。
 *  P97-I4 收编：本枚举此前在 4 处各自字面量，新增一档要改四处且漏一处即静默。 */
export type RunScope = "preview" | "create" | "custom";
export interface TaskContext {
  source: "local_agent";
  runId: string;
  signal: AbortSignal;
  scope: RunScope;
  /** 本档位勾选的授权域（清单见 `scopeTiers.DOMAINS`）；scope 非 custom 时由 hasDomain 忽略 */
  allowed?: string[];
}
export interface TaskAdapter { definitions: ToolDefinition[]; execute(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> }
export type RunStatus = "running" | "succeeded" | "paused" | "cancelled" | "failed" | "interrupted";
/** P89 A1：running（实时进度）与 paused（就地等用户点「继续任务」）需自动展开；
 *  其余为终态，会话内联流里一律折叠为一行摘要，不遮挡消息。 */
export function isLiveRun(status: RunStatus): boolean {
  return status === "running" || status === "paused";
}
/** P95-H2：一次发送实际带了多少东西（"模型这次看到什么"从内部知识变成可重放事实）。 */
export interface ContextStat {
  /** 估算的 UTF-8 请求字节数（消息 + 工具定义） */
  bytes: number;
  /** 送入的消息条数 */
  msgs: number;
  /** 上下文里剩余的附图张数（含本轮目标） */
  images: number;
  /** 为塞进去而丢掉的历史附图张数 */
  droppedImages?: number;
  /** 被折叠成一条摘要的中间消息条数 */
  folded?: number;
  /** 施压到哪一级：none < images < fold（阶梯见 context.ts / loop.ts） */
  step?: "none" | "images" | "fold";
  /** 会话历史投影阶段被遮蔽的事件数（sessionLog.projectMessages 的 shadowed） */
  shadowed?: number;
}
export type RunEvent = { seq: number; ts?: number; kind: "turn" | "reasoning" | "receipt" | "status" | "context"; tool?: string; text?: string; /** 工具调用参数摘要（时间线展开用，落盘前截断） */ args?: string; /** P92 D1：args 因超限被截断——截断过的参数不能当历史回灌，也不能拿来渲染"模型要了什么" */ argsTruncated?: boolean; /** P94 G2（红线 A7）：落盘时 receipt.data 超上限被省略——台账必须说得出"这里原本有内容"，投影据此给说明而不是空回执 */ receiptTruncated?: boolean; /** P91 A1：该事件对应耗时（ms）——思维链=思考时长、turn=本轮往返时长，取代旧「已思考 · 0s」假值 */ ms?: number; receipt?: ToolReceipt; /** P95-H2：kind==="context" 时的用量快照 */ ctx?: ContextStat }
export interface AgentResult { status: RunStatus; messages: AgentMessage[]; events: RunEvent[]; rounds: number; calls: number; caps: { maxRounds: number; maxCalls: number; deadlineAt: number }; /** P95-H2：本次任务实际送入模型的上下文用量（旧实现把 messages 快照丢掉，事后无从知道"当时带了多少"） */ ctx?: { last?: ContextStat; peakBytes: number } }
