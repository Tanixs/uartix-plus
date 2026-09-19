import { useState, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "../plot3d/plot3dStore";
import * as analysisStore from "./analysisStore";
import type { AnalysisRange } from "./analysisSnapshot";
import * as timeCursorStore from "./timeCursorStore";
import { NOTE_MAX_CHARS, previewGroupNote, writeGroupNotes, type NoteWriteMode, type NoteWriteOutcome } from "./noteWriteback";
import "./metrics.css";

type NoteStatus = NoteWriteOutcome["skipped"][number]["reason"] | "written";
function noteStatusText(status: NoteStatus): string {
  switch (status) {
    case "written": return tx("备注已写入并核验。", "Notes written and verified.");
    case "conflict": return tx("备注已被修改。请重新载入当前备注并检查预览后再写入。", "Notes changed. Reload current notes and review the preview before writing again.");
    case "locked": return tx("Operator 模式只读，未写入。退出 Operator 模式后重试。", "Operator mode is read-only; nothing was written. Exit Operator mode before retrying.");
    case "unknown-group": return tx("目标组已不存在，未写入。请重新选择组。", "The target group no longer exists; nothing was written. Select a group again.");
    case "unchanged": return tx("没有可写入的更改。", "No changes to write.");
    case "write-failed": return tx("未能确认写入成功。请检查当前备注后重试。", "Could not verify the write. Check current notes before retrying.");
  }
}

/** Local, user-authored draft only. Selecting/reloading never writes or calls AI. */
function GroupNotesEditor() {
  const p3d = useSyncExternalStore(plot3dStore.subscribe, plot3dStore.getSnapshot);
  const [target, setTarget] = useState<{ gid: string; expectedNotes: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<NoteWriteMode>("append");
  const [status, setStatus] = useState<NoteStatus | null>(null);
  const group = p3d.settings.groups.find((g) => g.id === target?.gid);
  const conflict = !!target && !!group && group.notes !== target.expectedNotes;
  const preview = target ? previewGroupNote(target.expectedNotes, draft, mode) : "";
  const tooLong = preview.length > NOTE_MAX_CHARS;
  const write = () => {
    if (!target || !draft.trim() || tooLong) return;
    const outcome = writeGroupNotes([{ ...target, note: preview }]);
    const next = outcome.written.length ? "written" : outcome.skipped[0]?.reason ?? "write-failed";
    setStatus(next);
    if (next === "written") {
      setTarget({ ...target, expectedNotes: preview });
      setDraft("");
    }
  };
  return <section className="metrics-notes" aria-label={tx("组备注编辑器", "Group notes editor")}>
    <h3>{tx("组备注 · 预览后写入", "Group notes · preview before writing")}</h3>
    <p>{tx("可手动输入或粘贴 AI 回复；此编辑器不会生成内容或调用外部 AI。只有点击“写入备注”才会保存。Operator 模式下不可写入。", "Type notes or paste an AI response; this editor does not generate content or call external AI. Only Write notes saves changes. Writes are blocked in Operator mode.")}</p>
    <div className="metrics-note-controls">
      <label>{tx("目标组", "Target group")} <select className="input" value={target?.gid ?? ""} onChange={(e) => {
        const selected = plot3dStore.getSnapshot().settings.groups.find((g) => g.id === e.target.value);
        setTarget(selected ? { gid: selected.id, expectedNotes: selected.notes } : null);
        setStatus(null);
      }}>
        <option value="">{tx("请选择", "Select a group")}</option>
        {target && !group && <option value={target.gid}>{tx("已删除", "Deleted")}: {target.gid}</option>}
        {p3d.settings.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select></label>
      <label>{tx("写入方式", "Write mode")} <select className="input" value={mode} onChange={(e) => { setMode(e.target.value as NoteWriteMode); setStatus(null); }}>
        <option value="append">{tx("追加", "Append")}</option>
        <option value="replace">{tx("替换", "Replace")}</option>
      </select></label>
      <button className="btn sm" disabled={!group} onClick={() => {
        if (group) setTarget({ gid: group.id, expectedNotes: group.notes });
        setStatus(null);
      }}>{tx("重新载入当前备注", "Reload current notes")}</button>
    </div>
    {target && <>
      <label className="metrics-note-field">{tx("已载入备注（写入校验基线）", "Loaded notes (write-check baseline)")}
        <textarea className="input" readOnly rows={3} value={target.expectedNotes} />
      </label>
      <label className="metrics-note-field">{tx("编辑内容 / 粘贴 AI 回复", "Edit text / paste an AI response")}
        <textarea className="input" rows={4} maxLength={NOTE_MAX_CHARS} value={draft} onChange={(e) => { setDraft(e.target.value); setStatus(null); }} />
      </label>
      <label className="metrics-note-field">{tx("写入预览", "Write preview")} · {group?.name ?? target.gid} · {preview.length}/{NOTE_MAX_CHARS}
        <textarea className="input" readOnly rows={4} value={preview} />
      </label>
      {mode === "replace" && <p>{tx("替换会用预览全文替代该组备注。", "Replace substitutes the full preview for this group's notes.")}</p>}
      {tooLong && <p role="alert">{tx("预览超过 2000 字符。请缩短内容或选择替换；不会静默截断。", "Preview exceeds 2000 characters. Shorten the text or choose Replace; no silent truncation.")}</p>}
      {conflict && <p role="alert">{noteStatusText("conflict")}</p>}
      {!group && <p role="alert">{noteStatusText("unknown-group")}</p>}
      <button className="btn primary sm" disabled={!group || conflict || tooLong || !draft.trim() || preview === target.expectedNotes} onClick={write}>{tx("写入备注", "Write notes")}</button>
    </>}
    {status && <p role={status === "written" || status === "unchanged" ? "status" : "alert"}>{noteStatusText(status)}</p>}
  </section>;
}

const fmt = (n: number | null) => n === null ? "—" : Number(n.toPrecision(7)).toString();

/** Manual analysis only: mounting/closing never starts acquisition or a background timer. */
export default function MetricsPanel() {
  useLocale();
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const p3d = useSyncExternalStore(plot3dStore.subscribe, plot3dStore.getSnapshot);
  const state = useSyncExternalStore(analysisStore.subscribe, analysisStore.getSnapshot);
  const cursor = useSyncExternalStore(timeCursorStore.subscribe, timeCursorStore.getSnapshot);
  const [rangeOrigin, setRangeOrigin] = useState<number | null>(null);
  const [channelId, setChannel] = useState("");
  const [groupA, setGroupA] = useState("");
  const [groupB, setGroupB] = useState("");
  const [mode, setMode] = useState<AnalysisRange["mode"]>("cache");
  const [seconds, setSeconds] = useState("10");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("10");
  const [tolerance, setTolerance] = useState("100");
  const [distance, setDistance] = useState("0");
  const refresh = () => {
    const origin = rangeOrigin ?? plotStore.timeOrigin();
    const range: AnalysisRange = mode === "custom" ? { mode, startMs: origin + Number(start) * 1000, endMs: origin + Number(end) * 1000 } :
      mode === "recent" ? { mode, seconds: Number(seconds) } : { mode };
    analysisStore.refreshAnalysis({ channelIds: channelId ? [channelId] : [], groupIds: [groupA, groupB].filter(Boolean),
      compare: groupA && groupB ? { a: groupA, b: groupB } : undefined,
      range, toleranceMs: Number(tolerance), distanceTolerance: Number(distance) });
  };
  const result = state.result;
  return <div className="plot analysis-panel">
    <div className="plot-bar analysis-controls">
      <label>{tx("通道", "Channel")} <select className="input" value={channelId} onChange={(e) => setChannel(e.target.value)}>
        <option value="">{tx("不选", "None")}</option>
        {plot.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      {([groupA, groupB] as const).map((value, i) => <label key={i}>{i === 0 ? tx("组 A", "Group A") : tx("组 B", "Group B")} <select className="input" value={value} onChange={(e) => (i === 0 ? setGroupA : setGroupB)(e.target.value)}>
        <option value="">{tx("不选", "None")}</option>
        {p3d.settings.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select></label>)}
      <label>{tx("范围", "Range")} <select className="input" value={mode} onChange={(e) => {
        setMode(e.target.value as AnalysisRange["mode"]);
        setRangeOrigin(plotStore.timeOrigin());
      }}>
        <option value="cache">{tx("当前缓存", "Current cache")}</option>
        <option value="recent">{tx("最近 N 秒（数据末端）", "Recent N seconds (data end)")}</option>
        <option value="custom">{tx("自定义（相对秒）", "Custom (relative seconds)")}</option>
      </select></label>
      <button className="btn sm" disabled={!cursor.rangeMs} title={tx("复制共享 A/B 范围到自定义输入，然后手动刷新。", "Copy the shared A/B range into custom inputs, then refresh manually.")} onClick={() => {
        const range = timeCursorStore.getSnapshot().rangeMs;
        if (!range) return;
        const origin = plotStore.timeOrigin();
        setRangeOrigin(origin);
        setStart(String(timeCursorStore.toDisplaySeconds(range[0], origin)));
        setEnd(String(timeCursorStore.toDisplaySeconds(range[1], origin)));
        setMode("custom");
      }}>{tx("使用 A/B 游标范围", "Use A/B cursor range")}</button>
      {mode === "recent" && <label>{tx("秒", "Seconds")} <input className="input" type="number" min="0.001" step="any" value={seconds} onChange={(e) => setSeconds(e.target.value)} /></label>}
      {mode === "custom" && <>
        <label>{tx("起点 s", "Start s")} <input className="input" type="number" step="any" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>{tx("终点 s", "End s")} <input className="input" type="number" step="any" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </>}
      <label>{tx("时间容差 ms", "Time tolerance ms")} <input className="input" type="number" min="0" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></label>
      <label>{tx("距离阈值 raw", "Distance threshold raw")} <input className="input" type="number" min="0" step="any" value={distance} onChange={(e) => setDistance(e.target.value)} /></label>
      <button className="btn primary sm" disabled={!channelId && !groupA && !groupB} onClick={refresh}>{tx("手动刷新", "Refresh")}</button>
      <button className="btn sm" disabled={!result} onClick={() => analysisStore.dispatchAnalysisEvent("vs-analysis-export")}>{tx("分析包…", "Analysis package…")}</button>
      <button className="btn sm" disabled={!result} onClick={() => analysisStore.dispatchAnalysisEvent("vs-analysis-ai")}>{tx("交给 AI…", "Ask AI…")}</button>
    </div>
    <div className="analysis-results">
      <p>{tx("仅分析现有原始缓存，不启动采样。参数修改后请刷新；最近窗口锚定数据末端。轨迹使用组变换和显式容差最近邻，不外推；不是显示平滑曲线。", "Uses existing raw cache only; does not start acquisition. Refresh after changing inputs. Recent range ends at latest data. Trajectories use group transforms and explicit-tolerance nearest pairing, without extrapolation or display smoothing.")}</p>
      {state.error && <p role="alert">{tx("分析失败", "Analysis failed")}: {state.error}</p>}
      {!result && !state.error && <p>{tx("选择通道或轨迹组，然后手动刷新。", "Select a channel or trajectory group, then refresh.")}</p>}
      {result && <>
        <p>{result.algorithmVersion} · {new Date(result.generatedAt).toLocaleTimeString()} · {tx("范围 ms", "Range ms")}: {result.range ? `${result.range.startMs} – ${result.range.endMs}` : "—"}</p>
        {result.coverage.truncated && <p role="status">{tx("快照已截断：结果仅覆盖保留的缓存尾部，不是全部历史。", "Snapshot truncated: results cover the retained cache tail, not all history.")}</p>}
        <div className="metrics-table-scroll" role="region" aria-label={tx("分析指标", "Analysis metrics")} tabIndex={0}><table className="analysis-table"><thead><tr><th>{tx("来源", "Source")}</th><th>{tx("指标", "Metric")}</th><th>{tx("数值", "Value")}</th><th>{tx("单位", "Unit")}</th></tr></thead><tbody>
          {result.channels.flatMap(({ id, stats: s }) => {
            const name = plot.channels.find((c) => c.id === id)?.name ?? id;
            const rows: [string, number | null, string][] = [
              ["n", s.n, "samples"], ["invalid", s.invalid, "samples"], ["min", s.min, s.units.value], ["max", s.max, s.units.value],
              ["mean", s.mean, s.units.value], ["rms", s.rms, s.units.value], [tx("样本 std", "Sample std"), s.std, s.units.value],
              [tx("线性斜率", "OLS slope"), s.slope, s.units.slope], [tx("最小时间间隙", "Min time gap"), s.timeGap.minMs, "ms"],
              [tx("平均时间间隙", "Mean time gap"), s.timeGap.meanMs, "ms"], [tx("最大时间间隙", "Max time gap"), s.timeGap.maxMs, "ms"],
              [tx("有效覆盖", "Valid coverage"), s.coverage.validFraction, "0–1"],
            ];
            return rows.map(([label, value, unit]) => <tr key={`${id}-${label}`}><td>{name}</td><td>{label}</td><td>{fmt(value)}</td><td>{unit}</td></tr>);
          })}
          {result.trajectories.flatMap(({ id, stats: s }) => ([
            ["n", s.n, "samples"], [tx("轨迹长度", "Path length"), s.length, s.unit],
            [tx("位移", "Displacement"), s.displacement, s.unit], [tx("有效覆盖", "Valid coverage"), s.coverage.validFraction, "0–1"],
          ] as [string, number | null, string][]).map(([label, value, unit]) => <tr key={`${id}-${label}`}><td>{id}</td><td>{label}</td><td>{fmt(value)}</td><td>{unit}</td></tr>))}
          {result.comparison && ([
            [tx("匹配点", "Matched samples"), result.comparison.stats.n, "samples"],
            [tx("匹配覆盖", "Match coverage"), result.comparison.stats.coverage.matchedFraction, "0–1"],
            [tx("平均偏差", "Mean deviation"), result.comparison.stats.meanDev, result.comparison.stats.unit],
            [tx("RMS 偏差", "RMS deviation"), result.comparison.stats.rmsDev, result.comparison.stats.unit],
            [tx("最大偏差", "Max deviation"), result.comparison.stats.maxDev, result.comparison.stats.unit],
            [tx("距离阈值内比例", "Within distance threshold"), result.comparison.stats.inToleranceFraction, "0–1"],
          ] as [string, number | null, string][]).map(([label, value, unit]) => <tr key={label}><td>{result.comparison!.a} → {result.comparison!.b}</td><td>{label}</td><td>{fmt(value)}</td><td>{unit}</td></tr>)}
        </tbody></table></div>
      </>}
      <GroupNotesEditor />
    </div>
  </div>;
}
