import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { tx, useLocale } from "../../i18n/strings";
import * as controlsStore from "./controlsStore";
import type { DebugParameter } from "./debugPreset";

type ParameterDraft = { key: number } & Record<keyof DebugParameter, string>;
const emptyParameter = (key: number): ParameterDraft => ({
  key, id: "", name: "", min: "", max: "", step: "", value: "", unit: "",
});
const identityFields = [
  { key: "id", label: { zh: "参数 ID", en: "Parameter ID" }, maxLength: 64 },
  { key: "name", label: { zh: "名称", en: "Name" }, maxLength: 64 },
  { key: "unit", label: { zh: "单位（可选）", en: "Unit (optional)" }, maxLength: undefined },
] as const;
const numericFields = [
  { key: "min", zh: "最小值", en: "Minimum" },
  { key: "max", zh: "最大值", en: "Maximum" },
  { key: "step", zh: "步进", en: "Step" },
  { key: "value", zh: "初值", en: "Initial value" },
] as const;

export function DebugPresetDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const [name, setName] = useState("惯导调试");
  const [parameters, setParameters] = useState<ParameterDraft[]>(() => [
    { ...emptyParameter(0), id: "kp", name: "Kp" },
  ]);
  const [error, setError] = useState("");
  const nextKey = useRef(1);
  const submitted = useRef(false);
  const dialog = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const helpId = useId();
  const errorId = useId();
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current!;
    nameInput.current?.focus();
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    ));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const list = focusables();
        const first = list[0], last = list[list.length - 1];
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
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const patch = (key: number, field: keyof DebugParameter, value: string) => {
    setError("");
    setParameters(current => current.map(p => p.key === key ? { ...p, [field]: value } : p));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitted.current) return;
    setError("");
    try {
      if (parameters.length < 1 || parameters.length > 12) {
        throw new Error(tx("参数数量必须为 1–12。", "Select 1–12 parameters."));
      }
      const values: DebugParameter[] = parameters.map((p, index) => {
        const numbers = {} as Pick<DebugParameter, "min" | "max" | "step" | "value">;
        for (const field of numericFields) {
          // Never coerce a missing physical value to zero or supply a guessed range.
          if (!p[field.key].trim() || !Number.isFinite(Number(p[field.key]))) {
            throw new Error(tx(
              `参数 ${index + 1}：请填写有效的${field.zh}。`,
              `Parameter ${index + 1}: enter a finite ${field.en.toLowerCase()}.`,
            ));
          }
          numbers[field.key] = Number(p[field.key]);
        }
        return { id: p.id.trim(), name: p.name.trim(), unit: p.unit.trim(), ...numbers };
      });
      // The store validates IDs, names, ranges and step alignment before committing.
      controlsStore.createDebugPage(name.trim(), values);
      submitted.current = true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`${tx("创建失败", "Creation failed")}: ${message}`);
      return;
    }
    onClose();
  };

  return createPortal(
    <div className="modal-mask workflow-dialog-mask" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form ref={dialog} className="modal workflow-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={helpId} tabIndex={-1}
        noValidate onSubmit={submit} onKeyDown={event => event.stopPropagation()}>
        <header className="workflow-dialog-head">
          <h2 className="workflow-dialog-head-title" id={titleId}>{tx("新建惯导调试页", "Create inertial debug page")}</h2>
          <p className="workflow-dialog-head-sub" id={helpId}>{tx(
            "定义 1–12 个参数。请根据设备规格填写范围、步进和初值；不提供物理默认值。",
            "Define 1–12 parameters. Enter ranges, steps and initial values from your device specifications; no physical defaults are supplied.",
          )}</p>
        </header>
        <div className="workflow-dialog-body">
          <div className="workflow-field">
            <label htmlFor={`${titleId}-name`}>{tx("页面名称", "Page name")}</label>
            <input ref={nameInput} id={`${titleId}-name`} className="input" value={name} maxLength={24} required
              onChange={event => { setName(event.target.value); setError(""); }} />
          </div>
          {parameters.map((p, index) => (
            <section key={p.key} className="workflow-section" aria-labelledby={`${titleId}-p${p.key}-title`}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h3 id={`${titleId}-p${p.key}-title`} className="workflow-section-title" style={{ flex: "1 1 auto" }}>
                  {tx(`参数 ${index + 1}`, `Parameter ${index + 1}`)}
                </h3>
                <button type="button" className="btn" disabled={parameters.length <= 1}
                  aria-label={tx(`删除参数 ${index + 1}`, `Remove parameter ${index + 1}`)}
                  onClick={() => {
                    dialog.current?.focus();
                    setParameters(current => current.length > 1 ? current.filter(item => item.key !== p.key) : current);
                    setError("");
                  }}>{tx("删除参数", "Remove parameter")}</button>
              </div>
              <p className="workflow-muted">{tx(
                "身份与显示", "Identity and display",
              )}</p>
              <div className="workflow-grid">
                {identityFields.map(field => (
                  <div className="workflow-field" key={field.key}>
                    <label htmlFor={`${titleId}-${p.key}-${field.key}`}>{tx(field.label.zh, field.label.en)}</label>
                    <input id={`${titleId}-${p.key}-${field.key}`} className="input"
                      value={p[field.key]} maxLength={field.maxLength}
                      required={field.key !== "unit"} onChange={event => patch(p.key, field.key, event.target.value)} />
                  </div>
                ))}
              </div>
              <p className="workflow-muted">{tx(
                "数值约束（按设备规格填写，不猜测默认值）", "Numeric constraints (from device specifications; no guessed defaults)",
              )}</p>
              <div className="workflow-grid">
                {numericFields.map(field => (
                  <div className="workflow-field" key={field.key}>
                    <label htmlFor={`${titleId}-${p.key}-${field.key}`}>{tx(field.zh, field.en)}</label>
                    <input id={`${titleId}-${p.key}-${field.key}`} className="input"
                      type="number" step="any" required value={p[field.key]}
                      onChange={event => patch(p.key, field.key, event.target.value)} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="workflow-actions">
            <button type="button" className="btn" disabled={parameters.length >= 12} onClick={() => {
              const parameter = emptyParameter(nextKey.current++);
              setParameters(current => current.length < 12 ? [...current, parameter] : current);
              setError("");
            }}>{tx("添加参数", "Add parameter")} ({parameters.length}/12)</button>
          </div>
          <div className="workflow-inset" aria-label={tx("预览", "Preview")}>
            <p className="workflow-inset-title">{tx("预览", "Preview")}</p>
            <p style={{ margin: "0 0 6px" }} aria-live="polite">{tx(
              `${2 * parameters.length + 6} 张卡片（每参数 1 滑条 + 1 回读监视，另含 6 张固定卡片）`,
              `${2 * parameters.length + 6} cards (1 slider + 1 readback monitor per parameter, plus 6 fixed cards)`,
            )}</p>
            <p className="workflow-muted" style={{ margin: "0 0 4px" }}>{tx(
              "固定卡片：模式、开始录制、停止录制、打点、急停、校准。",
              "Fixed cards: mode, start recording, stop recording, annotate, emergency stop, calibration.",
            )}</p>
            <p className="workflow-muted" style={{ margin: 0 }}>{tx(
              "目标未配置：发送模板和回读绑定为空，急停和校准未配置。生成不会发送任何指令。",
              "Target unconfigured: send templates and readback bindings are empty; emergency stop and calibration are unconfigured. Generation sends nothing.",
            )}</p>
          </div>
          {error && <p id={errorId} role="alert" className="workflow-status">{error}</p>}
        </div>
        <footer className="workflow-dialog-foot">
          <p className="workflow-status" role="status" aria-live="polite">{error ? "" : tx(
            "创建为新页，不覆盖现有页。", "Created as a new page; existing pages are untouched.",
          )}</p>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{tx("取消", "Cancel")}</button>
          <button type="submit" className="btn primary" aria-describedby={error ? errorId : undefined}>
            {tx("创建调试页", "Create debug page")}
          </button>
        </footer>
      </form>
    </div>, document.body,
  );
}

export default DebugPresetDialog;
