import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import * as store from "../protocol/templateStore";
import * as teleStore from "../protocol/telemetryStore";
import * as plotStore from "./plotStore";
import { clampFlyoutMenu } from "../../shared/Flyout";
import { beginPointerDrag } from "../../shared/pointerDrag";
import { labelText } from "../../shared/valueLabels";
import { patch as patchSettings, useSettings } from "../settings/settingsStore";
import { tx, useLocale } from "../../i18n/strings";
import { IconEye, IconEyeOff } from "../../shared/icons";

/**
 * P104-B8：字段图例（实时值）——从 `TemplatesPanel` 整块搬出。
 * R1 起住左侧导轨；P105-C 起住「协议」面板的下半区（导轨是单槽，「协议」与「通道」
 * 不能同屏，而字段本来就是协议解析的产物）。B8 那条右侧导轨已随 R1 退役。
 *
 * 为什么搬：它是**看数据时高频扫**的一块（45 行眼睛 + 实时值），
 * 却住在左栏「协议与连接」里，和低频的链路参数、模板列表抢同一列 330px。
 * B6 把链路节塞进去之后这一列更挤了——搬走它是把 B6 没收干净的尾收掉。
 *
 * 状态**仍只有一份**：这里只调 `plotStore` 的 addChannel / removeChannel / toggleVisible，
 * 不建第二张通道表。这是"镜像"与"第二真值"的分界。
 *
 * 代码是从 TemplatesPanel **搬**过来的不是重写的：眼睛三态（on/hidden/half）、
 * 自适应序列的整组开关、子变量右键删除后"等新帧出现再恢复"的 hiddenSubs、
 * 拖到曲线区建通道、点击定位 Hex —— 每一条行为都保持原样。
 */

function EyeIcon({ open }: { open: boolean }) {
  return open ? <IconEye /> : <IconEyeOff />;
}

function toggleEye(
  tplId: string,
  fieldId: string,
  name: string,
  color: string,
  groupIndices?: number[],
): void {
  if (groupIndices) {
    const st = plotStore.groupChannelState(tplId, fieldId);
    if (st === "off") {
      plotStore.addChannelGroup(tplId, fieldId, groupIndices, name, color);
    } else {
      plotStore.removeChannelGroup(tplId, fieldId);
    }
    return;
  }
  const st = plotStore.channelState(tplId, fieldId);
  if (st === "off") {
    plotStore.addChannel({
      tplId,
      fieldId,
      name,
      color,
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

function formatValue(v: number, d: number): string {
  if (!Number.isFinite(v)) return "--";
  if (v !== 0 && (Math.abs(v) >= 1e12 || Math.abs(v) < 1e-6)) {
    return v.toExponential(Math.max(0, Math.min(d, 4)));
  }
  return v.toFixed(d);
}

export function FieldLegend() {
  useLocale();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tele = useSyncExternalStore(teleStore.subscribe, teleStore.getSnapshot);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const settings = useSettings();
  const decimals = settings.decimals;
  /** 自适应序列里被手动删掉的子变量：记到"下一次出现新帧"为止（原行为，未改） */
  const [hiddenSubs, setHiddenSubs] = useState<Map<string, number>>(() => new Map());
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!ctx) return;
    const el = ctxMenuRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const cr = root.getBoundingClientRect();
    clampFlyoutMenu(el, root, ctx.x - cr.left, ctx.y - cr.top);
  }, [ctx]);

  return (
    <div className="legend-root" ref={rootRef}>
      <div className="legend-header">
        {tx("字段图例（实时值）", "Field legend (live values)")}
        <button
          className="legend-dec"
          title={tx("图例小数位数（点击 0→6 循环；也可在设置页自由填写 0~6）", "Legend decimals (click cycles 0→6; settings page accepts any 0~6)")}
          onClick={() => patchSettings({ decimals: (decimals + 1) % 7 })}
        >
          {decimals}{tx("位", "dp")}
        </button>
      </div>
      <div className="legend-list">
        {s.rules.templates
          .filter((tpl) => tpl.enabled)
          .flatMap((tpl) =>
            tpl.fields
              .filter((f) => f.role !== "header")
              .flatMap((f) => {
              const lv = tele.latest[f.id];
              const selected =
                s.selection?.kind === "field" && s.selection.fieldId === f.id;
              const seq = !!f.spanTail && !!f.spanElem;
              const adaptive = f.type === "csv" || seq;
              const seqIndices: number[] = [];
              if (adaptive) {
                const n = Math.min(64, tele.seqLen[f.id] ?? 0);
                if (n > 0) {
                  for (let i = 1; i <= n; i++) {
                    if (tele.latest[`${f.id}#${i}`]) seqIndices.push(i);
                  }
                } else {
                  for (let i = 1; i <= 64; i++) {
                    if (!tele.latest[`${f.id}#${i}`]) break;
                    seqIndices.push(i);
                  }
                }
              }
              const numeric = f.type !== "ascii" || seq;
              const eye = numeric
                ? seq
                  ? plotStore.groupChannelState(tpl.id, f.id)
                  : plotStore.channelState(tpl.id, f.id)
                : "off";
              const eyeOpen = plot.channels.some(
                (c) =>
                  c.tplId === tpl.id &&
                  (c.fieldId === f.id || c.fieldId.startsWith(`${f.id}#`)),
              );
              const row = (
                <div
                  key={f.id}
                  className={`legend-item ${selected ? "selected" : ""} pdrag-src`}
                  onPointerDown={(e) => {
                    if (!numeric || e.button !== 0) return;
                    beginPointerDrag(e, {
                      kind: "vs-field",
                      data: JSON.stringify({
                        tplId: tpl.id,
                        fieldId: f.id,
                        name: `${tpl.name}·${f.name}`,
                        type: f.type,
                      }),
                      label: `${tpl.name}·${f.name}`,
                      color: f.color,
                    });
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
                    adaptive
                      ? tx("自适应序列：展开行显示各元素实时值，眼睛开/关整组曲线", "Adaptive sequence: expanded rows show per-element live values; the eye toggles the whole group")
                      : numeric
                        ? tx("眼睛开关 2D 曲线；拖到曲线区也可添加；点击定位到 Hex 区", "Eye toggles the 2D curve; drag onto the plot to add; click locates it in the Hex view")
                        : tx("点击定位到 Hex 区 0x", "Click to locate in the Hex view at 0x") + (lv ? lv.seq.toString(16) : "")
                  }
                >
                  {numeric && (
                    <button
                      className={`legend-eye ${eye === "on" ? "on" : ""} ${eye === "hidden" || eye === "half" ? "half" : ""}`}
                      title={
                        eye === "off"
                          ? adaptive
                            ? tx("开启整组 2D 曲线", "Show group curves")
                            : tx("开启 2D 曲线", "Show 2D curve")
                          : eye === "on"
                            ? adaptive
                              ? tx("移除整组曲线", "Remove group curves")
                              : tx("隐藏曲线", "Hide curve")
                            : adaptive
                              ? tx("移除整组曲线（部分已隐藏）", "Remove group curves (some hidden)")
                              : tx("显示曲线（当前隐藏）", "Reveal curve (currently hidden)")
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleEye(
                          tpl.id,
                          f.id,
                          `${tpl.name}·${f.name}`,
                          f.color,
                          seq ? seqIndices : undefined,
                        );
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
                    {adaptive ? (
                      <em className="tpl-src">{tx("自适应", "auto")}</em>
                    ) : null}
                  </span>
                  <span
                    className="legend-value"
                    title={lv?.text ?? (lv ? labelText(f.labels, lv.value) ?? undefined : undefined)}
                  >
                    {lv
                      ? seq
                        ? `×${seqIndices.length}`
                        : lv.text !== null
                          ? lv.text
                          : formatValue(lv.value, decimals)
                      : "--"}
                    {lv && f.unit && f.unit !== "ascii" && !seq ? ` ${f.unit}` : ""}
                  </span>
                </div>
              );
              if (!adaptive) return [row];
              const chans: React.ReactNode[] = [];
              for (let i = 1; i <= 64; i++) {
                const subId = `${f.id}#${i}`;
                const cl = tele.latest[subId];
                if (!cl) break;
                const hidAt = hiddenSubs.get(subId);
                if (hidAt !== undefined && cl.seq === hidAt) continue;
                const st = plotStore.channelState(tpl.id, subId);
                chans.push(
                  <div
                    key={subId}
                    className="legend-item legend-sub"
                    onClick={() => {
                      store.setSelection({
                        kind: "field",
                        templateId: tpl.id,
                        fieldId: f.id,
                      });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const items: CtxItem[] = [
                        {
                          label: tx("删除该变量（新帧出现时恢复）", "Delete variable (returns when new frames arrive)"),
                          onClick: () => {
                            const ch = plotStore
                              .getSnapshot()
                              .channels.find(
                                (c) => c.tplId === tpl.id && c.fieldId === subId,
                              );
                            if (ch) plotStore.removeChannel(ch.id);
                            setHiddenSubs((prev) => {
                              const next = new Map(prev);
                              next.set(subId, tele.latest[subId]?.seq ?? 0);
                              return next;
                            });
                            setCtx(null);
                          },
                        },
                      ];
                      setCtx({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, items });
                    }}
                    title={`${f.name}${i}${tx("（点击选中该字段编辑 · 右键删除该变量）", " (click to edit this field · right-click to delete this variable)")}`}
                  >
                    <button
                      className={`legend-eye ${st === "on" ? "on" : ""} ${st === "hidden" ? "half" : ""}`}
                      title={
                        st === "off"
                          ? tx("开启该元素 2D 曲线", "Show this element's curve")
                          : st === "hidden"
                            ? tx("移除该曲线（当前隐藏）", "Remove this curve (hidden)")
                            : tx("移除该曲线", "Remove this curve")
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        const ch = plotStore
                          .getSnapshot()
                          .channels.find(
                            (c) => c.tplId === tpl.id && c.fieldId === subId,
                          );
                        if (!ch) {
                          plotStore.addChannel({
                            tplId: tpl.id,
                            fieldId: subId,
                            name: `${f.name}${i}`,
                            color: f.color,
                          });
                        } else {
                          plotStore.removeChannel(ch.id);
                        }
                      }}
                    >
                      <EyeIcon open={st !== "off"} />
                    </button>
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
            {tx("在协议画布框选字节 → 右键「定义为数据字段」", 'Drag-select bytes on the frame canvas → right-click "Define as field"')}
          </div>
        )}
      </div>

      {ctx && (
        <>
          <div className="fc-menu-mask" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="fc-menu" ref={ctxMenuRef} style={{ left: ctx.x, top: ctx.y }}>
            {ctx.items.map((it) => (
              <button
                key={it.label}
                className="fc-menu-item"
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
