/**
 * AI 对话状态广播：把主窗口 AI 助手的流式状态（思考中/输出中/完成/出错）
 * 与思维链、正文的尾部摘要广播到 BroadcastChannel，
 * 供小部件（悬浮通知、桌宠等任意形态）感知 AI 并做表情、气泡、提示等反应。
 *
 * 通道复用小部件 hub 的 "vs-aiwidget-hub"：
 * - {type:"aiw:chat", feed} 状态变化即时广播（phase 切换、每次 flush）
 * - feed = { phase, reasoningTail, textTail, ts }，尾部各截断 600 字符
 */

const TAIL = 600;

export type AiChatPhase = "idle" | "thinking" | "streaming" | "error";

export interface AiChatFeed {
  phase: AiChatPhase;
  /** 思维链尾部（截断） */
  reasoningTail: string;
  /** 正文尾部（截断） */
  textTail: string;
  ts: number;
  /** phase = error 时的错误摘要 */
  error?: string;
}

let feed: AiChatFeed = {
  phase: "idle",
  reasoningTail: "",
  textTail: "",
  ts: 0,
};

const tail = (s: string | undefined) =>
  s && s.length > TAIL ? s.slice(-TAIL) : s ?? "";

/** chatStore 每次快照更新后调用（含流式 flush），由调用方节流 */
export function updateChatFeed(p: {
  streaming: boolean;
  lastMsg?: { role: string; content: string; reasoning?: string; error?: string };
}): boolean {
  const m = p.lastMsg;
  let next: AiChatFeed;
  if (p.streaming) {
    next =
      m && m.role === "assistant"
        ? {
            phase: m.content ? "streaming" : "thinking",
            reasoningTail: tail(m.reasoning),
            textTail: tail(m.content),
            ts: Date.now(),
          }
        : { phase: "thinking", reasoningTail: "", textTail: "", ts: Date.now() };
  } else if (m && m.role === "assistant") {
    // 结束：保留最终思维链/正文，小部件可展示完整回答
    next = {
      phase: m.error ? "error" : "idle",
      reasoningTail: tail(m.reasoning),
      textTail: tail(m.content),
      ts: Date.now(),
      error: m.error ? String(m.error).slice(0, 200) : undefined,
    };
  } else {
    next = { ...feed, ts: Date.now() };
  }
  const changed =
    next.phase !== feed.phase ||
    next.reasoningTail !== feed.reasoningTail ||
    next.textTail !== feed.textTail;
  feed = next;
  return changed;
}

export function getChatFeed(): AiChatFeed {
  return feed;
}

export function broadcastChatFeed(post: (msg: Record<string, unknown>) => void) {
  post({ type: "aiw:chat", feed });
}
