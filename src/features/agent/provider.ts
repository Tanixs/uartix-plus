/**
 * P88b-1：真实模型 Provider（本机 Agent 专用）。
 * - 走 Rust `ai_agent_turn`：宿主侧以流式收 SSE 并聚合（P91 A1，非流式会让网关整包
 *   缓冲、长正文必撞上游超时），协议转换（chat/anthropic/responses）与
 *   “回复不完整 ⇒ 未执行工具”的校验都在宿主侧完成，前端不解析 Markdown 冒充工具协议。
 * - 取消：signal abort 时立即 `ai_abort(reqId)`，宿主停止读流并返回“已停止”，
 *   未派发调用不再执行（§5.3 停止顺序的第一级）。
 * - 上下文只含脱敏后的工具定义/回执；api key 仅作为 invoke 参数传给宿主，
 *   不进入消息、不回显。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import type { AgentMessage, AgentProvider, ModelTurn, ToolCall, ToolDefinition, TurnOptions } from "./types";

/** Base URL 清洗：去引号/空白/尾部斜杠（测试连接与真实请求共用） */
export function cleanBaseUrl(url: string): string {
  return url.replace(/[`"'\s]/g, "").replace(/\/+$/, "");
}

interface RustTurnResult {
  content: string;
  calls: { callId?: string; id?: string; name?: string; arguments?: string }[];
  /** P90 B1：三协议统一抽取的思维文本；模型不产思考时为空串/缺省 */
  reasoning?: string;
}

/** wire 形态与 Rust AgentMessage/AgentTool 对齐（camelCase；可选字段缺省不下发） */
export function toWireMessages(messages: AgentMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.calls && m.calls.length ? { calls: m.calls } : {}),
    ...(m.callId ? { callId: m.callId } : {}),
    ...(m.images && m.images.length ? { images: m.images } : {}),
  }));
}

export function fromRustTurn(result: RustTurnResult): ModelTurn {
  const calls: ToolCall[] = (result.calls ?? []).map((c) => ({
    callId: String(c.callId ?? c.id ?? ""),
    name: String(c.name ?? ""),
    arguments: String(c.arguments ?? ""),
  }));
  const reasoning = String(result.reasoning ?? "");
  return { content: String(result.content ?? ""), calls, ...(reasoning ? { reasoning } : {}) };
}

/** 单轮模型调用：读设置 → ai_agent_turn（流式，宿主侧聚合）→ 结构化 ModelTurn。 */
export const invokeAgentProvider: AgentProvider = async (
  messages: AgentMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  options?: TurnOptions,
): Promise<ModelTurn> => {
  if (signal.aborted) throw new Error("已停止；未发起模型请求");
  const st = getSettings();
  const reqId = crypto.randomUUID();
  const abortListener = () => {
    // 协作式中断：通知宿主放弃这条在途请求（超时/断流场景及时中断，不等下一个 chunk）
    void invoke("ai_abort", { reqId }).catch(() => undefined);
  };
  signal.addEventListener("abort", abortListener, { once: true });
  let unlisten: (() => void) | null = null;
  try {
    if (options?.onDelta) {
      // P91 A1：订阅本 reqId 的增量，思维链/正文边到边显示。
      // 非 Tauri 环境（vitest）拿不到事件属正常，不得因此中断任务。
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<{ reqId: string; text?: string; reasoning?: string }>("agent:delta", (e) => {
          const p = e.payload;
          if (!p || p.reqId !== reqId) return;
          if (p.reasoning) options.onDelta?.("reasoning", p.reasoning);
          if (p.text) options.onDelta?.("text", p.text);
        });
        unlisten = typeof off === "function" ? off : null;
      } catch {
        /* 无事件通道：静默降级为非实时 */
      }
    }
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
      // P90 B1：Agent 通道也要产思维链——anthropic 不开 thinking 就永远没有思考块。
      // P96-K4：模型行为开关改走 deepThink（以前借用的是界面"显示思考过程"，一个开关管两件事）；
      // loop 在空闲超时后的第二级重试会显式传 thinking:false——长静默正是网关掐断的诱因。
      thinking: options?.thinking ?? st.deepThink,
      // P96-K4：读空闲上限从设置来（只约束我们这一侧；上游网关自己掐断的管不到）
      streamIdleSecs: st.streamIdleSecs,
      // P91 A3：输出预算（截断类失败后 loop 逐级下调重试）
      maxTokens: options?.maxTokens ?? null,
    });
    return fromRustTurn(raw);
  } finally {
    signal.removeEventListener("abort", abortListener);
    try {
      unlisten?.();
    } catch {
      /* 卸载失败无关紧要 */
    }
  }
};
