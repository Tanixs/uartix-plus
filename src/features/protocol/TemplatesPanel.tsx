import { useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import type { FrameTemplate } from "../../ipc/types";
import * as store from "./templateStore";
import * as teleStore from "./telemetryStore";
import * as plotStore from "../plot/plotStore";
import { EmptyState } from "../../shared/EmptyState";
import { PRESETS, applyPreset, groupDisplayName, presetGroupKey } from "../framecanvas/presets";
import { NewTplDlg } from "../framecanvas/NewTplDlg";

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

interface CtxItem {
  label: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

interface CtxMenu {
  x: number;
  y: number;
  items: CtxItem[];
}

function RenameDlg({
  title,
  init,
  onOk,
  onCancel,
}: {
  title: string;
  init: string;
  onOk: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(init);
  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div className="fc-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fc-dlg-title">{title}</div>
        <div className="fc-dlg-row">
          <label>名称</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={() => onOk(name.trim() || init)}>确定</button>
        </div>
      </div>
    </div>
  );
}

export function TemplatesPanel() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tele = useSyncExternalStore(teleStore.subscribe, teleStore.getSnapshot);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const [newOpen, setNewOpen] = useState(false);
  const [pMenu, setPMenu] = useState(false);
  const [expGrp, setExpGrp] = useState<Set<string>>(() => new Set());
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [rename, setRename] = useState<{ kind: "grp" | "tpl"; key: string; id: string; init: string } | null>(null);
  const [decimals, setDecimals] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("vs.decimals") ?? "2", 10);
    return [0, 2, 4, 6].includes(v) ? v : 2;
  });
  const [splitPct, setSplitPct] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("vs.tplSplitPct"));
      return Number.isFinite(v) && v >= 0.12 && v <= 0.85 ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (splitPct != null) localStorage.setItem("vs.tplSplitPct", String(splitPct));
    } catch {
      return;
    }
  }, [splitPct]);
  const dragRef = useRef<{ y: number; pct: number; panelH: number } | null>(null);
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || d.panelH <= 0) return;
      const next = d.pct + (e.clientY - d.y) / d.panelH;
      setSplitPct(Math.min(0.85, Math.max(0.12, next)));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, FrameTemplate[]>();
    for (const t of s.rules.templates) {
      const key = presetGroupKey(t) ?? t.id;
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()];
  }, [s.rules.templates]);

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

  const pick = (id: string) => {
    store.setSelection({ kind: "template", templateId: id });
  };

  const openCtx = (e: React.MouseEvent, key: string, tpls: FrameTemplate[], focused?: FrameTemplate) => {
    e.preventDefault();
    e.stopPropagation();
    const items: CtxItem[] = [];
    const multi = tpls.length > 1;
    const focus = focused ?? (multi ? undefined : tpls[0]);
    if (focus) {
      items.push({
        label: `${focus.name.replace(/·帧型\S+$/, "")}`,
        disabled: true,
      });
      items.push({
        label: "复制帧型",
        onClick: () => {
          store.copyTpl(focus.id);
          setCtx(null);
        },
      });
      items.push({
        label: "粘贴帧型…",
        disabled: !store.canPaste(),
        title: store.canPaste() ? "粘贴到本组（跨组亦可先复制再粘贴）" : "请先复制一个帧型",
        onClick: () => {
          store.pasteTpl(key);
          setCtx(null);
        },
      });
      items.push({
        label: "重命名帧型…",
        onClick: () => {
          setRename({ kind: "tpl", key, id: focus.id, init: focus.name });
          setCtx(null);
        },
      });
      items.push({
        label: "删除帧型",
        onClick: () => {
          store.removeTemplate(focus.id);
          setCtx(null);
        },
      });
    } else if (multi) {
      const hasPreset = tpls.some((t) => !!t.presetKey);
      items.push({
        label: "重命名协议簇…",
        disabled: hasPreset,
        title: hasPreset ? "预设协议簇不可重命名" : "修改簇名称",
        onClick: () => {
          setRename({ kind: "grp", key, id: "", init: groupDisplayName(key, tpls[0]) });
          setCtx(null);
        },
      });
      items.push({
        label: "粘贴帧型…",
        disabled: !store.canPaste(),
        onClick: () => {
          store.pasteTpl(key);
          setCtx(null);
        },
      });
      items.push({
        label: tpls.every((t) => t.enabled) ? "整组停用" : "整组启用",
        onClick: () => {
          store.setGroupEnabled(key, !tpls.every((t) => t.enabled), (t) => presetGroupKey(t) ?? t.id);
          setCtx(null);
        },
      });
      items.push({
        label: "删除整组",
        onClick: () => {
          store.replaceRules(
            s.rules.templates.filter((t) => !tpls.some((x) => x.id === t.id)),
          );
          setCtx(null);
        },
      });
    }
    setCtx({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, items });
  };

  const onGroupClick = (tpls: FrameTemplate[]) => {
    pick((tpls.find((t) => t.enabled) ?? tpls[0]).id);
  };

  return (
    <div className="tpl-panel">
      <div className="tpl-header">
        <span>协议模板</span>
        <button className="btn" title="新建空白协议或协议簇（多帧型分组，可复制/粘贴帧型）" onClick={() => setNewOpen(true)}>
          ＋ 新建
        </button>
        <div className="tpl-preset-wrap">
          <button className="btn" title="从预设导入协议副本（可反复添加，改崩了删除副本再添加）" onClick={() => setPMenu((v) => !v)}>
            ＋ 预设 ▾
          </button>
          {pMenu && (
            <>
              <div className="tpl-menu-mask" onClick={() => setPMenu(false)} />
              <div className="tpl-menu">
                <span className="tpl-menu-title">导入预设副本</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className="tpl-menu-item"
                    title={p.desc}
                    onClick={() => {
                      setPMenu(false);
                      applyPreset(p);
                    }}
                  >
                    {p.tag} {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div
        className="tpl-list"
        style={splitPct != null ? { flex: "none", height: `${splitPct * 100}%`, maxHeight: "none" } : undefined}
      >
        {s.rules.templates.length === 0 && (
          <div className="tpl-empty-state">
            <EmptyState
              title="尚无协议模板"
              hint={["点「＋ 新建」创建空白协议/协议簇", "或「＋ 预设」导入已有协议"]}
            />
          </div>
        )}
        {groups.map(([key, tpls]) => {
          const multi = tpls.length > 1;
          const open = expGrp.has(key);
          const allOn = tpls.every((t) => t.enabled);
          const someOn = tpls.some((t) => t.enabled);
          const cur = currentTpl && tpls.some((t) => t.id === currentTpl.id);
          const label = multi ? groupDisplayName(key, tpls[0]) : stripF(tpls[0].name);
          const dotC = tpls[0].color;
          const cnt = tpls.reduce((a, t) => a + (tele.tplStats[t.id]?.ok ?? 0), 0);
          const errs = tpls.reduce((a, t) => a + (tele.tplStats[t.id]?.err ?? 0), 0);
          return (
            <div key={key} className={`tpl-grp${cur ? " on" : ""}`}>
              <div
                className="tpl-row tpl-grow"
                onClick={() => {
                  onGroupClick(tpls);
                }}
                onContextMenu={(e) => openCtx(e, key, tpls)}
                title={multi ? `${label} · 点击选中，点箭头展开帧型；右键：簇菜单` : tpls[0].name}
              >
                {multi ? (
                  <button
                    className={`tpl-chev-btn${open ? " open" : ""}`}
                    title={open ? "收起帧型列表" : "展开帧型列表"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpGrp((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18" />
                    </svg>
                  </button>
                ) : (
                  <span className="tpl-chev" />
                )}
                <span className="tpl-dot" style={{ background: dotC }} />
                <span className="tpl-row-name">
                  {label}
                  {multi ? (
                    <em className="tpl-src">
                      {tpls.length} 帧型{someOn && !allOn ? "·部分解析" : ""}
                    </em>
                  ) : (
                    tpls[0].presetKey && <em className="tpl-src">预设</em>
                  )}
                  <span className="tpl-row-stats">
                    {cnt}
                    {errs ? ` / 错${errs}` : ""}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="chk-box"
                  checked={allOn}
                  title={allOn ? "整组解析中（取消停用）" : someOn ? "部分帧型解析中" : "整组停用（点击启用全部）"}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    store.setGroupEnabled(key, e.target.checked, (t) => presetGroupKey(t) ?? t.id);
                    pick(tpls.find((t) => t.enabled)?.id ?? tpls[0].id);
                  }}
                />
                <button
                  className="tpl-del"
                  title="删除整组协议副本（预设源不受影响，可再导入）"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.replaceRules(
                      s.rules.templates.filter((t) => !tpls.some((x) => x.id === t.id)),
                    );
                  }}
                >
                  ×
                </button>
              </div>
              {multi && open && (
                <>
                  {tpls.map((t) => {
                    const st = tele.tplStats[t.id] ?? { ok: 0, err: 0 };
                    return (
                      <div
                        key={t.id}
                        className={`tpl-row tpl-subrow${currentTpl?.id === t.id ? " on" : ""}${t.enabled ? "" : " off"}`}
                        onClick={() => pick(t.id)}
                        onContextMenu={(e) => openCtx(e, key, tpls, t)}
                        title={`${t.name} · 右键：复制/粘贴/重命名/删除`}
                      >
                        <span className="tpl-dot" style={{ background: t.color }} />
                        <span className="tpl-row-name">
                          {t.name}
                          <span className="tpl-row-stats">
                            {st.ok}
                            {st.err ? ` / 错${st.err}` : ""}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          className="chk-box"
                          checked={t.enabled}
                          title="启用/停用该帧型"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            store.patchTemplate(t.id, { enabled: e.target.checked });
                            pick(t.id);
                          }}
                        />
                        <button
                          className="tpl-del"
                          title="删除该帧型副本"
                          onClick={(e) => {
                            e.stopPropagation();
                            store.removeTemplate(t.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>

      {currentTpl && (
        <div className="tpl-meta">
          帧头{" "}
          {currentTpl.boundary.headerBytes
            .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
            .join(" ") || "（无）"}
          {" · "}
          {currentTpl.boundary.mode === "fixedLength"
            ? `固定帧长 ${currentTpl.boundary.fixedLength}`
            : currentTpl.boundary.mode === "lengthField"
              ? "长度字段截帧"
              : "帧尾截帧"}
          {currentTpl.checksum && currentTpl.checksum.algo !== "none"
            ? ` · ${currentTpl.checksum.algo}`
            : ""}
          {currentTpl.boundary.discValue?.length
            ? ` · 识别位@${currentTpl.boundary.discOffset}`
            : ""}
          <button className="tpl-open" onClick={() => pick(currentTpl.id)}>
            在面板编辑 →
          </button>
        </div>
      )}

      <div
        className="tpl-splitter"
        title="上下拖动调整列表高度（双击复位）"
        onMouseDown={(e) => {
          const panelEl = document.querySelector(".tpl-panel") as HTMLElement | null;
          dragRef.current = {
            y: e.clientY,
            pct: splitPct ?? 0.4,
            panelH: panelEl ? panelEl.clientHeight : 400,
          };
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={() => setSplitPct(null)}
      >
        <span />
      </div>

      <div className="legend-header">
        字段图例（实时值）
        <button
          className="legend-dec"
          title="图例小数位数（点击切换 0/2/4/6 位）"
          onClick={() => {
            const order = [0, 2, 4, 6];
            const next = order[(order.indexOf(decimals) + 1) % order.length];
            setDecimals(next);
            localStorage.setItem("vs.decimals", String(next));
          }}
        >
          {decimals}位
        </button>
      </div>
      <div className="legend-list">
        {s.rules.templates
          .filter((tpl) => tpl.enabled)
          .flatMap((tpl) =>
            tpl.fields.flatMap((f) => {
              const lv = tele.latest[f.id];
              const selected =
                s.selection?.kind === "field" && s.selection.fieldId === f.id;
              const numeric = f.type !== "ascii";
              const eye = numeric ? plotStore.channelState(tpl.id, f.id) : "off";
              const eyeOpen = plot.channels.some(
                (c) => c.tplId === tpl.id && c.fieldId === f.id,
              );
              const row = (
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
                    f.type === "csv"
                      ? "自适应分隔数值：展开行显示各通道实时值，眼睛开整组曲线"
                      : numeric
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
                    {f.type === "csv" ? (
                      <em className="tpl-src">自适应</em>
                    ) : null}
                  </span>
                  <span className="legend-value">
                    {lv
                      ? lv.text !== null
                        ? lv.text
                        : formatValue(lv.value, decimals)
                      : "--"}
                    {lv && f.unit && f.unit !== "ascii" ? ` ${f.unit}` : ""}
                  </span>
                </div>
              );
              if (f.type !== "csv") return [row];
              const chans: React.ReactNode[] = [];
              for (let i = 1; i <= 64; i++) {
                const cl = tele.latest[`${f.id}#${i}`];
                if (!cl) break;
                chans.push(
                  <div
                    key={`${f.id}#${i}`}
                    className="legend-item legend-sub"
                    onClick={() => {
                      store.setSelection({
                        kind: "field",
                        templateId: tpl.id,
                        fieldId: f.id,
                      });
                    }}
                    title={`${f.name}${i}（点击选中该字段编辑）`}
                  >
                    <span className="tpl-dot" style={{ background: f.color, opacity: 0.55 }} />
                    <span className="legend-name">
                      {f.name}{i}
                    </span>
                    <span className="legend-value">{formatValue(cl.value, decimals)}</span>
                  </div>,
                );
              }
              return [row, ...chans];
            }),
          )}
        {s.rules.templates.filter((t) => t.enabled && t.fields.length > 0).length === 0 && (
          <div className="tpl-empty">
            在协议画布框选字节 → 右键「定义为数据字段」
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
        </div>
      </div>

      {newOpen && (
        <NewTplDlg
          onOk={(r) => {
            setNewOpen(false);
            if (r.mode === "cluster") {
              store.createCluster(r.name, r.count, r.len);
            } else if (r.mode === "csv") {
              store.createCsvTemplate(r.delim, r.elemType, r.lineEnd);
            } else {
              store.createBlankTemplate(r.len);
            }
          }}
          onCancel={() => setNewOpen(false)}
        />
      )}

      {rename && (
        <RenameDlg
          title={rename.kind === "grp" ? "重命名协议簇" : "重命名帧型"}
          init={rename.init}
          onOk={(nm) => {
            if (rename.kind === "grp") store.renameGroup(rename.key, nm);
            else store.patchTemplate(rename.id, { name: nm });
            setRename(null);
          }}
          onCancel={() => setRename(null)}
        />
      )}

      {ctx && (
        <>
          <div className="fc-menu-mask" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="fc-menu" style={{ left: ctx.x, top: ctx.y }}>
            {ctx.items.map((it) => (
              <button
                key={it.label}
                className={`fc-menu-item${it.disabled ? "" : ""}`}
                disabled={it.disabled}
                title={it.title}
                onClick={it.onClick}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function stripF(n: string): string {
  return n.replace(/\s*\(副本\)\s*$/, "");
}

function formatValue(v: number, d: number): string {
  if (!Number.isFinite(v)) return "--";
  if (v !== 0 && (Math.abs(v) >= 1e12 || Math.abs(v) < 1e-6)) {
    return v.toExponential(Math.max(0, Math.min(d, 4)));
  }
  return v.toFixed(d);
}
