/**
 * P91 B1：会话时间线合成器（纯函数）。
 *
 * 旧实现把 Agent 任务流渲染成消息列表**之后**的页脚（`messages.map()` 后紧跟
 * `<AgentInline/>`），于是任务永远沉底、新消息一律叠在它上面——用户看到的
 * "Agent 任务页面一直置于底层，新的对话到了原来的对话下继续堆叠"就是这个 DOM 顺序，
 * 不是渲染 bug。这里把两者按时间合成一条序列，任务卡紧跟发起它的那条用户消息。
 */
import type { ChatMsg } from "../ai/chatStore";
import type { AgentRunView } from "./agentRun";

export type TimelineItem =
  | { kind: "msg"; key: string; ts: number; msg: ChatMsg }
  | { kind: "run"; key: string; ts: number; run: AgentRunView };

export function buildTimeline(messages: ChatMsg[], runs: AgentRunView[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: "msg" as const, key: `m:${m.id}`, ts: m.ts, msg: m })),
    ...runs.map((r) => ({ kind: "run" as const, key: `r:${r.runId}`, ts: r.createdAt, run: r })),
  ];
  // 同刻并列时消息在前：任务必然由这条消息发起（appendUserMessage 先落，startRun 后起）
  items.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? 0 : a.kind === "msg" ? -1 : 1));
  return items;
}
