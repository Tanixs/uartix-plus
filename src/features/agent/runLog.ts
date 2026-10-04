/**
 * P133-I：Agent 任务台账 → 文本，**只有这一份**。
 *
 * 原来 `serializeLog` / `statusLabel` / `capOf` 住在 `AgentInline.tsx`（那枚「复制日志」按钮在用）。
 * 「导出对话为 md」也要把任务过程写进去，而第二份渲染器就是第二套真相：时间线上改了措辞、
 * 导出里没改，用户拿到的那份就是过时的。搬出来共用，顺带得到第二个好处——
 * 这一层不碰 React，测试可以直接驱动它。
 */
import type { AgentRunView } from "./agentRun";
import { NO_PROGRESS_PAUSE_AT } from "./loop";
import type { PauseReason, RunEvent } from "./types";
import { readDroppedPlaceholder } from "./context";
import { tx } from "../../i18n/strings";

/**
 * P109-A：`0 = 不限制`（用户裁决，见 `loop.ts` 的 `resolveBudget`）。
 * 显示成"第 5/0 轮"会被读成"预算是 0 轮、任务该立刻停"——那是反的，所以渲染成 ∞。
 */
export const capOf = (n: number): string => (n === 0 ? "∞" : String(n));

/**
 * 任务状态的人话。原来是 `STATUS_ZH: Record<string, string>`（值只有中文，名字也写着"只会出中文"）。
 * 用 switch 而不是"中英成对存在一张表里"：表里的字面量扫描器认不出来（它只认 `tx("…", "…")` 这个形状），
 * 债会被原样记在预算上 —— 表好看，数却是假的。
 */
export function statusLabel(status: string, reason?: PauseReason): string {
  switch (status) {
    case "running":
      return tx("运行中", "Running");
    case "succeeded":
      return tx("已完成", "Done");
    // P91 A4：failed/interrupted 现在都能「继续任务」（从台账续跑，不重做已生效步骤），
    // 但批准令牌与撤销令牌仍不跨重启（§5.4）——文案必须同时说清这两件事
    // P109-B：四种暂停的**正确动作不一样**，不能再塌成以前那一句"预算耗尽或连续失败"。
    // 没有原因码的旧记录只说"已暂停"——宁可不说是猜。
    case "paused":
      switch (reason) {
        case "no-progress":
          return tx(`已暂停（同一个调用连续失败 ${NO_PROGRESS_PAUSE_AT} 次）`, `Paused (same call failed ${NO_PROGRESS_PAUSE_AT} times)`);
        case "deadline":
          return tx("已暂停（达到时限）", "Paused (time limit reached)");
        case "calls":
          return tx("已暂停（工具调用次数用完）", "Paused (tool-call limit reached)");
        case "rounds":
          return tx("已暂停（轮数用完）", "Paused (round limit reached)");
        default:
          return tx("已暂停", "Paused");
      }
    case "cancelled":
      return tx("已取消", "Cancelled");
    case "failed":
      return tx("失败", "Failed");
    case "interrupted":
      return tx("已中断（应用重启）· 可继续任务", "Interrupted (app restarted) · the task can be resumed");
    default:
      return status;
  }
}

/**
 * P133-I：日志里的截断必须**看得见**。原来直接 `slice(0, 400)` 就写出去，
 * 于是一条被砍短的参数读起来像完整的——离线排查时那是最坏的一种假话。
 * 上限也从 400/1200 抬到 2000/4000：这份东西的存在理由就是"不用对着界面猜"。
 *
 * P139：这两个数字原来是**函数里写死的一对常量**，被剪贴板与文件两个出口共用，
 * 于是用户主动导出的那份 .md 被剪贴板的尺度截断（一份 6 万字的子代理报告落盘只剩 4000 字）。
 * 现在两个出口各有各的档，且**只在这里定义**——调用点再写一遍数字就是第二份真相（§8-36）。
 */
export const LOG_CLIPBOARD = { args: 2_000, data: 4_000 };
/** 文件是留档：正文与参数都不该被截。留"不截"这个显式值，而不是把上限调到一个自认为够大的数 */
export const LOG_FILE = { args: Number.POSITIVE_INFINITY, data: Number.POSITIVE_INFINITY };
export type LogProfile = typeof LOG_CLIPBOARD;

function cut(s: string, max: number): string {
  // 截断标记本身也要双语：这份日志的其余行都走 tx()，这里冒出一句纯中文，
  // 英文界面下导出的文件就成了半中半英。
  return s.length <= max ? s : `${s.slice(0, max)}${tx(`…（此处截断，共 ${s.length} 字）`, `… (truncated; ${s.length} chars total)`)}`;
}

/** P88e C2：事件台账 → 纯文本日志。含起止/预算/每事件时间戳与回执码，
 *  让用户拿到一份可离线排查的完整现场，而不是对着界面猜。
 *  `profile` 决定截断尺度：剪贴板档小、文件档不截（默认是剪贴板档，导出必须显式传 `LOG_FILE`）。 */
export function serializeLog(r: AgentRunView, profile: LogProfile = LOG_CLIPBOARD): string {
  const lines: string[] = [];
  lines.push(tx("# Uartix Agent 任务日志", "# Uartix+ Agent task log"));
  lines.push(`runId: ${r.runId}`);
  lines.push(tx(`目标: ${r.goal}`, `Goal: ${r.goal}`));
  lines.push(tx(`档位: ${r.scope}`, `Tier: ${r.scope}`));
  lines.push(tx(`状态: ${statusLabel(r.status, r.pauseReason)}`, `Status: ${statusLabel(r.status, r.pauseReason)}`));
  const startedAt = new Date(r.createdAt).toLocaleString();
  const endedAt = r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "";
  lines.push(
    endedAt
      ? tx(`起止: ${startedAt} → ${endedAt}`, `Span: ${startedAt} → ${endedAt}`)
      : tx(`起止: ${startedAt} → 进行中`, `Span: ${startedAt} → running`),
  );
  lines.push(
    tx(
      `预算: ${r.rounds}/${capOf(r.caps.maxRounds)} 轮 · ${r.calls}/${capOf(r.caps.maxCalls)} 次工具调用`,
      `Budget: ${r.rounds}/${capOf(r.caps.maxRounds)} rounds · ${r.calls}/${capOf(r.caps.maxCalls)} tool calls`,
    ),
  );
  // P139：从磁盘恢复的台账里，落盘预算装不下的那些正文是**占位**（P138-B）。
  // 这份文件的读者必须知道自己在看的是"完整现场"还是"缺了几段正文的现场"（§8-41）。
  const atRestOmitted = r.events.filter(
    (e) => e.kind === "receipt" && (readDroppedPlaceholder(e.receipt?.data) !== null || e.receiptTrim === "dropped"),
  ).length;
  if (atRestOmitted) {
    lines.push(tx(
      `未落盘: ${atRestOmitted} 条回执正文超出生成预算，已换成占位（这份日志是从磁盘恢复的，缺的那几段正文内存里也未必还在；需要内容请重新调用对应工具）`,
      `Not persisted: ${atRestOmitted} receipt bodies exceeded the at-rest budget and were replaced by placeholders (this log was restored from disk; re-run the tool if you need the content)`,
    ));
  }
  // P95-H2：日志里带上下文用量（离线复盘"为什么这轮被截/超限"时的第一手数据）
  if (r.ctx) {
    const last = r.ctx.last;
    const bits = [
      tx(`上下文: 末轮 ${((last?.bytes ?? 0) / 1024).toFixed(0)} KB`, `Context: last ${((last?.bytes ?? 0) / 1024).toFixed(0)} KB`),
      tx(`峰值 ${(r.ctx.peakBytes / 1024).toFixed(0)} KB`, `peak ${(r.ctx.peakBytes / 1024).toFixed(0)} KB`),
    ];
    if (last?.droppedImages) bits.push(tx(`已弃历史图 ${last.droppedImages} 张`, `${last.droppedImages} history images dropped`));
    if (last?.pruned) bits.push(tx(`无模型裁短 ${last.pruned} 条巨型回执（台账仍是全文）`, `${last.pruned} oversized receipt(s) pruned without a model call, the ledger still holds the full text`));
    if (last?.folded) bits.push(tx(`折叠 ${last.folded} 条`, `${last.folded} folded`));
    if (last?.shadowed) bits.push(tx(`会话遮蔽 ${last.shadowed} 条`, `${last.shadowed} session turns shadowed`));
    lines.push(bits.join(" · "));
  }
  lines.push(tx("--- 事件台账 ---", "--- Event ledger ---"));
  for (const e of r.events) {
    const t = e.ts ? `[${new Date(e.ts).toLocaleTimeString()}]` : "";
    if (e.kind === "turn") {
      lines.push(tx(`${t} #${e.seq} 模型叙述: ${e.text ?? ""}`, `${t} #${e.seq} Narration: ${e.text ?? ""}`));
    } else if (e.kind === "context") {
      lines.push(tx(`${t} #${e.seq} 上下文: ${e.text ?? ""}`, `${t} #${e.seq} Context: ${e.text ?? ""}`));
    } else if (e.kind === "reasoning") {
      lines.push(tx(`${t} #${e.seq} 思维链: ${e.text ?? ""}`, `${t} #${e.seq} Reasoning: ${e.text ?? ""}`));
    } else if (e.kind === "status") {
      lines.push(tx(`${t} #${e.seq} 状态: ${e.text ?? ""}`, `${t} #${e.seq} Status: ${e.text ?? ""}`));
    } else if (e.kind === "receipt") {
      lines.push(
        tx(
          `${t} #${e.seq} 工具: ${e.tool ?? ""} 参数: ${cut(e.args ?? "", profile.args)}${e.argsTruncated ? "（宿主侧已先行截断）" : ""}`,
          `${t} #${e.seq} Tool: ${e.tool ?? ""} Args: ${cut(e.args ?? "", profile.args)}${e.argsTruncated ? " (already truncated by the host)" : ""}`,
        ),
      );
      const rec = e.receipt;
      if (rec) {
        lines.push(
          tx(
            `    回执: ok=${rec.ok} status=${rec.status}${rec.code ? ` code=${rec.code}` : ""}`,
            `    Receipt: ok=${rec.ok} status=${rec.status}${rec.code ? ` code=${rec.code}` : ""}`,
          ),
        );
        const restOmitted = readDroppedPlaceholder(rec.data);
        if (restOmitted !== null) {
          // P138-B：旧写法只在 `data === undefined` 时才说"省略"，而落盘占位本身是个**有值**的对象
          // ⇒ 那句"省略"其实从来没说出来过，读导出的人只看见一个长得像业务字段的 truncated（§8-46 同族）。
          lines.push(tx(
            `    数据: <落盘时整份省略，原始 ${restOmitted} 字；这段正文不在台账里，需要请重新调用该工具>`,
            `    Data: <omitted at rest: ${restOmitted} chars originally; this text is not in the ledger - re-run the tool if you need it>`,
          ));
        } else if (rec.data !== undefined) {
          try {
            lines.push(tx(
              `    数据: ${cut(JSON.stringify(rec.data), profile.data)}${e.receiptTrim === "excerpt" ? "（落盘摘录：超长正文只留头尾）" : ""}`,
              `    Data: ${cut(JSON.stringify(rec.data), profile.data)}${e.receiptTrim === "excerpt" ? " (rest excerpt: long bodies keep head and tail only)" : ""}`,
            ));
          } catch {
            lines.push(tx("    数据: <不可序列化>", "    Data: <not serializable>"));
          }
        } else if (e.receiptTruncated) {
          // 台账说得出"这里原本有内容"（P94 G2 红线 A7），导出里也不能给一条空回执
          lines.push(tx("    数据: <落盘时省略，原始回执过大>", "    Data: <omitted at rest: the receipt was too large>"));
        }
      }
    } else {
      lines.push(`${t} #${e.seq} ${(e as RunEvent).kind}: ${(e as RunEvent).text ?? ""}`);
    }
  }
  return lines.join("\n");
}
