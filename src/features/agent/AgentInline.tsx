/**
 * P88d ③④ + P88e C：Agent 任务集成进 AI 对话——会话内联活动流。
 * - 目标气泡 + 时间线（模型叙述=打字机滚动、工具卡=中文名+人类摘要+可展开详情）
 *   + 审批卡（内联在消息位置）+ 终态结果条（失败必带原因）；
 * - P88e C2：时间线竖向连接线（视觉过程感）、工具卡带耗时、终态耗时定格、
 *   「复制日志」按钮（事件台账序列化进剪贴板——离线分析失败原因的正解）；
 * - P88e D1：同会话多个 run——最新完整渲染，更早的折叠为一行摘要；
 * - 任务归属 chatStore 会话（sessionId），按会话过滤渲染；
 * - P88e C3：悬浮任务条在任务结束后延迟 3s 再消失（给用户看到结果的机会）。
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as agentRun from "./agentRun";
import type { AgentRunView } from "./agentRun";
import type { RunEvent } from "./types";
import { hasDataLease } from "../plot/dataLease";
import { parseArgs, receiptRows, receiptStatusText, summarizeArgs, TOOL_LABEL } from "./toolDisplay";

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

const STATUS_ZH: Record<string, string> = {
  running: "运行中",
  succeeded: "已完成",
  paused: "已暂停（预算耗尽或连续失败）",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断（应用重启，仅可回看）",
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
  lines.push("--- 事件台账 ---");
  for (const e of r.events) {
    const t = e.ts ? `[${new Date(e.ts).toLocaleTimeString()}]` : "";
    if (e.kind === "turn") {
      lines.push(`${t} #${e.seq} 模型叙述: ${e.text ?? ""}`);
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

/** 单条工具卡：状态点 + 中文工具名 + 人类摘要 + 时刻与耗时；展开=参数/回执表格化 */
function ToolCard({
  tool,
  args,
  receipt,
  ts,
  dur,
  undoState,
  onUndo,
}: {
  tool: string;
  args?: string;
  receipt: { ok: boolean; status: string; code?: string; undoToken?: string; data?: unknown };
  ts?: number;
  dur?: number;
  undoState?: string;
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const parsed = parseArgs(args);
  const zh = TOOL_LABEL[tool] ?? tool;
  const sum = summarizeArgs(tool, parsed);
  const stat = receiptStatusText(receipt.ok, receipt.status, receipt.code);
  const rows = open ? receiptRows(receipt.data) : [];
  return (
    <div className={`ai-agent-tool${receipt.ok ? "" : " bad"}`}>
      <button className="ai-agent-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`ai-agent-dot${receipt.ok ? " ok" : " err"}`} aria-hidden="true" />
        <span className="ai-agent-tool-name">{zh}</span>
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
          {receipt.undoToken && (
            <div className="ai-agent-kv">
              <span className="ai-agent-k">撤销</span>
              {undoState === "undone" ? (
                <span className="ai-agent-v dim">已撤销</span>
              ) : (
                <button
                  className="ai-agent-undo"
                  title={
                    undoState === "revision_conflict"
                      ? "该设置之后又被修改，撤销会覆盖新改动"
                      : undoState === "token_expired"
                        ? "撤销仅本次运行内有效"
                        : "撤销本次应用"
                  }
                  onClick={onUndo}
                >
                  {undoState === "revision_conflict" ? "已被新改动覆盖" : undoState === "token_expired" ? "撤销已失效" : "撤销"}
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
      <div className="ai-agent-approval-title">需要你的批准：{TOOL_LABEL[req.tool] ?? req.tool}</div>
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
function ResumeHint({ view }: { view: AgentRunView }) {
  const [err, setErr] = useState("");
  const resume = () => {
    setErr("");
    agentRun
      .resumeRun(view.runId)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };
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
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const running = view.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const leaseOn = running && hasDataLease(view.runId);
  // 终态耗时定格（finishedAt）；运行中走实时 now
  const elapsedBase = view.finishedAt ?? now;
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
  return (
    <div className="ai-agent-block">
      <div className="ai-agent-head">
        <span className={`ai-agent-status${running ? " run" : view.status === "succeeded" ? " ok" : " bad"}`}>
          Agent 任务 · {STATUS_ZH[view.status] ?? view.status}
        </span>
        <span className="ai-agent-goal" title={view.goal}>{view.goal}</span>
        <button className="ai-agent-copylog" title="复制完整事件台账（含时间戳与回执码），便于离线排查" onClick={copyLog}>
          {copied ? "已复制" : "复制日志"}
        </button>
        {running && (
          <button className="btn danger sm" onClick={() => agentRun.stopRun(view.runId)}>
            停止
          </button>
        )}
      </div>
      <div className="ai-agent-meta">
        第 {view.rounds}/{view.caps.maxRounds} 轮 · 工具 {view.calls}/{view.caps.maxCalls} 次 · 已用 {fmtElapsed(elapsedBase - view.createdAt)}
        {leaseOn && <span className="ai-agent-lease">正在采集数据</span>}
      </div>
      <div className="ai-agent-timeline">
        {view.events.map((e, i) => {
          // 单事件耗时 = 下一事件时刻 − 本事件时刻（最后一个事件到 finishedAt/now）
          const nextTs = view.events[i + 1]?.ts ?? view.finishedAt;
          const dur = e.ts && nextTs && nextTs > e.ts ? nextTs - e.ts : undefined;
          if (e.kind === "turn") {
            return e.text?.trim() ? (
              <div key={e.seq} className="ai-agent-turn">
                <Typewriter text={e.text} instant={!running || e.text.length > 2000} />
              </div>
            ) : null;
          }
          if (e.kind === "status") {
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
              receipt={rec}
              ts={e.ts}
              dur={dur}
              undoState={view.undoState[e.seq]}
              onUndo={() => agentRun.undoReceipt(view.runId, e.seq)}
            />
          );
        })}
        {running && <ApprovalCard view={view} />}
        {running && (
          <div className="ai-agent-wait">模型思考中… {fmtElapsed(now - view.createdAt)}</div>
        )}
        {view.status === "paused" && <ResumeHint view={view} />}
      </div>
    </div>
  );
}

/** 会话内联时间线：本会话的 Agent 任务——最新一个完整渲染，更早的折叠为一行摘要（P88e D1） */
export const AgentInline = memo(function AgentInline({ sessionId }: { sessionId: string }) {
  const snap = useSyncExternalStore(agentRun.subscribe, agentRun.getSnapshot);
  const runs = snap.runs.filter((r) => r.sessionId === sessionId);
  if (runs.length === 0) return null;
  const shown = runs[0];
  const older = runs.slice(1, 6); // 摘要最多展示 5 个更早任务，防长会话堆积
  return (
    <div className="ai-agent-runs">
      {older.map((r) => (
        <div key={r.runId} className="ai-agent-oldrun" title={r.goal}>
          <span className={`ai-agent-dot${r.status === "succeeded" ? " ok" : r.status === "running" ? "" : " err"}`} aria-hidden="true" />
          <span className="ai-agent-oldrun-status">{STATUS_ZH[r.status] ?? r.status}</span>
          <span className="ai-agent-oldrun-goal">{r.goal}</span>
          <span className="ai-agent-oldrun-time">
            {fmtElapsed((r.finishedAt ?? r.updatedAt ?? r.createdAt) - r.createdAt)}
          </span>
        </div>
      ))}
      <RunBlock view={shown} />
    </div>
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
