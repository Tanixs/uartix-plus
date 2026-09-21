/**
 * P69 3D 轨迹面板组件（T1）· P87a 三组轨迹升级。
 *
 * 职责边界：本组件只做 UI 编排——
 * - 数据在 plot3dStore（120ms 泵 + 逐组时间水位续传），渲染在 scene.ts（逐组双层 LOD）；
 * - HUD：左上组托盘（G1/G2/G3 三行：可见性/色点/名称/模式/X·Y·Z 绑定/设置）、
 *   右上视角组 + 撤销/重做 + 清空、右下统计、左下测量气泡；
 * - 组设置弹层（P87a）：绑定/模式/平滑/着色/密度/渐隐/配对/上限/备注，
 *   确认一次 = updateGroup 一步撤销；行右键 = 该组快捷（设置/定位/导出/清空）；
 * - 拖 vs-field（协议模板图例行）落组行 = 智能绑定（X→Y→Z 空槽优先）；
 * - 右键菜单：组 / 模式 / 视图 / 测量 / 数据 / 设置（组级显示设置已入弹层）；
 * - 高频路径（悬停 tooltip、长按判定、时间条）直写 DOM/ref，绝不走 React state。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "./plot3dStore";
import type { GroupId, GroupHeading, GroupModel, TrajGroup } from "./plot3dStore";
import type { GroupTransform } from "./smoothing";
import * as sessionStore from "../session/sessionStore";
import * as templateStore from "../protocol/templateStore";
import { requestOpenPanel } from "../ai/appBus";
import * as timeCursor from "../analysis/timeCursorStore";
import { cancelPreview, navigateTime, previewTime, returnLatest, subscribeReplayClock } from "../analysis/timeNavigation";
import type { GroupStats, PickResult, Plot3DScene, ViewPreset } from "./scene";
import { createScene } from "./scene";
import { whyEmpty, dispatchRemedy, diagStage, REMEDY_LABEL, type DiagnoseInput, type EmptyDiagnosis } from "./diagnose";
import { fitEllipsoid, grade, FIT_MIN_POINTS, type FitOk } from "./ellipsoidFit";
import { attachPdragZone } from "../../shared/pointerDrag";
import { useSettings } from "../settings/settingsStore";
import { useOperator } from "../operator/operatorStore";
import { toast } from "../ai/extRuntime";
import { Flyout } from "../../shared/Flyout";
import { IconAutoSpin, IconCheck, IconChevron, IconCircle, IconClose, IconCrosshair, IconDot, IconEye, IconEyeOff, IconGear, IconLock, IconPlay, IconRotate, IconTarget, IconTrash, IconViewFront, IconViewIso, IconViewSide, IconViewTop } from "../../shared/icons";
import { confirmDialog } from "../../shared/Dialog";
import { fmtVal } from "../plot/plotMeasure";
import { tx, useLocale } from "../../i18n/strings";

/** 轴显示色：与 scene 轴线配色一致（X 红 / Y 绿 / Z 蓝，RViz 惯例） */
const AX_COLOR = { x: "#e05252", y: "#4caf50", z: "#4e9cef" } as const;
/** 测量强调色：与 scene 测量线一致 */
const MEASURE_COLOR = "#e8a13c";
/** 组色预设板（弹层 swatch） */
const PALETTE = ["#4e9cef", "#4caf50", "#e8a13c", "#e05252", "#b48ae8", "#36b3a6"];

/** 补偿预览迷你图逻辑尺寸（CSS px；canvas 属性固定 2×，P73 §2.2） */
const SPARK_W = 224;
const SPARK_H = 54;

/** 加计六面采集顺序（详设 §4.1 固定）：该面朝上静止 2s */
const A6_FACES = [
  { zh: "+X 朝上", en: "+X up" },
  { zh: "−X 朝上", en: "−X up" },
  { zh: "+Y 朝上", en: "+Y up" },
  { zh: "−Y 朝上", en: "−Y up" },
  { zh: "+Z 朝上", en: "+Z up" },
  { zh: "−Z 朝上", en: "−Z up" },
] as const;

type MenuSub = "ascale" | null;
type MenuState = { x: number; y: number; kind: "canvas" | "row"; gid?: GroupId };

const fsvg = (children: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconUndo = () => fsvg(<><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></>);
const IconRedo = () => fsvg(<><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></>);
const IconFlag = () =>
  fsvg(
    <>
      <path d="M4 21V4" />
      <path d="M4 4c4-2.2 8 2.2 12 0v9c-4 2.2-8-2.2-12 0" />
    </>,
  );

/** 相对秒短标签（34s / 5m / 1.2h）——与 2D fmtTickSec 同款语义，本地小函数不做跨文件抽象 */
const fmtTickSec = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 7200) return `${+(v / 3600).toFixed(1)}h`;
  if (a >= 150) return `${Math.round(v / 60)}m`;
  return `${Math.round(v * 10) / 10}s`;
};

const modeLabel = (m: TrajGroup["mode"]): string =>
  m === "point"
    ? tx("实时定位", "Live")
    : m === "points"
      ? tx("点集", "Cloud")
      : tx("连线", "Line");

/** 拟合失败原因（按错误码出双语；无码的历史文案回退中文 reason） */
function fitErrText(r: { reason: string; code?: string; p?: (number | string)[] }): string {
  const p = r.p ?? [];
  switch (r.code) {
    case "few":
      return tx(`采样点数不足（${p[0]}/${p[1]}），请继续翻滚传感器采样`, `Not enough samples (${p[0]}/${p[1]}) — keep tumbling the sensor`);
    case "octants":
      return tx("象限覆盖不足：点云集中在部分空间区域，请绕各轴翻滚一圈（画 8 字）覆盖全部象限后重试", "Poor quadrant coverage — tumble around every axis (figure-8) and retry");
    case "coincident":
      return tx("采样点重合，无法拟合（请检查数据是否在变化）", "Samples coincide; cannot fit (is the data changing?)");
    case "singular":
      return tx("采样覆盖不足：点分布近乎共面或集中在半球，请让传感器在空间各方向充分翻滚后重试", "Degenerate coverage (near-coplanar or hemisphere) — tumble fully and retry");
    case "solveFail":
    case "kNonPos":
      return tx("采样覆盖不足：请让传感器在空间各方向充分翻滚后重试", "Poor coverage — tumble the sensor in all directions and retry");
    case "hyperboloid":
      return tx("采样覆盖不足：点云分布无法构成封闭椭球，请全方位翻滚后重试", "Points cannot form a closed ellipsoid — tumble fully and retry");
    case "cigar":
      return tx("采样覆盖不足：椭球过度细长（旋转平面缺失），请绕各轴都翻滚一圈后重试", "Ellipsoid too slender (rotation plane missing) — tumble around every axis");
    case "oneSide":
      return tx("采样覆盖不足：某主轴方向只采样了单侧，请继续翻滚补齐对侧后重试", "One side of a principal axis is missing — cover the other side and retry");
    case "facesIncomplete":
      return tx("六面数据不完整（需要 +X/-X/+Y/-Y/+Z/-Z 六面各采一次）", "Six faces incomplete (+X/-X/+Y/-Y/+Z/-Z each needed)");
    case "faceFew":
      return tx(`面 ${Number(p[0]) + 1} 样本不足（${p[1]}/${p[2]}），请重新采集该面`, `Face ${Number(p[0]) + 1} has too few samples (${p[1]}/${p[2]}) — recapture it`);
    case "zeroDiff":
      return tx("两面均值差≈0：请检查采集顺序（+X 与 −X 是否摆对）", "Opposite faces differ by ~0 — check face order (+X vs −X)");
    case "axisOrder":
      return tx(`${["X", "Y", "Z"][Number(p[0])]} 轴两面均值差异常（+面应大于 −面）：疑似采集顺序错或传感器异常，请核对后重采`, `${["X", "Y", "Z"][Number(p[0])]} axis faces look inverted (+ should exceed −) — check order or sensor`);
    case "sigma":
      return tx(`面 ${Number(p[0]) + 1} 采集抖动过大（σ 超尺度均值 5%），请放稳后重采该面`, `Face ${Number(p[0]) + 1} too shaky (σ > 5% of scale) — hold still and recapture`);
    default:
      return r.reason;
  }
}

// ---------- 组设置弹层（P87a；确认一次 = 一步撤销） ----------

function GroupDialog(props: {
  gid: GroupId;
  channels: plotStore.Channel[];
  opLocked: boolean;
  roTip: string;
  onClose: () => void;
}) {
  useLocale();
  const { gid, channels, opLocked, roTip, onClose } = props;
  // P87e：组可能在弹层打开期间被删（另一入口/撤销）→ getGroup 返回 undefined。
  // 原快照进 draft；目标失效时仅提供关闭入口，绝不回退或保存到其他组。
  const src = plot3dStore.getGroup(gid);
  const [draft, setDraft] = useState<TrajGroup | undefined>(src ? { ...src } : undefined);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  if (!draft || !src) {
    // P87e：目标组已删除（弹层打开期间被删）→ 缺失态：仅提示 + 关闭，不崩溃不误写
    return (
      <div className="fc-dlg-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          className="fc-dlg p3d-gdlg"
          role="dialog"
          aria-modal="true"
          aria-label={tx("组设置（组已删除）", "Group settings (group deleted)")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        >
          <div className="fc-dlg-title">{tx("组设置", "Group settings")}</div>
          <div className="fc-dlg-warn">
            {tx(
              "该轨迹组已被删除（撤销或另一入口移除）。本弹层没有可编辑目标，未做任何修改。",
              "This trajectory group has been deleted. Nothing was modified.",
            )}
          </div>
          <div className="fc-dlg-foot">
            <button className="btn sm" onClick={onClose} autoFocus>
              {tx("关闭", "Close")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const set = (patch: Partial<TrajGroup>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const hSet = (patch: Partial<GroupHeading>) => set({ heading: { ...draft.heading, ...patch } });
  const mSet = (patch: Partial<GroupModel>) => set({ model: { ...draft.model, ...patch } });
  const tSet = (patch: Partial<GroupTransform>) => set({ transform: { ...draft.transform, ...patch } });
  const chanOpts = (
    <>
      <option value="">
        {channels.length === 0 ? tx("无通道", "No channels") : tx("未绑定", "Unbound")}
      </option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </>
  );
  const boundCnt = (draft.chX ? 1 : 0) + (draft.chY ? 1 : 0) + (draft.chZ ? 1 : 0);
  const dirty = src ? JSON.stringify({ ...draft, visible: src.visible }) !== JSON.stringify(src) : true;
  const ok = () => {
    if (opLocked || !plot3dStore.getGroup(gid)) return;
    plot3dStore.updateGroup(gid, draft);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && dirty && !opLocked) {
      ok();
    }
  };
  return (
    <div
      className="fc-dlg-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fc-dlg p3d-gdlg"
        role="dialog"
        aria-modal="true"
        aria-label={tx(`组设置 ${src.name}`, `Group settings ${src.name}`)}
        onKeyDown={onKey}
      >
        <div className="fc-dlg-title">
          {tx("组设置", "Group settings")}
          <span className="fc-dlg-sub">
            {tx(
              "确认一次 = 一步可撤销；绑定/模式/密度/配对变更会重灌该组轨迹",
              "Apply = one undo step; binding / mode / density / pairing reloads the group",
            )}
          </span>
        </div>
        {opLocked && (
          <div className="fc-dlg-warn">
            {tx("Operator 只读模式：配置已锁定，仅可查看", "Operator read-only: settings are view-only")}
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("名称", "Name")}</label>
          <input
            ref={nameRef}
            type="text"
            value={draft.name}
            maxLength={40}
            disabled={opLocked}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="fc-dlg-row">
          <label>{tx("颜色", "Color")}</label>
          <div className="fc-dlg-colors">
            <input
              type="color"
              value={draft.color}
              disabled={opLocked}
              onChange={(e) => set({ color: e.target.value })}
              className="fc-color-picker"
              title={tx("自由取色", "Custom color")}
            />
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={`fc-color-chip${draft.color === c ? " on" : ""}`}
                style={{ background: c }}
                disabled={opLocked}
                onClick={() => set({ color: c })}
                title={c}
              />
            ))}
          </div>
        </div>
        <div className="fc-dlg-row">
          <label>{tx("绑定", "Binding")}</label>
          <div className="p3d-gdlg-axes">
            <span className={`p3d-gdlg-ax ax-x`}>
              <b style={{ color: AX_COLOR.x }}>X</b>
              <select className="input" value={draft.chX} disabled={opLocked} onChange={(e) => set({ chX: e.target.value })}>
                {chanOpts}
              </select>
            </span>
            <span className="p3d-gdlg-ax ax-y">
              <b style={{ color: AX_COLOR.y }}>Y</b>
              <select className="input" value={draft.chY} disabled={opLocked} onChange={(e) => set({ chY: e.target.value })}>
                {chanOpts}
              </select>
            </span>
            <span className="p3d-gdlg-ax ax-z">
              <b style={{ color: AX_COLOR.z }} title={tx("Z（留空 = 平面轨迹）", "Z (empty = planar trajectory)")}>Z</b>
              <select className="input" value={draft.chZ} disabled={opLocked} onChange={(e) => set({ chZ: e.target.value })}>
                {chanOpts}
              </select>
            </span>
          </div>
        </div>
        {boundCnt > 0 && boundCnt < 2 && (
          <div className="fc-dlg-warn soft">
            {tx("X/Y 未绑齐：该组暂不绘制（Z 可留空=平面轨迹）", "X/Y not bound: this group is not drawn (empty Z = planar)")}
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("显示模式", "Mode")}</label>
          <div className="p3d-seg" role="group" aria-label={tx("显示模式", "Display mode")}>
            {(["point", "points", "line"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={draft.mode === m ? "on" : ""}
                disabled={opLocked}
                title={
                  m === "point"
                    ? tx("实时定位：只显示最新点，不留历史", "Live: only the latest point, no history")
                    : m === "points"
                      ? tx("点集：显示全部历史点，不连线", "Cloud: all points, no lines")
                      : tx("连线：按时间顺序连线（可加平滑）", "Line: time-ordered polyline (smoothable)")
                }
                onClick={() => set({ mode: m })}
              >
                {modeLabel(m)}
              </button>
            ))}
          </div>
        </div>
        {draft.mode !== "point" && (
          <div className="fc-dlg-row">
            <label>{tx("着色", "Color by")}</label>
            <div className="p3d-gdlg-inline2">
              <div className="p3d-seg" role="group" aria-label={tx("着色方式", "Coloring")}>
                {([
                  ["time", tx("按时间", "Time")],
                  ["ch", tx("按通道", "Channel")],
                  ["fixed", tx("组色", "Group")],
                ] as const).map(([v, lab]) => (
                  <button
                    key={v}
                    type="button"
                    className={draft.colorBy === v ? "on" : ""}
                    disabled={opLocked}
                    onClick={() => set({ colorBy: v })}
                  >
                    {lab}
                  </button>
                ))}
              </div>
              {draft.colorBy === "ch" && (
                <select
                  className="input"
                  value={draft.colorCh}
                  disabled={opLocked}
                  onChange={(e) => set({ colorCh: e.target.value })}
                >
                  {chanOpts}
                </select>
              )}
            </div>
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx(draft.mode === "point" ? "点大小" : "大小/透明", draft.mode === "point" ? "Size" : "Size / alpha")}</label>
          <div className="p3d-gdlg-inline2">
            <input
              type="range"
              min={1}
              max={draft.mode === "point" ? 32 : 24}
              step={1}
              value={draft.pointSize}
              disabled={opLocked}
              onChange={(e) => set({ pointSize: Number(e.target.value) })}
            />
            <b className="p3d-gdlg-num">{draft.pointSize}px</b>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={draft.opacity}
              disabled={opLocked}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
            />
            <b className="p3d-gdlg-num">{Math.round(draft.opacity * 100)}%</b>
            <button
              type="button"
              className="p3d-cbtn"
              disabled={opLocked}
              title={tx("按视口比例恢复推荐大小（模型×1.0、光点 3px），此后滚轮缩放视图不再影响", "reset to viewport-relative default; unaffected by later zoom")}
              onClick={() => {
                mSet({ scale: 1 });
                set({ pointSize: 3 });
              }}
            >
              {tx("自适应大小", "Fit size")}
            </button>
          </div>
        </div>
        {draft.mode === "line" && (
          <>
            <div className="fc-dlg-row">
              <label>{tx("平滑", "Smoothing")}</label>
              <div className="p3d-gdlg-inline2">
                <select
                  className="input"
                  value={draft.smooth}
                  disabled={opLocked}
                  onChange={(e) => set({ smooth: e.target.value as TrajGroup["smooth"] })}
                >
                  <option value="none">{tx("无（折线）", "None (polyline)")}</option>
                  <option value="movingAvg">{tx("滑动平均", "Moving average")}</option>
                  <option value="catmullRom">{tx("Catmull-Rom 样条", "Catmull-Rom")}</option>
                  <option value="spline">{tx("三次样条", "Cubic spline")}</option>
                </select>
                <span className="fc-dlg-hint">
                  {tx("曲线层只改视觉；悬停/测量/导出仍是原始点", "visual layer only; hover/measure/export stay raw")}
                </span>
              </div>
            </div>
            {draft.smooth === "movingAvg" && (
              <div className="fc-dlg-row">
                <label>{tx("窗口", "Window")}</label>
                <div className="p3d-gdlg-inline2">
                  <input
                    type="range"
                    min={3}
                    max={51}
                    step={2}
                    value={draft.smoothWin}
                    disabled={opLocked}
                    onChange={(e) => set({ smoothWin: Number(e.target.value) | 1 })}
                  />
                  <b className="p3d-gdlg-num">{draft.smoothWin}</b>
                  <span className="fc-dlg-hint">{tx("点（奇数）", "pts (odd)")}</span>
                </div>
              </div>
            )}
            {(draft.smooth === "catmullRom" || draft.smooth === "spline") && (
              <div className="fc-dlg-row">
                <label>{tx("细分", "Subdivision")}</label>
                <div className="p3d-gdlg-inline2">
                  <input
                    type="range"
                    min={2}
                    max={10}
                    step={1}
                    value={draft.smoothSub}
                    disabled={opLocked}
                    onChange={(e) => set({ smoothSub: Number(e.target.value) })}
                    title={tx("每段细分顶点数（越大越圆润、开销越高）", "vertices per segment (higher = rounder & costlier)")}
                  />
                  <b className="p3d-gdlg-num">×{draft.smoothSub}</b>
                  {draft.smooth === "catmullRom" && (
                    <>
                      <span className="fc-dlg-hint">{tx("张力", "tension")}</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={draft.smoothTension}
                        disabled={opLocked}
                        onChange={(e) => set({ smoothTension: Number(e.target.value) })}
                        title={tx("0=直线 1=全曲率", "0 = straight, 1 = full curvature")}
                      />
                      <b className="p3d-gdlg-num">{draft.smoothTension.toFixed(2)}</b>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="fc-dlg-row">
              <label>{tx("叠画点", "Show dots")}</label>
              <label className="p3d-gdlg-check">
                <input
                  type="checkbox"
                  checked={draft.showDots}
                  disabled={opLocked}
                  onChange={(e) => set({ showDots: e.target.checked })}
                />
                {tx("线上叠画轨迹点", "draw vertices over the line")}
              </label>
            </div>
            <div className="fc-dlg-row">
              <label>{tx("方向箭头", "Arrows")}</label>
              <div className="p3d-gdlg-inline2">
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={draft.arrowEvery}
                  disabled={opLocked}
                  onChange={(e) => set({ arrowEvery: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                />
                <span className="fc-dlg-hint">{tx("每 N 点一支（0=关；最少间隔 10）", "one per N points (0=off; min 10)")}</span>
              </div>
            </div>
          </>
        )}
        {draft.mode !== "point" && (
          <>
            <div className="fc-dlg-row">
              <label>{tx("渐隐", "Fade")}</label>
              <select
                className="input"
                value={draft.fade}
                disabled={opLocked}
                onChange={(e) => set({ fade: Number(e.target.value) as TrajGroup["fade"] })}
              >
                <option value={10}>{tx("最近 10 秒", "last 10 s")}</option>
                <option value={60}>{tx("最近 60 秒", "last 60 s")}</option>
                <option value={300}>{tx("最近 5 分钟", "last 5 min")}</option>
                <option value={0}>{tx("全程渐变", "full span")}</option>
              </select>
            </div>
            <div className="fc-dlg-row">
              <label>{tx("点密度", "Density")}</label>
              <select
                className="input"
                value={draft.density}
                disabled={opLocked}
                onChange={(e) => set({ density: e.target.value as TrajGroup["density"] })}
              >
                <option value="high">{tx("高（1:1 全点）", "High (1:1)")}</option>
                <option value="mid">{tx("中（1:2 抽稀）", "Mid (1:2)")}</option>
                <option value="low">{tx("低（1:4 抽稀）", "Low (1:4)")}</option>
              </select>
            </div>
            <div className="fc-dlg-row">
              <label>{tx("最大点数", "Max points")}</label>
              <div className="p3d-gdlg-inline2">
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={draft.maxPoints}
                  disabled={opLocked}
                  onChange={(e) => set({ maxPoints: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                />
                <span className="fc-dlg-hint">{tx("0 = 不限（22 万双层 LOD）；超限从最老端丢弃", "0 = uncapped (220k dual LOD); oldest dropped beyond")}</span>
              </div>
            </div>
            <div className="fc-dlg-row">
              <label>{tx("起点标记", "Start flag")}</label>
              <label className="p3d-gdlg-check">
                <input
                  type="checkbox"
                  checked={draft.showStartEnd}
                  disabled={opLocked}
                  onChange={(e) => set({ showStartEnd: e.target.checked })}
                />
                {tx("在最老轨迹点立起点光点（终点=最新点标记常显）", "mark the oldest trajectory point (end = live dot)")}
              </label>
            </div>
          </>
        )}
        <div className="fc-dlg-row">
          <label>{tx("数据配对", "Pairing")}</label>
          <div className="p3d-gdlg-inline2">
            <select
              className="input"
              value={draft.pairMode}
              disabled={opLocked}
              onChange={(e) => set({ pairMode: e.target.value as TrajGroup["pairMode"] })}
              title={tx(
                "插值=平滑消除阶梯（推荐）；最近邻=保持原始采样节奏；旧版前向填充=兼容口径",
                "Interp = smooth ladder removal (recommended); nearest = raw cadence; union = legacy fill",
              )}
            >
              <option value="interp">{tx("插值配对", "Interpolated")}</option>
              <option value="nearest">{tx("最近邻配对", "Nearest")}</option>
              <option value="union">{tx("旧版前向填充", "Legacy fill")}</option>
            </select>
            {draft.pairMode !== "union" && (
              <select
                className="input"
                value={draft.pairTolMs}
                disabled={opLocked}
                onChange={(e) => set({ pairTolMs: Number(e.target.value) })}
                title={tx("Y/Z 样本距锚点超过容差即丢弃（3D 不编造坐标）", "Y/Z samples beyond tolerance are dropped (no invented coords)")}
              >
                <option value={0}>{tx("自动容差", "Auto")}</option>
                {[5, 10, 25, 50, 100].map((v) => (
                  <option key={v} value={v}>
                    {v} ms
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="p3d-gdlg-sec">{tx("朝向与模型", "Heading & model")}</div>
        <div className="fc-dlg-row">
          <label>{tx("车头朝向", "Heading")}</label>
          <div className="p3d-gdlg-inline2">
            <select
              className="input"
              value={draft.heading.src}
              disabled={opLocked}
              onChange={(e) => hSet({ src: e.target.value as GroupHeading["src"] })}
            >
              <option value="xAxis">{tx("默认 +X", "Default +X")}</option>
              <option value="velocity">{tx("速度方向（差分）", "Velocity (differenced)")}</option>
              <option value="ch">{tx("航向角通道", "Heading channel")}</option>
              <option value="quat">{tx("四元数（4 通道）", "Quaternion (4 chs)")}</option>
            </select>
            {draft.heading.src === "ch" && (
              <select className="input" value={draft.heading.chYaw} disabled={opLocked} onChange={(e) => hSet({ chYaw: e.target.value })} title={tx("角度单位：度", "unit: degrees")}>
                {chanOpts}
              </select>
            )}
            <label className="p3d-gdlg-field"><span>{tx("航向 (°)", "Yaw (°)")}</span>
            <input
              type="number"
              step={5}
              value={draft.heading.yawOff}
              disabled={opLocked}
              onChange={(e) => hSet({ yawOff: Number(e.target.value) })}
              title={tx("航向修正角（度）：如北=0 或 90 系约定", "yaw offset (deg)")}
            /></label>
            <button
              type="button"
              className={`p3d-cbtn${draft.heading.yawSign === -1 ? " on" : ""}`}
              disabled={opLocked || draft.heading.src !== "ch"}
              onClick={() => hSet({ yawSign: draft.heading.yawSign === 1 ? -1 : 1 })}
              title={tx("航向增减方向翻转（顺/逆时针约定）", "flip yaw direction (CW/CCW convention)")}
            >
              {tx("翻转", "Flip")}
            </button>
          </div>
        </div>
        {draft.heading.src === "quat" && (
          <div className="fc-dlg-row">
            <label>{tx("四元数通道", "Quat channels")}</label>
            <div className="p3d-gdlg-inline2 p3d-gdlg-quat">
              {([["qX", "X"], ["qY", "Y"], ["qZ", "Z"], ["qW", "W"]] as const).map(([k, lab]) => (
                <select
                  key={k}
                  className="input"
                  value={draft.heading[k]}
                  disabled={opLocked}
                  onChange={(e) => hSet({ [k]: e.target.value } as Partial<GroupHeading>)}
                  title={`q${lab}`}
                >
                  {chanOpts}
                </select>
              ))}
              <span className="fc-dlg-hint">{tx("顺序若不符用「模型旋转」修正", "fix axis order via model rotation below")}</span>
            </div>
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("俯仰/滚修", "Pitch/Roll")}</label>
          <div className="p3d-gdlg-inline2">
            <label className="p3d-gdlg-field"><span>{tx("俯仰 (°)", "Pitch (°)")}</span>
              <input type="number" step={5} value={draft.heading.pitchOff} disabled={opLocked} onChange={(e) => hSet({ pitchOff: Number(e.target.value) })} />
            </label>
            <label className="p3d-gdlg-field"><span>{tx("滚转 (°)", "Roll (°)")}</span>
              <input type="number" step={5} value={draft.heading.rollOff} disabled={opLocked} onChange={(e) => hSet({ rollOff: Number(e.target.value) })} />
            </label>
          </div>
        </div>
        <div className="fc-dlg-row">
          <label>{tx("模型", "Model")}</label>
          <div className="p3d-gdlg-inline2">
            <select
              className="input"
              value={draft.model.kind}
              disabled={opLocked}
              onChange={(e) => mSet({ kind: e.target.value as GroupModel["kind"] })}
              title={tx("替换实时定位的光点，显示在最新点并随朝向转动", "replaces the live dot at the latest point, rotates with heading")}
            >
              <option value="point">{tx("光点（默认）", "Dot (default)")}</option>
              <option value="sphere">{tx("球", "Sphere")}</option>
              <option value="arrow">{tx("箭头", "Arrow")}</option>
              <option value="car">{tx("车", "Car")}</option>
              <option value="cone">{tx("锥体", "Cone")}</option>
              <option value="axes">{tx("坐标轴", "Axes")}</option>
              <option value="gltf">GLTF / GLB</option>
            </select>
            {draft.model.kind !== "point" && (
              <>
                <input
                  type="range"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={draft.model.scale}
                  disabled={opLocked}
                  onChange={(e) => mSet({ scale: Number(e.target.value) })}
                  title={tx("模型缩放", "model scale")}
                />
                <b className="p3d-gdlg-num">×{draft.model.scale.toFixed(1)}</b>
                <label className="p3d-gdlg-field"><span>{tx("高度 Y（工程单位）", "Height Y (units)")}</span>
                <input
                  type="number"
                  step={0.5}
                  value={draft.model.heightOff}
                  disabled={opLocked}
                  onChange={(e) => mSet({ heightOff: Number(e.target.value) })}
                  title={tx("高度偏移（真实单位，沿 Y）", "height offset (real units, along Y)")}
                /></label>
              </>
            )}
          </div>
        </div>
        {draft.model.kind === "gltf" && (
          <div className="fc-dlg-row">
            <label>{tx("模型文件", "Model file")}</label>
            <div className="p3d-gdlg-inline2">
              <button
                type="button"
                className="p3d-cbtn"
                disabled={opLocked}
                onClick={() => {
                  void (async () => {
                    const p = await open({
                      multiple: false,
                      filters: [{ name: "GLTF/GLB", extensions: ["glb", "gltf"] }],
                    });
                    if (typeof p === "string") mSet({ src: p });
                  })();
                }}
              >
                {tx("选择文件…", "Choose file…")}
              </button>
              <span className="fc-dlg-hint p3d-gdlg-path" title={draft.model.src}>
                {draft.model.src || tx("未选择（本地文件，不加载远程 URL）", "none (local file; no remote URLs)")}
              </span>
            </div>
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("模型旋转修正", "Model rot fix")}</label>
          <div className="p3d-gdlg-inline2">
            {(["rotX", "rotY", "rotZ"] as const).map((k) => (
              <label key={k} className="p3d-gdlg-field">
                <span>{k.slice(3)} (°)</span>
                <input type="number" step={15} value={draft.model[k]} disabled={opLocked}
                  onChange={(e) => mSet({ [k]: Number(e.target.value) } as Partial<GroupModel>)} />
              </label>
            ))}
          </div>
        </div>
        <div className="p3d-gdlg-sec">{tx("坐标变换与对齐", "Transform & align")}</div>
        <div className="fc-dlg-row">
          <label>{tx("旋转（度）", "Rotation")}</label>
          <div className="p3d-gdlg-inline2">
            {(["rotX", "rotY", "rotZ"] as const).map((k) => (
              <label key={k} className="p3d-gdlg-field">
                <span>{k.slice(3)} (°)</span>
                <input type="number" step={15} value={draft.transform[k]} disabled={opLocked}
                  onChange={(e) => tSet({ [k]: Number(e.target.value) } as Partial<GroupTransform>)} />
              </label>
            ))}
          </div>
        </div>
        <div className="fc-dlg-row">
          <label>{tx("平移/缩放", "Offset/scale")}</label>
          <div className="p3d-gdlg-inline2 p3d-gdlg-tf6">
            {(["offX", "offY", "offZ", "scale"] as const).map((k) => (
              <label key={k} className="p3d-gdlg-field">
                <span>{k === "scale" ? tx("比例 (×)", "Scale (×)") : `${k.slice(3)} (${tx("工程单位", "units")})`}</span>
                <input type="number" step={k === "scale" ? 0.1 : 1} value={draft.transform[k]} disabled={opLocked}
                  onChange={(e) => tSet({ [k]: Number(e.target.value) } as Partial<GroupTransform>)} />
              </label>
            ))}
          </div>
        </div>
        <div className="fc-dlg-row">
          <label>{tx("全部组对齐", "Align all groups")}</label>
          <div className="p3d-gdlg-inline2">
            <button type="button" className="p3d-cbtn" disabled={opLocked || dirty}
              title={tx("独立操作；请先确认或取消当前草稿，再对齐所有已绑定组", "Separate action: apply or cancel this draft before aligning all bound groups")}
              onClick={() => {
                if (dirty || opLocked || !plot3dStore.getGroup(gid)) return;
                if (plot3dStore.alignToOrigin()) {
                  const next = plot3dStore.getGroup(gid);
                  if (next) setDraft({ ...next });
                }
              }}>
              {tx("首点对齐原点", "Align starts to origin")}
            </button>
            <span className="fc-dlg-hint">{dirty
              ? tx("草稿尚未确认，对齐已禁用", "Unapplied draft: alignment disabled")
              : tx("独立的一步撤销；作用于全部已绑定组", "Separate undo step; affects all bound groups")}</span>
          </div>
        </div>
        <div className="fc-dlg-hint p3d-gdlg-tf-note">
          {tx(
            "变换作用于轨迹几何（显示/导出/测量同源）；校准采样恒用原始传感器值",
            "Transform applies to trajectory geometry (display/export/measure share it); calibration always samples raw sensor values",
          )}
        </div>
        <div className="fc-dlg-row">
          <label>{tx("备注", "Notes")}</label>
          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            value={draft.notes}
            disabled={opLocked}
            placeholder={tx("本组用途/结论（进分析包 meta.json）", "purpose / conclusions (exported to meta.json)")}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>
        <div className="fc-dlg-foot">
          <button className="btn sm" onClick={onClose}>
            {tx("取消", "Cancel")}
          </button>
          <button className="btn sm primary" disabled={!dirty || opLocked} onClick={ok} title={tx(`确认并保存${roTip}`, `Apply & save${roTip}`)}>
            {tx("确认", "Apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Plot3D() {
  useLocale(); // 语言切换重渲染（文案即时更新）
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const cbSafe = settings.chartPalette === "cbSafe";
  const cbSafeRef = useRef(cbSafe);
  cbSafeRef.current = cbSafe;

  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Plot3DScene | null>(null);
  const plotRef = useRef(plotStore.getSnapshot());
  const s3dRef = useRef(plot3dStore.getSnapshot().settings);
  const zfRef = useRef(zf);
  zfRef.current = zf;

  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  plotRef.current = plot;
  const p3d = useSyncExternalStore(plot3dStore.subscribe, plot3dStore.getSnapshot);
  s3dRef.current = p3d.settings;
  const s3d = p3d.settings;

  /* C1：Operator 只读边界 —— 「配置类」设置（组绑定/模式/显示/密度/渐隐/着色/网格/
     键盘飞行/三轴缩放…）锁定（store 层 updateGroup/setSetting 同等守卫兜底），
     视图与操作态（视角预设、自动旋转、跟随、缩放、测距、时间游标、组可见性、
     清空轨迹、导出、椭球校准/六面）全部放行：只读不允许改部署口径，但必须允许看和测。 */
  const opLocked = useOperator().pkg !== null;
  const opLockedRef = useRef(opLocked);
  opLockedRef.current = opLocked;
  const roTip = opLocked ? tx("（Operator 只读：设置已锁定）", " (operator read-only: settings locked)") : "";

  const [ready, setReady] = useState(false);
  const [gen, setGen] = useState(0); // WebGL context lost → +1 重建
  const [stats, setStats] = useState<{ groups: Record<GroupId, GroupStats>; fps: number; gridStep: number }>({
    groups: {},
    fps: 0,
    gridStep: 0,
  });
  // P87b：录制态（打点钮门控）与标注旗标相对秒列表
  const [recording, setRecording] = useState(false);
  const [annRels, setAnnRels] = useState<number[]>([]);
  const modelSrcRef = useRef<Record<string, string>>({});
  // P75 B2 → P87a 逐组：配对诊断（三轴值域 + 配对/跳过计数），1Hz 低频刷新
  const [pairInfo, setPairInfo] = useState<Record<GroupId, plot3dStore.PairStatSnapshot> | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [dlg, setDlg] = useState<GroupId | null>(null);

  // ---------- 右键菜单（画布 / 组行两态） ----------
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<MenuSub>(null);
  const [subPinned, setSubPinned] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const ascaleRowRef = useRef<HTMLDivElement | null>(null);
  const subTimer = useRef<number | null>(null);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  // ---------- 悬停 / 测距（高频路径，ref 化） ----------
  const hoverRef = useRef<PickResult | null>(null);
  const lastMoveT = useRef(0);
  const ldownRef = useRef<{ x: number; y: number; moved: boolean; menuOpen: boolean } | null>(null);
  const rdownRef = useRef<{ x: number; y: number } | null>(null);
  const lpTimer = useRef<number | null>(null);
  const suppressUpRef = useRef(false);
  const [measureMode, setMeasureMode] = useState(false);
  const measureModeRef = useRef(false);
  const mPts = useRef<{ a: PickResult | null; b: PickResult | null }>({ a: null, b: null });
  const [measureInfo, setMeasureInfo] = useState<{ a: PickResult; b: PickResult | null } | null>(null);

  // ---------- 椭球校准（P71）：拟合结果/错误为低频 state；采样计数 500ms 轮询 ----------
  const [fit, setFit] = useState<FitOk | null>(null);
  const fitRef = useRef<FitOk | null>(null);
  fitRef.current = fit;
  const [fitErr, setFitErr] = useState<string | null>(null);
  const [fitStale, setFitStale] = useState(false);
  const fitStaleRef = useRef(false);
  fitStaleRef.current = fitStale;
  const [calibUi, setCalibUi] = useState({ capturing: false, count: 0, coverage: 0 });
  const calSentRef = useRef(0); // 已推送 scene 的点数水位（缓冲清空 → 归零重推）
  /** P74c A5：场景重建后待重放的校准态（线框/显示模式）——必须在点云重新灌入之后应用 */
  const calReplayRef = useRef(false);

  // ---------- 校准 T+（P73）：子页 / 显示切换 / 预览迷你图 / 六面向导 ----------
  const [calibTab, setCalibTab] = useState<"ellipsoid" | "six">("ellipsoid");
  const [calibDisp, setCalibDisp] = useState<"raw" | "corrected">("raw");
  const calibDispRef = useRef<"raw" | "corrected">("raw");
  calibDispRef.current = calibDisp;
  const [previewOn, setPreviewOn] = useState(false);
  const [a6, setA6] = useState<plot3dStore.Accel6Snapshot | null>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const a6StartRef = useRef(0); // 采集面开始时刻（UI 侧秒表，仅倒计时显示用）
  const a6LastRef = useRef(-2); // 上一轮快照采集面（-2 = 未初始化）

  // ---------- 时间条（P70 T2）：高频路径全走 DOM/ref，不进 state ----------
  const tbTrackRef = useRef<HTMLDivElement>(null);
  const tbFillRef = useRef<HTMLDivElement>(null);
  const tbCurRef = useRef<HTMLDivElement>(null);
  const tbBubbleRef = useRef<HTMLDivElement>(null);
  const tbTRef = useRef<HTMLSpanElement>(null);
  const tbDragRef = useRef(false); // 非回放 scrub 拖动中
  const tbReplayDragRef = useRef(false);
  const endRelRef = useRef(0); // 数据末端相对秒（渲染时刷新）
  const ptsRef = useRef(0); // br 行点数（DOM 写入时判断分隔符）

  // ---------- 场景生命周期 ----------
  // 区分「WebGL 重建」与「面板真正卸载」：清理顺序 = 声明顺序（本 effect 先于
  // gen-effect 声明），真卸载时本清理先行置 false；重建时 gen-effect 清理读到 true
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let scene: Plot3DScene | null = null;
    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const s = await createScene(host, {
        onContextLost: () => setGen((g) => g + 1), // 触发整场景重建
        onToggleFollow: () =>
          plot3dStore.setSetting({ follow: !plot3dStore.getSnapshot().settings.follow }), // 键盘飞行 F 键（P72）
        onModelError: (gid, src) =>
          toast(
            tx(
              `组 ${gid.toUpperCase()} 的 GLTF 读取/解析失败：${src.slice(0, 60)}（回退为无模型标记，可重选文件或改回内置形状）`,
              `Group ${gid.toUpperCase()} GLTF failed to read/parse: ${src.slice(0, 60)} (no marker until fixed)`,
            ),
          ),
      });
      if (disposed) {
        s.dispose();
        return;
      }
      scene = s;
      sceneRef.current = s;
      // P87a：批次按组分发（entries 含逐组 reloaded 标记）
      s.applySettings(
        s3dRef.current,
        plotRef.current.channels,
        cbSafeRef.current,
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4e9cef",
      );
      plot3dStore.setSink((entries, cursorSec) => s.applyBatch(entries, cursorSec));
      // P74c A5：新场景是空的 → 点云推送水位归零 + 挂上「校准态重放」标记。
      // 否则重建后 snap.count 与水位相等，增量判定两个分支都不命中，
      // 出现「UI 有拟合结果、画布空点云」的假象。
      calSentRef.current = 0;
      calReplayRef.current = true;
      modelSrcRef.current = {}; // 新场景 gltf 缓存是空的 → 标记 src 水位重置，下一拍重注入
      // 游标同理：静态/回放暂停时没有新批次，pump 不会重发 → 强制下一拍重发一次
      plot3dStore.invalidateCursor();
      // P91 C1/C2：截空即处置——外部来源（联动/打点回灌）的游标把画面截到 0 点时
      // 自动回到最新并告知；用户在 3D 时间条上亲手拖的位置只弹提示条、不擅自改动。
      s.setOnCursorEmpty(() => {
        if (plot3dStore.scrubSource() !== "local") {
          plot3dStore.setScrub(null);
          s.setTimeCursor(null);
          toast(
            tx(
              "外部联动游标落在保留窗口之前，画面被截成空；已自动回到最新",
              "External cursor fell before the retained window; jumped back to latest",
            ),
          );
        }
        diagRef.current();
      });
      // P91 C5：只读探针——验收时贴回这一行输出即可定案，不再靠截图猜（真机取证成本归零）
      (window as unknown as { __p3d?: () => unknown }).__p3d = () => {
        const p = s.probe();
        return {
          cursorSec: p.cursorSec,
          calibOn: p.calibOn,
          visible: p.visible,
          totalPoints: p.totalPoints,
          groups: p.groups,
          scrubSource: plot3dStore.scrubSource(),
          cfg: plot3dStore.getSnapshot().settings.groups.map((g) => ({
            id: g.id, mode: g.mode, visible: g.visible, maxPoints: g.maxPoints,
            density: g.density, smooth: g.smooth, bind: [g.chX, g.chY, g.chZ], model: g.model.kind,
          })),
        };
      };
      setReady(true);
    })();
    return () => {
      disposed = true;
      scene?.setOnCursorEmpty(null);
      delete (window as unknown as { __p3d?: unknown }).__p3d;
      // P90 D3（裁决点4）：面板卸载/重建一律回到「跟随最新」——scrub 是 store 模块级
      // 视图态，留着会让重开的面板落回上次拖到的历史位置甚至截成空白（旧注释写反了）。
      plot3dStore.setScrub(null);
      plot3dStore.invalidateCursor();
      // C8：重建只停泵保留校准（采样是几分钟的工作量，显卡抖一下不该全灭）；
      // 真卸载才丢缓冲 + 退校准会话（红线：关闭了的面板不许后台跑）
      const final = !aliveRef.current;
      plot3dStore.setSink(null, { keepCalib: !final });
      scene?.dispose();
      sceneRef.current = null;
      setReady(false);
      if (final) plot3dStore.endCalibSession();
    };
  }, [gen]);

  // 主题切换（data-theme 属性）→ 场景重新读 CSS 变量
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.applyTheme();
  }, [themeTick]);

  // 设置/通道/色弱 → 应用到场景。通道用签名做依赖：plotStore 快照 10Hz 刷新
  // 会换 channels 数组身份，直接依赖会把 rebuildGrid 拖成 10Hz 风暴
  const chansSig = plot.channels.map((c) => `${c.id}:${c.name}`).join("|");
  useEffect(() => {
    if (!ready) return;
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#4e9cef";
    sceneRef.current?.applySettings(
      s3dRef.current,
      plotRef.current.channels,
      cbSafe,
      accent,
    );
  }, [ready, s3d, chansSig, cbSafe, themeTick]);

  // P87a 拖放绑定：图例行 vs-field 落到组行 = 智能绑进该组第一个空槽（X→Y→Z）；
  // 三槽已满时弹设置让用户手动改（引导而非静默覆盖——防「拖一下就丢绑定」）
  useEffect(() => {
    const el = trayRef.current;
    if (!el) return;
    return attachPdragZone(el, {
      kinds: "vs-field",
      onDrop: (d) => {
        if (opLocked) return;
        let f: { tplId: string; fieldId: string; name: string } | null = null;
        try {
          f = JSON.parse(d.data);
        } catch {
          f = null;
        }
        if (!f) return;
        const rowEl = document.elementFromPoint(d.x, d.y)?.closest(".p3d-grp-row");
        const gid = (rowEl as HTMLElement | null)?.dataset.gid as GroupId | undefined;
        if (!gid || !plot3dStore.getGroup(gid) || !(rowEl instanceof Element && el.contains(rowEl))) return;
        const chans = plotRef.current.channels;
        let ch = chans.find((c) => c.tplId === f!.tplId && c.fieldId === f!.fieldId);
        if (!ch) {
          if (!plotStore.addChannel({ tplId: f.tplId, fieldId: f.fieldId, name: f.name, color: "#4e9cef" }))
            return;
          ch = plotStore.getSnapshot().channels.find(
            (c) => c.tplId === f!.tplId && c.fieldId === f!.fieldId,
          );
        }
        if (!ch) return;
        const hit = plot3dStore.bindGroupFirstFree(gid, ch.id);
        const g = plot3dStore.getGroup(gid);
        if (!g) return;
        toast(
          hit
            ? tx(
                `已把「${ch.name}」绑到 ${g.name} 的 ${hit.toUpperCase()} 轴（Ctrl+Z 撤销）`,
                `Bound "${ch.name}" to ${g.name}'s ${hit.toUpperCase()} axis (Ctrl+Z to undo)`,
              )
            : tx(
                `${g.name} 三个绑定槽已满——打开组设置手动替换`,
                `${g.name} has all three slots filled — open its settings to replace one`,
              ),
        );
        if (!hit) setDlg(gid);
      },
    });
  }, [opLocked, ready]);

  // 1Hz 统计（按组点数/FPS/逐组配对诊断）：低频 state，可接受
  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => {
      const st = sceneRef.current?.stats();
      if (st) setStats(st);
      setPairInfo(Object.fromEntries(plot3dStore.getSnapshot().settings.groups.map(
        (g) => [g.id, plot3dStore.pairSnapshot(g.id)],
      )));
    }, 1000);
    return () => window.clearInterval(t);
  }, [ready]);

  // 跟随模式开关（P70 T2）：scene 侧 target 平滑锁定主组锚点；与 autoRotate 互斥已在 store 层联动
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setFollow(s3d.follow);
  }, [ready, s3d.follow]);

  // 校准模式开关（P71）：scene 切点云/轨迹层（退出零重建）；进入时退出测距（互斥）
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setCalibMode(s3d.calibMode);
    if (s3d.calibMode && measureModeRef.current) exitMeasure();
  }, [ready, s3d.calibMode]);

  // 键盘飞行开关（P72）：scene 侧挂/摘 window 按键监听（悬停画布才响应）
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setKeyFlight(s3d.keyFlight);
  }, [ready, s3d.keyFlight]);

  // P87b 标注旗标 + 打点门控：订阅 sessionStore（标注低频、进 state 可接受）
  useEffect(() => {
    const sync = () => {
      const snap = sessionStore.getSnapshot();
      setRecording(snap.state === "recording");
      const org = plotStore.timeOrigin();
      const rel: number[] = [];
      for (const a of sessionStore.getAnnotations()) {
        const r = (a.ts - org) / 1000;
        if (isFinite(r) && r >= 0) rel.push(r);
      }
      rel.sort((a, b) => a - b);
      setAnnRels(rel);
      sceneRef.current?.setAnnots(rel);
    };
    sync();
    // sessionStore 的标注推送只在会话事件里通知；500ms 低频兜底（打点后 ≤0.5s 上旗）
    const t = window.setInterval(sync, 500);
    const unsub = sessionStore.subscribe(sync);
    return () => {
      window.clearInterval(t);
      unsub();
    };
  }, [ready]);

  // P87b GLTF 字节加载（P87e：请求令牌化）：src 变化时**先**在当前场景实例上取
  // beginModelRequest(gid) 令牌（组未在册/非 gltf/重建中 → null，直接放弃），
  // 再 await 读盘——await 期间删组/重建/换 src 都会令牌失效，setModelBytes 内按
  // {场景代际, 组实例, src, token} 校验，过期产物直接丢弃，绝不复活已删组。
  useEffect(() => {
    if (!ready) return;
    for (const id of Object.keys(modelSrcRef.current)) {
      if (!s3d.groups.some((g) => g.id === id)) delete modelSrcRef.current[id];
    }
    for (const g of s3d.groups) {
      const key = g.model.kind === "gltf" ? g.model.src : "";
      if (modelSrcRef.current[g.id] === key) continue;
      modelSrcRef.current[g.id] = key;
      if (!key) continue;
      const scene = sceneRef.current; // 捕获实例：重建后旧 scene 已 dispose，不许把字节喂给新场景
      if (!scene) continue;
      const token = scene.beginModelRequest(g.id);
      if (token === null) continue; // 组不在册/非 gltf/空 src → 不读盘
      void (async () => {
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path: key });
          const buf = new Uint8Array(bytes).buffer;
          scene.setModelBytes(g.id, buf, token); // 过期令牌 scene 侧静默丢弃
        } catch {
          scene.setModelBytes(g.id, null, token);
        }
      })();
    }
  }, [ready, s3d]);

  // 校准采样轮询（500ms 低频）：store 缓冲 → scene 点云增量推送；
  // 缓冲缩水（重灌签名变化/清空）→ 场景点云与拟合结果同步重置；
  // 同拍带出六面快照（P73 向导 UI）与采集倒计时锚点
  useEffect(() => {
    if (!ready || !s3d.calibMode) return;
    const poll = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const snap = plot3dStore.calibSnapshot();
      if (snap.count < calSentRef.current || (fitRef.current && !plot3dStore.getCalibFit())) {
        scene.resetCalibView();
        scene.setCalibEllipsoid(null);
        calSentRef.current = 0;
        setFit(null);
        setFitErr(null);
        setFitStale(false);
        setPreviewOn(false);
        setCalibDisp("raw");
      }
      if (snap.count > calSentRef.current) {
        scene.setCalibPoints(plot3dStore.calibPoints(), calSentRef.current);
        calSentRef.current = snap.count;
        if (fitRef.current && snap.count > fitRef.current.n) setFitStale(true);
      }
      // P74c A5：重建后的校准态重放——必须排在点云推送之后
      // （scene 的 applyCalibView 依赖 calCount > 0，否则线框会被判定为「无点云」而隐藏）
      if (calReplayRef.current) {
        calReplayRef.current = false;
        scene.setCalibEllipsoid(fitRef.current);
        scene.setCalibDisplay(calibDispRef.current);
      }
      setCalibUi(snap);
      const a6s = plot3dStore.accel6Snapshot();
      if (a6s.collecting) {
        if (a6s.idx !== a6LastRef.current) a6StartRef.current = performance.now();
      } else {
        a6StartRef.current = 0;
      }
      a6LastRef.current = a6s.collecting ? a6s.idx : -1;
      setA6(a6s);
    };
    poll();
    const t = window.setInterval(poll, 500);
    return () => window.clearInterval(t);
  }, [ready, s3d.calibMode]);

  // 源身份变化（含删除、撤销、导入）同步清理本地视图，不能展示旧传感器结果。
  useEffect(() => {
    sceneRef.current?.resetCalibView();
    sceneRef.current?.setCalibEllipsoid(null);
    sceneRef.current?.setCalibDisplay("raw");
    calSentRef.current = 0;
    calReplayRef.current = false;
    fitRef.current = null;
    setFit(null);
    setFitErr(null);
    setFitStale(false);
    setPreviewOn(false);
    setCalibDisp("raw");
    setCalibUi(plot3dStore.calibSnapshot());
    setA6(plot3dStore.accel6Snapshot());
  }, [s3d.calibSrc]);

  useEffect(() => {
    const exists = (p: PickResult | null | undefined) => !p || s3d.groups.some((g) => g.id === p.gid);
    if (!exists(hoverRef.current)) { hoverRef.current = null; if (tipRef.current) tipRef.current.style.display = "none"; }
    if (!exists(mPts.current.a) || !exists(measureInfo?.a) || !exists(measureInfo?.b)) {
      mPts.current = { a: null, b: null };
      setMeasureInfo(null);
      sceneRef.current?.setMeasure(null, null);
    }
  }, [s3d.groups, measureInfo]);

  // ---------- 测距模式 ----------
  const enterMeasure = () => {
    measureModeRef.current = true;
    setMeasureMode(true);
    mPts.current = { a: null, b: null };
    setMeasureInfo(null);
    sceneRef.current?.setMeasure(null, null);
  };
  const exitMeasure = () => {
    measureModeRef.current = false;
    setMeasureMode(false);
    mPts.current = { a: null, b: null };
    setMeasureInfo(null);
    sceneRef.current?.setMeasure(null, null);
  };

  // P87a A7：撤销/重做快捷键（焦点在本面板时生效；输入框内不劫持）
  const doUndo = () => {
    if (plot3dStore.undo()) toast(tx("已撤销组配置", "Group config change undone"));
  };
  const doRedo = () => {
    if (plot3dStore.redo()) toast(tx("已重做组配置", "Group config change redone"));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (measureModeRef.current) exitMeasure();
        return;
      }
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- 悬停 tooltip（直写 DOM，不进 state） ----------
  const hideTip = () => {
    const tip = tipRef.current;
    if (tip) tip.style.display = "none";
  };
  const showTip = (pr: PickResult) => {
    const host = hostRef.current;
    const tip = tipRef.current;
    if (!host || !tip) return;
    const hr = host.getBoundingClientRect();
    const z = zfRef.current || 1;
    const s = s3dRef.current;
    const chans = plotRef.current.channels;
    const nameOf = (id: string) => chans.find((c) => c.id === id)?.name ?? id;
    const grp = s.groups.find((g) => g.id === pr.gid);
    const lines = [
      `${grp?.name ?? pr.gid} · t = ${pr.tSec.toFixed(2)} s`,
      `X ${fmtVal(pr.real[0])}   Y ${fmtVal(pr.real[1])}   Z ${fmtVal(pr.real[2])}`,
    ];
    if (grp?.colorBy === "ch" && grp.colorCh) lines.push(`${nameOf(grp.colorCh)} = ${fmtVal(pr.val)}`);
    tip.textContent = lines.join("\n");
    tip.style.display = "block";
    const vx = pr.screen[0] - hr.left;
    const vy = pr.screen[1] - hr.top;
    let lx = vx / z + 14;
    let ly = vy / z + 12;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    if (lx + w > hr.width / z - 4) lx = vx / z - w - 12;
    if (ly + h > hr.height / z - 4) ly = vy / z - h - 10;
    tip.style.left = `${Math.max(2, lx)}px`;
    tip.style.top = `${Math.max(2, ly)}px`;
  };

  // ---------- 指针交互（长按测距 / 右键菜单 / 悬停拾取） ----------
  const onPointerDown = (e: React.PointerEvent) => {
    // HUD 控件（组行绑定下拉/按钮）不冒泡进画布：长按会误触测距、按住下拉 400ms 直接进测距模式
    // P96-K1：空态引导卡与诊断条上的按钮同理——它们 DOM 上在 host 之内，不摘出来点一下就会起长按测距
    if ((e.target as HTMLElement).closest(".p3d-hud, .p3d-empty, .p3d-guide")) return;
    // P87a A7：点画布即把焦点收进面板根（Ctrl+Z/Y 撤销路由的前置）
    rootRef.current?.focus({ preventScroll: true });
    hideTip();
    if (e.button === 0) {
      ldownRef.current = { x: e.clientX, y: e.clientY, moved: false, menuOpen: menuOpenRef.current };
      if (lpTimer.current !== null) window.clearTimeout(lpTimer.current);
      lpTimer.current = window.setTimeout(() => {
        lpTimer.current = null;
        if (ldownRef.current && !ldownRef.current.moved) {
          suppressUpRef.current = true; // 长按已消费本次按压，弹起不再放点
          if (!s3dRef.current.calibMode) enterMeasure(); // 校准模式下不进测距（互斥）
        }
      }, 400);
    } else if (e.button === 2) {
      rdownRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const ld = ldownRef.current;
    if (ld) {
      if (Math.hypot(e.clientX - ld.x, e.clientY - ld.y) > 6) {
        ld.moved = true;
        if (lpTimer.current !== null) {
          window.clearTimeout(lpTimer.current);
          lpTimer.current = null;
        }
      }
      if (ld.moved) return; // 拖拽中不拾取
    }
    if (e.buttons !== 0) return;
    const now = performance.now();
    if (now - lastMoveT.current < 30) return; // 30ms 节流
    lastMoveT.current = now;
    const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
    hoverRef.current = pr;
    if (pr) showTip(pr);
    else hideTip();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button === 0) {
      if (lpTimer.current !== null) {
        window.clearTimeout(lpTimer.current);
        lpTimer.current = null;
      }
      const ld = ldownRef.current;
      ldownRef.current = null;
      const wasSuppress = suppressUpRef.current;
      suppressUpRef.current = false;
      if (
        measureModeRef.current &&
        ld &&
        !ld.moved &&
        !wasSuppress &&
        !ld.menuOpen
      ) {
        const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
        if (!pr) return; // 未命中轨迹点：保持等待
        if (!mPts.current.a) {
          mPts.current.a = pr;
          setMeasureInfo({ a: pr, b: null });
        } else {
          const a = mPts.current.a;
          sceneRef.current?.setMeasure(a, pr);
          setMeasureInfo({ a, b: pr });
          mPts.current = { a: null, b: null }; // 下一次点击开始新测量
        }
      }
    } else if (e.button === 2) {
      rdownRef.current = null;
    }
  };

  const onPointerLeave = () => {
    hideTip();
    hoverRef.current = null;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rd = rdownRef.current;
    rdownRef.current = null;
    if (rd && Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < 6) {
      setSub(null);
      setSubPinned(false);
      setMenu({ x: e.clientX, y: e.clientY, kind: "canvas" });
    }
  };

  /** P87a：组行右键 = 该组快捷菜单（设置/定位/导出/清空） */
  const onRowContextMenu = (e: React.MouseEvent, gid: GroupId) => {
    e.preventDefault();
    e.stopPropagation();
    setSub(null);
    setSubPinned(false);
    setMenu({ x: e.clientX, y: e.clientY, kind: "row", gid });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".p3d-hud")) return; // 双击 HUD 按钮（拟合/停止等）不该触发相机动作
    if (measureModeRef.current) return;
    const pr = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
    if (pr) sceneRef.current?.focusPoint(pr.real);
    else sceneRef.current?.resetView();
  };

  // ---------- 时间条（P70 T2）：非回放 scrub / 回放真 seek；进度直写 DOM（10Hz 红线） ----------
  /** 回放时钟 → 相对秒（与泵的游标映射一致：firstTs+posMs 对齐 timeOrigin，clamp 防御） */
  const sessionRelSec = (): number | null => {
    const s = sessionStore.getSnapshot();
    if ((s.state !== "playing" && s.state !== "paused") || s.firstTs <= 0) return null;
    const rel = (s.firstTs + s.posMs - plotStore.timeOrigin()) / 1000;
    return Math.min(Math.max(rel, 0), endRelRef.current);
  };
  const writeTb = (ratio: number, bubble: boolean) => {
    const r = Math.min(Math.max(ratio, 0), 1);
    const pct = `${r * 100}%`;
    if (tbFillRef.current) tbFillRef.current.style.width = pct;
    if (tbCurRef.current) tbCurRef.current.style.left = pct;
    const bub = tbBubbleRef.current;
    if (!bub) return;
    if (bubble) {
      bub.textContent = fmtTickSec(r * endRelRef.current);
      bub.style.left = pct;
      bub.style.display = "block";
    } else {
      bub.style.display = "none";
    }
  };
  const writeBrT = (relSec: number | null) => {
    const el = tbTRef.current;
    if (!el) return;
    el.textContent =
      relSec !== null
        ? `${ptsRef.current > 0 ? " · " : ""}t = ${fmtTickSec(relSec)}`
        : "";
  };
  const clearScrub = () => {
    returnLatest("plot3d"); // 清预览/挂起 seek，发布空游标（回放中不 seek 到结尾）
    plot3dStore.setScrub(null);
    sceneRef.current?.setTimeCursor(null);
    writeTb(1, false);
    writeBrT(null);
  };
  /** clientX → 轨道比例（ratio 无量纲，天然免疫 zoom，无需补偿） */
  const tbRatio = (clientX: number): number => {
    const track = tbTrackRef.current;
    if (!track) return 0;
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
  };
  const applyScrub = (ratio: number) => {
    const rel = ratio * endRelRef.current;
    // 拖拽中=预览：不抢回放时钟、不落真 seek，松手才提交（navigateTime）
    previewTime(timeCursor.fromDisplaySeconds(rel, plotStore.timeOrigin()), "plot3d");
    sceneRef.current?.setTimeCursor(rel);
    plot3dStore.setScrub(rel);
    writeTb(ratio, true);
    writeBrT(rel);
  };
  const tbSeek = (ratio: number) => {
    void navigateTime(timeCursor.fromDisplaySeconds(ratio * endRelRef.current, plotStore.timeOrigin()), "plot3d");
  };
  const sharedCursorRef = useRef(() => {});
  sharedCursorRef.current = () => {
    const c = timeCursor.getSnapshot();
    if (c.tsMs !== null && c.source !== "session" && (!c.linked || c.source === "plot3d")) return;
    const sec = c.tsMs === null ? null : timeCursor.toDisplaySeconds(c.tsMs, plotStore.timeOrigin());
    // P91 C2：标来源——3D 内亲手拖的（local）一律尊重；别的面板/打点回灌的（linked/
    // session）越界或截空时可自动放弃并说明，不再把画面永久钉死在空白位。
    plot3dStore.setScrub(sec, c.source === "session" ? "session" : "linked");
    sceneRef.current?.setTimeCursor(sec);
    writeTb(sec === null || endRelRef.current <= 0 ? 1 : sec / endRelRef.current, false);
    writeBrT(sec);
  };
  useEffect(() => {
    const unsub = timeCursor.subscribe(() => sharedCursorRef.current());
    const stopClock = subscribeReplayClock();
    sharedCursorRef.current();
    return () => {
      unsub();
      cancelPreview("plot3d");
      plot3dStore.setScrub(null);
      stopClock();
    };
  }, []);

  /* ===== P91 C1：空态自诊断 =====
   * 六次几何层修复都没命中，因为真因在可见性门控而门控是静默的。从此"画面为空"
   * 必须当场说清是哪一条（缺绑定 / 无数据 / 配对跳过 / 游标截断 / 上限挤空 / 校准接管），
   * 能给按钮的直接给按钮。 */
  const [diag, setDiag] = useState<EmptyDiagnosis | null>(null);
  const diagRef = useRef<() => void>(() => {});
  diagRef.current = () => {
    const s = sceneRef.current;
    if (!s) {
      setDiag(null);
      return;
    }
    const p = s.probe();
    const byId = new Map(p.groups.map((g) => [String(g.gid), g]));
    const input: DiagnoseInput = {
      calibOn: p.calibOn,
      panelVisible: p.visible,
      groups: plot3dStore.diagFacts().map((f) => {
        const g = byId.get(f.id);
        return {
          ...f,
          tailCount: g?.tailCount ?? 0,
          tailVisible: g?.tailDraw ?? 0,
          windowStartSec: g?.windowStartSec ?? null,
          overviewCount: g?.overviewCount ?? 0,
          cursorSec: g?.cursorSec ?? null,
          maxPoints: g?.maxPoints ?? 0,
          markerKind: g?.markerKind ?? "point",
          hasLatest: (g?.hasLatest ?? false) || (g?.tailCount ?? 0) > 0,
        };
      }),
    };
    const next = whyEmpty(input);
    // 同因同文不重设 state（避免 10Hz 泵把诊断条变成重渲染风暴）
    setDiag((prev) => (prev?.code === next.code && prev?.text === next.text ? prev : next));
  };

  useEffect(() => {
    if (!ready) return;
    diagRef.current();
    const t = window.setInterval(() => diagRef.current(), 700);
    return () => window.clearInterval(t);
  }, [ready, s3d]);

  /** 空态上的一键补救：分发逻辑在 diagnose.ts（纯函数 + Record 守卫），这里只注入落地依赖 */
  const runRemedy = (d: EmptyDiagnosis) => {
    const done = dispatchRemedy(d, {
      clearScrub: () => clearScrub(),
      showAllGroups: () => plot3dStore.diagFacts().forEach((f) => { if (!f.visible) plot3dStore.setGroupVisible(f.id, true); }),
      exitCalib: () => plot3dStore.setSetting({ calibMode: false }),
      raiseMaxPoints: (gid) => plot3dStore.updateGroup(gid as GroupId, { maxPoints: 0 }),
      openGroupDialog: (gid) => setDlg(gid as GroupId),
      startDemo: () => void templateStore.toggleDemo(),
      unknown: (what) => console.warn(`[P3D诊断] 空态补救未接的动作：${what}`),
    });
    if (done) window.setTimeout(() => diagRef.current(), 60);
  };

  const onTbPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation(); // 不触发画布长按/拾取/右键
    if (e.button !== 0) return;
    const track = tbTrackRef.current;
    if (!track) return;
    const s = sessionStore.getSnapshot();
    const replaying = s.state === "playing" || s.state === "paused";
    const ratio = tbRatio(e.clientX);
    if (replaying) {
      // 回放中：真时间机器 seek（hex 环复位 + 全面板同步倒带，3D 经重灌+游标自动跟随）
      track.setPointerCapture(e.pointerId);
      tbReplayDragRef.current = true;
      applyScrub(ratio);
      return;
    }
    track.setPointerCapture(e.pointerId);
    tbDragRef.current = true;
    applyScrub(ratio);
  };
  const onTbPointerMove = (e: React.PointerEvent) => {
    if (tbDragRef.current) {
      e.stopPropagation();
      applyScrub(tbRatio(e.clientX));
      return;
    }
    if (tbReplayDragRef.current) {
      e.stopPropagation();
      applyScrub(tbRatio(e.clientX));
    }
  };
  const onTbPointerUp = (e: React.PointerEvent) => {
    if (tbDragRef.current) {
      e.stopPropagation();
      tbDragRef.current = false;
      cancelPreview("plot3d"); // 释放手势；游标已落位，保留查看（实况无 seek 语义）
      const bub = tbBubbleRef.current;
      if (bub) bub.style.display = "none"; // 松手游标保留（查看历史意图明确）
    } else if (tbReplayDragRef.current) {
      e.stopPropagation();
      tbReplayDragRef.current = false;
      tbSeek(tbRatio(e.clientX)); // 收尾 seek 到最终位置（navigateTime 自清预览）
    }
  };
  /** pointercancel（拖出窗口/设备打断）：释放手势不提交；回放侧不 seek，预览随取消回退 */
  const onTbPointerCancel = (e: React.PointerEvent) => {
    if (!tbDragRef.current && !tbReplayDragRef.current) return;
    e.stopPropagation();
    tbDragRef.current = false;
    tbReplayDragRef.current = false;
    cancelPreview("plot3d");
    const bub = tbBubbleRef.current;
    if (bub) bub.style.display = "none";
    sharedCursorRef.current();
  };
  const onTbDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = sessionStore.getSnapshot();
    if (s.state === "playing" || s.state === "paused") return; // 回放中无 scrub 语义
    clearScrub(); // 双击 = 回到最新
  };

  // 回放进度 / scrub 游标 → 直写 DOM（sessionStore 10Hz posMs 推送，绝不进 React state）
  useEffect(() => {
    const update = () => {
      if (tbDragRef.current || tbReplayDragRef.current) return; // 拖拽预览优先，不被 10Hz 推送覆盖
      const endRel = endRelRef.current;
      if (endRel <= 0 || !tbFillRef.current) return;
      const shared = timeCursor.getSnapshot();
      const rel = shared.tsMs !== null && shared.linked
        ? timeCursor.toDisplaySeconds(shared.tsMs, plotStore.timeOrigin())
        : sessionRelSec();
      if (rel !== null) {
        writeTb(rel / endRel, false);
        writeBrT(rel);
      } else {
        const c = plot3dStore.lastCursorSec();
        if (c === null) writeTb(1, false);
        else writeTb(Math.min(Math.max(c / endRel, 0), 1), false);
        writeBrT(c);
      }
    };
    update();
    return sessionStore.subscribe(update);
  }, []);

  // ---------- 菜单定位（zoom 补偿）与关闭闭环 ----------
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    const left = Math.max(8, Math.min(menu.x / zf, vw - w - 8));
    let top = menu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setMenuPos({ left, top });
  }, [menu, zf]);

  const armSub = () => {
    if (subTimer.current !== null) window.clearTimeout(subTimer.current);
    subTimer.current = window.setTimeout(() => setSub(null), 250);
  };
  const disarmSub = () => {
    if (subTimer.current !== null) {
      window.clearTimeout(subTimer.current);
      subTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (subTimer.current !== null) window.clearTimeout(subTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    let t: number | null = null;
    const inEl = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    };
    const insideAny = (x: number, y: number) => {
      if (inEl(menuRef.current, x, y)) return true;
      for (const el of Array.from(document.querySelectorAll(".ctx-flyout")))
        if (inEl(el, x, y)) return true;
      return false;
    };
    const closeAll = () => {
      setMenu(null);
      setSub(null);
      setSubPinned(false);
    };
    const onMove = (e: PointerEvent) => {
      if (insideAny(e.clientX, e.clientY)) {
        if (t !== null) {
          window.clearTimeout(t);
          t = null;
        }
        return;
      }
      if (t === null)
        t = window.setTimeout(() => {
          t = null;
          closeAll();
        }, 500);
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".ctx-menu")) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", closeAll, true);
    return () => {
      if (t !== null) window.clearTimeout(t);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", closeAll, true);
    };
  }, [menu]);

  // ---------- 菜单动作 ----------
  const chanName = (id: string) => plot.channels.find((c) => c.id === id)?.name ?? id;
  const closeAnd = (fn: () => void) => () => {
    fn();
    setMenu(null);
    setSub(null);
    setSubPinned(false);
  };
  const copyHover = () => {
    const pr = hoverRef.current;
    if (!pr) return;
    const s = s3dRef.current;
    const grp = s.groups.find((g) => g.id === pr.gid);
    const parts = [
      `g=${pr.gid}`,
      `t=${pr.tSec.toFixed(3)}s`,
      `X=${fmtVal(pr.real[0])}`,
      `Y=${fmtVal(pr.real[1])}`,
      `Z=${fmtVal(pr.real[2])}`,
    ];
    if (grp?.colorBy === "ch" && grp.colorCh) parts.push(`${chanName(grp.colorCh)}=${fmtVal(pr.val)}`);
    void navigator.clipboard?.writeText(parts.join("  "));
  };

  /** 组数据清空（P87a 组化）：水位推进 + 场景缓冲清零；不可撤销——确认弹窗如实说明 */
  const clearGroupData = async (gid?: GroupId) => {
    const g = gid ? plot3dStore.getGroup(gid) : null;
    if (gid && !g) return;
    const ok = await confirmDialog({
      title: gid ? tx(`清空 ${g?.name} 轨迹数据`, `Clear ${g?.name} data`) : tx("清空轨迹数据", "Clear trajectory data"),
      message: gid
        ? tx(
            "清空该组已积累的轨迹：历史全部跳过，新数据从零画起。\n该操作不可撤销。绑定、显示设置与校准采样不受影响。",
            "Clear this group's trajectory: history is skipped, new data draws from zero.\nThis cannot be undone. Bindings, display settings and calibration sampling are untouched.",
          )
        : tx(
            "清空全部组已积累的轨迹：历史全部跳过，新数据从零画起。\n该操作不可撤销。绑定、显示设置与校准采样不受影响。",
            "Clear all groups' trajectories: history is skipped, new data draws from zero.\nThis cannot be undone. Bindings, display settings and calibration sampling are untouched.",
          ),
      danger: true,
      okLabel: tx("清空", "Clear"),
    });
    if (!ok || !aliveRef.current || (gid && !plot3dStore.getGroup(gid))) return;
    // 运行/视图类操作：Operator 只读模式放行（红线 27——不改配置，数据可重新积累）
    plot3dStore.clearData(gid);
    sceneRef.current?.clearTrajectory(gid);
    toast(tx("轨迹数据已清空，等待新数据", "Trajectory cleared, waiting for new data"));
  };

  /** 删除轨迹组（P87e）：本地人工确认——说明只移除组配置与显示资源、不动源通道、可撤销 */
  const removeGroupUi = async (gid: GroupId) => {
    if (opLocked) return;
    const g = plot3dStore.getGroup(gid);
    if (!g) return; // 已删：入口自动失效
    const ok = await confirmDialog({
      title: tx(`删除轨迹组 ${g.name}`, `Delete trajectory group ${g.name}`),
      message: tx(
        `移除该组的配置与 3D 显示资源，不删除源通道；撤销可恢复配置并从仍可用的源数据重建；不保证恢复源端已裁掉的历史。
若此组是校准源，采样将停止，拟合/预览/六面临时态将清空，且不会自动选择另一组。
确定删除？`,
        `Removes the group's config and 3D display resources; source channels are kept. Undo restores the config and rebuilds from still-available sources, not history already trimmed at the source.
If this is the calibration source, capture stops and fit/preview/six-face state clears; no other source is selected automatically.
Delete?`,
      ),
      danger: true,
      okLabel: tx("删除组", "Delete group"),
    });
    if (!ok || !aliveRef.current) return;
    if (!plot3dStore.getGroup(gid)) return; // 弹窗期间已被删：幂等退出
    if (plot3dStore.removeGroup(gid)) {
      if (dlg === gid) setDlg(null);
      if (menu?.gid === gid) setMenu(null);
      toast(tx(`已删除 ${g.name}（可撤销）`, `Deleted ${g.name} (undoable)`));
    }
  };
  /** 设为校准源（P87e）：显式选择 + 人工确认——切换即停采样并清全部校准临时态（不自动换源） */
  const setCalibSrcUi = async (gid: GroupId) => {
    if (opLocked) return;
    const g = plot3dStore.getGroup(gid);
    if (!g) return; // 已删：入口自动失效
    const cur = s3dRef.current.calibSrc;
    if (cur === gid) return;
    const curName = cur ? plot3dStore.getGroup(cur)?.name : null;
    const ready = !!g.chX && !!g.chY && !!g.chZ;
    const ok = await confirmDialog({
      title: tx(`校准源 → ${g.name}`, `Calibration source → ${g.name}`),
      message: tx(
        `切换校准采样源为 ${g.name}${curName ? `（当前：${curName}）` : cur === null ? "（当前：未选择）" : "（当前源已删除）"}。
将停止进行中的采样，并清空椭球采样/拟合/补偿预览/六面临时态（不可恢复，不随撤销恢复）。`,
        `Switch the calibration sampling source to ${g.name}${curName ? ` (current: ${curName})` : cur === null ? " (current: none)" : " (current source deleted)"}.
Any running capture stops; ellipsoid samples / fit / preview / six-face temp state are cleared (not restored by undo).`,
      ),
      danger: true,
      okLabel: tx("切换校准源", "Switch source"),
    });
    if (!ok || !aliveRef.current || opLockedRef.current || plot3dStore.getSnapshot().settings.calibSrc !== cur) return;
    if (!plot3dStore.getGroup(gid)) return; // 弹窗期间被删：幂等退出
    if (!plot3dStore.setCalibSrc(gid)) {
      toast(tx("切换校准源失败（组已删除或配置被锁定）", "Failed to switch source (group deleted or config locked)"));
      return;
    }
    // 换源后点云/拟合 UI 全清（store 已清缓冲）；若新源三轴未绑齐，提示先补绑定
    clearCalibAll();
    if (!ready) toast(tx("新校准源尚未绑齐 X/Y/Z，请先在组行补齐绑定", "New source lacks X/Y/Z binding — bind them first"));
  };
  /** 校准源置空（P87e）：显式取消选择 → 校准禁用；确认语义同切源（临时态清空） */
  const switchCalibSrcUiNone = async () => {
    if (opLocked) return;
    const ok = await confirmDialog({
      title: tx("取消校准源", "Clear calibration source"),
      message: tx(
        "取消后校准禁用（不自动换源）；进行中的采样停止，椭球采样/拟合/预览/六面临时态清空。确定？",
        "Calibration will be disabled (no auto fallback); running capture stops and samples/fit/preview/six-face state clear. Continue?",
      ),
      danger: true,
      okLabel: tx("取消选择", "Clear"),
    });
    if (!ok || !aliveRef.current) return;
    if (!plot3dStore.setCalibSrc(null)) return;
    clearCalibAll();
  };
  // ---------- 椭球校准动作（P71 / P73 T+）----------
  const doFit = () => {
    const r = fitEllipsoid(plot3dStore.calibPoints());
    if (r.ok) {
      setFit(r);
      setFitStale(false);
      setFitErr(null);
      plot3dStore.setCalibFit(r); // 下沉 store：泵在线补偿预览 + scene 显示切换共用（P73）
      sceneRef.current?.setCalibEllipsoid(r);
    } else {
      setFitErr(fitErrText(r)); // 保留旧结果与线框，错误就地展示（详设 §3.2）
    }
  };
  const clearCalibAll = () => {
    plot3dStore.clearCalib();
    sceneRef.current?.resetCalibView();
    calSentRef.current = 0;
    setFit(null);
    setFitErr(null);
    setFitStale(false);
    setPreviewOn(false);
    setCalibDisp("raw");
  };
  const copyCalibJson = () => {
    const f = fitRef.current;
    if (!f) return;
    void navigator.clipboard?.writeText(
      JSON.stringify({ offset: f.offset, gains: f.gains, matrix: f.matrix, cv: f.cv, points: f.n }),
    );
  };
  const copyCalibC = () => {
    const f = fitRef.current;
    if (!f) return;
    const rows = f.matrix.map((r) => `{${r.join(", ")}}`).join(", ");
    void navigator.clipboard?.writeText(
      `float mag_offset[3] = {${f.offset.join(", ")}};\nfloat mag_matrix[3][3] = {${rows}};`,
    );
  };

  /** 子页切换（P73 §4.2）：椭球 ↔ 六面互清对方缓冲（数据语义不同，混采无意义）。
   *  对侧已有可观工作量（采样达标或已有拟合/已采面）时先确认，误点不再瞬间清空 */
  const switchCalibTab = async (t: "ellipsoid" | "six") => {
    if (t === calibTab) return;
    const snap = plot3dStore.calibSnapshot();
    const a6s = plot3dStore.accel6Snapshot();
    const dropEllipsoid = t === "six" && (snap.count >= FIT_MIN_POINTS || !!fitRef.current);
    const dropSix = t === "ellipsoid" && a6s.faces.some(Boolean);
    if (dropEllipsoid || dropSix) {
      if (
        !(await confirmDialog({
          message: tx(
            "切换子页会清空另一侧已采集的数据与结果（椭球点云 / 六面清单互不兼容），确定继续？",
            "Switching clears the other side's samples and results (ellipsoid cloud vs six-face data are incompatible). Continue?",
          ),
          danger: true,
        }))
      )
        return;
    }
    setCalibTab(t);
    if (t === "six") {
      clearCalibAll();
    } else {
      plot3dStore.accel6Reset();
    }
  };
  /** 点云显示切换：raw = 原始椭球+残差着色；corrected = 校正后球壳+参考球 */
  const switchCalibDisp = (m: "raw" | "corrected") => {
    setCalibDisp(m);
    sceneRef.current?.setCalibDisplay(m);
  };

  /** 退出校准模式：正在采样/六面采集先自动停止并告知（缓冲保留，重进可继续/清空） */
  const exitCalibMode = () => {
    const snap = plot3dStore.calibSnapshot();
    const a6s = plot3dStore.accel6Snapshot();
    if (snap.capturing) {
      plot3dStore.stopCalibCapture();
      toast(tx("已退出校准模式，椭球采样自动停止（已采数据保留）", "Left calibration mode; ellipsoid capture stopped (samples kept)"));
    } else if (a6s.collecting) {
      plot3dStore.accel6Abort();
      toast(tx("已退出校准模式，六面采集自动停止（已采面保留）", "Left calibration mode; six-face capture stopped (faces kept)"));
    }
    plot3dStore.setSetting({ calibMode: false });
  };

  // ---------- 补偿预览迷你图（P73）：10Hz canvas 直绘，不走 React state ----------
  const drawSpark = () => {
    const cvs = sparkRef.current;
    const ctx = cvs?.getContext("2d");
    if (!cvs || !ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // 画布属性固定 2×抗锯齿，CSS 尺寸 224×54
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#4e9cef";
    const dim = css.getPropertyValue("--text-dim").trim() || "#8a929e";
    const pv = plot3dStore.previewSnapshot();
    ctx.font = "10px ui-monospace, Consolas, monospace";
    if (!pv || pv.len < 2) {
      ctx.fillStyle = dim;
      ctx.textAlign = "center";
      ctx.fillText(tx("等待数据流…", "waiting for data…"), SPARK_W / 2, SPARK_H / 2 + 3);
      ctx.textAlign = "left";
      return;
    }
    const CAP = plot3dStore.PREVIEW_CAP;
    const n = pv.len;
    const mr = pv.meanR > 1e-12 ? pv.meanR : 1;
    let sum = 0;
    let sum2 = 0;
    let maxDev = 0;
    let lastK = 1;
    for (let i = 0; i < n; i++) {
      const k = pv.r[(pv.head - n + CAP + i + CAP) % CAP] / mr;
      sum += k;
      sum2 += k * k;
      const d = Math.abs(k - 1);
      if (d > maxDev) maxDev = d;
      lastK = k;
    }
    const mean = sum / n;
    const cv = mean > 0 ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / mean : 0;
    // 纵窗至少 ±12%（保证 3%/8% 参考带可见），偏差爆表时自适应放大
    const band = Math.max(0.12, maxDev * 1.15);
    const padY = 3;
    const yOf = (k: number) => padY + ((1 + band - k) / (2 * band)) * (SPARK_H - 2 * padY);
    const bandRect = (k0: number, k1: number, fill: string) => {
      const lo = Math.max(k0, 1 - band);
      const hi = Math.min(k1, 1 + band);
      if (hi <= lo) return;
      ctx.fillStyle = fill;
      ctx.fillRect(0, yOf(hi), SPARK_W, yOf(lo) - yOf(hi));
    };
    bandRect(0.97, 1.03, "rgba(76,175,80,0.16)"); // ±3% 绿带（grade 优）
    bandRect(0.92, 0.97, "rgba(232,161,60,0.14)"); // 3–8% 黄带（grade 良）
    bandRect(1.03, 1.08, "rgba(232,161,60,0.14)");
    ctx.strokeStyle = dim; // 1.0 基线
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOf(1));
    ctx.lineTo(SPARK_W, yOf(1));
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 横轴 = 最近窗口实际时长（缓冲 t 自适应）；主线 accent，越界 ±8% 段红
    const i0 = (pv.head - n + CAP + CAP) % CAP;
    const t0 = pv.t[i0];
    const span = Math.max(pv.t[(pv.head - 1 + CAP) % CAP] - t0, 1e-6);
    const pt = (i: number): [number, number] => {
      const idx = (i0 + i) % CAP;
      return [(pv.t[idx] - t0) / span * (SPARK_W - 1), yOf(pv.r[idx] / mr)];
    };
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath(); // 越界段覆盖重绘
    let anyBad = false;
    for (let i = 1; i < n; i++) {
      const ka = pv.r[(i0 + i - 1) % CAP] / mr;
      const kb = pv.r[(i0 + i) % CAP] / mr;
      if (Math.abs(ka - 1) <= 0.08 && Math.abs(kb - 1) <= 0.08) continue;
      const a = pt(i - 1);
      const b = pt(i);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      anyBad = true;
    }
    if (anyBad) {
      ctx.strokeStyle = "#e5534b";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = dim; // 实时数字：当前偏差 + 窗口 CV
    ctx.textAlign = "right";
    ctx.fillText(
      `Δ ${((lastK - 1) * 100).toFixed(2)}% · CV ${(cv * 100).toFixed(2)}%`,
      SPARK_W - 4,
      SPARK_H - 4,
    );
    ctx.textAlign = "left";
  };
  useEffect(() => {
    if (!previewOn) return;
    const draw = () => {
      if (!fitStaleRef.current) drawSpark(); // 陈旧挂起：冻结最后一帧（灰显由 CSS 承担）
    };
    draw();
    const t = window.setInterval(draw, 100);
    return () => window.clearInterval(t);
  }, [previewOn]);

  // ---------- 加计六面（P73）：解算 / 复制 / 重置 ----------
  const a6Solve = () => {
    plot3dStore.accel6Solve(); // gRef=1：scale/gain 以「原始单位/g」计，offset 恒原始单位
    setA6(plot3dStore.accel6Snapshot()); // 结果（含拒绝原因）随快照回 UI
  };
  const a6ok = a6?.result && a6.result.ok ? a6.result : null;
  const copyAccel6C = () => {
    if (!a6ok) return;
    void navigator.clipboard?.writeText(
      `float acc_offset[3] = {${a6ok.offset.join(", ")}};\nfloat acc_gain[3] = {${a6ok.gains.join(", ")}};\n// a' = (a - offset) * gain ≈ 1g`,
    );
  };

  // ---------- 导出（P72 → P87a 逐组 → P87b 同源 store 层）：轨迹 CSV / 快照 PNG ----------
  const exportCsv = async (gid: GroupId) => {
    const g = plot3dStore.getGroup(gid);
    if (!g) return;
    // P87b：exportTriples 单点真相——与显示严格同源（配对 + **组变换**）
    const data = plot3dStore.exportTriples(gid);
    if (!data) return;
    const chans = plotRef.current.channels;
    const nameOf = (id: string) => chans.find((c) => c.id === id)?.name ?? id;
    const esc = (v: string | number) => {
      const str = String(v);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const zName = g.chZ ? nameOf(g.chZ) : "z0";
    const rows: string[] = [
      ["t_s", nameOf(g.chX), nameOf(g.chY), zName].map(esc).join(","),
    ];
    for (let i = 0; i < data.t.length; i++) {
      rows.push(
        `${data.t[i].toFixed(3)},${data.x[i]},${data.y[i]},${data.z[i]}`,
      );
    }
    if (rows.length <= 1) return; // 无轨迹点
    const path = await save({
      title: tx(`导出 ${g.name} 轨迹 CSV`, `Export ${g.name} trajectory CSV`),
      defaultPath: `trajectory-${g.name}-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.csv`,
      filters: [{ name: "CSV 文件", extensions: ["csv"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content: "\uFEFF" + rows.join("\r\n") });
      toast(tx(`已导出 ${rows.length - 1} 个点`, `Exported ${rows.length - 1} points`));
    } catch (e) {
      toast(tx(`轨迹 CSV 写盘失败：${String(e).slice(0, 80)}`, `Failed to write trajectory CSV: ${String(e).slice(0, 80)}`));
    }
  };

  /**
   * P87b：导入轨迹 CSV → 本组（虚拟通道）。列格式 t,x,y[,z]（t 为秒或毫秒，
   * 自动识别；首行非数值视为表头跳过）。t 平移对齐到当前时间原点（离线文件
   * 与在线流不共时钟——对齐形状不猜绝对时刻）。重复导入先回收本组旧虚拟通道。
   */
  const importCsvTo = async (gid: GroupId) => {
    if (opLocked) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv", "txt"] }],
    });
    if (typeof path !== "string") return;
    let text: string;
    try {
      text = await invoke<string>("read_text_file", { path });
    } catch (e) {
      toast(tx(`读取失败：${String(e).slice(0, 80)}`, `Read failed: ${String(e).slice(0, 80)}`));
      return;
    }
    const ts: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    let hasZ = false;
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line) continue;
      const cells = line.split(/[,;\t]/).map((c) => Number(c.trim()));
      if (cells.length < 3 || cells.slice(0, 3).some((v) => !isFinite(v))) continue;
      ts.push(cells[0]);
      xs.push(cells[1]);
      ys.push(cells[2]);
      if (cells.length >= 4 && isFinite(cells[3])) {
        hasZ = true;
        zs.push(cells[3]);
      } else {
        zs.push(0);
      }
    }
    if (ts.length < 2) {
      toast(tx("未解析到 ≥2 行数值数据（列格式：t,x,y[,z]，逗号/分号/Tab 分隔）", "Need ≥2 numeric rows (columns: t,x,y[,z])"));
      return;
    }
    const secScale = Math.abs(ts[ts.length - 1] - ts[0]) < 1e7 ? 1000 : 1;
    const base = plotStore.timeOrigin();
    const t0 = Math.min(...ts);
    const tsMs = ts.map((v) => base + (v - t0) * secScale);
    // 回收本组旧的虚拟绑定（导入过一次再导不堆垃圾通道）
    const g = plot3dStore.getGroup(gid);
    if (!g || !aliveRef.current || opLockedRef.current) return;
    const chans = plotRef.current.channels;
    for (const id of [g.chX, g.chY, g.chZ]) {
      const ch = id ? chans.find((c) => c.id === id) : null;
      if (ch?.virtual && !plot3dStore.getSnapshot().settings.groups.some((other) =>
        other.id !== gid && [other.chX, other.chY, other.chZ, other.colorCh,
          other.heading.chYaw, other.heading.qX, other.heading.qY, other.heading.qZ, other.heading.qW].includes(ch.id)))
        plotStore.removeChannel(ch.id);
    }
    const nm = (s: string) => `${g.name}·${s}`;
    const ix = plotStore.addVirtualChannel(nm("X"), tsMs, xs);
    const iy = plotStore.addVirtualChannel(nm("Y"), tsMs, ys);
    const iz = hasZ ? plotStore.addVirtualChannel(nm("Z"), tsMs, zs) : "";
    plot3dStore.updateGroup(gid, { chX: ix, chY: iy, chZ: iz });
    toast(
      tx(
        `已导入 ${tsMs.length} 点到 ${g.name}（虚拟通道，t 已平移对齐）`,
        `Imported ${tsMs.length} points into ${g.name} (virtual channels, t rebased)`,
      ),
    );
  };
  const exportPng = async () => {
    const scene = sceneRef.current;
    if (!scene) return;
    const url = scene.snapshotPng(); // 先同步渲染取像素，再弹对话框（await 后画布会被清）
    const path = await save({
      title: tx("快照 PNG", "Snapshot PNG"),
      defaultPath: `p3d-snapshot-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.png`,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (typeof path !== "string") return;
    try {
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await invoke("save_binary_file", { path, content: Array.from(arr) });
    } catch (e) {
      toast(tx(`快照写盘失败：${String(e).slice(0, 80)}`, `Failed to write snapshot: ${String(e).slice(0, 80)}`));
    }
  };

  const presets: { p: ViewPreset; zh: string; en: string; tipZh: string; tipEn: string }[] = [
    { p: "top", zh: "俯", en: "T", tipZh: "俯视：看航迹/路径平面形状", tipEn: "Top view: plan-form shape" },
    { p: "side", zh: "侧", en: "S", tipZh: "侧视", tipEn: "Side view" },
    { p: "front", zh: "正", en: "F", tipZh: "正视", tipEn: "Front view" },
    { p: "iso", zh: "等", en: "I", tipZh: "等轴：立体全貌（默认）", tipEn: "Isometric: full 3D view (default)" },
  ];

  const calibSrcG = s3d.calibSrc ? s3d.groups.find((g) => g.id === s3d.calibSrc) : undefined;
  const calibSrcMissing = !!s3d.calibSrc && !calibSrcG;
  const g1Bound = plot3dStore.calibSourceReady(); // P87e：按 calibSrc 判定（不再固定组1）
  const ascaleCur =
    s3d.axisScale === "perAxis" ? tx("逐轴归一化", "Per-axis") : tx("等比（真实比例）", "Uniform");

  const pointCount = (gid: GroupId) => (stats.groups[gid]?.tail ?? 0) + (stats.groups[gid]?.overview ?? 0);
  const totalPts = s3d.groups.reduce((n, g) => n + pointCount(g.id), 0);
  ptsRef.current = totalPts;
  const groupPtsLine = s3d.groups
    .filter((g) => pointCount(g.id) > 0 || (g.chX && g.chY))
    .map((g) => `${g.name} ${pointCount(g.id).toLocaleString()}`)
    .join(" · ");

  // P75 B2：配对诊断副行（P87a 主组 = 第一个绑齐且有消费的组；三轴值域 + 配对/跳过计数）
  const primaryGid = s3d.groups.find(
    (g) => g.chX && g.chY && ((pairInfo?.[g.id]?.paired ?? 0) + (pairInfo?.[g.id]?.skipped ?? 0)) > 0,
  )?.id;
  const fmtRange = (mn: number, mx: number) =>
    isFinite(mn) && isFinite(mx) ? `${fmtVal(mn)}~${fmtVal(mx)}` : "—";
  const pairLine = (() => {
    if (!primaryGid || !pairInfo) return null;
    const g = s3d.groups.find((x) => x.id === primaryGid);
    const pi = pairInfo[primaryGid];
    if (!g || !pi) return null;
    return [
      g.name,
      `X ${fmtRange(pi.min[0], pi.max[0])}`,
      `Y ${fmtRange(pi.min[1], pi.max[1])}`,
      `Z ${fmtRange(pi.min[2], pi.max[2])}`,
      tx(
        `配对 ${pi.paired.toLocaleString()} · 跳过 ${pi.skipped.toLocaleString()}`,
        `paired ${pi.paired.toLocaleString()} · skipped ${pi.skipped.toLocaleString()}`,
      ),
      g.pairMode === "union"
        ? tx("前向填充（旧版）", "forward-fill (legacy)")
        : g.pairTolMs > 0
          ? `±${g.pairTolMs}ms`
          : tx("自动容差", "auto tol"),
    ].join(" · ");
  })();

  // 时间条数据范围：P87a = 全部已绑组的原始序列末端最大值（未绑齐时回退联合轴末端）
  const endRel = (() => {
    const org = plotStore.timeOrigin();
    let end = -Infinity;
    for (const g of s3d.groups) {
      if (!g.chX || !g.chY) continue;
      for (const id of [g.chX, g.chY, g.chZ]) {
        if (!id) continue;
        const d = plotStore.getChanData(id);
        if (d.t.length > 0 && d.t[d.t.length - 1] > end) end = d.t[d.t.length - 1];
      }
    }
    if (isFinite(end)) return Math.max(0, (end - org) / 1000);
    const rawAll = plotStore.fullAlignedRaw();
    return rawAll.x.length > 0
      ? Math.max(0, (rawAll.x[rawAll.x.length - 1] - org) / 1000)
      : 0;
  })();
  endRelRef.current = endRel;

  useEffect(() => { sharedCursorRef.current(); }, [ready, endRel]);

  return (
    <div className="plot p3d" ref={rootRef} tabIndex={-1}>
      <div
        ref={hostRef}
        className={`p3d-host${measureMode ? " measuring" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
      >
        {/* P87a 组托盘（左上）：三行独立轨迹；通道与 2D 图例共享；拖 vs-field 落行=智能绑定 */}
        <div className="p3d-hud tl p3d-groups" ref={trayRef}>
          {s3d.groups.map((g) => {
            const bound = !!(g.chX && g.chY);
            return (
              <div
                key={g.id}
                className={`p3d-grp-row${g.visible ? "" : " off"}${bound ? "" : " unbound"}`}
                data-gid={g.id}
                title={tx(
                  `${g.name}：双击聚焦该组 · 右键更多操作 · 拖协议图例字段到本行绑定`,
                  `${g.name}: double-click to focus · right-click for more · drag a legend field onto this row to bind`,
                )}
                onDoubleClick={() => bound && sceneRef.current?.focusGroup(g.id)}
                onContextMenu={(e) => onRowContextMenu(e, g.id)}
              >
                <button
                  className={`p3d-grp-eye${g.visible ? " on" : ""}`}
                  onClick={() => plot3dStore.setGroupVisible(g.id, !g.visible)}
                  title={g.visible ? tx("隐藏此组", "Hide group") : tx("显示此组", "Show group")}
                >
                  {g.visible ? <IconEye /> : <IconEyeOff />}
                </button>
                <span className="p3d-grp-dot" style={{ background: g.color }} />
                <span className="p3d-grp-name">{g.name}</span>
                <span className="p3d-grp-mode">{modeLabel(g.mode)}</span>
                {(["x", "y", "z"] as const).map((ax) => {
                  const id = ax === "x" ? g.chX : ax === "y" ? g.chY : g.chZ;
                  return (
                    <select
                      key={ax}
                      className={`input p3d-grp-ax ax-${ax}${id ? " bound" : ""}`}
                      value={id}
                      disabled={plot.channels.length === 0 || opLocked}
                      title={`${ax.toUpperCase()} → ${id ? chanName(id) : tx("未绑定（可直接拖字段进来）", "unbound (drop a field here)")}${roTip}`}
                      onChange={(e) => plot3dStore.bindGroup(g.id, ax, e.target.value)}
                    >
                      <option value="">{ax.toUpperCase()}</option>
                      {plot.channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  );
                })}
                <button
                  className="p3d-grp-gear"
                  onClick={() => setDlg(g.id)}
                  title={tx(`组设置 ${g.name}${roTip}`, `Group settings ${g.name}${roTip}`)}
                >
                  <IconGear />
                </button>
                <button
                  className="p3d-grp-del"
                  disabled={opLocked}
                  onClick={() => void removeGroupUi(g.id)}
                  title={tx(`删除轨迹组 ${g.name}（配置可撤销；源通道保留）`, `Delete group ${g.name} (config undoable; source channels kept)`)}
                >
                  <IconTrash />
                </button>
              </div>
            );
          })}
          <button
            className="p3d-grp-add"
            disabled={opLocked}
            onClick={() => {
              const gid = plot3dStore.addGroup();
              if (gid) toast(tx("已新增轨迹组（一步撤销；拖字段到行上绑定）", "Group added (one undo step; drag fields onto its row to bind)"));
            }}
            title={tx("新增轨迹组：追加到列表尾，默认未绑定", "Add trajectory group: appended at the end, unbound by default")}
          >
            {fsvg(<path d="M12 5v14M5 12h14" />)} {tx("新增轨迹组", "Add group")}
          </button>
        </div>

        {/* 视角组（右上，P82② → P87a +撤销/重做）：毛玻璃胶囊——视角预设｜聚焦·跟随·自旋｜撤销重做｜校准·清空 */}
        <div className="p3d-hud tr p3d-tray">
          {presets.map((it) => (
            <button
              key={it.p}
              className="icon-btn"
              onClick={() => sceneRef.current?.setViewPreset(it.p)}
              title={tx(it.tipZh, it.tipEn)}
            >
              {it.p === "top" ? <IconViewTop /> : it.p === "side" ? <IconViewSide /> : it.p === "front" ? <IconViewFront /> : <IconViewIso />}
            </button>
          ))}
          <span className="p3d-tray-sep" />
          <button
            className="icon-btn"
            onClick={() => sceneRef.current?.resetView()}
            title={tx("重置视角", "Reset view")}
          >
            <IconRotate />
          </button>
          <button
            className="icon-btn"
            onClick={() => sceneRef.current?.focusLatest()}
            title={tx("聚焦最新点", "Focus latest point")}
          >
            <IconCrosshair />
          </button>
          <button
            className={`icon-btn${s3d.follow ? " primary" : ""}`}
            onClick={() => plot3dStore.setSetting({ follow: !s3d.follow })}
            title={tx(
              "跟随模式：视角平滑锁定最新点（与自动旋转互斥；开启时平移暂失效）",
              "Follow mode: camera smoothly locks onto the latest point (mutually exclusive with auto-rotate; panning disabled while on)",
            )}
          >
            <IconLock />
          </button>
          <button
            className={`icon-btn${s3d.autoRotate ? " primary" : ""}`}
            onClick={() => plot3dStore.setSetting({ autoRotate: !s3d.autoRotate })}
            title={tx("自动旋转：绕中心缓慢转动展示（与跟随互斥）", "Auto rotate: slow turntable showcase (exclusive with follow)")}
          >
            <IconAutoSpin />
          </button>
          <span className="p3d-tray-sep" />
          <button
            className="icon-btn"
            disabled={!p3d.canUndo || opLocked}
            onClick={doUndo}
            title={tx("撤销组配置 (Ctrl+Z)", "Undo group settings (Ctrl+Z)")}
          >
            <IconUndo />
          </button>
          <button
            className="icon-btn"
            disabled={!p3d.canRedo || opLocked}
            onClick={doRedo}
            title={tx("重做组配置 (Ctrl+Y)", "Redo group settings (Ctrl+Y)")}
          >
            <IconRedo />
          </button>
          <span className="p3d-tray-sep" />
          <button
            className="icon-btn"
            disabled={!recording || s3d.calibMode}
            onClick={() => {
              const stamp = new Date().toISOString().slice(11, 19);
              void sessionStore.annotate(`3D ${stamp}`);
              toast(tx("已打点（时间轴/2D/3D 旗标同步浮现）", "Marker placed (synced on timeline / 2D / 3D flags)"));
            }}
            title={
              recording
                ? tx("打点：在当前时刻记一条标注（需录制中）", "Drop a marker at current time (requires recording)")
                : tx("打点需要先在顶栏开始录制会话", "Marking requires an active recording session")
            }
          >
            <IconFlag />
          </button>
          <span className="p3d-tray-sep" />
          <button
            className={`icon-btn${s3d.calibMode ? " primary" : ""}`}
            disabled={!s3d.calibMode && (!g1Bound || !s3d.calibSrc)}
            onClick={() => (s3d.calibMode ? exitCalibMode() : plot3dStore.setSetting({ calibMode: true }))}
            title={
              !s3d.calibSrc
                ? tx("未选择校准源：在组行右键「设为校准源」", "No calibration source: right-click a group row → set as source")
                : calibSrcMissing
                  ? tx("校准源已被删除：请重新选择校准源", "Calibration source deleted — pick another source")
                  : tx(
                      "椭球校准模式：点云采样 + 九参数拟合（磁力计/加计）",
                      "Ellipsoid calibration: point-cloud sampling + 9-parameter fit (mag/acc)",
                    )
            }
          >
            <IconTarget />
          </button>
          <button
            className="icon-btn p3d-tray-danger"
            onClick={() => void clearGroupData()}
            title={tx(
              "清空全部轨迹组数据：历史清零、新数据从零画（校准采样不动；不可撤销）",
              "Clear all groups' trajectory data: drop history, new data from zero (calibration untouched; not undoable)",
            )}
          >
            <IconTrash />
          </button>
        </div>

        {/* 统计（右下）：按组点数 + 游标秒数 + 主组配对诊断副行 */}
        {ready && (
          <div className="p3d-hud br">
            {pairLine && (
              <div
                className="p3d-hud-sub"
                title={tx(
                  "三轴值域与时间戳配对情况（主组）：配对=成功生成轨迹点，跳过=容差外/无数据被丢弃（3D 不编造坐标）",
                  "Per-axis range and timestamp pairing (primary group): paired = points emitted, skipped = dropped (out-of-tolerance / no data)",
                )}
              >
                {pairLine}
              </div>
            )}
            {groupPtsLine || (totalPts > 0 ? totalPts.toLocaleString() : "")}
            {settings.perfHud && totalPts > 0 ? ` · ${stats.fps} FPS` : ""}
            {stats.gridStep > 0 && isFinite(stats.gridStep) && (
              <span title={tx("网格步长（真实单位/格）＝比例尺", "grid step (real units per cell) = scale")}>
                {" "}
                · {tx("格", "grid")} {fmtVal(stats.gridStep)}
              </span>
            )}
            <span ref={tbTRef} />
          </div>
        )}

        {/* 测量气泡（左下）——校准模式下让位给校准 HUD */}
        {(measureMode || measureInfo) && !s3d.calibMode && (
          <div className="p3d-hud bl">
            <div className="p3d-measure">
              <div className="p3d-measure-head">
                <b>{tx("测距", "Measure")}</b>
                <button
                  className="p3d-mclose"
                  onClick={exitMeasure}
                  title={tx("清除测量并退出测距模式（Esc）", "Clear measurement and exit (Esc)")}
                >
                  <IconClose />
                </button>
              </div>
              <div className="p3d-measure-row">
                <span className="p3d-mtag" style={{ color: MEASURE_COLOR }}>A</span>
                {measureInfo ? (
                  <span>
                    {fmtVal(measureInfo.a.real[0])}, {fmtVal(measureInfo.a.real[1])},{" "}
                    {fmtVal(measureInfo.a.real[2])}
                  </span>
                ) : (
                  <i>{tx("点击轨迹放置 A", "Click the trajectory to place A")}</i>
                )}
              </div>
              <div className="p3d-measure-row">
                <span className="p3d-mtag" style={{ color: MEASURE_COLOR }}>B</span>
                {measureInfo?.b ? (
                  <span>
                    {fmtVal(measureInfo.b.real[0])}, {fmtVal(measureInfo.b.real[1])},{" "}
                    {fmtVal(measureInfo.b.real[2])}
                  </span>
                ) : (
                  <i>
                    {measureInfo
                      ? tx("点击轨迹放置 B", "Click the trajectory to place B")
                      : tx("长按或菜单进入测距模式", "Long-press or use the menu to start measuring")}
                  </i>
                )}
              </div>
              {measureInfo?.b && (
                <div className="p3d-measure-dt">
                  Δ ={" "}
                  {fmtVal(
                    Math.hypot(
                      measureInfo.a.real[0] - measureInfo.b.real[0],
                      measureInfo.a.real[1] - measureInfo.b.real[1],
                      measureInfo.a.real[2] - measureInfo.b.real[2],
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 校准 HUD（左下，P71/P73）：子页（椭球拟合 | 六面向导）+ 采样 + 拟合 + 预览/对比 */}
        {s3d.calibMode && (
          <div className="p3d-hud bl">
            <div className={`p3d-calib${fitStale ? " stale" : ""}`}>
              <div className="p3d-measure-head">
                <b>
                  {tx("椭球校准", "Calibration")}{" "}
                  <span className="p3d-calib-src">
                    {(() => {
                      const src = plot3dStore.getGroup(s3d.calibSrc ?? "");
                      const label = src
                        ? tx(`采样源：${src.name}`, `source: ${src.name}`)
                        : s3d.calibSrc
                          ? tx("采样源：（已删除）", "source: (deleted)")
                          : tx("采样源：未选择", "source: none");
                      return (
                        <select
                          className="input p3d-calib-srcsel"
                          aria-label={label}
                          disabled={opLocked}
                          value={s3d.calibSrc ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === (s3d.calibSrc ?? "")) return;
                            if (v) void setCalibSrcUi(v);
                            else void switchCalibSrcUiNone();
                          }}
                          title={tx(
                            "校准采样源（显式选择；切换清空采样/拟合/预览临时态）",
                            "Calibration sampling source (switching clears samples/fit/preview)",
                          )}
                        >
                          <option value="">{tx("未选择（校准禁用）", "none (calibration off)")}</option>
                          {s3d.groups.map((opt) => (
                            <option key={opt.id} value={opt.id}>{opt.name}</option>
                          ))}
                          {s3d.calibSrc && !s3d.groups.some((o) => o.id === s3d.calibSrc) && (
                            <option value={s3d.calibSrc}>{tx("（已删除）", "(deleted)")}</option>
                          )}
                        </select>
                      );
                    })()}
                  </span>
                </b>
                <button
                  className="p3d-mclose"
                  onClick={exitCalibMode}
                  title={tx("退出校准模式（回到轨迹）", "Exit calibration (back to trajectory)")}
                >
                  <IconClose />
                </button>
              </div>
              <div className="p3d-calib-tabs">
                <button
                  className={calibTab === "ellipsoid" ? "on" : ""}
                  onClick={() => void switchCalibTab("ellipsoid")}
                  title={tx(
                    "连续翻滚采样 + 九参数椭球拟合（磁力计/加计通用）",
                    "Continuous tumble sampling + 9-param ellipsoid fit (mag/acc)",
                  )}
                >
                  {tx("椭球拟合（磁/加通用）", "Ellipsoid (mag/acc)")}
                </button>
                <button
                  className={calibTab === "six" ? "on" : ""}
                  onClick={() => void switchCalibTab("six")}
                  title={tx(
                    "六面静止采样分步向导（加计专用，切换清空椭球采样）",
                    "Step-by-step six-face wizard (acc only; switching clears ellipsoid samples)",
                  )}
                >
                  {tx("六面向导（加计专用）", "Six-face wizard (acc)")}
                </button>
              </div>

              {calibTab === "ellipsoid" ? (
                <>
                  <div className="p3d-calib-hint">
                    {tx(
                      "缓慢翻滚传感器覆盖全空间（画 8 字），点云越接近球面越好",
                      "Slowly tumble the sensor to cover all directions (figure-8); the closer the cloud is to a sphere, the better",
                    )}
                  </div>
                  <div className="p3d-calib-row">
                    <button
                      className={`p3d-cbtn${calibUi.capturing ? " stop" : ""}`}
                      disabled={!g1Bound && !calibUi.capturing}
                      onClick={() =>
                        calibUi.capturing
                          ? plot3dStore.stopCalibCapture()
                          : plot3dStore.startCalibCapture()
                      }
                    >
                      {calibUi.capturing ? tx("停止采样", "Stop capture") : tx("开始采样", "Start capture")}
                    </button>
                    <span className="p3d-calib-count">
                      {calibUi.count.toLocaleString()} / {plot3dStore.CALIB_CAP.toLocaleString()}
                    </span>
                  </div>
                  <div className="p3d-calib-row">
                    <span>
                      {tx("象限覆盖", "Octant coverage")} {calibUi.coverage}/8
                    </span>
                    {calibUi.count >= plot3dStore.CALIB_CAP && (
                      <span className="p3d-calib-warn">{tx("已达上限，自动停止", "Cap reached — auto-stopped")}</span>
                    )}
                  </div>
                  <div className="p3d-calib-row">
                    <button className="p3d-cbtn" disabled={!g1Bound || calibUi.count < 500} onClick={doFit}>
                      {tx("拟合椭球", "Fit ellipsoid")}
                    </button>
                    {!fit && calibUi.count < 500 && (
                      <i className="p3d-calib-dim">{tx("至少采样 500 点", "min 500 points")}</i>
                    )}
                  </div>
                  {fitErr && <div className="p3d-calib-err">{fitErr}</div>}
                  {fit && (
                    <>
                      <div className="p3d-calib-sec">
                        {tx("拟合结果", "Fit result")}
                        {fitStale && (
                          <span className="p3d-calib-stale">{tx("（基于旧采样）", " (stale samples)")}</span>
                        )}
                      </div>
                      <div className="p3d-calib-grid">
                        <span>offset</span>
                        <span className="p3d-calib-mono">[{fit.offset.map((v) => fmtVal(v)).join(", ")}]</span>
                        <span>gains</span>
                        <span className="p3d-calib-mono">[{fit.gains.map((v) => v.toFixed(4)).join(", ")}]</span>
                        <span>W</span>
                        <span className="p3d-calib-mono">
                          {fit.matrix.map((row, i) => (
                            <span key={i}>
                              [{row.map((v) => v.toFixed(4)).join(", ")}]
                              {i < 2 && <br />}
                            </span>
                          ))}
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <span>
                          CV {(fit.cv * 100).toFixed(2)}%（{grade(fit.cv)}）
                        </span>
                        <span>
                          RMS {(fit.rms * 100).toFixed(2)}% · {fit.n.toLocaleString()} {tx("点", "pts")}
                        </span>
                      </div>
                      {/* P73：补偿预览 toggle + 校正前后显示切换（无 fit 禁用） */}
                      <div className="p3d-calib-row">
                        <button
                          className={`p3d-cbtn${previewOn ? " on" : ""}`}
                          onClick={() => setPreviewOn((v) => !v)}
                          title={tx(
                            "实时显示校正后幅值 r=|W·(x−offset)|：贴平 1.0 线 = 校准有效",
                            "Live corrected radius r=|W·(x−offset)|: flat around 1.0 = calibration works",
                          )}
                        >
                          {previewOn ? tx("关闭预览", "Hide preview") : tx("补偿预览", "Comp. preview")}
                        </button>
                        <div className="p3d-seg" role="group" aria-label={tx("点云显示模式", "Point-cloud display")}>
                          <span className="p3d-seg-l">{tx("显示", "Show")}</span>
                          <button
                            className={calibDisp === "raw" ? "on" : ""}
                            disabled={!fit}
                            onClick={() => switchCalibDisp("raw")}
                            title={tx("原始点云 + 椭球线框 + 残差着色", "Raw cloud + ellipsoid + residual colors")}
                          >
                            {tx("原始", "Raw")}
                          </button>
                          <button
                            className={calibDisp === "corrected" ? "on" : ""}
                            disabled={!fit}
                            onClick={() => switchCalibDisp("corrected")}
                            title={tx("校正后点云（应收缩为均匀球壳）+ 参考球", "Corrected cloud (should shrink to a uniform shell) + reference sphere")}
                          >
                            {tx("校正后", "Corrected")}
                          </button>
                        </div>
                      </div>
                      {previewOn && (
                        <div className={`p3d-spark${fitStale ? " stale" : ""}`}>
                          <canvas ref={sparkRef} width={SPARK_W * 2} height={SPARK_H * 2} />
                          {fitStale && (
                            <span className="p3d-spark-susp">
                              {tx("已挂起 · 重新拟合后恢复", "suspended · re-fit to resume")}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="p3d-calib-row">
                        <button className="p3d-cbtn" onClick={copyCalibJson}>
                          {tx("复制 JSON", "Copy JSON")}
                        </button>
                        <button className="p3d-cbtn" onClick={copyCalibC}>
                          {tx("复制 C 数组", "Copy C array")}
                        </button>
                        <button className="p3d-cbtn" onClick={clearCalibAll}>
                          {tx("清空重来", "Clear & restart")}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="p3d-calib-hint">
                    {tx(
                      "每面朝上静置，点「采集该面」自动采 2 秒；六面齐后计算参数",
                      "Rest each face up and capture (2 s auto); solve after all six faces",
                    )}
                  </div>
                  <div className="p3d-a6-list">
                    {A6_FACES.map((f, i) => {
                      const face = a6?.faces[i] ?? null;
                      const col = !!a6?.collecting && a6.idx === i;
                      const dom = i >> 1; // 该面的主轴下标（+X/−X → 轴 0 …）
                      return (
                        <div key={i} className={`p3d-a6-row${col ? " run" : ""}`}>
                          <span className={`p3d-a6-ico${face ? " ok" : col ? " run" : ""}`}>
                            {face ? <IconCheck /> : col ? <IconPlay /> : <IconCircle />}
                          </span>
                          <span className="p3d-a6-lbl">{tx(f.zh, f.en)}</span>
                          {face ? (
                            <span className="p3d-a6-stat" title={tx("主轴均值 ± 标准差（原始单位）", "Dominant-axis mean ± std (raw units)")}>
                              μ {fmtVal(face.mean[dom])} · σ {fmtVal(face.std[dom])}
                            </span>
                          ) : col ? (
                            <span className="p3d-a6-stat run">
                              {tx("采集中", "capturing")}{" "}
                              {(a6StartRef.current > 0
                                ? Math.min(
                                    plot3dStore.ACCEL6_WINDOW_MS / 1000,
                                    (performance.now() - a6StartRef.current) / 1000,
                                  )
                                : 0
                              ).toFixed(1)}
                              s
                            </span>
                          ) : null}
                          <button
                            className={`p3d-cbtn${col ? " stop" : ""}`}
                            disabled={!g1Bound && !col}
                            onClick={() => (col ? plot3dStore.accel6Abort() : plot3dStore.accel6StartFace(i))}
                          >
                            {col ? tx("中止", "Abort") : face ? tx("重采", "Redo") : tx("采集该面", "Capture")}
                          </button>
                        </div>
                      );
                    })}
                  {a6?.stalled && (
                    <div className="p3d-calib-err">
                      {tx(
                        "数据流中断：连续 4 秒未收到样本，本轮采集已作废。恢复数据流后重试。",
                        "Data stream stalled: no sample for 4 s; this capture was discarded. Restore the stream and retry.",
                      )}
                    </div>
                  )}
                  </div>
                  <div className="p3d-calib-row">
                    <button
                      className="p3d-cbtn"
                      disabled={!g1Bound || !a6 || a6.faces.some((f) => f === null)}
                      onClick={a6Solve}
                    >
                      {tx("计算参数", "Solve")}
                    </button>
                    {a6 && !a6.result && (
                      <i className="p3d-calib-dim">{tx("六面齐后可用", "needs all six faces")}</i>
                    )}
                  </div>
                  {a6?.result && !a6.result.ok && <div className="p3d-calib-err">{fitErrText(a6.result)}</div>}
                  {a6ok && (
                    <>
                      <div className="p3d-calib-sec">{tx("六面结果", "Six-face result")}</div>
                      <div className="p3d-calib-grid">
                        <span>offset</span>
                        <span className="p3d-calib-mono">[{a6ok.offset.map((v) => fmtVal(v)).join(", ")}]</span>
                        <span>gain</span>
                        <span className="p3d-calib-mono">[{a6ok.gains.map((v) => v.toFixed(4)).join(", ")}]</span>
                        <span>scale</span>
                        <span className="p3d-calib-mono">
                          [{a6ok.scales.map((v) => fmtVal(v)).join(", ")}] {tx("原始单位/g", "raw/g")}
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <span title={tx("三轴尺度一致性，>2% 提示装配/对齐问题", "Scale consistency; >2% hints assembly/misalignment")}>
                          CV {(a6ok.cvScale * 100).toFixed(2)}%（{a6ok.grade}）
                        </span>
                        <span title={tx("各面校正后非主轴分量占比最大值（对齐/正交性指示）", "Max off-axis ratio after correction (alignment/orthogonality indicator)")}>
                          {tx("面偏差", "Face dev")} {(a6ok.faceDev * 100).toFixed(2)}%
                        </span>
                      </div>
                      <div className="p3d-calib-row">
                        <button className="p3d-cbtn" onClick={copyAccel6C}>
                          {tx("复制 C 数组", "Copy C array")}
                        </button>
                        <button className="p3d-cbtn" onClick={() => plot3dStore.accel6Reset()}>
                          {tx("清空重来", "Clear & restart")}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 空态引导卡（P96-K1）：与底部诊断条**同源**——只有 stage=start（还没开始画）才居中给引导。
            旧实现中央卡看 anyBound（只查 X/Y）、底部条看 whyEmpty（还查 Z/数据/游标），两条件不等价
            ⇒ 未绑齐时两张卡同时出现、说的是同一句话。 */}
        {ready && diag && diagStage(diag.code) === "start" && (
          <div className="p3d-guide" role="status">
            <div className="p3d-guide-t">{tx("还没有轨迹", "No trajectory yet")}</div>
            <div className="p3d-guide-d">{diag.text}</div>
            <ol className="p3d-guide-steps">
              <li>{tx("在 2D 曲线图例或帧画布里点亮通道（3D 与它们共用同一批通道）", "Enable a channel in the 2D legend or frame canvas — 3D shares the same channels")}</li>
              <li>{tx("把字段拖到左上的组行 X / Y（Z 可留空 = 平面轨迹）", "Drag a field onto a group row's X / Y (Z optional = planar)")}</li>
              <li>{tx("或点「选通道」，在组设置里直接挑", "…or pick channels in group settings")}</li>
            </ol>
            <div className="p3d-guide-ops">
              {diag.action && (
                <button className="btn sm primary" onClick={() => runRemedy(diag)}>
                  {tx(...REMEDY_LABEL[diag.action])}
                </button>
              )}
              <button className="btn sm" onClick={() => requestOpenPanel("plot2d")}>
                {tx("打开 2D 曲线", "Open 2D plot")}
              </button>
            </div>
          </div>
        )}

        {/* 底部时间条（P70 T2）：非回放拖动 = scrub 查看历史；回放中拖动 = 真时间机器 seek；
            双击 = 回到最新。有数据才显示。P74c B5：校准模式下轨迹层已隐藏，
            拖动没有任何视觉因果 → 直接禁用并说明原因（指针事件一起摘掉）。 */}
        {ready && endRel > 0 && (
          <div
            className={`p3d-timebar${s3d.calibMode ? " off" : ""}`}
            aria-disabled={s3d.calibMode || undefined}
            title={
              s3d.calibMode
                ? tx("校准模式下时间游标不适用（轨迹层已隐藏）；退出校准即可拖动", "The time cursor does not apply in calibration mode (trajectory hidden)")
                : undefined
            }
            onPointerDown={onTbPointerDown}
            onPointerMove={onTbPointerMove}
            onPointerUp={onTbPointerUp}
            onPointerCancel={onTbPointerCancel}
            onDoubleClick={onTbDoubleClick}
          >
            <span className="p3d-tb-lbl">0s</span>
            <div className="p3d-tb-track" ref={tbTrackRef}>
              <div className="p3d-tb-fill" ref={tbFillRef} />
              {annRels.map((r, k) => {
                const pct = endRel > 0 ? Math.min(100, Math.max(0, (r / endRel) * 100)) : 0;
                return (
                  <i
                    key={k}
                    className="p3d-tb-ann"
                    style={{ left: `${pct}%` }}
                    title={tx(`${fmtTickSec(r)} 标注`, `marker ${fmtTickSec(r)}`)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      void navigateTime(timeCursor.fromDisplaySeconds(r, plotStore.timeOrigin()), "annotation");
                    }}
                  />
                );
              })}
              <div className="p3d-tb-cursor" ref={tbCurRef} />
              <div className="p3d-tb-bubble" ref={tbBubbleRef} />
            </div>
            <span className="p3d-tb-lbl">{fmtTickSec(endRel)}</span>
            {/* C14：三态标识。scrub 残留此前唯一的线索是右下角一行小字，
                极易误判为「采集停了」；回放 seek 与 scrub 也无从区分 */}
            {(() => {
              const sess = sessionStore.getSnapshot().state;
              if (sess === "playing" || sess === "paused") {
                return <span className="p3d-tb-badge">{tx("回放 seek", "replay seek")}</span>;
              }
              if (!s3d.calibMode && plot3dStore.lastCursorSec() !== null) {
                return (
                  <button
                    className="p3d-tb-badge on"
                    onClick={clearScrub}
                    title={tx(
                      "历史模式：轨迹停在拖动点，新数据继续在后台积累；点击回到最新",
                      "History mode: trajectory parked at the dragged spot; new data keeps accumulating. Click to jump to latest",
                    )}
                  >
                    {tx("历史模式 · 回最新", "history · to latest")}
                  </button>
                );
              }
              return null;
            })()}
          </div>
        )}

        {/* 底部一行条：只给"已经在画但被挡住"的态（stage=blocked），与中央引导卡互斥 */}
        {ready && diag && diagStage(diag.code) === "blocked" && (
          <div className="p3d-empty" role="status">
            <span className="p3d-empty-text">{diag.text}</span>
            {diag.action && (
              <span className="p3d-empty-ops">
                <button className="p3d-cbtn" onClick={() => runRemedy(diag)}>
                  {tx(...REMEDY_LABEL[diag.action])}
                </button>
              </span>
            )}
          </div>
        )}

        <div ref={tipRef} className="p3d-tip" />
      </div>

      {/* 组设置弹层（P87a） */}
      {dlg && (
        <GroupDialog
          key={dlg}
          gid={dlg}
          channels={plot.channels}
          opLocked={opLocked}
          roTip={roTip}
          onClose={() => setDlg(null)}
        />
      )}

      {/* 右键菜单：画布态（组/模式/视图/测量/数据/设置） + 组行态（快捷操作） */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="ctx-menu"
            style={{
              left: menuPos?.left ?? -9999,
              top: menuPos?.top ?? -9999,
              visibility: menuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.kind === "row" && menu.gid ? (
              (() => {
                const g = s3d.groups.find((x) => x.id === menu.gid);
                if (!g) return <div className="ctx-title">{tx("该组已删除", "Group deleted")}</div>;
                const bound = !!(g.chX && g.chY);
                return (
                  <>
                    <div className="ctx-title">
                      {tx("组", "Group")} {g.name}
                    </div>
                    {opLocked && (
                      <div className="ctx-lock">
                        <IconLock />
                        {tx("Operator 只读：设置已锁定", "Operator read-only: settings locked")}
                      </div>
                    )}
                    <button className="ctx-item" onClick={closeAnd(() => setDlg(g.id))}>
                      {tx("组设置…", "Group settings…")}
                    </button>
                    <button
                      className="ctx-item"
                      onClick={closeAnd(() => plot3dStore.setGroupVisible(g.id, !g.visible))}
                    >
                      {g.visible ? <IconEye /> : <IconEyeOff />}{" "}
                      {g.visible ? tx("隐藏此组", "Hide group") : tx("显示此组", "Show group")}
                    </button>
                    <button
                      className="ctx-item"
                      disabled={!bound}
                      onClick={closeAnd(() => sceneRef.current?.focusGroup(g.id))}
                    >
                      {tx("聚焦此组", "Focus group")}
                    </button>
                    <button
                      className="ctx-item"
                      disabled={!bound}
                      onClick={closeAnd(() => void exportCsv(g.id))}
                    >
                      {tx("导出本组 CSV", "Export CSV")}
                    </button>
                    <button
                      className="ctx-item"
                      disabled={opLocked}
                      title={tx(
                        "导入轨迹 CSV（列 t,x,y[,z]）→ 本组虚拟通道；重复导入替换旧通道",
                        "Import trajectory CSV (t,x,y[,z]) → this group's virtual channels; re-import replaces",
                      )}
                      onClick={closeAnd(() => void importCsvTo(g.id))}
                    >
                      {tx("导入轨迹 CSV → 本组", "Import CSV → group")}
                    </button>
                    <button
                      className="ctx-item"
                      disabled={opLocked || s3d.calibSrc === g.id}
                      title={s3d.calibSrc === g.id ? tx("当前已是校准源", "Already the calibration source") : tx(
                        "设为校准采样源（切换会清空校准采样/拟合/预览/六面临时态）",
                        "Set as calibration source (switching clears calibration samples/fit/preview/six-face temp state)",
                      )}
                      onClick={closeAnd(() => void setCalibSrcUi(g.id))}
                    >
                      {s3d.calibSrc === g.id ? <IconDot /> : <IconCircle />} {tx("设为校准源", "Set as calibration source")}
                    </button>
                    <button
                      className="ctx-item danger"
                      disabled={opLocked}
                      onClick={closeAnd(() => void removeGroupUi(g.id))}
                    >
                      <IconTrash /> {tx("删除组…（源通道保留，可撤销）", "Delete group… (channels kept, undoable)")}
                    </button>
                    <button
                      className="ctx-item danger"
                      onClick={closeAnd(() => void clearGroupData(g.id))}
                    >
                      {tx("清空本组数据（不可撤销）", "Clear data (not undoable)")}
                    </button>
                  </>
                );
              })()
            ) : (
              <>
                <div className="ctx-title">{tx("3D 轨迹", "3D Trajectory")}</div>
                {opLocked && (
                  <div className="ctx-lock" title={tx("Operator 只读模式：设置项已锁定，视角/测量/校准仍可用", "Operator read-only: settings locked; view, measure and calibration remain available")}>
                    <IconLock />
                    {tx("Operator 只读：设置已锁定", "Operator read-only: settings locked")}
                  </div>
                )}

                <div className="ctx-group">{tx("组", "Groups")}</div>
                {s3d.groups.map((g) => {
                  const bound = !!(g.chX && g.chY);
                  return (
                    <button key={g.id} className="ctx-item" onClick={closeAnd(() => setDlg(g.id))}>
                      <span className="p3d-mi-dot" style={{ background: g.color }} />
                      {g.name}
                      <span className="ctx-cur">
                        {bound ? modeLabel(g.mode) : tx("未绑齐", "unbound")}
                      </span>
                    </button>
                  );
                })}

                <div className="ctx-group">{tx("模式", "Mode")}</div>
                <button
                  className="ctx-item"
                  disabled={!s3d.calibMode && (!g1Bound || !s3d.calibSrc)}
                  title={
                    !s3d.calibSrc
                      ? tx("未选择校准源：在组行右键「设为校准源」", "No calibration source — right-click a group row → set as source")
                      : calibSrcMissing
                        ? tx("所选校准源已被删除：请重新选择", "Selected calibration source was deleted — pick another")
                        : !g1Bound
                          ? tx("校准源需绑定 X / Y / Z 三轴", "Bind the source group's X / Y / Z axes first")
                          : undefined
                  }
                  onClick={closeAnd(() => (s3d.calibMode ? exitCalibMode() : plot3dStore.setSetting({ calibMode: true })))}
                >
                  {s3d.calibMode ? <IconDot /> : <IconCircle />}{" "}
                  {s3d.calibMode
                    ? tx("退出椭球校准模式", "Exit ellipsoid calibration")
                    : tx(
                        `椭球校准模式（采样源：${calibSrcG?.name ?? (calibSrcMissing ? tx("已删除", "deleted") : tx("未选择", "none"))}）`,
                        `Ellipsoid calibration (source: ${calibSrcG?.name ?? (calibSrcMissing ? "deleted" : "none")})`,
                      )}
                </button>

                <div className="ctx-group">{tx("视图", "View")}</div>
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("top"))}>
                  {tx("俯视", "Top view")}
                </button>
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("side"))}>
                  {tx("侧视", "Side view")}
                </button>
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("front"))}>
                  {tx("正视", "Front view")}
                </button>
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.setViewPreset("iso"))}>
                  {tx("等轴", "Isometric")}
                </button>
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.resetView())}>
                  {tx("重置视角", "Reset view")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ autoRotate: !s3d.autoRotate }))}
                >
                  {s3d.autoRotate ? <IconDot /> : <IconCircle />} {tx("自动旋转", "Auto rotate")}
                </button>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => plot3dStore.setSetting({ follow: !s3d.follow }))}
                >
                  {s3d.follow ? <IconDot /> : <IconCircle />} {tx("跟随模式（锁定最新点）", "Follow mode (lock to latest point)")}
                </button>
                <button
                  className="ctx-item"
                  disabled={opLocked}
                  title={opLocked ? tx("键盘飞行", "Keyboard flight") + roTip : undefined}
                  onClick={closeAnd(() => plot3dStore.setSetting({ keyFlight: !s3d.keyFlight }))}
                >
                  {s3d.keyFlight ? <IconDot /> : <IconCircle />} {tx("键盘飞行（WASD/QE/方向键，悬停生效）", "Keyboard flight (WASD/QE/arrows, while hovered)")}
                </button>
                <button
                  className="ctx-item"
                  disabled={opLocked}
                  title={opLocked ? tx("缩放到光标", "Zoom to cursor") + roTip : undefined}
                  onClick={closeAnd(() => plot3dStore.setSetting({ zoomToCursor: !s3d.zoomToCursor }))}
                >
                  {s3d.zoomToCursor ? <IconDot /> : <IconCircle />} {tx("缩放到光标", "Zoom to cursor")}
                </button>
                <button
                  className="ctx-item"
                  disabled={opLocked}
                  title={opLocked ? tx("网格与坐标轴", "Grid & axes") + roTip : undefined}
                  onClick={closeAnd(() => plot3dStore.setSetting({ showGrid: !s3d.showGrid }))}
                >
                  {s3d.showGrid ? <IconDot /> : <IconCircle />} {tx("网格与坐标轴", "Grid & axes")}
                </button>
                {s3d.showGrid &&
                  (
                    [
                      ["coarse", tx("网格：疏（步长×2）", "Grid: coarse (step ×2)")],
                      ["std", tx("网格：标准（自适应）", "Grid: standard (auto)")],
                      ["fine", tx("网格：密（步长×0.5）", "Grid: fine (step ×0.5)")],
                    ] as const
                  ).map(([v, lab]) => (
                    <button
                      key={v}
                      className="ctx-item"
                      disabled={opLocked}
                      onClick={closeAnd(() => plot3dStore.setSetting({ gridDensity: v }))}
                    >
                      {s3d.gridDensity === v ? <IconDot /> : <IconCircle />} {lab}
                    </button>
                  ))}
                <button className="ctx-item" onClick={closeAnd(() => sceneRef.current?.focusLatest())}>
                  {tx("聚焦最新点", "Focus latest point")}
                </button>

                <div className="ctx-group">{tx("测量", "Measure")}</div>
                <button
                  className="ctx-item"
                  onClick={closeAnd(() => (measureModeRef.current ? exitMeasure() : enterMeasure()))}
                >
                  {measureMode ? <IconDot /> : <IconCircle />} {tx("测距模式（同长按）", "Measure mode (same as long-press)")}
                </button>
                <button
                  className="ctx-item"
                  disabled={!measureInfo}
                  onClick={closeAnd(() => sceneRef.current?.setMeasure(null, null))}
                >
                  {tx("清除测量", "Clear measurement")}
                </button>

                <div className="ctx-group">{tx("数据", "Data")}</div>
                <button className="ctx-item" disabled={!hoverRef.current} onClick={closeAnd(copyHover)}>
                  {tx("复制悬停点坐标", "Copy hovered point")}
                </button>
                {s3d.groups.map((g) => (
                  <button
                    key={g.id}
                    className="ctx-item"
                    disabled={!(g.chX && g.chY)}
                    onClick={closeAnd(() => void exportCsv(g.id))}
                  >
                    <span className="p3d-mi-dot" style={{ background: g.color }} />
                    {tx(`导出 ${g.name} CSV`, `Export ${g.name} CSV`)}
                  </button>
                ))}
                <button className="ctx-item" onClick={closeAnd(() => window.dispatchEvent(new Event("vs-analysis-export")))}>
                  {tx("分析包…", "Analysis package…")}
                </button>
                <button className="ctx-item" onClick={closeAnd(() => void exportPng())}>
                  {tx("快照 PNG", "Snapshot PNG")}
                </button>
                <button
                  className="ctx-item"
                  disabled={endRel <= 0}
                  onClick={closeAnd(() => clearScrub())}
                >
                  {tx("回到最新（清除时间游标）", "Back to latest (clear time cursor)")}
                </button>
                <button
                  className="ctx-item"
                  disabled={!p3d.canUndo || opLocked}
                  onClick={closeAnd(doUndo)}
                >
                  {tx("撤销组配置（Ctrl+Z）", "Undo group settings (Ctrl+Z)")}
                </button>
                <button
                  className="ctx-item"
                  disabled={!p3d.canRedo || opLocked}
                  onClick={closeAnd(doRedo)}
                >
                  {tx("重做组配置（Ctrl+Y）", "Redo group settings (Ctrl+Y)")}
                </button>
                <button
                  className="ctx-item danger"
                  onClick={closeAnd(() => void clearGroupData())}
                >
                  {tx("清空全部轨迹数据（不可撤销）", "Clear all trajectory data (not undoable)")}
                </button>

                <div className="ctx-group">{tx("设置", "Settings")}</div>
                <div
                  ref={ascaleRowRef}
                  className={`ctx-row${opLocked ? " dis" : ""}`}
                  onMouseEnter={() => {
                    if (opLocked) return;
                    disarmSub();
                    setSub("ascale");
                  }}
                  onMouseLeave={() => {
                    if (!subPinned) armSub();
                  }}
                  onClick={() => {
                    if (opLocked) return;
                    setSub((s) => (s === "ascale" ? null : "ascale"));
                    setSubPinned(sub !== "ascale");
                    disarmSub();
                  }}
                >
                  <button className="ctx-item" disabled={opLocked}>
                    <span className="ctx-item-l">
                      {tx("三轴缩放", "Axis scaling")}{" "}
                      <span className="ctx-arrow">
                        <IconChevron size={12} />
                      </span>
                    </span>
                    <span className="ctx-cur">{ascaleCur}</span>
                  </button>
                </div>
                <button className="ctx-item" disabled={opLocked} onClick={closeAnd(() => plot3dStore.resetSettings())}>
                  {tx("恢复默认（可撤销）", "Reset to defaults (undoable)")}
                </button>
                <div className="fc-dlg-hint p3d-mi-note">
                  {tx("组级显示设置（模式/平滑/着色/密度/配对）已移入组行设置弹层", "per-group display settings now live in the group dialog")}
                </div>

                {/* 三轴缩放子菜单（P75 B2）：等比=真实比例；逐轴=各轴独立撑满（扁平数据查看） */}
                {sub === "ascale" && (
                  <Flyout anchor={ascaleRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={220}>
                    <button
                      className="ctx-item"
                      onClick={closeAnd(() => plot3dStore.setSetting({ axisScale: "uniform" }))}
                      title={tx(
                        "三轴同一比例尺：反映真实几何形状（默认）",
                        "One scale for all axes: true geometry (default)",
                      )}
                    >
                      {s3d.axisScale === "uniform" ? <IconDot /> : <IconCircle />}{" "}
                      {tx("等比（真实比例）", "Uniform (true scale)")}
                    </button>
                    <button
                      className="ctx-item"
                      onClick={closeAnd(() => plot3dStore.setSetting({ axisScale: "perAxis" }))}
                      title={tx(
                        "各轴独立归一化撑满视锥：查看扁平/量级悬殊的数据",
                        "Normalize each axis to fill the view: for flat / mixed-magnitude data",
                      )}
                    >
                      {s3d.axisScale === "perAxis" ? <IconDot /> : <IconCircle />}{" "}
                      {tx("逐轴归一化", "Per-axis normalize")}
                    </button>
                  </Flyout>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
