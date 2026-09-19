export interface ToolCall { callId: string; name: string; arguments: string }
export interface ToolReceipt {
  callId: string; ok: boolean; status: "applied" | "read" | "validated" | "not_executed" | "error";
  code?: string; data?: unknown; revision?: string; undoToken?: string; artifactRefs?: string[];
}
export interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string; calls?: ToolCall[]; callId?: string }
export interface ModelTurn { content: string; calls: ToolCall[] }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export type AgentProvider = (messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal) => Promise<ModelTurn>;
export interface TaskContext { source: "local_agent"; runId: string; signal: AbortSignal; scope: "preview" | "create" | "custom"; /** 自定义档位勾选的授权域（config/plugins/device/files/network/shell）；scope 非 custom 时忽略 */ allowed?: string[] }
export interface TaskAdapter { definitions: ToolDefinition[]; execute(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> }
export type RunStatus = "running" | "succeeded" | "paused" | "cancelled" | "failed" | "interrupted";
export type RunEvent = { seq: number; ts?: number; kind: "turn" | "receipt" | "status"; tool?: string; text?: string; /** 工具调用参数摘要（时间线展开用，落盘前截断） */ args?: string; receipt?: ToolReceipt }
export interface AgentResult { status: RunStatus; messages: AgentMessage[]; events: RunEvent[]; rounds: number; calls: number; caps: { maxRounds: number; maxCalls: number; deadlineAt: number } }
