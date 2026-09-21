/**
 * P88d ③④ + P88e C：Agent 任务集成进 AI 对话——会话内联活动流。
 * - 目标气泡 + 时间线（模型叙述=打字机滚动、工具卡=中文名+人类摘要+可展开详情）
 *   + 审批卡（内联在消息位置）+ 终态结果条（失败必带原因）；
 * - P88e C2：时间线竖向连接线（视觉过程感）、工具卡带耗时、终态耗时定格、
 *   「复制日志」按钮（事件台账序列化进剪贴板——离线分析失败原因的正解）；
 * - P89 A1：同会话多个 run——终态（含失败）一律折叠为一行摘要，点击展开、可删除；
 *   running/paused 自动展开（进度实时可见、暂停就地可续跑）；
 * - 任务归属 chatStore 会话（sessionId），按会话过滤渲染；
 * - P88e C3：悬浮任务条在任务结束后延迟 3s 再消失（给用户看到结果的机会）。
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as agentRun from "./agentRun";
import type { AgentRunView } from "./agentRun";
import { isLiveRun, type RunEvent, type ToolProvenance } from "./types";
import { ctxGauge, fmtKb } from "./context";
import { hasDataLease } from "../plot/dataLease";
import { confirmDialog } from "../../shared/Dialog";
import { IconTrash } from "../../shared/icons";
import { parseArgs, receiptRows, receiptStatusText, summarizeArgs, toolLabel } from "./toolDisplay";
// 插件库真值（停用按钮态）：AgentInline 是 UI 叶子，静态引入不成环
// （pluginStore→extRuntime→chatStore→agentRun 链上没有任何一环回头引本文件）
import { getSnapshot as getPluginSnapshot, subscribe as subscribePlugins } from "../plugins/pluginStore";

function fmtClock(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtElapsed(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m${t % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** P98-M4：体积可读化与用量档位统一收在 `context.ts`（运行卡与输入区用量条共用一份口径） */

const STATUS_ZH: Record<string, string> = {
  running: "运行中",
  succeeded: "已完成",
  paused: "已暂停（预算耗尽或连续失败）",
  cancelled: "已取消",
  failed: "失败",
  // P91 A4：failed/interrupted 现在都能「继续任务」（从台账续跑，不重做已生效步骤），
  // 但批准令牌与撤销令牌仍不跨重启（§5.4）——文案必须同时说清这两件事
  interrupted: "已中断（应用重启）· 可继续任务",
};

/** P88e C2：事件台账 → 纯文本日志（剪贴板用）。含起止/预算/每事件时间戳与回执码，
 *  让用户拿到一份可离线排查的完整现场，而不是对着界面猜。 */
function serializeLog(r: AgentRunView): string {
  const lines: string[] = [];
  lines.push("# Uartix Agent 任务日志");
  lines.push(`runId: ${r.runId}`);
  lines.push(`目标: ${r.goal}`);
  lines.push(`档位: ${r.scope}`);
  lines.push(`状态: ${STATUS_ZH[r.status] ?? r.status}`);
  lines.push(
    `起止: ${new Date(r.createdAt).toLocaleString()} → ${r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "进行中"}`,
  );
  lines.push(`预算: ${r.rounds}/${r.caps.maxRounds} 轮 · ${r.calls}/${r.caps.maxCalls} 次工具调用`);
  // P95-H2：日志里带上下文用量（离线复盘"为什么这轮被截/超限"时的第一手数据）
  if (r.ctx) {
    lines.push(
      `上下文: 末轮 ${((r.ctx.last?.bytes ?? 0) / 1024).toFixed(0)} KB · 峰值 ${(r.ctx.peakBytes / 1024).toFixed(0)} KB` +
        `${r.ctx.last?.droppedImages ? ` · 已弃历史图 ${r.ctx.last.droppedImages} 张` : ""}` +
        `${r.ctx.last?.folded ? ` · 折叠 ${r.ctx.last.folded} 条` : ""}` +
        `${r.ctx.last?.shadowed ? ` · 会话遮蔽 ${r.ctx.last.shadowed} 条` : ""}`,
    );
  }
  lines.push("--- 事件台账 ---");
  for (const e of r.events) {
    const t = e.ts ? `[${new Date(e.ts).toLocaleTimeString()}]` : "";
    if (e.kind === "turn") {
      lines.push(`${t} #${e.seq} 模型叙述: ${e.text ?? ""}`);
    } else if (e.kind === "context") {
      lines.push(`${t} #${e.seq} 上下文: ${e.text ?? ""}`);
    } else if (e.kind === "reasoning") {
      lines.push(`${t} #${e.seq} 思维链: ${e.text ?? ""}`);
    } else if (e.kind === "status") {
      lines.push(`${t} #${e.seq} 状态: ${e.text ?? ""}`);
    } else if (e.kind === "receipt") {
      lines.push(`${t} #${e.seq} 工具: ${e.tool ?? ""} 参数: ${(e.args ?? "").slice(0, 400)}`);
      const rec = e.receipt;
      if (rec) {
        lines.push(`    回执: ok=${rec.ok} status=${rec.status}${rec.code ? ` code=${rec.code}` : ""}`);
        if (rec.data !== undefined) {
          try {
            lines.push(`    数据: ${JSON.stringify(rec.data).slice(0, 1200)}`);
          } catch {
            lines.push("    数据: <不可序列化>");
          }
        }
      }
    } else {
      lines.push(`${t} #${e.seq} ${(e as RunEvent).kind}: ${(e as RunEvent).text ?? ""}`);
    }
  }
  return lines.join("\n");
}

/** 打字机滚动文本（模型叙述/思考）：新内容逐字浮现；超长（>2000 字）或终态直显防卡顿 */
function Typewriter({ text, instant }: { text: string; instant?: boolean }) {
  const [shown, setShown] = useState(instant ? text.length : 0);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
    if (instant) setShown(text.length);
  }, [text, instant]);
  useEffect(() => {
    if (instant) return;
    const t = setInterval(() => {
      setShown((v) => {
        const target = textRef.current.length;
        if (v >= target) return v;
        return Math.min(target, v + Math.max(2, Math.ceil((target - v) / 12)));
      });
    }, 40);
    return () => clearInterval(t);
  }, [instant]);
  return <>{text.slice(0, shown)}</>;
}

/** P90 B3/B4：长文本折叠块——收起态一行高且自动滚到最新（"单行滚动"），
 *  点击展开看全量；观感对齐聊天侧 ThinkBox（渐变左条 + 耗时文案 + caret）。 */
function Foldable({
  label,
  text,
  live,
  italic,
}: {
  label: string;
  text: string;
  live?: boolean;
  italic?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, open]);
  return (
    <div className={`ai-agent-fold${live ? " live" : ""}${open ? " open" : ""}${italic ? " italic" : ""}`}>
      <button className="ai-agent-fold-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {live && <span className="ai-agent-fold-dot" aria-hidden="true" />}
        <span className="ai-agent-fold-label">{label}</span>
        <svg className={`ai-agent-caret${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </button>
      <div className="ai-agent-fold-body" ref={bodyRef}>{text}</div>
    </div>
  );
}

/** 单条工具卡：状态点 + 中文工具名 + 人类摘要 + 时刻与耗时；展开=参数/回执表格化 */
function ToolCard({
  tool,
  args,
  truncated,
  receipt,
  ts,
  dur,
  undoState,
  onUndo,
}: {
  tool: string;
  args?: string;
  /** P92 D1：参数被截断过——摘要要承认"没看全"，不能猜 */
  truncated?: boolean;
  receipt: { ok: boolean; status: string; code?: string; undoToken?: string; data?: unknown; src?: ToolProvenance };
  ts?: number;
  dur?: number;
  /** 撤销态；类型直接由展示表反推 ⇒ 加了新撤销态却没配说法，这里就编译不过 */
  undoState?: keyof typeof agentRun.UNDO_STATE_UI | "undone";
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // P90 E4：任务保存的插件就地一键停用（覆盖层已清、撤销令牌已失效，"停用"才是恢复路径）。
  // P91 D2：按钮态一律读插件库真值——旧实现用局部 useState，刷新后对已停用的插件
  // 仍然再给一次「停用」，失败只写在 console 里（用户看到的就是"点了没反应"）。
  const plugins = useSyncExternalStore(subscribePlugins, getPluginSnapshot);
  const pluginId =
    receipt.ok && typeof (receipt.data as { pluginId?: unknown } | undefined)?.pluginId === "string"
      ? (receipt.data as { pluginId: string }).pluginId
      : "";
  const plugin = pluginId ? plugins.plugins.find((p) => p.pkg.id === pluginId) : undefined;
  const disablePlugin = async () => {
    const { setEnabled } = await import("../plugins/pluginStore");
    const r = setEnabled(pluginId, false);
    if (!r.ok) {
      const { toast } = await import("../ai/extRuntime");
      toast(`停用失败：${r.msg}`);
    }
  };
  const parsed = parseArgs(args);
  const zh = toolLabel(tool);
  const sum = summarizeArgs(tool, parsed, truncated) || (truncated ? "参数过长（见日志）" : "");
  const stat = receiptStatusText(receipt.ok, receipt.status, receipt.code);
  const rows = open ? receiptRows(receipt.data) : [];
  return (
    <div className={`ai-agent-tool${receipt.ok ? "" : " bad"}`}>
      <button className="ai-agent-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`ai-agent-dot${receipt.ok ? " ok" : " err"}`} aria-hidden="true" />
        <span className="ai-agent-tool-name">{zh}</span>
        {receipt.src?.kind === "plugin" && (
          <span
            className="ai-agent-src"
            title={`这支工具由插件提供：${receipt.src.pkgId} v${receipt.src.version}（不是宿主内置能力）`}
          >
            插件提供
          </span>
        )}
        <span className="ai-agent-tool-sum">{sum ? `${sum} · ${stat}` : stat}</span>
        <span className="ai-agent-tool-time">
          {ts ? fmtClock(ts) : ""}
          {dur != null && dur >= 1000 ? ` · ${fmtElapsed(dur)}` : ""}
        </span>
        <svg className={`ai-agent-caret${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </button>
      {open && (
        <div className="ai-agent-tool-detail">
          {Object.entries(parsed).filter(([k]) => k !== "revision").map(([k, v]) => (
            <div key={k} className="ai-agent-kv">
              <span className="ai-agent-k">{k}</span>
              <span className="ai-agent-v">{typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200)}</span>
            </div>
          ))}
          {rows.map((r, i) => (
            <div key={i} className="ai-agent-kv">
              <span className="ai-agent-k">{r.k}</span>
              <span className="ai-agent-v">{r.v}</span>
            </div>
          ))}
          {pluginId && (
            <div className="ai-agent-kv">
              <span className="ai-agent-k">持久化</span>
              {!plugin ? (
                <span className="ai-agent-v dim">插件已不在库中（记录保留）</span>
              ) : plugin.state !== "enabled" ? (
                <span className="ai-agent-v dim">已停用（插件库可重新启用）</span>
              ) : (
                <button
                  className="ai-agent-undo"
                  title={`停用插件「${plugin.pkg.name}」，界面立即恢复；也可到 设置 → 插件管理 处理`}
                  onClick={() => void disablePlugin()}
                >
                  在插件库停用
                </button>
              )}
            </div>
          )}
          {receipt.undoToken && (
            <div className="ai-agent-kv">
              <span className="ai-agent-k">撤销</span>
              {undoState === "undone" ? (
                <span className="ai-agent-v dim">已撤销</span>
              ) : (
                <button
                  className="ai-agent-undo"
                  title={undoState ? agentRun.UNDO_STATE_UI[undoState].tip : "撤销本次应用"}
                  disabled={!!undoState}
                  onClick={onUndo}
                >
                  {undoState ? agentRun.UNDO_STATE_UI[undoState].label : "撤销"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 审批卡（内联在消息流位置） */
function ApprovalCard({ view }: { view: AgentRunView }) {
  const req = view.pending;
  if (!req) return null;
  return (
    <div className="ai-agent-approval" role="alert">
      <div className="ai-agent-approval-title">需要你的批准：{toolLabel(req.tool)}</div>
      <div className="ai-agent-approval-plan">{req.plan}</div>
      <div className="ai-agent-approval-row">
        <span className="ai-agent-approval-exp">有效期至 {new Date(req.expiresAt).toLocaleTimeString()}；批准只对当前参数有效</span>
        <div className="ai-agent-approval-btns">
          <button className="btn" onClick={() => agentRun.reject(view.runId, req.id)}>拒绝</button>
          <button className="btn primary" onClick={() => agentRun.approve(view.runId, req.id)}>批准执行</button>
        </div>
      </div>
    </div>
  );
}

/** P88e B3：暂停续跑提示——用原 goal/授权域发起新 run；忙碌或失败原因就地展示。 */
function ResumeHint({ view, inline }: { view: AgentRunView; inline?: boolean }) {
  const [err, setErr] = useState("");
  const resume = () => {
    setErr("");
    agentRun
      .resumeRun(view.runId)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };
  if (inline) {
    return (
      <>
        <button className="btn primary ai-agent-act" title="以原目标与授权范围发起新任务（本记录保留）" onClick={resume}>
          继续任务
        </button>
        {err && <span className="ai-agent-resume-err">{err}</span>}
      </>
    );
  }
  return (
    <div className="ai-agent-resume-hint">
      <span>任务因预算耗尽或连续失败而暂停；继续将以原目标与授权范围发起新任务（本记录保留）。</span>
      <button className="btn sm" onClick={resume}>
        继续任务
      </button>
      {err && <span className="ai-agent-resume-err">{err}</span>}
    </div>
  );
}

/** 单个任务块的完整活动流（头部状态/目标/复制日志/停止 + meta + 时间线） */
function RunBlock({ view }: { view: AgentRunView }) {
  // 订阅宿主变更以吃到 live 增量（≤10Hz）；快照引用在 notify 里整体替换（R2）
  useSyncExternalStore(agentRun.subscribe, agentRun.getSnapshot);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const running = view.status === "running";
  const live = agentRun.getLive(view.runId);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const leaseOn = running && hasDataLease(view.runId);
  // 终态耗时定格（finishedAt）；运行中走实时 now
  const elapsedBase = view.finishedAt ?? now;
  const applied = view.events.filter((e) => e.kind === "receipt" && e.receipt?.ok).length;
  const interrupted = view.status === "failed" || view.status === "interrupted";
  const canRetry = agentRun.canRetry(view.runId);
  const copyLog = () => {
    const text = serializeLog(view);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };
  const run = (label: string, fn: () => Promise<unknown> | void) => {
    setBusy(label);
    void Promise.resolve()
      .then(fn)
      .catch(async (e: unknown) => {
        const { toast } = await import("../ai/extRuntime");
        toast(`任务操作失败：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setBusy(""));
  };
  const headStatus = interrupted && applied > 0 ? `已完成 ${applied} 步后中断` : STATUS_ZH[view.status] ?? view.status;
  return (
    <div className={`ai-agent-block${running ? " live" : ""}${interrupted ? " bad" : ""}`}>
      <div className="ai-agent-head">
        <span
          className={`ai-agent-dot${running ? " run" : view.status === "succeeded" ? " ok" : interrupted ? " err" : " warn"}`}
          aria-hidden="true"
        />
        <span className="ai-agent-status">{headStatus}</span>
        <span className="ai-agent-goal" title={view.goalBrief}>{view.goalBrief}</span>
        <span className="ai-agent-acts">
          {running && (
            <button className="btn ai-agent-act" onClick={() => agentRun.stopRun(view.runId)}>停止</button>
          )}
          {canRetry && (
            <button
              className="btn primary ai-agent-act"
              disabled={busy === "继续"}
              title="从事件台账重建历史并续跑：已生效的步骤不重做"
              onClick={() => run("继续", () => agentRun.retryRun(view.runId))}
            >
              {busy === "继续" ? "续跑中…" : "继续任务"}
            </button>
          )}
          {view.status === "paused" && <ResumeHint view={view} inline />}
          <button className="btn ai-agent-act" title="复制完整事件台账（含时间戳与回执码），便于离线排查" onClick={copyLog}>
            {copied ? "已复制" : "复制日志"}
          </button>
        </span>
      </div>
      <div className="ai-agent-meta">
        第 {view.rounds}/{view.caps.maxRounds} 轮 · 工具 {view.calls}/{view.caps.maxCalls} 次 · 已用 {fmtElapsed(elapsedBase - view.createdAt)}
        {/* P95-H2：这一轮到底送了多少东西进去（旧实现完全没有这个数） */}
        {view.ctx?.last && (
          <span
            className={`ai-agent-ctx${ctxGauge(view.ctx.last.bytes).level !== "ok" ? " warn" : ""}`}
            // P98-M4：带上分母与百分比。旧版只报「上下文 N KB」，用户看得见数字却判断不了还剩多少
            title={`末轮送入 ${ctxGauge(view.ctx.last.bytes).text}（峰值 ${fmtKb(view.ctx.peakBytes)}）· ${view.ctx.last.msgs} 条消息${view.ctx.last.images ? ` · 附图 ${view.ctx.last.images} 张` : ""}${view.ctx.last.shadowed ? ` · 会话历史遮蔽 ${view.ctx.last.shadowed} 条` : ""}`}
          >
            上下文 {ctxGauge(view.ctx.last.bytes).text}
            {view.ctx.last.droppedImages ? ` · 弃图 ${view.ctx.last.droppedImages}` : ""}
            {view.ctx.last.folded ? ` · 折叠 ${view.ctx.last.folded}` : ""}
          </span>
        )}
        {leaseOn && <span className="ai-agent-lease">正在采集数据</span>}
        {interrupted && applied > 0 && (
          <span className="ai-agent-applied">已生效 {applied} 项改动（展开可逐项撤销）</span>
        )}
      </div>
      {view.goal !== view.goalBrief && (
        <details className="ai-agent-fullgoal">
          <summary>完整目标（含附加上下文 · {view.goal.length} 字）</summary>
          <pre className="ai-agent-fullgoal-body">
            {view.goal.slice(0, 2000)}
            {view.goal.length > 2000 ? "\n…" : ""}
          </pre>
        </details>
      )}
      <div className="ai-agent-timeline">
        {view.events.map((e, i) => {
          // 单事件耗时 = 下一事件时刻 − 本事件时刻（最后一个事件到 finishedAt/now）
          const nextTs = view.events[i + 1]?.ts ?? view.finishedAt;
          const dur = e.ts && nextTs && nextTs > e.ts ? nextTs - e.ts : undefined;
          const isLast = i === view.events.length - 1;
          if (e.kind === "reasoning") {
            const t = e.text?.trim();
            if (!t) return null; // 模型不产思维链时零渲染，不留空卡
            // P91 A1：优先用 loop 记下的真实思考时长（旧实现靠事件时间差，非流式恒 0s）
            const ms = e.ms ?? dur ?? 0;
            const live = running && isLast;
            return <Foldable key={e.seq} italic live={live} label={live ? `思考中 · ${fmtElapsed(now - (e.ts ?? now))}` : `已思考 · ${fmtElapsed(ms)}`} text={t} />;
          }
          if (e.kind === "context") {
            // P95-H2：用量/收缩过程收成一条淡色细线（不抢正文视线，但可复盘"为什么这轮砍了图"）
            const t = e.text?.trim();
            return t ? <div key={e.seq} className="ai-agent-ctx-line">{t}</div> : null;
          }
          if (e.kind === "turn") {
            const t = e.text?.trim();
            if (!t) return null;
            if (/^〔第 \d+ 轮〕$/.test(t)) {
              // 轮次分隔线：过去它是一行裸文本，现在收成一条带序号的细线
              return <div key={e.seq} className="ai-agent-round">{t}</div>;
            }
            // P90 B4：超长叙述折叠，不再一条块体撑爆整屏（收起态一行滚动）
            if (t.length > 1200) return <Foldable key={e.seq} label={`模型叙述 · ${t.length} 字`} text={t} />;
            return (
              <div key={e.seq} className="ai-agent-turn">
                <Typewriter text={t} instant={!running || t.length > 2000} />
              </div>
            );
          }
          if (e.kind === "status") {
            const isEnd = e.text === "succeeded" || e.text === "failed" || e.text === "cancelled" || e.text === "paused" || e.text === "interrupted";
            if (!isEnd) return <div key={e.seq} className="ai-agent-note">{e.text}</div>;
            return (
              <div key={e.seq} className={`ai-agent-final${e.text === "succeeded" ? " ok" : ""}`}>
                任务结束：{STATUS_ZH[e.text ?? ""] ?? e.text}
              </div>
            );
          }
          const rec = e.receipt;
          if (!rec) return null;
          return (
            <ToolCard
              key={e.seq}
              tool={e.tool ?? "tool"}
              args={e.args}
              truncated={e.argsTruncated}
              receipt={rec}
              ts={e.ts}
              dur={dur}
              undoState={view.undoState[e.seq]}
              onUndo={() => agentRun.undoReceipt(view.runId, e.seq)}
            />
          );
        })}
        {/* P91 A1：流式增量——思维链与正文边到边冒出来（台账只在轮末收全量）。
            P96-K4：计时起点随每次送请求复位（旧实现整个 run 共用起点，"已思考 5m55s"读起来像卡死），
            超过 90s 才额外给一个累计值，免得用户以为前面几分钟白跑了。 */}
        {running && live?.reasoning && (
          <Foldable
            key="live-reasoning"
            italic
            live
            label={`本轮思考 · ${fmtElapsed(now - live.startedAt)}${now - view.createdAt > 90_000 ? ` · 累计 ${fmtElapsed(now - view.createdAt)}` : ""}`}
            text={live.reasoning}
          />
        )}
        {running && live?.text && (
          <div key="live-text" className="ai-agent-turn ai-agent-turn-live">{live.text}</div>
        )}
        {running && <ApprovalCard view={view} />}
        {running && !live?.text && !live?.reasoning && (
          <div className="ai-agent-wait">{`模型思考中… ${fmtElapsed(now - view.updatedAt)}`}</div>
        )}
        {/* 静默 20s 以上必须说清"为什么"和"怎么办"：旧实现只有一个跳秒的数字，
            用户只能在"卡死了"和"还在想"之间猜。做成兄弟节点而不是嵌进上面那行，
            是为了不跟着它的 agent-pulse 呼吸一起闪（长文闪烁没法读）。 */}
        {running && !live?.text && !live?.reasoning && now - view.updatedAt > 20_000 && (
          <div className="ai-agent-wait-hint">
            上游一直没有吐字。若反复停在这一轮：设置 → AI 服务 里关掉「深度思考」或调大「流式读空闲超时」；右侧红色按钮可停止并保留已完成步骤。
          </div>
        )}
        {view.status === "paused" && <ResumeHint view={view} />}
      </div>
    </div>
  );
}

/**
 * P91 B1：单条任务记录（由会话时间线按时间插到发起它的用户消息之后）。
 * 终态默认折成一行摘要，running/paused 自动展开；旧版这里是"本会话任务页脚"，
 * 页脚永远沉底 → 已由 buildTimeline 取代，AgentInline 组件随之删除。
 */
export const RunEntry = memo(function RunEntry({ view }: { view: AgentRunView }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  if (isLiveRun(view.status)) return <RunBlock view={view} />;
  const applied = view.events.filter((e) => e.kind === "receipt" && e.receipt?.ok).length;
  const interrupted = view.status === "failed" || view.status === "interrupted";
  const remove = async () => {
    if (
      await confirmDialog({
        message: `删除任务记录「${view.goalBrief}」？仅删本机台账，不可恢复。`,
        danger: true,
        okLabel: "删除",
      })
    ) {
      agentRun.removeRun(view.runId);
    }
  };
  const retry = () => {
    setBusy("retry");
    void Promise.resolve()
      .then(() => agentRun.retryRun(view.runId))
      .catch(async (e: unknown) => {
        const { toast } = await import("../ai/extRuntime");
        toast(`续跑失败：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setBusy(""));
  };
  return (
    <>
      <div className={`ai-agent-oldrun${interrupted && applied > 0 ? " partial" : ""}`}>
        <button
          className="ai-agent-oldrun-toggle"
          aria-expanded={open}
          title={view.goalBrief}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={`ai-agent-dot${view.status === "succeeded" ? " ok" : interrupted ? " err" : " warn"}`}
            aria-hidden="true"
          />
          <span className="ai-agent-oldrun-status">
            {interrupted && applied > 0 ? `已完成 ${applied} 步后中断` : STATUS_ZH[view.status] ?? view.status}
          </span>
          <span className="ai-agent-oldrun-goal">{view.goalBrief}</span>
          <span className="ai-agent-oldrun-time">
            {fmtElapsed((view.finishedAt ?? view.updatedAt ?? view.createdAt) - view.createdAt)}
          </span>
          <svg className={`ai-agent-caret${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        {agentRun.canRetry(view.runId) && (
          <button
            className="btn sm ai-agent-retry"
            title="从事件台账重建历史并续跑：已生效的步骤不重做"
            disabled={busy === "retry"}
            onClick={retry}
          >
            {busy === "retry" ? "续跑中…" : "继续任务"}
          </button>
        )}
        <button className="ai-agent-del" title="删除这条任务记录" onClick={() => void remove()}>
          <IconTrash />
        </button>
      </div>
      {open && <RunBlock view={view} />}
    </>
  );
});

/** 悬浮任务条：有活动任务且当前视图不在该会话时显示（点击=切回会话）。
 *  P88e C3：任务结束后延迟 3s 再消失——让用户有机会看到"已完成/失败"再收走。 */
export const AgentFloat = memo(function AgentFloat({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (sessionId: string) => void;
}) {
  const snap = useSyncExternalStore(agentRun.subscribe, agentRun.getSnapshot);
  const active = snap.runs.find((r) => r.runId === snap.activeRunId) ?? null;
  const isMine = active != null && active.sessionId === sessionId;
  const running = active?.status === "running";
  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (!active || isMine) {
      setLinger(false);
      return;
    }
    if (running) {
      setLinger(true);
      return;
    }
    // 刚结束：停 3s 显示终态，然后消失
    const t = window.setTimeout(() => setLinger(false), 3000);
    return () => window.clearTimeout(t);
    // active 每次通知都是新引用：running 期间重复 setLinger(true) 无害；
    // 结束后不再有通知，最后一次 effect 的 3s 定时器必然完整走到期。
  }, [active, running, isMine]);
  if (!active || isMine || !linger) return null;
  const done = !running;
  return (
    <button
      className={`ai-agent-float${done ? " done" : ""}`}
      onClick={() => active.sessionId && onOpen(active.sessionId)}
      title="回到任务所在会话查看结果"
    >
      <span className={`ai-agent-dot${active.pending ? " err" : done && active.status === "succeeded" ? " ok" : done ? " err" : " ok"}`} aria-hidden="true" />
      {active.pending ? "Agent 待批准" : done ? `任务${STATUS_ZH[active.status] ?? active.status}` : "Agent 运行中"}
    </button>
  );
});
