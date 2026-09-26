import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "../plot3d/plot3dStore";
import type { AnalysisSnapshot } from "./analysisSnapshot";
import { exportAnalysisPackage, getAnalysisCacheRange, PACKAGE_LIMITS, type AnalysisModule } from "./analysisPackage";
import { initialExportSelection } from "./exportSelection";
import { t, tx, useLocale } from "../../i18n/strings";
import "./analysis.css";

export interface AnalysisExportDialogProps { onClose: () => void; snapshot?: AnalysisSnapshot }
/**
 * 上屏顺序 = 这里的键序。用 `Record<AnalysisModule,…>` 而不是数组：数组少写一种模块没人拦，
 * Record 少一个键直接编译不过 —— 老代码靠文案表的键序拿这个保证，表换成渲染时挑话术后不能丢。
 */
const MODULE_SLOTS: Record<AnalysisModule, true> = { waveform: true, trajectory: true, metrics: true, annotations: true };
const MODULE_ORDER: readonly AnalysisModule[] = Object.keys(MODULE_SLOTS) as AnalysisModule[];
/** 码 → 一组话。渲染时取；写成模块级 `Record<…, string>` 就把语言冻在加载那一刻了 */
function moduleRow(m: AnalysisModule): { name: string; desc: string } {
  switch (m) {
    case "waveform": return { name: tx("波形 waveform", "Waveform"), desc: tx("所选通道的窗口数据", "Window data for the selected channels") };
    case "trajectory": return { name: tx("轨迹 trajectory", "Trajectory"), desc: tx("所选组配对、变换后的轨迹", "Pairing and transforms of the selected groups") };
    case "metrics": return { name: tx("指标 metrics", "Metrics"), desc: tx("按完整缓存窗口重新计算", "Recomputed over the full cached window") };
    case "annotations": return { name: tx("标注 annotations", "Annotations"), desc: tx("窗口内标注，可能含敏感文本", "Annotations in the window; may contain sensitive text") };
  }
}
/** 窗口是从哪来的：状态里存**码**，名字渲染时才挑（存显示串的话，中途切语言这句就说谎） */
type WindowSource = "snapshot" | "preset" | "cache" | "manual";
function windowSourceText(s: WindowSource): string {
  switch (s) {
    case "snapshot": return tx("面板快照（冻结）", "Panel snapshot (frozen)");
    case "preset": return tx("打开时所选缓存范围", "Cached range selected when opened");
    case "cache": return tx("当前所选缓存", "Currently selected cache");
    case "manual": return tx("手动输入", "Typed in");
  }
}

export function AnalysisExportDialog({ onClose, snapshot }: AnalysisExportDialogProps) {
  useLocale(); // 这一面全是 tx() 出来的话术，切语言要有人重渲染
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
  const [windowFrom, setWindowFrom] = useState<WindowSource>(() => snapshot ? "snapshot" : "preset");
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
      setWindowFrom("cache");
      setError(r ? "" : tx("所选缓存无有效时间；可手动输入源毫秒窗口以导出标注。",
        "The selected cache carries no valid timestamps; you can type a source-millisecond window to export annotations."));
    } catch (e) { setError(String(e)); }
  };
  const toggle = <T,>(items: T[], item: T) => items.includes(item) ? items.filter(x => x !== item) : [...items, item];
  const submit = async () => {
    if (phaseRef.current !== "idle") return;
    setError(""); setSuccess("");
    const startMs = Number(start), endMs = Number(end), maxRowsPerSeries = Number(limit);
    if (!start.trim() || !end.trim() || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      setError(tx("请输入有效源毫秒窗口，起点不得晚于终点。", "Enter a valid source-millisecond window; the start must not come after the end.")); return;
    }
    if (!Number.isInteger(maxRowsPerSeries) || maxRowsPerSeries < 2 || maxRowsPerSeries > PACKAGE_LIMITS.rowsPerSeries) {
      setError(tx(`每序列输出上限必须为 2–${PACKAGE_LIMITS.rowsPerSeries} 行。`, `The per-series row limit must be between 2 and ${PACKAGE_LIMITS.rowsPerSeries}.`)); return;
    }
    if (!modules.length) { setError(tx("请至少选择一个导出模块。", "Select at least one export module.")); return; }
    try {
      // 提前验证所有 gid/channel；真正导出前构建器还会重新验证。
      getAnalysisCacheRange(channelIds, modules.includes("trajectory") || modules.includes("metrics") ? groupIds : []);
      changePhase("choosing");
      const directory = await open({ directory: true, multiple: false,
        title: tx("选择分析包父目录（自动新建，不覆盖）", "Parent directory for the analysis package (a new folder is created, nothing is overwritten)") });
      if (!alive.current) return;
      if (typeof directory !== "string") { changePhase("idle"); return; }
      changePhase("writing");
      // 让忙态先呈现；此后关闭/Esc 禁用，不承诺可中止 writer。
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      if (!alive.current) return;
      const receipt = await exportAnalysisPackage(directory, { modules, channelIds, groupIds,
        range: { startMs, endMs }, maxRowsPerSeries, snapshot, includeSnapshot, includeGroupNotes });
      if (alive.current) setSuccess(tx(`已完成：${receipt.fileCount} 个文件，${receipt.totalBytes} 字节。新包目录：${receipt.directory}`,
        `Done: ${receipt.fileCount} files, ${receipt.totalBytes} bytes. New package directory: ${receipt.directory}`));
    } catch (e) {
      if (alive.current) setError(tx(`导出失败：${String(e)}。若写盘已经开始，可能保留带 incomplete.json 的不完整包；不会覆盖或自动重试。`,
        `Export failed: ${String(e)}. If writing had already begun, an incomplete package carrying incomplete.json may remain; nothing is overwritten and nothing is retried automatically.`));
    } finally { if (alive.current) changePhase("idle"); }
  };
  const busy = phase !== "idle";
  const selChannels = channelIds.length, selGroups = groupIds.length, selModules = modules.length;
  const windowText = start.trim() && end.trim() ? `${start} – ${end} ms`
    : tx("未填写完整（不隐式扩大）", "Not filled in (never widened implicitly)");
  return createPortal(
    <div className="modal-mask workflow-dialog-mask" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialog} className="modal workflow-dialog analysis-export" role="dialog" aria-modal="true" aria-labelledby={title}
        aria-describedby={help} aria-busy={busy} tabIndex={-1}>
        <header className="workflow-dialog-head">
          <h2 id={title} className="workflow-dialog-head-title">{tx("导出离线分析包", "Export offline analysis package")}</h2>
          <p id={help} className="workflow-dialog-head-sub">{tx("仅读取当前原始缓存，不启动采样、不消费 dirty、无网络。默认所选通道缓存范围；调整选择后可点击更新范围。",
            "Reads the current raw cache only: no sampling is started, no dirty state is consumed, no network. Defaults to the cached range of the selected channels; after changing the selection, press the button below to refresh the range.")}</p>
        </header>
        <div className="workflow-dialog-body">
          <div className="analysis-export-layout">
          <fieldset disabled={busy} className="analysis-export-main workflow-reset-fieldset">
            <legend className="workflow-sr-only">{tx("导出配置", "Export configuration")}</legend>
            <section className="workflow-section" aria-labelledby={`${title}-modules`}>
              <h3 id={`${title}-modules`} className="workflow-section-title">{tx("模块", "Modules")}</h3>
              <div className="analysis-export-modules">
                {MODULE_ORDER.map(m => {
                  const checked = modules.includes(m);
                  const row = moduleRow(m);
                  return <label key={m} className="analysis-export-module">
                    <input type="checkbox" checked={checked} onChange={() => setModules(toggle(modules, m))} />
                    <span className="analysis-export-module-text">
                      <span className="analysis-export-module-name">{row.name}</span>
                      <span className="analysis-export-module-desc">{row.desc}</span>
                    </span>
                  </label>;
                })}
              </div>
              <p className="workflow-muted">{tx("始终包含 meta.json / ai-prompt.md。raw / parsed / ledger 无可靠源，明确不可用。",
                "meta.json / ai-prompt.md are always included. raw / parsed / ledger have no reliable source, so they are reported unavailable on purpose.")}</p>
            </section>
            <section className="workflow-section" aria-labelledby={`${title}-extras`}>
              <h3 id={`${title}-extras`} className="workflow-section-title">{tx("可选附加资料", "Optional extras")}</h3>
              <div className="analysis-export-options">
                <label><input type="checkbox" disabled={!snapshot} checked={includeSnapshot} onChange={e => setIncludeSnapshot(e.target.checked)} />{tx("保留面板分析快照", "Keep the panel analysis snapshot")}</label>
                <label><input type="checkbox" checked={includeGroupNotes} onChange={e => setIncludeGroupNotes(e.target.checked)} />{tx("附带所选组当前备注", "Include current notes of the selected groups")}</label>
              </div>
              <p className="workflow-muted">{tx("analysis-snapshot.json 保存原分析结果与已记录的参数；改变本次导出窗口不会重写它。metrics.json 则按当前缓存窗口重算。",
                "analysis-snapshot.json keeps the original analysis result and the parameters recorded with it; changing this export window does not rewrite it. metrics.json is recomputed over the current cached window.")}{!snapshot && tx("从指标面板的已有结果打开才能附带快照。",
                " A snapshot can only ride along when this dialog was opened from an existing metrics-panel result.")}</p>
              <p className="workflow-muted">{tx("group-notes.json 为导出时的当前备注，不是历史备注；与轨迹 CSV 独立。备注可能含敏感信息，默认不导出。",
                "group-notes.json holds the notes as they stand at export time, not their history, and is separate from the trajectory CSV. Notes may contain sensitive information, so they are not exported by default.")}</p>
            </section>
            <section className="workflow-section" aria-labelledby={`${title}-selection`}>
              <h3 id={`${title}-selection`} className="workflow-section-title">{tx("通道与轨迹组", "Channels and trajectory groups")}</h3>
              <div className="analysis-export-selection" role="group" aria-label={tx("通道选择", "Channel selection")}>
                {catalog.channels.map(c => <label key={c.id}>
                  <input type="checkbox" checked={channelIds.includes(c.id)} onChange={() => setChannelIds(toggle(channelIds, c.id))} />{c.name} <small>{c.id}</small>
                </label>)}
                {!catalog.channels.length && <p className="workflow-muted">{tx("没有缓存通道", "No cached channels")}</p>}
              </div>
              <div className="analysis-export-options">
                {catalog.groups.map(g => <label key={g.id}>
                  <input type="checkbox" disabled={!g.available && (!includeGroupNotes || modules.includes("trajectory") || modules.includes("metrics"))} checked={groupIds.includes(g.id)} onChange={() => setGroupIds(toggle(groupIds, g.id))} />
                  {g.name}{tx(`（${g.id}）`, ` (${g.id})`)}{!g.available && tx("：绑定不可用", " — binding unavailable")}
                </label>)}
              </div>
              <p className="workflow-muted">{tx("组选择用于 trajectory / metrics；Z 未绑定按现有 API 输出平面轨迹。最多 32 个源通道（包括组绑定）。",
                "Group selection feeds trajectory / metrics; a group with no Z binding still yields the planar trajectory the existing API produces. At most 32 source channels, group bindings included.")}</p>
            </section>
            <section className="workflow-section" aria-label={tx("源毫秒时间窗口", "Source-millisecond time window")}>
              <h3 className="workflow-section-title">{tx("源毫秒时间窗口（两端包含）", "Source-millisecond window (both ends inclusive)")}</h3>
              <div className="analysis-export-options">
                <label>{tx("起点 ms", "Start ms")}<input className="input" type="number" step="any" value={start} onChange={e => { setStart(e.target.value); setWindowFrom("manual"); }} /></label>
                <label>{tx("终点 ms", "End ms")}<input className="input" type="number" step="any" value={end} onChange={e => { setEnd(e.target.value); setWindowFrom("manual"); }} /></label>
                <button type="button" className="btn" onClick={refreshRange}>{tx("更新为所选缓存范围", "Use the selected cache range")}</button>
              </div>
            </section>
            <details className="workflow-section analysis-export-advanced" open={advancedOpen}
              onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
              <summary>{tx("高级限额与数据边界", "Advanced limits and data boundaries")}</summary>
              <div className="analysis-export-advanced-body">
                <div className="analysis-export-options">
                  <label>{tx("每序列最大行数", "Max rows per series")}<input className="input" type="number" min={2} max={PACKAGE_LIMITS.rowsPerSeries} value={limit} onChange={e => setLimit(e.target.value)} /></label>
                </div>
                <div className="workflow-inset analysis-export-limits">
                  <p>{tx("数据输出总计最多 120000 行，自动均分额度；按时间排序后均匀抽取行下标，保留窗口首尾，不是 first-N，不保证峰值保留。",
                    "Data output is capped at 120000 rows in total, split evenly across series; row indices are sampled evenly after sorting by time, keeping the window's first and last row — this is not first-N, and peaks are not guaranteed to survive.")}</p>
                  <p>{tx("源通道合计最多 100 万行，标注最多 100 万行；单文件 16 MiB、包 64 MiB，超限报错不静默截尾。已淘汰缓存无法恢复。",
                    "Source channels cap at 1 million rows in total, annotations at 1 million rows; 16 MiB per file and 64 MiB per package — over a limit raises an error instead of silently trimming. Evicted cache data cannot be recovered.")}</p>
                  <p>{tx("指标使用抽取前完整窗口重算，不复用旧快照。轨迹先配对/变换，再转源 ms 选窗。未知单位为 raw；标注可能含敏感文本，请审阅后分享。",
                    "Metrics are recomputed over the full pre-sampling window and never reuse an old snapshot. Trajectories are paired/transformed first, then windowed in source milliseconds. Unknown units are labelled raw; annotations may contain sensitive text, so review before sharing.")}</p>
                  {snapshot && <p>{tx("已有面板快照不会随本次导出选项改变；仅勾选「保留面板分析快照」时写出其证据文件。",
                    "An existing panel snapshot is untouched by this export's options; its evidence file is written only when “Keep the panel analysis snapshot” is checked.")}</p>}
                </div>
              </div>
            </details>
          </fieldset>
          <aside className="workflow-inset analysis-export-summary" aria-label={tx("导出摘要", "Export summary")}>
            <p className="workflow-inset-title">{tx("摘要", "Summary")}</p>
            <p>{tx(`模块：${selModules ? `${selModules} 项（${modules.map(m => moduleRow(m).name).join("、")}）` : "未选择"}`,
              `Modules: ${selModules ? `${selModules} (${modules.map(m => moduleRow(m).name).join(", ")})` : "none selected"}`)}</p>
            <p>{tx(`通道：${selChannels || "无"}；组：${selGroups || "无"}`, `Channels: ${selChannels || "none"} · Groups: ${selGroups || "none"}`)}</p>
            <p>{tx("窗口来源：", "Window source: ")}{windowSourceText(windowFrom)}</p>
            <p>{tx("窗口：", "Window: ")}{windowText}</p>
            <p>{tx("冻结范围保持原样，不随当前缓存自动扩大。", "A frozen range stays as recorded; it does not grow with the current cache.")}</p>
          </aside>
          </div>
        </div>
        <footer className="workflow-dialog-foot">
          {error ? <p className="workflow-status analysis-export-status" role="alert">{error}</p>
            : <p className="workflow-status analysis-export-status" role="status" aria-live="polite">{phase === "choosing"
              ? tx("请选择父目录；取消不会写出。", "Pick a parent directory; cancelling writes nothing.") : phase === "writing"
                ? tx("正在构建并写出新包；已开始的写盘不能中止，请等待结果。", "Building and writing the new package; a write already started cannot be aborted, please wait for the result.") : success}</p>}
          <div className="spacer" />
          <div className="analysis-export-actions workflow-actions">
            <button type="button" className="btn" disabled={phase === "writing"} onClick={close}>{success ? t("c.close") : t("c.cancel")}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>{tx("选择父目录并导出", "Pick a directory and export")}</button>
          </div>
        </footer>
      </div>
    </div>, document.body,
  );
}
export default AnalysisExportDialog;
