/**
 * P92-A1/A2：会话事件日志与投影出口（移植 DeepSeek Harness 的 session 合同）。
 *
 * dsh 的原生模型是「先记下事件，再决定模型看到什么」：`Session.append()` 给事件分配 seq 写入
 * append-only 日志，模型输入**只能**由 `deriveMessages()` 从日志投影得到，压缩是**追加一条
 * 遮蔽节点**而不是回头改旧节点。我们对照落地，但**不新增持久层**——日志是两个既有 store
 * （chatStore 会话消息 + agentRun 任务台账）之上的派生视图，避免造出第三份真相。
 *
 * 依赖只有类型（编译期擦除），因此不引入 chatStore/agentRun 的运行时环（红线 R1）。
 * 唯一的运行时 import 是 `contextBudget`（零 import 的算术叶子）与 `context`（同样只 import 类型
 * + contextBudget）——两者都指不回本模块，环守卫（门禁 9）盯的就是这条。
 */
import { interruptedReceipt, INTERRUPTED_CODE, markStaleArtifacts } from "./context";
import type { ChatMsg } from "../ai/chatStore";
import type { AgentRunView } from "./agentRun";
import type { AgentMessage, ToolReceipt } from "./types";

export type SessionEventKind =
  | "user/message"
  | "assistant/message"
  | "turn/start"
  | "assistant/message/attempt"
  | "tool/call"
  | "tool/result"
  | "turn/end";

export interface SessionEvent {
  seq: number;
  ts: number;
  kind: SessionEventKind;
  text?: string;
  /** P94-G5：这一轮的正文是"半截话"（被中止或以错误结束）——日志照记，投影负责标注 */
  incomplete?: "aborted" | "error";
  /** P94-G5：历史 user 消息附带的图片（data URL）；投影只对最近若干轮透传给模型 */
  images?: string[];
  callId?: string;
  tool?: string;
  args?: string;
  /** 日志说真话：被截断过也照记，由投影决定给不给模型看 */
  argsTruncated?: boolean;
  /** P94-G2（红线 A7）：落盘时回执内容被省略过——投影要说明，不能下发一条"没返回任何内容"的回执 */
  receiptTruncated?: boolean;
  receipt?: ToolReceipt;
  runId?: string;
}

/** 台账里的轮次心跳与状态行是给人看的脚手架，不是会话事实 */
const ROUND_MARK_RE = /^〔第 \d+ 轮〕$/;
const SCAFFOLD_PREFIX = ["执行出错：", "已从中断处继续", "任务结束："];

function isScaffold(t: string): boolean {
  return ROUND_MARK_RE.test(t) || SCAFFOLD_PREFIX.some((p) => t.startsWith(p));
}

/**
 * 归并会话消息与任务台账为一条按时间排序的事件序列（共享 seq）。
 * 同一时刻的先后按"消息在前、任务在后"的稳定次序排（任务必然由那条消息发起）。
 */
export function buildSessionLog(messages: ChatMsg[], runs: AgentRunView[]): SessionEvent[] {
  const raw: Omit<SessionEvent, "seq">[] = [];
  for (const m of messages) {
    if (m.error && !m.content) continue; // 纯错误占位不是会话事实
    raw.push({
      ts: m.ts,
      kind: m.role === "user" ? "user/message" : "assistant/message",
      text: m.content,
      ...(m.aborted ? { incomplete: "aborted" as const } : m.error ? { incomplete: "error" as const } : {}),
      ...(m.role === "user" && m.images?.length ? { images: m.images } : {}),
    });
  }
  for (const r of runs) {
    raw.push({ ts: r.createdAt, kind: "turn/start", text: r.goalBrief, runId: r.runId });
    /* P134-B：turn 事件里声明过、却没有回执的调用 = 应用被杀在中途的那些。
       这里补一对（call + 合成 result），措辞见 `interruptedReceipt`。
       不补的后果不是"少一段上下文"，而是模型会把那次写入**再做一遍**。 */
    const withReceipt = new Set<string>();
    for (const e of r.events) if (e.kind === "receipt" && e.receipt?.callId) withReceipt.add(e.receipt.callId);
    for (const e of r.events) {
      const ts = e.ts ?? r.createdAt;
      if (e.kind === "turn") {
        const t = (e.text ?? "").trim();
        if (t && !isScaffold(t)) raw.push({ ts, kind: "assistant/message/attempt", text: t, runId: r.runId });
        for (const c of e.calls ?? []) {
          if (withReceipt.has(c.callId)) continue; // 有回执的走下面 receipt 分支，避免重复下发
          raw.push({ ts, kind: "tool/call", callId: c.callId, tool: c.name, args: c.args, argsTruncated: c.argsTruncated, runId: r.runId });
          raw.push({ ts, kind: "tool/result", callId: c.callId, receipt: interruptedReceipt(c.callId, c.name), runId: r.runId });
        }
      } else if (e.kind === "receipt") {
        const callId = e.receipt?.callId ?? `r${r.runId}-${e.seq}`;
        raw.push({ ts, kind: "tool/call", callId, tool: e.tool ?? "tool", args: e.args, argsTruncated: e.argsTruncated, runId: r.runId });
        if (e.receipt) raw.push({ ts: e.ts ?? ts, kind: "tool/result", callId, receipt: e.receipt, receiptTruncated: e.receiptTruncated, runId: r.runId });
      }
    }
    raw.push({ ts: r.finishedAt ?? r.updatedAt, kind: "turn/end", text: r.status, runId: r.runId });
  }
  raw.sort((a, b) => a.ts - b.ts);
  return raw.map((e, i) => ({ ...e, seq: i + 1 }));
}

export interface ProjectOptions {
  /** 字符预算（≈4 字符/汉字、≈4 字符/英文 token 的粗口径）；超限从最旧开始遮蔽 */
  budgetChars?: number;
  /** 排除某个 run（续跑时避免把当前任务自己算进历史） */
  excludeRunId?: string;
}

export interface Projection {
  messages: AgentMessage[];
  /** 被遮蔽的事件数（>0 时 messages 头部有一条说明性 system 消息） */
  shadowed: number;
  chars: number;
}

/**
 * P110-B2：这些数的**定义**搬到了算术叶子 `contextBudget.ts`（窗口/token/字节/保险丝一处说清），
 * 这里只做 re-export —— 老 import 路径不破，也不留第二份 12000。
 * `HISTORY_CHAR_BUDGET` 的语义跟着变了：它不再是"那个跟模型无关的预算"，
 * 而是**没配模型档案时的兜底值**；真正的预算由 `budgetFor()` 按窗口算。
 */
import {
  FALLBACK_HISTORY_CHAR_BUDGET,
  MIN_HISTORY_BUDGET as BUDGET_MIN,
  tightenHistoryBudget as tightenByHalf,
  historyCharBudget as budgetFromWindow,
} from "./contextBudget";

export const HISTORY_CHAR_BUDGET = FALLBACK_HISTORY_CHAR_BUDGET;
export const MIN_HISTORY_BUDGET = BUDGET_MIN;

/**
 * 手动压缩的一档：预算减半、夹在下限之上。
 * 返回新值；**已到下限则原样返回**，调用方据此禁用按钮并说明原因（不许"点了没反应"）。
 */
export function tightenHistoryBudget(current: number = HISTORY_CHAR_BUDGET): number {
  return tightenByHalf(current);
}

/** 当前该用多少历史预算：模型窗口 × 压缩比例，扣掉这一轮回答的输出预留，再被传输保险丝封顶 */
export function budgetFor(contextTokens: number, ratio?: number, outputTokens?: number): number {
  return budgetFromWindow(contextTokens, ratio, undefined, outputTokens);
}

/** 只对最近这么多条带图的历史 user 透传图片：data URL 一张可达上百 KB，全量重发会撑爆请求 */
const HISTORY_IMAGE_TURNS = 3;

/** 半截话的统一标记：投影与聊天侧共用一份，两条路径别再各写一套口径（P94-G5） */
export const INCOMPLETE_MARK: Record<NonNullable<SessionEvent["incomplete"]>, string> = {
  aborted: "（该轮被用户中止，以下内容不完整）",
  error: "（该轮以错误结束，以下内容可能不完整）",
};

function sizeOf(m: AgentMessage): number {
  const img = (m.images ?? []).reduce((n, s) => n + s.length, 0);
  return m.content.length + JSON.stringify(m.calls ?? "[]").length + img;
}

/** 剥掉一次性令牌：跨轮/跨重启复用即误撤销（陈旧 revision 会被宿主拒，属自纠，保留）；
 *  顺带把"可用 read_artifact 取回"改成实话——缓存是上一个 run 的内存（P134-A）。 */
function receiptForModel(rec: ToolReceipt): string {
  const { undoToken: _drop, ...rest } = rec;
  return JSON.stringify(markStaleArtifacts(rest));
}

/**
 * 事件日志 → 模型消息（唯一的投影出口）。
 * 规则：连续 assistant 文本合并成一条；`tool/call` 与其 `tool/result` **成对才下发**
 * （孤儿调用会让模型以为存在一次没发生的写入）；参数被截断过的调用整对丢弃；
 * 被中止/出错的轮次保留正文但加前缀说明（P94-G5：模型不能把半截话当成完整回答）；
 * 超预算从最旧端遮蔽，并在头部追加一条说明——**绝不修改日志本身**。
 */
export function projectMessages(events: SessionEvent[], opts: ProjectOptions = {}): Projection {
  const budget = opts.budgetChars ?? HISTORY_CHAR_BUDGET;
  const msgs: AgentMessage[] = [];
  let pendingText = "";
  let pendingCalls: { callId: string; name: string; arguments: string }[] = [];
  let droppedTruncated = 0;
  let omittedReceipts = 0;

  // 图片只跟最近若干轮：先数一遍哪些 user 事件有资格带图
  const keepImagesFor = new Set<number>();
  {
    let seen = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind !== "user/message" || !events[i].images?.length) continue;
      if (seen++ >= HISTORY_IMAGE_TURNS) break;
      keepImagesFor.add(i);
    }
  }

  const flushAssistant = () => {
    if (!pendingText && pendingCalls.length === 0) return;
    msgs.push({ role: "assistant", content: pendingText, ...(pendingCalls.length ? { calls: pendingCalls } : {}) });
    pendingText = "";
    pendingCalls = [];
  };

  /* P134-B：合成出来的「结果未知」那一对要放行，即使参数没记下来。
     P92 D1「截断过的参数整对丢弃」防的是"模型把 `{}` 当成自己当初要的参数"；
     而这里的回执明写着结果未知、不要据此重做——再丢弃就把"这一步存在过"这条事实一起抹掉了，
     那正是续跑会重做写入的来源。 */
  const interruptedCall = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool/result" && e.callId && e.receipt?.code === INTERRUPTED_CODE) interruptedCall.add(e.callId);
  }
  const byCall = new Map<string, SessionEvent>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (opts.excludeRunId && e.runId === opts.excludeRunId) continue;
    const mark = e.incomplete ? INCOMPLETE_MARK[e.incomplete] : "";
    switch (e.kind) {
      case "user/message": {
        flushAssistant();
        if (e.text || e.images?.length) {
          msgs.push({
            role: "user",
            content: mark ? `${mark}\n${e.text ?? ""}` : e.text ?? "",
            ...(keepImagesFor.has(i) && e.images?.length ? { images: e.images } : {}),
          });
        }
        break;
      }
      case "assistant/message":
      case "assistant/message/attempt": {
        const t = e.text ?? "";
        if (!t && !mark) break;
        pendingText += (pendingText ? "\n" : "") + (mark ? `${mark}\n${t}` : t);
        break;
      }
      case "tool/call": {
        if (e.argsTruncated && !(e.callId && interruptedCall.has(e.callId))) { droppedTruncated++; break; } // 整对丢弃（含其 result）
        if (!e.callId) break;
        byCall.set(e.callId, e);
        pendingCalls = [...pendingCalls, { callId: e.callId, name: e.tool ?? "tool", arguments: e.args || "{}" }];
        break;
      }
      case "tool/result": {
        if (!e.callId || !byCall.has(e.callId) || !e.receipt) break; // 孤儿回执不下发
        if (e.receiptTruncated) omittedReceipts++;
        flushAssistant();
        msgs.push({ role: "tool", callId: e.callId, content: receiptForModel(e.receipt) });
        break;
      }
      default:
        break;
    }
  }
  flushAssistant();
  if (droppedTruncated > 0) {
    msgs.push({
      role: "system",
      content: `（先前 ${droppedTruncated} 次工具调用的参数超出台账上限，未纳入本历史；它们确实已执行过，请勿据此重复写入。）`,
    });
  }
  if (omittedReceipts > 0) {
    msgs.push({
      role: "system",
      content: `（先前 ${omittedReceipts} 次工具回执的返回内容因持久化上限未纳入本历史，状态与结果码仍在；需要细节请重新调用对应工具，不要据此判断"当时什么都没发生"。）`,
    });
  }

  // 遮蔽式压缩：从新到旧收取，超预算的旧段整体换成一条说明
  let chars = 0;
  let keepFrom = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const next = chars + sizeOf(msgs[i]);
    if (i < msgs.length - 1 && next > budget) break;
    chars = next;
    keepFrom = i;
  }
  const shadowed = keepFrom;
  const kept = msgs.slice(keepFrom);
  if (shadowed > 0) {
    kept.unshift({ role: "system", content: `（更早 ${shadowed} 条会话记录已省略以适配上下文预算；需要全文请让用户看会话。）` });
  }
  return { messages: kept, shadowed, chars };
}

/**
 * 会话 → 模型历史（投影的唯一入口，P94-G5）。
 *
 * `excludeFromMsgId`：**从某条消息重发**时必须先把该条及其之后的内容剔掉再投影——旧实现在
 * `rewriteForResend()` 截断之前就算好了 history，于是模型读到一批"已经被删掉的后续"。
 * 放在这里做而不是在 UI 里做，是为了让这条时序约束可被单测钉住（UI 不可测）。
 *
 * P95-H2：连 `stats` 一起返回。旧实现只 `.messages`，`shadowed/chars` 在函数边界蒸发，
 * "遮蔽了多少"变成只有单测知道的内部知识。
 */
export function buildAgentHistory(
  messages: ChatMsg[],
  runs: AgentRunView[],
  opts: { excludeFromMsgId?: string; excludeRunId?: string; budgetChars?: number } = {},
): { messages: AgentMessage[]; stats: { shadowed: number; chars: number } } {
  let list = messages;
  if (opts.excludeFromMsgId) {
    const idx = list.findIndex((m) => m.id === opts.excludeFromMsgId);
    if (idx >= 0) list = list.slice(0, idx);
  }
  const p = projectMessages(buildSessionLog(list, runs), {
    ...(opts.excludeRunId ? { excludeRunId: opts.excludeRunId } : {}),
    ...(opts.budgetChars ? { budgetChars: opts.budgetChars } : {}),
  });
  return { messages: p.messages, stats: { shadowed: p.shadowed, chars: p.chars } };
}
