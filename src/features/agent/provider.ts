/**
 * P88b-1：真实模型 Provider（本机 Agent 专用）。
 * - 走 Rust `ai_agent_turn`：非流式、协议转换（chat/anthropic/responses）与
 *   “回复不完整 ⇒ 未执行工具”的校验都在宿主侧完成，前端不解析 Markdown 冒充工具协议。
 * - 取消：signal abort 时立即 `ai_abort(reqId)`，宿主停止读流并返回“已停止”，
 *   未派发调用不再执行（§5.3 停止顺序的第一级）。
 * - 上下文只含脱敏后的工具定义/回执；api key 仅作为 invoke 参数传给宿主，
 *   不进入消息、不回显。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import type { AgentMessage, AgentProvider, ModelTurn, ToolCall, ToolDefinition } from "./types";

/** Base URL 清洗：去引号/空白/尾部斜杠（测试连接与真实请求共用） */
export function cleanBaseUrl(url: string): string {
  return url.replace(/[`"'\s]/g, "").replace(/\/+$/, "");
}

interface RustTurnResult {
  content: string;
  calls: { callId?: string; id?: string; name?: string; arguments?: string }[];
}

/** wire 形态与 Rust AgentMessage/AgentTool 对齐（camelCase；可选字段缺省不下发） */
export function toWireMessages(messages: AgentMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.calls && m.calls.length ? { calls: m.calls } : {}),
    ...(m.callId ? { callId: m.callId } : {}),
  }));
}

export function fromRustTurn(result: RustTurnResult): ModelTurn {
  const calls: ToolCall[] = (result.calls ?? []).map((c) => ({
    callId: String(c.callId ?? c.id ?? ""),
    name: String(c.name ?? ""),
    arguments: String(c.arguments ?? ""),
  }));
  return { content: String(result.content ?? ""), calls };
}

/** 单轮模型调用：读设置 → ai_agent_turn → 结构化 ModelTurn。 */
export const invokeAgentProvider: AgentProvider = async (
  messages: AgentMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<ModelTurn> => {
  if (signal.aborted) throw new Error("已停止；未发起模型请求");
  const st = getSettings();
  const reqId = crypto.randomUUID();
  const abortListener = () => {
    // 协作式中断：通知宿主放弃这条在途请求（超时/断流场景及时中断，不等下一个 chunk）
    void invoke("ai_abort", { reqId }).catch(() => undefined);
  };
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    const raw = await invoke<RustTurnResult>("ai_agent_turn", {
      reqId,
      baseUrl: cleanBaseUrl(st.aiBaseUrl),
      apiKey: st.aiApiKey,
      model: st.aiModel,
      format: st.aiFormat,
      proxy: st.aiProxy || null,
      noProxy: st.aiNoProxy || null,
      messages: toWireMessages(messages),
      tools,
    });
    return fromRustTurn(raw);
  } finally {
    signal.removeEventListener("abort", abortListener);
  }
};
