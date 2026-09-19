import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { tx, useLocale } from "../../i18n/strings";
import { guardLocked } from "../operator/lock";
import * as controlsStore from "./controlsStore";
import type { ControlPage, SliderCard } from "./controlsStore";
import { captureParameterPage, requireCurrentParameterPage, type ParameterPageCapture } from "./parameterPageValidation";
import { DEBUG_SCHEMA } from "./debugPreset";
import { parameterSetStore, type ParameterSet } from "./parameterSetStore";

export interface ParameterSetDialogProps {
  page: ControlPage;
  /** Local requested values keyed by managed paramId, not card ID or variable name. */
  drafts: Record<string, number>;
  /** Recheck this capture against the current store before committing all local drafts. */
  onLoad: (values: Record<string, number>, captured: ParameterPageCapture) => void;
  onClose: () => void;
}

type ParameterSlider = SliderCard & { managed: NonNullable<SliderCard["managed"]> };

function parameters(page: ControlPage): ParameterSlider[] {
  return page.cards.filter((card): card is ParameterSlider =>
    card.type === "slider" && card.managed?.role === "parameter");
}

function validateDefinitions(page: ControlPage, defs: ParameterSlider[]): void {
  if (page.debugProfile?.schema !== DEBUG_SCHEMA ||
      !Number.isSafeInteger(page.debugProfile.version) || page.debugProfile.version < 1) {
    throw new Error(tx("页面调试配置未配置或无效。", "Page debug profile is missing or invalid."));
  }
  if (!defs.length || defs.length > 32) {
    throw new Error(tx("需要 1–32 个受管滑条参数。", "Requires 1–32 managed slider parameters."));
  }
  const ids = new Set<string>();
  for (const def of defs) {
    if (def.managed.schema !== DEBUG_SCHEMA ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(def.managed.paramId) || ids.has(def.managed.paramId)) {
      throw new Error(tx("参数 ID 无效或重复。", "Parameter IDs are invalid or duplicated."));
    }
    ids.add(def.managed.paramId);
    if (![def.min, def.max, def.step].every(Number.isFinite) ||
        !Number.isFinite(def.max - def.min) || def.min >= def.max ||
        def.step <= 0 || def.step > def.max - def.min) {
      throw new Error(tx(`${def.name}：参数范围或步进无效。`, `${def.name}: invalid parameter range or step.`));
    }
  }
}

function validateValue(value: number, def: ParameterSlider): void {
  if (!Number.isFinite(value) || value < def.min || value > def.max) {
    throw new Error(tx(`${def.name}：值必须为范围 [${def.min}, ${def.max}] 内的有限数。`,
      `${def.name}: value must be finite and within [${def.min}, ${def.max}].`));
  }
  const ticks = (value - def.min) / def.step;
  if (!Number.isFinite(ticks) || Math.abs(ticks - Math.round(ticks)) >
      Math.min(1e-5, 1e-7 * Math.max(1, Math.abs(ticks)))) {
    throw new Error(tx(`${def.name}：值不符合步进 ${def.step}。`,
      `${def.name}: value is off step ${def.step}.`));
  }
}

function currentValue(def: ParameterSlider, drafts: Record<string, number>): number {
  // Invalid supplied drafts must fail validation, not silently become defaults.
  return Object.prototype.hasOwnProperty.call(drafts, def.managed.paramId)
    ? drafts[def.managed.paramId] : def.defaultValue;
}

function validateCompatibility(page: ControlPage, defs: ParameterSlider[], set: ParameterSet): void {
  validateDefinitions(page, defs);
  if (set.profileId !== page.id || set.profileVersion !== page.debugProfile!.version) {
    throw new Error(tx("页面 ID 或配置版本不匹配。", "Page ID or profile version does not match."));
  }
  if (!set.entries.length) {
    throw new Error(tx("参数集为空，无法载入。", "The parameter set is empty and cannot be loaded."));
  }
  for (const entry of set.entries) {
    const def = defs.find((item) => item.managed.paramId === entry.paramId);
    if (!def) throw new Error(tx(`当前页面缺少参数 ${entry.paramId}。`,
      `Parameter ${entry.paramId} is missing from this page.`));
    validateValue(entry.value, def);
  }
}

// A stable null sentinel allows corrupt storage to be reported without a render exception.
function safeSnapshot(): readonly ParameterSet[] | null {
  try { return parameterSetStore.getSnapshot(); } catch { return null; }
}

export function ParameterSetDialog({ page, drafts, onLoad, onClose }: ParameterSetDialogProps) {
  useLocale();
  const sets = useSyncExternalStore(parameterSetStore.subscribe, safeSnapshot, safeSnapshot);
  const currentControls = useSyncExternalStore(controlsStore.subscribe, controlsStore.getSnapshot);
  const [pageCapture] = useState(() => captureParameterPage(page));
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    active.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current!;
    nameInput.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        active.current = false;
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = Array.from(root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ));
        const first = items[0], last = items[items.length - 1];
        if (!first) {
          event.preventDefault();
          root.focus();
        } else if (!root.contains(document.activeElement) || document.activeElement === root) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        event.stopPropagation();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!root.contains(event.target as Node)) root.focus();
    };
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      active.current = false;
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const close = () => { active.current = false; onClose(); };
  const defs = parameters(page);
  const selected = sets?.find((set) => set.id === selectedId);
  let definitionError = "";
  let compatibilityError = "";
  try {
    requireCurrentParameterPage(currentControls, pageCapture);
    validateDefinitions(page, defs);
  } catch (cause) {
    definitionError = cause instanceof Error ? cause.message : tx("参数定义无效。", "Invalid parameter definitions.");
  }
  if (selected) {
    try { validateCompatibility(page, defs, selected); } catch (cause) {
      compatibilityError = cause instanceof Error ? cause.message : tx("参数集不兼容。", "Incompatible parameter set.");
    }
  }

  const run = async (action: () => void | Promise<void>, locked = true) => {
    if (pending.current || !active.current || (locked && guardLocked())) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try { await action(); } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : tx("操作失败。", "Operation failed."));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };

  const saveRequested = () => run(() => {
    requireCurrentParameterPage(controlsStore.getSnapshot(), pageCapture); // Never save into another page.
    validateDefinitions(page, defs);
    const entries = defs.map((def) => {
      const value = currentValue(def, drafts);
      validateValue(value, def);
      return { paramId: def.managed.paramId, value, source: "requested" as const };
    });
    const saved = parameterSetStore.saveParameterSet({
      name: name.trim(), profileId: page.id, profileVersion: page.debugProfile!.version, entries,
    });
    setSelectedId(saved.id);
    setMessage(tx("已保存为新版本；未发送任何指令。", "Saved as a new version; nothing was sent."));
  });

  const load = () => run(() => {
    if (!selected) return;
    validateCompatibility(page, defs, selected); // Revalidate the whole set immediately before the callback.
    // Re-read the live store here: a stale preview after a page switch or definition change is rejected
    // before the callback can write any drafts. Loading remains local-only.
    const currentPage = requireCurrentParameterPage(controlsStore.getSnapshot(), pageCapture);
    const values = Object.fromEntries(
      selected.entries.map((entry) => {
        const def = parameters(currentPage).find((item) => item.managed.paramId === entry.paramId);
        if (!def) throw new Error(tx(`当前页面缺少参数 ${entry.paramId}。`,
          `Parameter ${entry.paramId} is missing from this page.`));
        return [entry.paramId, entry.value] as const;
      }),
    );
    onLoad(values, captureParameterPage(currentPage));
    setMessage(tx("已载入本地草稿；未发送任何指令。", "Loaded into local drafts; nothing was sent."));
  });

  const importJson = () => run(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    if (!active.current) return;
    const path = await open({ multiple: false, title: tx("导入参数集", "Import parameter set"),
      filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string" || !active.current) return;
    let content: string;
    try { content = await invoke<string>("read_text_file", { path }); } catch {
      throw new Error(tx("无法读取参数集文件。", "Unable to read the parameter set file."));
    }
    // A native dialog/read can outlive this modal or a lock transition.
    if (!active.current || guardLocked()) return;
    const imported = parameterSetStore.importParameterSet(content); // Store enforces schema and 1 MiB UTF-8 limit.
    setSelectedId(imported.id);
    setMessage(tx("已导入为新参数集。尚未载入草稿；载入前将检查兼容性。",
      "Imported as a new parameter set. Drafts are unchanged; compatibility is checked before loading."));
  });

  const exportJson = () => run(async () => {
    if (!selected) return;
    const content = parameterSetStore.exportParameterSet(selected.id);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    if (!active.current) return;
    const path = await save({ title: tx("导出参数集", "Export parameter set"),
      defaultPath: "parameter-set.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || !active.current) return;
    try { await invoke("save_text_file", { path, content }); } catch {
      throw new Error(tx("无法写入参数集文件。", "Unable to write the parameter set file."));
    }
    if (active.current) setMessage(tx("已导出参数集 JSON。", "Parameter set JSON exported."));
  }, false);

  return createPortal(
    <div className="modal-mask workflow-dialog-mask" onMouseDown={event => {
      if (event.target === event.currentTarget) close();
    }}>
      <div ref={dialog} className="modal workflow-dialog" role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={titleId} aria-describedby={`${titleId}-help`}
        onKeyDown={event => event.stopPropagation()}>
        <header className="workflow-dialog-head">
          <h2 className="workflow-dialog-head-title" id={titleId}>{tx("参数集", "Parameter sets")}</h2>
          <p className="workflow-dialog-head-sub" id={`${titleId}-help`}>{tx(
            "保存与载入仅处理本地请求值，不发送指令、不修改遥测。只使用受管参数滑条；未包含的草稿保持不变。",
            "Saving and loading only handle local requested values: no commands or telemetry changes. Only managed parameter sliders are used; unlisted drafts stay unchanged.",
          )}</p>
        </header>
        <div className="workflow-dialog-body">
          {sets === null && <p role="alert" className="workflow-status">{tx(
            "无法读取参数集：存储不可用、损坏或不兼容。原数据未删除或覆盖；请明确修复存储后重新打开。",
            "Cannot read parameter sets: storage is unavailable, corrupt, or incompatible. Original data was not deleted or overwritten; explicitly repair storage and reopen.",
          )}</p>}
          {definitionError && <p role="alert" className="workflow-status">{definitionError}</p>}
          <section className="workflow-section" aria-label={tx("保存请求值", "Save requested values")}>
            <div className="workflow-grid">
              <div className="workflow-field">
                <label htmlFor={`${titleId}-name`}>{tx("参数集名称", "Parameter set name")}</label>
                <input ref={nameInput} id={`${titleId}-name`} className="input" maxLength={64} value={name}
                  onChange={event => setName(event.target.value)} />
              </div>
            </div>
            <p className="workflow-muted">{tx("缺少草稿时使用滑条初值；保存前检查有限值、范围和步进。每次保存创建新 ID 和新版本。",
              "Missing drafts use slider defaults; finite values, ranges and steps are validated. Every save creates a new ID and version.")}</p>
            <div className="workflow-actions">
              <button type="button" className="btn" disabled={busy || sets === null || !!definitionError || !name.trim()}
                onClick={() => void saveRequested()}>{tx("保存请求值", "Save requested values")}</button>{" "}
            </div>
            <p className="workflow-muted" id={`${titleId}-observed`}>{tx("未配置设备回读契约及新鲜度依据，观测值保存不可用；不将缺值补为 0。",
              "No device readback contract or freshness evidence is configured. Observed-value saving is unavailable; missing values are never replaced with zero.")}</p>
          </section>
          <section className="workflow-section" aria-label={tx("已保存参数集", "Saved parameter sets")}>
            <div className="workflow-grid">
              <div className="workflow-field">
                <label htmlFor={`${titleId}-sets`}>{tx("已保存参数集", "Saved parameter sets")}</label>
                <select id={`${titleId}-sets`} className="input" value={selectedId} disabled={busy || sets === null}
                  onChange={event => { setSelectedId(event.target.value); setError(""); setMessage(""); }}>
                  <option value="">{tx("选择参数集…", "Select a parameter set…")}</option>
                  {sets?.map((set) => <option key={set.id} value={set.id}>{set.name} · v{set.version}</option>)}
                </select>
              </div>
            </div>
            {sets?.length === 0 && <p className="workflow-muted">{tx("暂无参数集。", "No parameter sets yet.")}</p>}
            {selected && <>
              <p className="workflow-muted">{tx("绑定页面 / 配置版本", "Bound page / profile version")}: {selected.profileId} / v{selected.profileVersion}</p>
              <p className="workflow-status" role="status">{compatibilityError || tx("与当前页面兼容。", "Compatible with the current page.")}</p>
              <div className="workflow-inset" style={{ overflowX: "auto" }}>
                <table className="workflow-table">
                  <caption>{tx("保存顺序：当前请求值 → 原始目标值（不取整、不修正）",
                    "Saved order: current requested → original target (no rounding or correction)")}</caption>
                  <thead><tr>
                    <th scope="col">#</th><th scope="col">{tx("参数", "Parameter")}</th>
                    <th scope="col">{tx("当前请求值", "Current requested")}</th>
                    <th scope="col">{tx("目标值", "Target")}</th>
                    <th scope="col">{tx("差异", "Difference")}</th>
                    <th scope="col">{tx("来源", "Source")}</th>
                  </tr></thead>
                  <tbody>{selected.entries.map((entry, index) => {
                    const def = defs.find((item) => item.managed.paramId === entry.paramId);
                    const current = def ? currentValue(def, drafts) : undefined;
                    return <tr key={entry.paramId}>
                      <td>{index + 1}</td>
                      <td style={{ overflowWrap: "anywhere" }}>{def?.name ?? entry.paramId} ({entry.paramId})</td>
                      <td className="num">{Number.isFinite(current) ? String(current) : tx("不可用", "Unavailable")}</td>
                      <td className="num">{entry.value}</td>
                      <td>{Number.isFinite(current) && current === entry.value
                        ? tx("未变化", "Unchanged")
                        : Number.isFinite(current) ? tx("已变化", "Changed") : tx("不可比较", "Not comparable")}</td>
                      <td>{entry.source === "requested" ? tx("请求值", "Requested") : tx("历史观测值（非实时）", "Historical observation (not live)")}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            </>}
            <div className="workflow-actions">
              <button type="button" className="btn" disabled={busy || sets === null}
                onClick={() => void importJson()}>{tx("导入 JSON（≤1 MiB）", "Import JSON (≤1 MiB)")}</button>
              <button type="button" className="btn" disabled={busy || !selected}
                onClick={() => void exportJson()}>{tx("导出 JSON", "Export JSON")}</button>
            </div>
            <div className="workflow-inset">
              <p className="workflow-inset-title">{tx("设备执行与读回（未配置）", "Device execution and readback (unconfigured)")}</p>
              <p className="workflow-muted" id={`${titleId}-execute`}>{tx(
                "实际设备适配器及宿主可信审批未配置，执行参数集不可用；观测值保存同样缺少回读契约。载入从不发送指令。",
                "The actual device adapter and trusted host approval are unconfigured, so execution is unavailable; observed-value saving also lacks a readback contract. Loading never sends.",
              )}</p>
            </div>
          </section>
          {busy && <p className="workflow-status" role="status">{tx("处理中…", "Working…")}</p>}
          {message && <p className="workflow-status" role="status">{message}</p>}
          {error && <p className="workflow-status" role="alert">{error}</p>}
        </div>
        <footer className="workflow-dialog-foot">
          <p className="workflow-status" role="status" aria-live="polite">{busy ? tx("处理中…", "Working…")
            : error ? "" : message}</p>
          <div className="spacer" />
          <button type="button" className="btn" onClick={close}>{tx("关闭", "Close")}</button>
          <button type="button" className="btn primary" disabled={busy || !selected || !!definitionError || !!compatibilityError}
            onClick={() => void load()}>{tx("载入本地草稿", "Load local drafts")}</button>
        </footer>
      </div>
    </div>, document.body,
  );
}

export default ParameterSetDialog;
