import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "../plot3d/plot3dStore";
import type { AnalysisSnapshot } from "./analysisSnapshot";
import { exportAnalysisPackage, getAnalysisCacheRange, PACKAGE_LIMITS, type AnalysisModule } from "./analysisPackage";
import { initialExportSelection } from "./exportSelection";
import "./analysis.css";

export interface AnalysisExportDialogProps { onClose: () => void; snapshot?: AnalysisSnapshot }
const labels: Record<AnalysisModule, string> = { waveform: "波形 waveform", trajectory: "轨迹 trajectory", metrics: "指标 metrics", annotations: "标注 annotations" };
const descriptions: Record<AnalysisModule, string> = {
  waveform: "所选通道的窗口数据",
  trajectory: "所选组配对、变换后的轨迹",
  metrics: "按完整缓存窗口重新计算",
  annotations: "窗口内标注，可能含敏感文本",
};

export function AnalysisExportDialog({ onClose, snapshot }: AnalysisExportDialogProps) {
  // 仅打开时读取选项；不订阅/启动采集，导出时再次验证身份并读取当前缓存。
  const [catalog] = useState(() => {
    const channels = plotStore.getSnapshot().channels;
    const known = new Set(channels.map(c => c.id));
    const groups = plot3dStore.getSnapshot().settings.groups.map(g => ({ id: g.id, name: g.name,
      available: !!g.chX && !!g.chY && [g.chX, g.chY, ...(g.chZ ? [g.chZ] : [])].every(id => known.has(id)) }));
    return { channels, groups };
  });
  const [initialSelection] = useState(() => initialExportSelection(snapshot,
    catalog.channels.slice(0, PACKAGE_LIMITS.channels).map(c => c.id), getAnalysisCacheRange));
  const [channelIds, setChannelIds] = useState(initialSelection.channelIds);
  const [groupIds, setGroupIds] = useState(initialSelection.groupIds);
  const [modules, setModules] = useState<AnalysisModule[]>(["waveform", "metrics", "annotations"]);
  const initialRange = initialSelection.range;
  const [start, setStart] = useState(initialRange ? String(initialRange.startMs) : "");
  const [end, setEnd] = useState(initialRange ? String(initialRange.endMs) : "");
  const [limit, setLimit] = useState(String(PACKAGE_LIMITS.rowsPerSeries));
  const [includeSnapshot, setIncludeSnapshot] = useState(false);
  const [includeGroupNotes, setIncludeGroupNotes] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "choosing" | "writing">("idle");
  const phaseRef = useRef(phase);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [windowSource, setWindowSource] = useState(() => snapshot ? "面板快照（冻结）" : "打开时所选缓存范围");
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const title = useId(), help = useId();
  const close = () => {
    if (phaseRef.current === "writing") return;
    alive.current = false;
    closeRef.current();
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current!;
    root.focus();
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    )).filter(el => !el.closest("fieldset:disabled") && el.offsetParent !== null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (phaseRef.current !== "writing") { alive.current = false; closeRef.current(); }
      } else if (event.key === "Tab") {
        const list = focusables();
        const first = list[0], last = list[list.length - 1];
        if (!first) { event.preventDefault(); root.focus(); }
        else if (!root.contains(document.activeElement) || document.activeElement === root) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        event.stopPropagation();
      }
    };
    const focus = (event: FocusEvent) => { if (!root.contains(event.target as Node)) root.focus(); };
    window.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const changePhase = (next: typeof phase) => { phaseRef.current = next; setPhase(next); };
  const needsGroupsNow = () => modules.includes("trajectory") || modules.includes("metrics");
  const refreshRange = () => {
    try {
      const r = getAnalysisCacheRange(channelIds, needsGroupsNow() ? groupIds : []);
      setStart(r ? String(r.startMs) : ""); setEnd(r ? String(r.endMs) : "");
      setWindowSource("当前所选缓存");
      setError(r ? "" : "所选缓存无有效时间；可手动输入源毫秒窗口以导出标注。");
    } catch (e) { setError(String(e)); }
  };
  const toggle = <T,>(items: T[], item: T) => items.includes(item) ? items.filter(x => x !== item) : [...items, item];
  const submit = async () => {
    if (phaseRef.current !== "idle") return;
    setError(""); setSuccess("");
    const startMs = Number(start), endMs = Number(end), maxRowsPerSeries = Number(limit);
    if (!start.trim() || !end.trim() || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      setError("请输入有效源毫秒窗口，起点不得晚于终点。"); return;
    }
    if (!Number.isInteger(maxRowsPerSeries) || maxRowsPerSeries < 2 || maxRowsPerSeries > PACKAGE_LIMITS.rowsPerSeries) {
      setError("每序列输出上限必须为 2–30000 行。"); return;
    }
    if (!modules.length) { setError("请至少选择一个导出模块。"); return; }
    try {
      // 提前验证所有 gid/channel；真正导出前构建器还会重新验证。
      getAnalysisCacheRange(channelIds, modules.includes("trajectory") || modules.includes("metrics") ? groupIds : []);
      changePhase("choosing");
      const directory = await open({ directory: true, multiple: false, title: "选择分析包父目录（自动新建，不覆盖）" });
      if (!alive.current) return;
      if (typeof directory !== "string") { changePhase("idle"); return; }
      changePhase("writing");
      // 让忙态先呈现；此后关闭/Esc 禁用，不承诺可中止 writer。
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (!alive.current) return;
      const receipt = await exportAnalysisPackage(directory, { modules, channelIds, groupIds,
        range: { startMs, endMs }, maxRowsPerSeries, snapshot, includeSnapshot, includeGroupNotes });
      if (alive.current) setSuccess(`已完成：${receipt.fileCount} 个文件，${receipt.totalBytes} 字节。新包目录：${receipt.directory}`);
    } catch (e) {
      if (alive.current) setError(`导出失败：${String(e)}。若写盘已经开始，可能保留带 incomplete.json 的不完整包；不会覆盖或自动重试。`);
    } finally { if (alive.current) changePhase("idle"); }
  };
  const busy = phase !== "idle";
  const selChannels = channelIds.length, selGroups = groupIds.length, selModules = modules.length;
  const windowText = start.trim() && end.trim() ? `${start} – ${end} ms` : "未填写完整（不隐式扩大）";
  return createPortal(
    <div className="modal-mask workflow-dialog-mask" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialog} className="modal workflow-dialog analysis-export" role="dialog" aria-modal="true" aria-labelledby={title}
        aria-describedby={help} aria-busy={busy} tabIndex={-1}>
        <header className="workflow-dialog-head">
          <h2 id={title} className="workflow-dialog-head-title">导出离线分析包</h2>
          <p id={help} className="workflow-dialog-head-sub">仅读取当前原始缓存，不启动采样、不消费 dirty、无网络。默认所选通道缓存范围；调整选择后可点击更新范围。</p>
        </header>
        <div className="workflow-dialog-body">
          <div className="analysis-export-layout">
          <fieldset disabled={busy} className="analysis-export-main workflow-reset-fieldset">
            <legend className="workflow-sr-only">导出配置</legend>
            <section className="workflow-section" aria-labelledby={`${title}-modules`}>
              <h3 id={`${title}-modules`} className="workflow-section-title">模块</h3>
              <div className="analysis-export-modules">
                {(Object.keys(labels) as AnalysisModule[]).map(m => {
                  const checked = modules.includes(m);
                  return <label key={m} className="analysis-export-module">
                    <input type="checkbox" checked={checked} onChange={() => setModules(toggle(modules, m))} />
                    <span className="analysis-export-module-text">
                      <span className="analysis-export-module-name">{labels[m]}</span>
                      <span className="analysis-export-module-desc">{descriptions[m]}</span>
                    </span>
                  </label>;
                })}
              </div>
              <p className="workflow-muted">始终包含 meta.json / ai-prompt.md。raw / parsed / ledger 无可靠源，明确不可用。</p>
            </section>
            <section className="workflow-section" aria-labelledby={`${title}-extras`}>
              <h3 id={`${title}-extras`} className="workflow-section-title">可选附加资料</h3>
              <div className="analysis-export-options">
                <label><input type="checkbox" disabled={!snapshot} checked={includeSnapshot} onChange={e => setIncludeSnapshot(e.target.checked)} />保留面板分析快照</label>
                <label><input type="checkbox" checked={includeGroupNotes} onChange={e => setIncludeGroupNotes(e.target.checked)} />附带所选组当前备注</label>
              </div>
              <p className="workflow-muted">analysis-snapshot.json 保存原分析结果与已记录的参数；改变本次导出窗口不会重写它。metrics.json 则按当前缓存窗口重算。{!snapshot && "从指标面板的已有结果打开才能附带快照。"}</p>
              <p className="workflow-muted">group-notes.json 为导出时的当前备注，不是历史备注；与轨迹 CSV 独立。备注可能含敏感信息，默认不导出。</p>
            </section>
            <section className="workflow-section" aria-labelledby={`${title}-selection`}>
              <h3 id={`${title}-selection`} className="workflow-section-title">通道与轨迹组</h3>
              <div className="analysis-export-selection" role="group" aria-label="通道选择">
                {catalog.channels.map(c => <label key={c.id}>
                  <input type="checkbox" checked={channelIds.includes(c.id)} onChange={() => setChannelIds(toggle(channelIds, c.id))} />{c.name} <small>{c.id}</small>
                </label>)}
                {!catalog.channels.length && <p className="workflow-muted">没有缓存通道</p>}
              </div>
              <div className="analysis-export-options">
                {catalog.groups.map(g => <label key={g.id}>
                  <input type="checkbox" disabled={!g.available && (!includeGroupNotes || modules.includes("trajectory") || modules.includes("metrics"))} checked={groupIds.includes(g.id)} onChange={() => setGroupIds(toggle(groupIds, g.id))} />
                  {g.name}（{g.id}）{!g.available && "：绑定不可用"}
                </label>)}
              </div>
              <p className="workflow-muted">组选择用于 trajectory / metrics；Z 未绑定按现有 API 输出平面轨迹。最多 32 个源通道（包括组绑定）。</p>
            </section>
            <section className="workflow-section" aria-label="源毫秒时间窗口">
              <h3 className="workflow-section-title">源毫秒时间窗口（两端包含）</h3>
              <div className="analysis-export-options">
                <label>起点 ms<input className="input" type="number" step="any" value={start} onChange={e => { setStart(e.target.value); setWindowSource("手动输入"); }} /></label>
                <label>终点 ms<input className="input" type="number" step="any" value={end} onChange={e => { setEnd(e.target.value); setWindowSource("手动输入"); }} /></label>
                <button type="button" className="btn" onClick={refreshRange}>更新为所选缓存范围</button>
              </div>
            </section>
            <details className="workflow-section analysis-export-advanced" open={advancedOpen}
              onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
              <summary>高级限额与数据边界</summary>
              <div className="analysis-export-advanced-body">
                <div className="analysis-export-options">
                  <label>每序列最大行数<input className="input" type="number" min={2} max={PACKAGE_LIMITS.rowsPerSeries} value={limit} onChange={e => setLimit(e.target.value)} /></label>
                </div>
                <div className="workflow-inset analysis-export-limits">
                  <p>数据输出总计最多 120000 行，自动均分额度；按时间排序后均匀抽取行下标，保留窗口首尾，不是 first-N，不保证峰值保留。</p>
                  <p>源通道合计最多 100 万行，标注最多 100 万行；单文件 16 MiB、包 64 MiB，超限报错不静默截尾。已淘汰缓存无法恢复。</p>
                  <p>指标使用抽取前完整窗口重算，不复用旧快照。轨迹先配对/变换，再转源 ms 选窗。未知单位为 raw；标注可能含敏感文本，请审阅后分享。</p>
                  {snapshot && <p>已有面板快照不会随本次导出选项改变；仅勾选「保留面板分析快照」时写出其证据文件。</p>}
                </div>
              </div>
            </details>
          </fieldset>
          <aside className="workflow-inset analysis-export-summary" aria-label="导出摘要">
            <p className="workflow-inset-title">摘要</p>
            <p>模块：{selModules ? `${selModules} 项（${modules.map(m => labels[m]).join("、")}）` : "未选择"}</p>
            <p>通道：{selChannels || "无"}；组：{selGroups || "无"}</p>
            <p>窗口来源：{windowSource}</p>
            <p>窗口：{windowText}</p>
            <p>冻结范围保持原样，不随当前缓存自动扩大。</p>
          </aside>
          </div>
        </div>
        <footer className="workflow-dialog-foot">
          {error ? <p className="workflow-status analysis-export-status" role="alert">{error}</p>
            : <p className="workflow-status analysis-export-status" role="status" aria-live="polite">{phase === "choosing"
              ? "请选择父目录；取消不会写出。" : phase === "writing"
                ? "正在构建并写出新包；已开始的写盘不能中止，请等待结果。" : success}</p>}
          <div className="spacer" />
          <div className="analysis-export-actions workflow-actions">
            <button type="button" className="btn" disabled={phase === "writing"} onClick={close}>{success ? "关闭" : "取消"}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>选择父目录并导出</button>
          </div>
        </footer>
      </div>
    </div>, document.body,
  );
}
export default AnalysisExportDialog;
