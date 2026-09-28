import { useState } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { invoke } from "@tauri-apps/api/core";
import { jobStateText } from "./jobExecutor";
interface Details {
  jobId: string; source: string; createdAt: number; updatedAt: number; deadlineAt: number;
  targetSummary: string; permissionCheck: string; error?: { code: string };
  events?: { seq: number; ts: number; state: string; phase: string }[];
  result?: { text: string; nextOffset: number | null }; resultAvailability: string;
}
export function JobDetails({ jobId }: { jobId: string }) {
  useLocale(); // 展开一次读一次快照：文案渲染时取，切语言后再展开就是新语言
  const [detail, setDetail] = useState<Details | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(offset = 0) {
    setBusy(true); setError("");
    try {
      const result = await invoke<Details>("bridge_jobs_control", { kind: "wait_event", args: { jobId, afterSeq: 0, includeResult: true, offset, limit: 4096 } });
      setDetail(result);
    } catch { setError(tx("任务查询失败；不会重试执行。", "Query unavailable. No retry of execution was made.")); }
    finally { setBusy(false); }
  }
  return <details onToggle={(e) => { if (e.currentTarget.open && !detail && !busy) void load(); }}>
    <summary>{tx("详情", "Details")}</summary>
    <div style={{ maxWidth: 460, overflowWrap: "anywhere" }}>
      <code>{jobId}</code>{" "}
      <button className="btn" onClick={() => void navigator.clipboard.writeText(jobId).catch(() => setError(tx("复制失败", "Copy failed")))}>{tx("复制编号", "Copy ID")}</button>
      <button className="btn" disabled={busy} onClick={() => void load()}>{tx("刷新", "Refresh")}</button>
      {error && <p role="status">{error}</p>}
      {detail && <>
        <p>{detail.source} · {detail.targetSummary} · {detail.permissionCheck}</p>
                <p>{tx("创建", "Created")} {new Date(detail.createdAt).toLocaleString()} · {tx("截止", "Deadline")} {new Date(detail.deadlineAt).toLocaleString()}</p>
        {detail.error && <p>{detail.error.code} — {tx("请查询同一任务，不自动补发", "Query the same job, never auto-replay.")}</p>}
        <div style={{ maxHeight: 140, overflow: "auto" }}>{detail.events?.map((e) => <div key={e.seq}>{e.seq} · {new Date(e.ts).toLocaleTimeString()} · {jobStateText(e.state)} · {e.phase}</div>)}</div>
        <p>{tx("结果", "Result")}: {detail.resultAvailability}</p>
        {detail.result && <>
          <pre style={{ maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.result.text}</pre>
          {detail.result.nextOffset !== null && <button className="btn" disabled={busy} onClick={() => void load(detail.result!.nextOffset!)}>{tx("下一页", "Next page")}</button>}
        </>}
      </>}
    </div>
  </details>;
}
