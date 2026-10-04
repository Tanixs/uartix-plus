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
 *    超 `REQUEST_SOFT_LIMIT` 就按"丢历史图 → **P135-A 无模型裁短巨型回执** → 收紧折叠 → 本地抛 context_overflow"施压，
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

/** P110-B2：这条数搬到 `contextBudget.ts`（算术叶子，零 import ⇒ 结构上不会成环）。
 *  这里 re-export 是为了老 import 路径不破，更重要的是**不留第二份 1.6 MB**。 */
import { REQUEST_SOFT_LIMIT as BUDGET_SOFT_LIMIT } from "./contextBudget";
export const REQUEST_SOFT_LIMIT = BUDGET_SOFT_LIMIT;

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

/**
 * 重放旧回执时，把"完整内容已缓存，可用 read_artifact 取回"改成实话（P134-A）。
 *
 * 依据是两条都已核实的事实：artifacts 缓存是**每个 run 一份内存**（`agentAdapter` 里
 * `newRunScratch()`），而 `read_artifact` 自己的说明就写着"任务结束后取回会得到
 * artifact_expired"。所以「继续任务」/新任务重放上一次的回执时，那句 note 是一张必然兑不了的支票
 * ——模型照它做一次就白烧一轮。引用本身留着（历史形状不变、日志可复盘），只把承诺改口。
 */
export function markStaleArtifacts<T>(rec: T): T {
  const r = rec as { data?: unknown; artifactRefs?: unknown };
  const d = r?.data;
  const hasRefs = Array.isArray(r.artifactRefs) && r.artifactRefs.length > 0;
  if (!d || typeof d !== "object") return hasRefs ? { ...r, artifactRefs: undefined } as T : rec;
  const o = d as Record<string, unknown>;
  if (typeof o.artifactRef !== "string" && !hasRefs) return rec;
  const next: Record<string, unknown> = { ...o, note: "原文缓存在上一次运行的内存里，那次任务结束即失效：不要调 read_artifact，需要内容请重新调用对应工具" };
  delete next.artifactRef;
  /** 数组型回执的引用挂在顶层 `artifactRefs` 上（P95-H3）——那条也得一起摘，
   *  否则 `data` 里的承诺改了口、壳上却还留着一串能照着撞的 ref（P135-A 补的同一类）。 */
  return { ...r, ...(hasRefs ? { artifactRefs: undefined } : {}), data: next } as T;
}

/* ================= P134-B：台账里"有调用、没回执"时该说什么 =================
 * 两种情形必须分开，它们的正确动作相反：
 *  · 宿主主动丢弃（取消 / 调用数或时限耗尽）⇒ **确定没执行**，可以直接重试；
 *  · 进程被杀在写操作中途 ⇒ **结果未知**，盲目重试可能把同一份写入落两次。
 * 旧实现两种都不说：调用在台账里根本不存在（回执事件要等执行完才有），
 * 于是续跑的模型读到的是"这一步没发生过"——那是第三种、也是最坏的一种假话。
 * 判据与措辞对标 DSH `packages/core/session/src/repair.ts:36-39`（源码核实于 commit 477b4f4）。 */

export const INTERRUPTED_CODE = "interrupted_no_result";
export const NOT_DISPATCHED_CODE = "cancelled_before_dispatch";

/** 结果未知：措辞里三条判据一条都不能省——只说"失败了"模型就会原样重试。 */
export function interruptedReceipt(callId: string, tool = "tool"): ToolReceipt {
  return {
    callId, ok: false, status: "error", code: INTERRUPTED_CODE,
    data: {
      tool,
      note: "这次调用在台账里有声明、没有回执：应用可能在它执行到一半时被结束，**结果未知**。"
        + "只有确认它是只读或幂等的才可以重试；可能有副作用（写文件、改设置、发设备、装插件）时，"
        + "先用只读工具核对当前状态，或把情况告诉用户由用户决定——不要盲目重试。",
    },
  };
}

/** 确定没执行：宿主在派发之前就中止了它，所以这里可以说"没有产生任何效果"。 */
export function notDispatchedReceipt(callId: string, tool: string, why: string): ToolReceipt {
  return {
    callId, ok: false, status: "not_executed", code: NOT_DISPATCHED_CODE,
    data: { tool, note: `这次调用没有派发执行（${why}），没有产生任何效果；需要它请重新发起。` },
  };
}

/** 折叠结果带计数——"折了几条"必须能被记进事件台账，而不是像旧实现那样折完即丢。 */
export interface FoldResult {
  messages: AgentMessage[];
  folded: number;
  /** 是否真的动了（未超阈值时返回原数组引用，测试据此钉"无副作用"这件事） */
  changed: boolean;
}

/* ================= P135-A：压缩时的无模型裁剪器（对标 DSH `compaction-tool-result-pruner` + `spill-policy`） =================
 * 这里补的是 P134-A §10 留下的空档：**按形态裁短只在回执进台账那一刻跑一次**（`shrinkByShape`），
 * 压缩的时候没有再跑一遍——于是超限之后只有一种手段可用：把整条记录扔掉
 * （折叠压成一行 / 投影整条遮蔽）。为了放下一条 40 KB 的旧回执，
 * 旁边三十条几百字节的小步骤一起没了，那是本可避免的损失。
 *
 * 顺序的含义：**先做不花钱、不撒谎、可复算的那一步，再让"整段没了"退成最后手段**。
 * 无模型 ⇒ 不多烧一轮请求；确定性 ⇒ 每一轮重算都得到同一份字节（台账随时能复演）。 */

/** 单条不足这个字节数不值得动手：省不下什么，却先毁了一份原文 */
export const PRUNE_MIN_BYTES = 3 * 1024;
/** 头部留多少：字段名与结构在这儿 */
export const PRUNE_HEAD_BYTES = 1_200;
/** 尾部留多少：失败原因与末行统计在这儿（`shrink.ts` 开头那条教训——只给头部等于只给回声） */
export const PRUNE_TAIL_BYTES = 600;
/** 末尾这么多条不动：那是模型当前的工作集，裁它的尾巴等于让它在关键一步上盲猜 */
export const PRUNE_KEEP_RECENT = 2;

export interface PruneOptions {
  /** "这一套发得下吗"。两条压缩线口径不同（传输按字节、窗口投影按字符），所以由调用方给 */
  fits: (messages: AgentMessage[]) => boolean;
  /** 单条尺寸，与 `fits` 同一口径 */
  size: (m: AgentMessage) => number;
  /**
   * 把即将从这一轮请求里消失的原文交进**本 run 的可取回缓存**，返回真能取回的 ref。
   * 不提供（或返回 null）⇒ 裁剪仍然发生，但 note 自动降档成"请重新调用对应工具"——
   * P94-G3 / P134-A ③ 两次都栽在无条件承诺 `read_artifact`，这一条就是那道闸。
   */
  spill?: (ref: string, original: string) => string | null;
  keepRecent?: number;
}

export interface PruneResult {
  messages: AgentMessage[];
  pruned: number;
  /** 未超限时返回**原数组引用**，与 `foldContext` 同一套"无副作用可被钉住"的写法 */
  changed: boolean;
}

/**
 * 把超预算那几条**巨型工具回执**裁成 head + marker + tail。
 * 四条判据：① 未超限一条不裁（`fits` 先判）② 只裁发出那一份，绝不改台账本体
 * ③ 末尾 `keepRecent` 条不动 ④ content 解析不出 JSON 对象的**跳过**，不猜形状。
 */
export function pruneToolResults(messages: AgentMessage[], opts: PruneOptions): PruneResult {
  if (opts.fits(messages)) return { messages, pruned: 0, changed: false };
  const keep = Math.max(0, Math.floor(opts.keepRecent ?? PRUNE_KEEP_RECENT));
  const out = messages.slice();
  const cutPoint = Math.max(0, out.length - keep);
  let n = 0;
  for (let i = 0; i < cutPoint; i++) {
    const pruned = pruneReceipt(out[i], opts);
    if (!pruned) continue;
    out[i] = pruned;
    n++;
    if (opts.fits(out)) break; // 放得下就立刻停手：多裁一条都是白毁的保真度
  }
  return n > 0 ? { messages: out, pruned: n, changed: true } : { messages, pruned: 0, changed: false };
}

/** 一条都裁不动时返回 null（调用方据此决定"这条不动"，而不是换成我猜的形状）。 */
function pruneReceipt(m: AgentMessage, opts: PruneOptions): AgentMessage | null {
  if (m.role !== "tool" || opts.size(m) < PRUNE_MIN_BYTES) return null;
  let rec: Record<string, unknown>;
  try {
    const v = JSON.parse(m.content) as unknown;
    if (!v || typeof v !== "object") return null;
    rec = v as Record<string, unknown>;
  } catch {
    return null;
  }
  // 没有 `data` 就没有正文可裁（顶层是数组的回执也落在这里：数组上没有 data 字段，
  // 于是它不会被 `{...rec, data}` 改写成对象——验牙时正是这条把数组形状接住的）
  const data = rec.data;
  if (data === undefined) return null;
  const full = typeof data === "string" ? data : JSON.stringify(data);
  const fullBytes = utf8Bytes(full);
  if (fullBytes <= PRUNE_HEAD_BYTES + PRUNE_TAIL_BYTES) return null; // 裁不出东西，别白毁
  const head = full.slice(0, PRUNE_HEAD_BYTES);
  const tail = full.slice(-PRUNE_TAIL_BYTES);
  /** 原文已经在缓存里的那一份（捕获层 `rememberArtifact` 存的）优先沿用，绝不另开一个引用 */
  const carried = (data !== null && typeof data === "object" && typeof (data as { artifactRef?: unknown }).artifactRef === "string")
    ? (data as { artifactRef: string }).artifactRef
    : Array.isArray(rec.artifactRefs) && typeof rec.artifactRefs[0] === "string" ? rec.artifactRefs[0] as string : null;
  const key = `prune:${m.callId ?? ""}`;
  const spilled = !carried && m.callId ? opts.spill?.(key, full) ?? null : null;
  const ref = carried ?? spilled;
  const omitted = fullBytes - utf8Bytes(head) - utf8Bytes(tail);
  const nextData: Record<string, unknown> = {
    pruned: true,
    fullBytes,
    omittedBytes: Math.max(0, omitted),
    head,
    tail,
    ...(ref ? { artifactRef: ref } : {}),
    note: ref
      ? `这条回执在发送前被无模型裁剪压短：中间约 ${omitted} 字节本轮没有发出去。`
        + `完整原文可用 read_artifact { ref: "${ref}" } 分页取回；台账与用户界面上仍是全文。`
      : `这条回执在发送前被无模型裁剪压短：中间约 ${omitted} 字节本轮没有发出去，`
        + "这里没有可取回的缓存；需要完整内容请重新调用对应工具（把范围缩小）。台账与用户界面上仍是全文。",
  };
  return { ...m, content: JSON.stringify({ ...rec, data: nextData }) };
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
    let tailStart = Math.max(headEnd, messages.length - keep);
    /* P134-A（对标 DSH `region.ts:133-147` 的 toolPairingBalancedBefore）：
       折叠边界不许把"一次调用"和"它的回执"劈开。劈开的代价不是难看而已——
       Anthropic 那条路上 `tool_result` 找不到配对的 `tool_use` 是 400，
       而就算协议层放过了，模型读到一条孤儿回执也会以为存在一次没发生的调用
       （P92 A2 对"孤儿调用"的同一判据，这次发生在折叠侧）。 */
    while (tailStart > headEnd && messages[tailStart]?.role === "tool") tailStart--;
    const middle = messages.slice(headEnd, tailStart);
    return {
      out: [...messages.slice(0, headEnd), ...(middle.length ? [summarize(middle)] : []), ...messages.slice(tailStart)],
      folded: middle.length,
    };
  };
  const fits = (arr: AgentMessage[]) =>
    maxBytes === undefined ? estimateChars(arr) <= CONTEXT_SOFT_LIMIT : agentPayloadBytes(arr) <= maxBytes;

  if (fits(messages)) return { messages, folded: 0, changed: false };
  /* P134-A：阶梯必须**逐级往下试到放得下为止**。
     旧写法是 `for (keep = 8; keep >= 2; keep -= 2) { best = foldWith(keep); if (best.folded === 0 || fits || keep === 2) break; }`
     ——第一轮 keep=8 时"最近 8 条"往往就是全部（10 条消息 ⇒ 中间段为空 ⇒ folded===0），
     于是 `folded === 0` 这条 break 立刻命中，阶梯在第一级就收工，报一个本来可避免的 context_overflow。
     症状是"任务没多大就说放不下"。现在从 8 起算，放不下就继续 6/4/2，取第一个放得下的那一级。 */
  let best = foldWith(KEEP_RECENT_MESSAGES);
  if (maxBytes !== undefined && !fits(best.out)) {
    for (let keep = KEEP_RECENT_MESSAGES - 2; keep >= 2; keep -= 2) {
      best = foldWith(keep);
      if (fits(best.out)) break;
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
  /* P134-A：这句说明里"能不能取回原文"必须跟着事实走。旧写法无条件写"可用 read_artifact 取回"，
     而 read_artifact 只认**当时被裁过并存进 artifacts 的那份**（`artifactRef`）——
     被折叠的多是普通正文与短回执，照着这句话去调只会拿到 artifact_not_found。
     同一类空头支票 P94-G3 在 shrinkReceipt 里修过一次，这里是它的另一半。 */
  const refable = msgs.some((m) => m.role === "tool" && m.content.includes("artifactRef"));
  const tail = refable
    ? "带 artifactRef 的条目可用 read_artifact 分页取回，其余请重新调用对应工具"
    : "需要原文请重新调用对应工具（这里没有可取回的缓存）";
  return { role: "system", content: `（较早 ${msgs.length} 条步骤摘要，细节已折叠；${tail}）\n${lines.join("\n")}` };
}
