/**
 * P88b-1 §5.2：Agent 上下文窗口管理（修复 H1）。
 * loop 每轮全量携带历史消息与工具回执，长任务会先撞模型自身窗口
 * （Rust 侧 2MiB 字节熔断只是防失控兜底，远大于常见 128K/200K token 窗口）。
 *
 * 两级策略：
 * 1) 回执落库时截断：data 超阈值转“摘要 + artifactRef”，细节留给 read_artifact 只读工具；
 * 2) 送模型前折叠：保留系统提示与目标（永不折叠）+ 最近 keepRecentTurns 轮完整消息，
 *    更早的 assistant/tool 折叠为一行状态摘要（callId、工具名、status、revision）。
 * 以字符数近似估算，不引入 tokenizer 依赖。
 */
import type { AgentMessage, ToolReceipt } from "./types";

/** 单个回执 data 超此字节数即截断为摘要 + artifactRef。 */
export const RECEIPT_DATA_LIMIT = 8 * 1024;
/** 折叠后仍超此字符数才继续折叠更早轮次（近似，非精确 token）。 */
export const CONTEXT_SOFT_LIMIT = 120 * 1024;
/** 折叠时保留最近多少条消息（约 N 轮）不动。 */
export const KEEP_RECENT_MESSAGES = 8;

/** 回执截断：大 data 换成引用占位，保留 ok/status/code/revision/undoToken 等控制字段。 */
export function shrinkReceipt(receipt: ToolReceipt): { receipt: ToolReceipt; truncated: boolean } {
  if (receipt.data === undefined) return { receipt, truncated: false };
  const size = JSON.stringify(receipt.data).length;
  if (size <= RECEIPT_DATA_LIMIT) return { receipt, truncated: false };
  const preview = typeof receipt.data === "string"
    ? receipt.data.slice(0, 2000)
    : JSON.stringify(receipt.data).slice(0, 2000);
  return {
    truncated: true,
    receipt: {
      ...receipt,
      data: { truncated: true, preview, fullBytes: size, artifactRef: `call:${receipt.callId}` },
    },
  };
}

function estimateChars(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.content.length;
    if (m.calls) n += JSON.stringify(m.calls).length;
  }
  return n;
}

function summarize(msgs: AgentMessage[]): AgentMessage {
  const lines = msgs.map((m) => {
    if (m.role === "tool") {
      let r: Partial<ToolReceipt> = {};
      try { r = JSON.parse(m.content); } catch { /* 保留原样 */ }
      return `tool ${m.callId ?? "?"}: ${r.status ?? "?"}${r.ok === false ? ` code=${r.code ?? "?"}` : ""}${r.revision ? ` rev=${String(r.revision).slice(0, 12)}` : ""}`;
    }
    if (m.role === "assistant") {
      const calls = m.calls?.map((c) => c.name).join(",") ?? "";
      return `assistant: ${m.content.slice(0, 80)}${calls ? ` [calls:${calls}]` : ""}`;
    }
    return `${m.role}: ${m.content.slice(0, 80)}`;
  });
  return { role: "system", content: `（较早 ${msgs.length} 条步骤摘要，细节已折叠，可用 read_artifact 取回）\n${lines.join("\n")}` };
}

/**
 * 折叠上下文：系统提示与首条目标永不折叠；最近 KEEP_RECENT_MESSAGES 条保留完整；
 * 中间段折叠为一条摘要。仅在估算超软阈值时才折叠，否则原样返回。
 */
export function foldContext(messages: AgentMessage[]): AgentMessage[] {
  if (estimateChars(messages) <= CONTEXT_SOFT_LIMIT) return messages;
  // 头部：开头的 system 与首条 user（任务目标）永不折叠
  let headEnd = 0;
  while (headEnd < messages.length && (messages[headEnd].role === "system" || (messages[headEnd].role === "user" && headEnd === 1))) headEnd++;
  const tailStart = Math.max(headEnd, messages.length - KEEP_RECENT_MESSAGES);
  const middle = messages.slice(headEnd, tailStart);
  if (!middle.length) return messages;
  return [...messages.slice(0, headEnd), summarize(middle), ...messages.slice(tailStart)];
}
