/**
 * P88b-1 §5.2：Agent 上下文窗口管理（修复 H1）。
 * loop 每轮全量携带历史消息与工具回执，长任务会先撞模型自身窗口
 * （Rust 侧 2MiB 字节熔断只是防失控兜底，远大于常见 128K/200K token 窗口）。
 *
 * 三级策略：
 * 1) 回执落库时截断：data 超阈值转“摘要 + artifactRef”，细节留给 read_artifact 只读工具；
 * 2) 送模型前折叠：保留系统提示与目标（永不折叠）+ 最近 keepRecentTurns 轮完整消息，
 *    更早的 assistant/tool 折叠为一行状态摘要（callId、工具名、status、revision）；
 * 3) **P95-H1 字节口径的自适应阶梯**：`agentPayloadBytes` 估算真实 UTF-8 字节（含图片），
 *    超 `REQUEST_SOFT_LIMIT` 就按"丢历史图 → 收紧折叠 → 本地抛 context_overflow"施压，
 *    并把每一步记成事件——旧实现只有字符软阈，与 Rust 的 2 MiB 字节熔断互不知情。
 * 以字节/字符近似估算，不引入 tokenizer 依赖。
 */
import type { AgentMessage, ToolReceipt } from "./types";

/** 单个回执 data 超此字节数即截断为摘要 + artifactRef。 */
export const RECEIPT_DATA_LIMIT = 8 * 1024;
/** 折叠后仍超此字符数才继续折叠更早轮次（近似，非精确 token）。 */
export const CONTEXT_SOFT_LIMIT = 120 * 1024;
/** 折叠时保留最近多少条消息（约 N 轮）不动。 */
export const KEEP_RECENT_MESSAGES = 8;

/**
 * 回执截断（**第二级兜底**）：大 data 换成摘要占位，保留 ok/status/code/revision/undoToken 等控制字段。
 *
 * P94-G3 的口径：`artifactRef` 只在**数据真的进了 adapter 的 artifacts 缓存**时才给（那第一级在
 * `agentAdapter.capReceipt`，它裁完顺手存）。此前这里无条件发一个 `call:<callId>`，而绕过 adapter
 * 裁剪的回执根本没入库 ⇒ 模型照着 ref 去 `read_artifact` 必得 `artifact_not_found`：空头支票。
 * 现在不可取回就如实说"请重新调用该工具"，不再给假引用。
 */
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
      data: {
        truncated: true,
        preview,
        fullBytes: size,
        note: "本回执未缓存，无法按引用取回；需要完整内容请用更小的范围重新调用该工具",
      },
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

/* ================= P95-H1：按字节的请求体积口径 =================
 * 旧实现只有两条线且互不知情：`CONTEXT_SOFT_LIMIT`（12 万**字符**）与 Rust 的 2 MiB
 * **字节**熔断（`ai.rs` 里判 `body.to_string().len()`），而 `estimateChars` 压根不计
 * images——P94-G5 让最近 3 轮历史截图进上下文之后，这条盲区直接变成硬失败面。
 * 这一节把"会不会撞线"变成发送前可测、可收缩、可记账的事实。 */

/** Rust 侧 2 MiB 是最终裁判；这里取 ~76% 作为前端软顶，留协议外壳/转义/工具定义的估算误差。 */
export const REQUEST_SOFT_LIMIT = 1_600_000;

/** P95-H2：体积可读化（<1 MB 用 KB，以上用一位小数 MB） */
export function fmtKb(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * 上下文用量读数（P98-M4）：**带分母**。
 * 旧 UI 只有一个「上下文 N KB」的胶囊，软顶从不显示、也没有百分比 —— 用户看得见数字，
 * 却判断不了"还剩多少"，更不知道什么时候该手动压缩。运行卡与输入区用量条共用这一份口径。
 */
export const CTX_WARN_RATIO = 0.7;
export const CTX_DANGER_RATIO = 0.9;

export function ctxGauge(bytes: number): { pct: number; text: string; level: "ok" | "warn" | "danger" } {
  const pct = REQUEST_SOFT_LIMIT > 0 ? Math.min(100, Math.round((bytes / REQUEST_SOFT_LIMIT) * 100)) : 0;
  return {
    pct,
    text: `${fmtKb(bytes)} / ${fmtKb(REQUEST_SOFT_LIMIT)} · ${pct}%`,
    level: pct >= CTX_DANGER_RATIO * 100 ? "danger" : pct >= CTX_WARN_RATIO * 100 ? "warn" : "ok",
  };
}

/** UTF-8 字节数（Rust 判的是序列化后的字节，`string.length` 是 UTF-16 单元数，CJK 差 3 倍）。 */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } // 代理对＝一个 4 字节码点
    else n += 3;
  }
  return n;
}

/**
 * 一条消息将占用的字节估算。
 * 注意 data URL **已经是 base64 文本**，长度即字节数（不再乘 4/3，那是二进制→base64 的膨胀系数）。
 */
export function messageBytes(m: AgentMessage): number {
  let n = utf8Bytes(m.content) + 32; // role/callId 等字段与花括号
  if (m.calls) n += utf8Bytes(JSON.stringify(m.calls));
  if (m.images) for (const u of m.images) n += u.length + 96;
  return n;
}

/** 本轮要发出去的东西有多大（消息 + 工具定义 + 顶层壳）。 */
export function agentPayloadBytes(messages: AgentMessage[], definitions: unknown[] = []): number {
  return messages.reduce((n, m) => n + messageBytes(m), 0) + utf8Bytes(JSON.stringify(definitions)) + 256;
}

/** 数一数当前上下文里还挂着几张图。 */
export function countImages(messages: AgentMessage[]): number {
  return messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
}

/**
 * 阶梯第一级：丢掉**历史**图片，保留最近一条 user（＝本轮目标）的附图。
 * 代价最低、可解释、且正是 P94-G5 引进的那部分体积。返回丢掉的张数。
 */
export function dropHistoryImages(messages: AgentMessage[]): number {
  let lastUserWithImages = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].images?.length) { lastUserWithImages = i; break; }
  }
  let dropped = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === lastUserWithImages || !m.images?.length) continue;
    dropped += m.images.length;
    m.images = undefined;
  }
  return dropped;
}

/** 折叠结果带计数——"折了几条"必须能被记进事件台账，而不是像旧实现那样折完即丢。 */
export interface FoldResult {
  messages: AgentMessage[];
  folded: number;
  /** 是否真的动了（未超阈值时返回原数组引用，测试据此钉"无副作用"这件事） */
  changed: boolean;
}

/**
 * 折叠上下文：系统提示与首条目标永不折叠；最近 `keepRecent` 条保留完整；
 * 中间段折叠为一条摘要。
 *
 * P95：默认阈值从"12 万字符"改成**按字节软顶折算**，且返回折叠计数。
 * `maxBytes` 传入时逐级多折（每轮少留 2 条）直到估算落进预算——这是阶梯的第二级。
 */
export function foldContext(messages: AgentMessage[], maxBytes?: number): FoldResult {
  let headEnd = 0;
  while (headEnd < messages.length && (messages[headEnd].role === "system" || (messages[headEnd].role === "user" && headEnd === 1))) headEnd++;
  /** 折成"头部不折 + 中间一条摘要 + 最近 keep 条完整" */
  const foldWith = (keep: number) => {
    const tailStart = Math.max(headEnd, messages.length - keep);
    const middle = messages.slice(headEnd, tailStart);
    return {
      out: [...messages.slice(0, headEnd), ...(middle.length ? [summarize(middle)] : []), ...messages.slice(tailStart)],
      folded: middle.length,
    };
  };
  const fits = (arr: AgentMessage[]) =>
    maxBytes === undefined ? estimateChars(arr) <= CONTEXT_SOFT_LIMIT : agentPayloadBytes(arr) <= maxBytes;

  if (fits(messages)) return { messages, folded: 0, changed: false };
  let best = foldWith(KEEP_RECENT_MESSAGES);
  if (maxBytes !== undefined) {
    for (let keep = KEEP_RECENT_MESSAGES; keep >= 2; keep -= 2) {
      best = foldWith(keep);
      if (best.folded === 0 || fits(best.out) || keep === 2) break;
    }
  }
  return { messages: best.out, folded: best.folded, changed: best.folded > 0 };
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
