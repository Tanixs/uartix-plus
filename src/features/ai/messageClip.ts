/**
 * P96-K2：气泡收拢判据（纯函数，组件里只留渲染）。
 *
 * 为什么单独成模块：这条判据原先直接写在 `AiChat.tsx` 的渲染里，并且写死了
 * `role === "assistant"` —— 限高机制其实早就有，只是门只开了一半，于是用户自己发的
 * 3000 字长文把整屏顶走、要滑很久才到头。抽出来之后两种角色同规则，也测得到。
 */

export type BubbleMode = "plain" | "clip" | "scroll";

/** 超过这个字数就收拢 */
export const CLIP_CHARS = 1200;
/** 行数判据：贴日志/表格这类"短行很多"的消息字数不大，同样顶屏 */
export const CLIP_LINES = 18;
/** user 气泡内部滚动的最大高度（px），与 theme.css 的 .ai-msg-text.scroll 对齐 */
export const SCROLL_MAX_PX = 260;

/**
 * `clip` = 渐隐收拢 + 「展开 N 字」（assistant：读长文时不希望有第二条滚动条）；
 * `scroll` = 气泡内滚动（user：用户要能立刻看到自己写的全文，展开按钮反而多一步）。
 */
export function bubbleMode(m: { role: string; content: string }, isStreaming = false): BubbleMode {
  if (isStreaming) return "plain";
  const long = m.content.length > CLIP_CHARS || m.content.split("\n").length > CLIP_LINES;
  if (!long) return "plain";
  return m.role === "assistant" ? "clip" : "scroll";
}
