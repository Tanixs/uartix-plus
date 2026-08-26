import { useSyncExternalStore } from "react";
import * as store from "./templateStore";
import * as plotStore from "../plot/plotStore";
import { EmptyState } from "../../shared/EmptyState";

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="legend-eye-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      )}
    </svg>
  );
}

function toggleEye(
  tplId: string,
  fieldId: string,
  name: string,
): void {
  const st = plotStore.channelState(tplId, fieldId);
  if (st === "off") {
    plotStore.addChannel({
      tplId,
      fieldId,
      name,
      color: plotStore.nextColor(),
    });
  } else {
    const ch = plotStore.getSnapshot().channels.find(
      (c) => c.tplId === tplId && c.fieldId === fieldId,
    );
    if (ch) plotStore.toggleVisible(ch.id);
  }
}

export function TemplatesPanel() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);

  const currentTpl =
    (s.selection?.kind === "template" || s.selection?.kind === "field"
      ? s.rules.templates.find((t) => t.id === s.selection!.templateId)
      : undefined) ?? s.rules.templates[0];

  const toggleDemo = async () => {
    try {
      await store.toggleDemo();
    } catch {
      return;
    }
  };

  return (
    <div className="tpl-panel">
      <div className="tpl-header">
        <span>协议模板</span>
        <button
          className="btn"
          onClick={() => store.addTemplate([0xaa, 0x55])}
          title="新建空白模板（默认帧头 AA 55，可在属性面板修改）"
        >
          + 新建
        </button>
      </div>

      {currentTpl ? (
        <>
          <div className="tpl-current">
            <span className="tpl-dot" style={{ background: currentTpl.color }} />
            <select
              className="input tpl-select"
              value={currentTpl.id}
              title="切换当前模板"
              onChange={(e) =>
                store.setSelection({
                  kind: "template",
                  templateId: e.target.value,
                })
              }
            >
              {s.rules.templates.map((tpl) => {
                const st = s.tplStats[tpl.id] ?? { ok: 0, err: 0 };
                return (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}（帧{st.ok}
                    {st.err ? `/错${st.err}` : ""}）
                  </option>
                );
              })}
            </select>
            <input
              type="checkbox"
              className="chk-box"
              checked={currentTpl.enabled}
              title="启用/禁用该模板解析"
              onChange={(e) =>
                store.patchTemplate(currentTpl.id, { enabled: e.target.checked })
              }
            />
            <button
              className="tpl-del"
              title="删除模板"
              onClick={() => store.removeTemplate(currentTpl.id)}
            >
              ×
            </button>
          </div>
          <div className="tpl-meta">
            帧头{" "}
            {currentTpl.boundary.headerBytes
              .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
              .join(" ")}
            {" · "}
            {currentTpl.boundary.mode === "fixedLength"
              ? `固定帧长 ${currentTpl.boundary.fixedLength}`
              : currentTpl.boundary.mode === "lengthField"
                ? "长度字段截帧"
                : "帧尾截帧"}
            {currentTpl.checksum && currentTpl.checksum.algo !== "none"
              ? ` · ${currentTpl.checksum.algo}`
              : ""}
          </div>
        </>
      ) : (
        <div className="tpl-empty-state">
          <EmptyState
            title="尚无协议模板"
            hint={["在 Hex 区框选字节后右键创建", "或点击下方「载入演示模板」"]}
          />
        </div>
      )}

      <div className="tpl-running">
        <span className="tpl-running-tag">解析中</span>
        {s.rules.templates
          .filter((t) => t.enabled)
          .map((t) => (
            <span
              key={t.id}
              className="run-chip"
              title="点击编辑该模板"
              onClick={() =>
                store.setSelection({ kind: "template", templateId: t.id })
              }
            >
              <span className="tpl-dot" style={{ background: t.color }} />
              {t.name}
              <button
                className="run-chip-x"
                title="停止解析该模板"
                onClick={(e) => {
                  e.stopPropagation();
                  store.patchTemplate(t.id, { enabled: false });
                }}
              >
                ×
              </button>
            </span>
          ))}
        {s.rules.templates.filter((t) => t.enabled).length === 0 && (
          <span className="run-none">未启用任何模板（解析已停止）</span>
        )}
        {s.rules.templates.some((t) => !t.enabled) && (
          <select
            className="input run-add"
            value=""
            title="启用模板（可多选，启用的模板并行解析）"
            onChange={(e) => {
              if (e.target.value)
                store.patchTemplate(e.target.value, { enabled: true });
            }}
          >
            <option value="">＋ 启用模板</option>
            {s.rules.templates
              .filter((t) => !t.enabled)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        )}
      </div>

      <div className="legend-header">字段图例（实时值）</div>
      <div className="legend-list">
        {s.rules.templates
          .filter((tpl) => tpl.enabled)
          .flatMap((tpl) =>
            tpl.fields.map((f) => {
              const lv = s.latest[f.id];
              const selected =
                s.selection?.kind === "field" && s.selection.fieldId === f.id;
              const numeric = f.type !== "ascii";
              const eye = numeric ? plotStore.channelState(tpl.id, f.id) : "off";
              const eyeOpen = plot.channels.some(
                (c) => c.tplId === tpl.id && c.fieldId === f.id,
              );
              return (
                <div
                  key={f.id}
                  className={`legend-item ${selected ? "selected" : ""}`}
                  draggable={numeric}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      "text/vs-field",
                      JSON.stringify({
                        tplId: tpl.id,
                        fieldId: f.id,
                        name: `${tpl.name}·${f.name}`,
                        type: f.type,
                      }),
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => {
                    store.setSelection({
                      kind: "field",
                      templateId: tpl.id,
                      fieldId: f.id,
                    });
                    if (lv) store.locate(lv.seq);
                  }}
                  title={
                    numeric
                      ? "眼睛开关 2D 曲线；拖到曲线区也可添加；点击定位到 Hex 区"
                      : "点击定位到 Hex 区 0x" + (lv ? lv.seq.toString(16) : "")
                  }
                >
                  {numeric && (
                    <button
                      className={`legend-eye ${eye === "on" ? "on" : ""} ${eye === "hidden" ? "half" : ""}`}
                      title={eye === "off" ? "开启 2D 曲线" : eye === "hidden" ? "显示曲线（当前隐藏）" : "隐藏曲线"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleEye(tpl.id, f.id, `${tpl.name}·${f.name}`);
                      }}
                    >
                      <EyeIcon open={eyeOpen} />
                    </button>
                  )}
                  <span
                    className="tpl-dot"
                    style={{ background: f.color }}
                  />
                  <span className="legend-name">
                    {tpl.name}·{f.name}
                  </span>
                  <span className="legend-value">
                    {lv
                      ? lv.text !== null
                        ? lv.text
                        : formatValue(lv.value)
                      : "--"}
                    {lv && f.unit && f.unit !== "ascii" ? ` ${f.unit}` : ""}
                  </span>
                </div>
              );
            }),
          )}
        {s.rules.templates.every((t) => t.fields.length === 0) && (
          <div className="tpl-empty">
            在 Hex 区框选字节 → 右键「定义为数据字段」
          </div>
        )}
      </div>

      <div className="tpl-footer">
        {s.syncError && <div className="tpl-sync-error">{s.syncError}</div>}
        <div className="tpl-demo">
          <button
            className={`btn ${s.demoRunning ? "danger" : ""}`}
            onClick={toggleDemo}
          >
            {s.demoRunning ? "停止演示源" : "启动演示源"}
          </button>
          <button className="btn" onClick={() => store.loadDemoRules()}>
            载入演示模板
          </button>
        </div>
      </div>
    </div>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3).replace(/\.?0+$/, "");
}
