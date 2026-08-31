import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import * as plotStore from "./plotStore";
import { useSettings } from "../settings/settingsStore";
import { Flyout } from "../../shared/Flyout";
import { IconChevron } from "../../shared/icons";

function fmtVal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

function hexA(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

type PathsFactory = NonNullable<uPlot.Series["paths"]>;

/** 喂给 uPlot 的每通道显示点数上限（min/max 抽稀），与缓冲上限解耦，控制重绘成本 */
const FED_CAP = 16000;

const LINE_PATHS: Record<string, PathsFactory> = {
  linear: uPlot.paths.linear!() as PathsFactory,
  step: uPlot.paths.stepped!({ align: 1 }) as PathsFactory,
  smooth: uPlot.paths.spline!() as PathsFactory,
};

/** 游标测量：按时间在通道数据上线性插值取值 */
function interpAt(
  d: { t: number[]; v: number[] },
  t: number,
): number | null {
  if (!d.t.length) return null;
  if (t <= d.t[0]) return d.v[0];
  if (t >= d.t[d.t.length - 1]) return d.v[d.t.length - 1];
  let lo = 0;
  let hi = d.t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = d.t[lo];
  const t1 = d.t[hi];
  const v0 = d.v[lo];
  const v1 = d.v[hi];
  if (t1 === t0) return v0;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

export function Plot2D() {
  const settings = useSettings();
  const zf = (settings.zoom || 100) / 100;
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const followXRef = useRef(true);
  const panRef = useRef<
    | null
    | {
        x0: number;
        y0: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        moved: boolean;
      }
  >(null);
  const boxRef = useRef<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const cleanupRefs = useRef<(() => void)[][]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<null | "x" | "y">(null);
  const [subPinned, setSubPinned] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const xRowRef = useRef<HTMLDivElement | null>(null);
  const yRowRef = useRef<HTMLDivElement | null>(null);
  const subTimer = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const [followState, setFollowState] = useState(true);
  const fedXRef = useRef<number[]>([]);
  const yManualRef = useRef(false);
  const affineRef = useRef<({ a: number; b: number } | null)[]>([]);
  const stackMetaRef = useRef<
    { name: string; color: string; lo: number; hi: number }[]
  >([]);
  const cursorRef = useRef<{ a: number | null; b: number | null }>({
    a: null,
    b: null,
  });
  const activeCursorRef = useRef<null | "a" | "b">(null);
  const yCurInitRef = useRef(false);
  const [backlog, setBacklog] = useState(0);
  const [measure, setMeasure] = useState<{
    dt: string;
    rows: {
      name: string;
      color: string;
      v1: number | null;
      v2: number | null;
      dv: number | null;
    }[];
  } | null>(null);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const settingsRef = useRef(plot.settings);
  settingsRef.current = plot.settings;

  const setFollow = (v: boolean) => {
    followXRef.current = v;
    setFollowState(v);
  };

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
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    let left = Math.max(8, Math.min(menu.x / zf, vw - w - 8));
    let top = menu.y / zf;
    if (top + h > vh - 8) {
      top = Math.max(8, vh - h - 8);
    }
    setMenuPos({ left, top });
  }, [menu, zf]);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const chart = chartRef.current;
    if (!wrap || !chart) return;
    const channels = plot.channels;
    const settings = plot.settings;
    if (uRef.current) {
      uRef.current.destroy();
      uRef.current = null;
    }
    if (channels.length === 0) return;
    setFollow(true);

    const cs = getComputedStyle(document.documentElement);
    const axisColor = cs.getPropertyValue("--text-dim").trim() || "#8b93a1";
    const gridColor = cs.getPropertyValue("--border-soft").trim() || "#1d2229";
    const accent = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    const dimColor = axisColor;

    const opts: uPlot.Options = {
      width: Math.max(wrap.clientWidth, 80),
      height: Math.max(wrap.clientHeight, 60),
      cursor: {
        drag: { x: false, y: false },
        points: { size: 4 },
      },
      legend: { show: true, live: true },
      scales: {
        x: { time: settings.xSource === "time", auto: false },
        ...(settings.stack
          ? { y: { auto: false, range: (): [number, number] => [0, 1] } }
          : {}),
      },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: settings.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          labelSize: 0,
          font: '10px "Cascadia Mono", Consolas, monospace',
          values:
            settings.xSource === "time"
              ? undefined
              : (_u, splits) =>
                  splits.map((v) =>
                    Number.isInteger(v) ? String(v) : v.toFixed(2),
                  ),
        },
        {
          stroke: axisColor,
          grid: { stroke: settings.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          font: '10px "Cascadia Mono", Consolas, monospace',
          values: (_u, splits) =>
            settings.stack ? [] : splits.map((v) => fmtVal(v)),
        },
      ],
      series: [
        {},
        ...channels.map((ch) => ({
          label: ch.name,
          stroke: ch.color,
          width: settings.plotMode === "points" ? 0 : settings.lineWidth,
          show: ch.visible,
          spanGaps: true,
          paths:
            settings.stack && settings.lineStyle === "smooth"
              ? LINE_PATHS.linear
              : LINE_PATHS[settings.lineStyle],
          points: { show: settings.plotMode === "points", size: 3 },
          value: (_u: uPlot, v: number | null) => fmtVal(v),
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const xs = fedXRef.current;
            const sx = u.scales.x;
            /** 本帧已放置的徽标矩形，用于防重叠（A/B/最新 挤在一起时自动换行） */
            const badgeRects: { x: number; y: number; w: number; h: number }[] = [];
            /** 顶部/底部徽标标签（填充色块 + 白字），保证游标一眼可见 */
            const drawBadge = (
              px: number,
              py: number,
              label: string,
              color: string,
              side: "l" | "r" | "tr",
            ) => {
              ctx.save();
              ctx.font = 'bold 11px "Segoe UI", sans-serif';
              const tw = ctx.measureText(label).width;
              const bw = tw + 10;
              let bx: number;
              let by = py;
              if (side === "tr") {
                bx = px + 6 + bw > u.bbox.left + u.bbox.width ? px - 6 - bw : px + 6;
              } else {
                bx = side === "l" ? px + 6 : px - 6 - bw;
                if (bx < u.bbox.left + 2) bx = u.bbox.left + 2;
                if (bx + bw > u.bbox.left + u.bbox.width - 2)
                  bx = u.bbox.left + u.bbox.width - 2 - bw;
              }
              // 防重叠：与已放置徽标碰撞则下移一行（最多 3 行）
              for (let row = 0; row < 3; row++) {
                const cand = { x: bx, y: by, w: bw, h: 16 };
                const clash = badgeRects.some(
                  (r) =>
                    cand.x < r.x + r.w + 4 &&
                    r.x < cand.x + cand.w + 4 &&
                    cand.y < r.y + r.h + 2 &&
                    r.y < cand.y + cand.h + 2,
                );
                if (!clash) break;
                by += 18;
              }
              badgeRects.push({ x: bx, y: by, w: bw, h: 16 });
              ctx.fillStyle = color;
              ctx.fillRect(bx, by - 8, bw, 16);
              ctx.fillStyle = "#fff";
              ctx.textAlign = "left";
              ctx.fillText(label, bx + 5, by + 4);
              ctx.restore();
            };
            /** 竖直参考线（游标/最新线）：2px 实线 + 上下三角旗标 + 徽标；越界时画边缘指示箭头 */
            const drawV = (
              val: number,
              color: string,
              dash: boolean,
              label: string,
            ) => {
              if (!Number.isFinite(val)) return;
              if (sx.min == null || sx.max == null || sx.max === sx.min) return;
              const frac = (val - sx.min) / (sx.max - sx.min);
              if (frac < -0.02 || frac > 1.02) {
                // 视野外：贴边画指示箭头，提示游标在可见区间之外
                const ex =
                  frac < 0 ? u.bbox.left : u.bbox.left + u.bbox.width;
                const dir = frac < 0 ? 1 : -1;
                ctx.save();
                ctx.fillStyle = hexA(color, 0.9);
                ctx.beginPath();
                ctx.moveTo(ex, u.bbox.top + 8);
                ctx.lineTo(ex + dir * 8, u.bbox.top + 15);
                ctx.lineTo(ex, u.bbox.top + 22);
                ctx.closePath();
                ctx.fill();
                ctx.font = 'bold 10px "Segoe UI", sans-serif';
                ctx.fillStyle = color;
                ctx.textAlign = frac < 0 ? "left" : "right";
                ctx.fillText(
                  label,
                  frac < 0 ? ex + 11 : ex - 11,
                  u.bbox.top + 19,
                );
                ctx.restore();
                return;
              }
              const px = u.bbox.left + frac * u.bbox.width;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = dash ? 1 : 2;
              if (dash) ctx.setLineDash([5, 4]);
              ctx.beginPath();
              ctx.moveTo(px, u.bbox.top);
              ctx.lineTo(px, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.setLineDash([]);
              if (!dash) {
                // 上下两端三角旗标
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(px - 5, u.bbox.top);
                ctx.lineTo(px + 5, u.bbox.top);
                ctx.lineTo(px, u.bbox.top + 7);
                ctx.closePath();
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(px - 5, u.bbox.top + u.bbox.height);
                ctx.lineTo(px + 5, u.bbox.top + u.bbox.height);
                ctx.lineTo(px, u.bbox.top + u.bbox.height - 7);
                ctx.closePath();
                ctx.fill();
              }
              ctx.restore();
              drawBadge(px, u.bbox.top + 12, label, color, "tr");
            };
            /** 水平游标（Y 轴测量）：2px 横线 + 左右三角旗标 + 徽标；越界时画边缘指示 */
            const drawH = (val: number, color: string, label: string) => {
              const sy = u.scales.y;
              if (
                !Number.isFinite(val) ||
                sy.min == null ||
                sy.max == null ||
                sy.max === sy.min
              )
                return;
              const frac = (sy.max - val) / (sy.max - sy.min);
              if (frac < -0.02 || frac > 1.02) {
                const ey =
                  frac < 0 ? u.bbox.top : u.bbox.top + u.bbox.height;
                const dir = frac < 0 ? 1 : -1;
                ctx.save();
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(u.bbox.left + 8, ey);
                ctx.lineTo(u.bbox.left + 15, ey + dir * 8);
                ctx.lineTo(u.bbox.left + 22, ey);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
                return;
              }
              const py = u.bbox.top + frac * u.bbox.height;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, py);
              ctx.lineTo(u.bbox.left + u.bbox.width, py);
              ctx.stroke();
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, py - 5);
              ctx.lineTo(u.bbox.left, py + 5);
              ctx.lineTo(u.bbox.left + 7, py);
              ctx.closePath();
              ctx.fill();
              ctx.beginPath();
              ctx.moveTo(u.bbox.left + u.bbox.width, py - 5);
              ctx.lineTo(u.bbox.left + u.bbox.width, py + 5);
              ctx.lineTo(u.bbox.left + u.bbox.width - 7, py);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
              drawBadge(
                u.bbox.left + u.bbox.width,
                py - 10 < u.bbox.top + 8 ? py + 12 : py - 10,
                label,
                color,
                "r",
              );
            };
            if (xs.length > 0) {
              drawV(xs[0], dimColor, true, "起");
              drawV(xs[xs.length - 1], accent, false, "最新");
            }
            const st = settingsRef.current;
            if (st.stack) {
              const K = Math.max(1, stackMetaRef.current.length);
              ctx.save();
              ctx.strokeStyle = gridColor;
              ctx.setLineDash([2, 3]);
              for (let i = 1; i < K; i++) {
                const py = u.bbox.top + (1 - i / K) * u.bbox.height;
                ctx.beginPath();
                ctx.moveTo(u.bbox.left, py);
                ctx.lineTo(u.bbox.left + u.bbox.width, py);
                ctx.stroke();
              }
              ctx.setLineDash([]);
              stackMetaRef.current.forEach((m, i) => {
                const py =
                  u.bbox.top + (1 - (i + 0.5) / K) * u.bbox.height;
                ctx.fillStyle = m.color;
                ctx.font = '10px "Segoe UI", sans-serif';
                ctx.textAlign = "left";
                ctx.fillText(
                  `${m.name}  [${fmtVal(m.lo)} ~ ${fmtVal(m.hi)}]`,
                  u.bbox.left + 6,
                  py - 4,
                );
              });
              ctx.restore();
            }
            if (st.cursors) {
              const cur = cursorRef.current;
              (["a", "b"] as const).forEach((k) => {
                const tv = cur[k];
                if (tv == null) return;
                const color = k === "a" ? "#18b893" : "#e8a13c";
                if (st.cursorMode === "y") drawH(tv, color, k.toUpperCase());
                else drawV(tv, color, false, k.toUpperCase());
              });
            }
            const box = boxRef.current;
            if (box) {
              const r = u.over.getBoundingClientRect();
              const cv = u.ctx.canvas;
              const kx = cv.width / Math.max(1, r.width);
              const ky = cv.height / Math.max(1, r.height);
              const l = (Math.min(box.x0, box.x1) - r.left) * kx;
              const t = (Math.min(box.y0, box.y1) - r.top) * ky;
              const w = Math.abs(box.x1 - box.x0) * kx;
              const h = Math.abs(box.y1 - box.y0) * ky;
              ctx.save();
              ctx.fillStyle = hexA(accent, 0.12);
              ctx.strokeStyle = accent;
              ctx.lineWidth = 1;
              ctx.fillRect(l, t, w, h);
              ctx.strokeRect(l, t, w, h);
              ctx.restore();
            }
          },
        ],
        ready: [
          (u) => {
            const removers: (() => void)[] = [];
            const overRect = () => u.over.getBoundingClientRect();
            const zoomX = (clientX: number, k: number) => {
              const sx = u.scales.x;
              const min = sx.min ?? 0;
              const max = sx.max ?? 1;
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
              const t = min + frac * (max - min);
              u.setScale("x", {
                min: t - (t - min) * k,
                max: t + (max - t) * k,
              });
              setFollow(false);
            };
            const zoomY = (clientY: number, k: number) => {
              const sy = u.scales.y;
              // Y 范围未就绪时跳过（否则会围绕 [0,1] 伪范围缩放并锁死 Y 手动态）
              if (sy.min == null || sy.max == null) return;
              let min = sy.min;
              let max = sy.max;
              if (min === max) {
                min -= 1;
                max += 1;
              }
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
              const v = max - frac * (max - min);
              u.setScale("y", {
                min: v - (v - min) * k,
                max: v + (max - v) * k,
              });
              yManualRef.current = true;
            };
            u.root.addEventListener("dblclick", () => {
              // 双击 = 保形回实时：保持当前 X 窗宽与 Y 范围不变，仅把窗口平移到最新数据
              setFollow(true);
              const xs = fedXRef.current;
              if (xs.length) {
                const sx = u.scales.x;
                const span = Math.max(
                  (sx.max ?? 0) - (sx.min ?? 0),
                  settingsRef.current.xSource === "time" ? 10 : 200,
                );
                const last = xs[xs.length - 1];
                u.setScale("x", {
                  min: last - span * 0.95,
                  max: last + span * 0.05,
                });
              }
            });
            u.root.addEventListener(
              "wheel",
              (e) => {
                e.preventDefault();
                const rect = u.over.getBoundingClientRect();
                const inYZone =
                  e.clientX < rect.left &&
                  e.clientY >= rect.top &&
                  e.clientY <= rect.bottom;
                const inXZone =
                  e.clientY > rect.bottom &&
                  e.clientX >= rect.left &&
                  e.clientX <= rect.right;
                const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
                const k = Math.exp(dy * 0.0012);
                if (inYZone) {
                  // Y 轴区滚轮：只缩 Y
                  zoomY(e.clientY, k);
                } else if (inXZone) {
                  // X 轴区滚轮：只缩 X
                  zoomX(e.clientX, k);
                } else {
                  // 图区滚轮：X/Y 等比缩放，围绕鼠标位置（地图式缩放手感）
                  zoomX(e.clientX, k);
                  zoomY(e.clientY, k);
                }
              },
              { passive: false },
            );
            const onDown = (e: MouseEvent) => {
              const r = overRect();
              if (
                e.clientX < r.left ||
                e.clientX > r.right ||
                e.clientY < r.top ||
                e.clientY > r.bottom
              )
                return;
              if (e.button === 0 && settingsRef.current.cursors) {
                const cur = cursorRef.current;
                const isY = settingsRef.current.cursorMode === "y";
                const sy = u.scales.y;
                const pickY = (v: number | null) => {
                  if (
                    v == null ||
                    sy.min == null ||
                    sy.max == null ||
                    sy.max === sy.min
                  )
                    return Infinity;
                  const py =
                    r.top + ((sy.max - v) / (sy.max - sy.min)) * r.height;
                  // 钳制到绘图区内：游标越界贴边时（边缘指示箭头处）也能抓到
                  const cy = Math.min(r.bottom - 2, Math.max(r.top + 2, py));
                  return Math.abs(e.clientY - cy);
                };
                const pickX = (t: number | null) => {
                  if (t == null) return Infinity;
                  const sx = u.scales.x;
                  if (sx.min == null || sx.max == null) return Infinity;
                  const px =
                    r.left + ((t - sx.min) / (sx.max - sx.min)) * r.width;
                  const cx = Math.min(r.right - 2, Math.max(r.left + 2, px));
                  return Math.abs(e.clientX - cx);
                };
                const da = isY ? pickY(cur.a) : pickX(cur.a);
                const db = isY ? pickY(cur.b) : pickX(cur.b);
                if (Math.min(da, db) <= 32) {
                  activeCursorRef.current = da <= db ? "a" : "b";
                  e.preventDefault();
                  return;
                }
              }
              if (e.button === 0) {
                const sx = u.scales.x;
                const sy = u.scales.y;
                panRef.current = {
                  x0: e.clientX,
                  y0: e.clientY,
                  minX: sx.min ?? 0,
                  maxX: sx.max ?? 1,
                  minY: sy.min ?? 0,
                  maxY: sy.max ?? 1,
                  moved: false,
                };
                e.preventDefault();
              } else if (e.button === 1 && !settingsRef.current.cursors) {
                boxRef.current = {
                  x0: e.clientX,
                  y0: e.clientY,
                  x1: e.clientX,
                  y1: e.clientY,
                };
                e.preventDefault();
              }
            };
            const onMove = (e: MouseEvent) => {
              // 卡死保护：按键全部松开但 mouseup 丢失（如在窗口外释放）→ 复位拖拽状态
              if (e.buttons === 0) {
                if (panRef.current || boxRef.current || activeCursorRef.current) {
                  panRef.current = null;
                  boxRef.current = null;
                  activeCursorRef.current = null;
                }
              }
              if (activeCursorRef.current) {
                const r = overRect();
                const isY = settingsRef.current.cursorMode === "y";
                if (isY) {
                  const sy = u.scales.y;
                  if (sy.min != null && sy.max != null) {
                    const v = u.posToVal(e.clientY - r.top, "y");
                    cursorRef.current = {
                      ...cursorRef.current,
                      [activeCursorRef.current]: v,
                    };
                    u.redraw();
                  }
                } else {
                  const sx = u.scales.x;
                  if (sx.min != null && sx.max != null) {
                    const t = u.posToVal(e.clientX - r.left, "x");
                    cursorRef.current = {
                      ...cursorRef.current,
                      [activeCursorRef.current]: t,
                    };
                    u.redraw();
                  }
                }
                return;
              }
              if (panRef.current) {
                const p = panRef.current;
                if (
                  !p.moved &&
                  Math.abs(e.clientX - p.x0) + Math.abs(e.clientY - p.y0) < 4
                )
                  return;
                if (!p.moved) {
                  p.moved = true;
                  setFollow(false);
                }
                const r = overRect();
                const dvx = ((e.clientX - p.x0) / r.width) * (p.maxX - p.minX);
                const dvy = ((e.clientY - p.y0) / r.height) * (p.maxY - p.minY);
                u.setScale("x", { min: p.minX - dvx, max: p.maxX - dvx });
                u.setScale("y", { min: p.minY + dvy, max: p.maxY + dvy });
                if (dvy !== 0) yManualRef.current = true;
              }
              if (boxRef.current) {
                const b = boxRef.current;
                b.x1 = e.clientX;
                b.y1 = e.clientY;
                u.redraw();
              }
            };
            // 空闲态：鼠标靠近游标线时给出可拖拽光标反馈
            const nearCursor = (e: MouseEvent) => {
              if (panRef.current || boxRef.current || activeCursorRef.current)
                return;
              if (!settingsRef.current.cursors) return;
              const r = overRect();
              const sx = u.scales.x;
              const sy = u.scales.y;
              const cur = cursorRef.current;
              const isY = settingsRef.current.cursorMode === "y";
              const clamp = (v: number, lo: number, hi: number) =>
                Math.min(hi, Math.max(lo, v));
              let near = false;
              const yMin = sy.min;
              const yMax = sy.max;
              const xMin = sx.min;
              const xMax = sx.max;
              if (isY && yMin != null && yMax != null && yMax > yMin) {
                const py = (v: number | null) =>
                  v == null
                    ? Infinity
                    : clamp(
                        r.top + ((yMax - v) / (yMax - yMin)) * r.height,
                        r.top,
                        r.bottom,
                      );
                near =
                  Math.min(
                    Math.abs(e.clientY - py(cur.a)),
                    Math.abs(e.clientY - py(cur.b)),
                  ) <= 10;
              } else if (
                !isY &&
                xMin != null &&
                xMax != null &&
                xMax > xMin
              ) {
                const px = (t: number | null) =>
                  t == null
                    ? Infinity
                    : clamp(
                        r.left + ((t - xMin) / (xMax - xMin)) * r.width,
                        r.left,
                        r.right,
                      );
                near =
                  Math.min(
                    Math.abs(e.clientX - px(cur.a)),
                    Math.abs(e.clientX - px(cur.b)),
                  ) <= 10;
              }
              u.over.style.cursor = near ? (isY ? "ns-resize" : "ew-resize") : "";
            };
            const onUp = (e: MouseEvent) => {
              if (activeCursorRef.current && e.button === 0) {
                activeCursorRef.current = null;
                return;
              }
              if (panRef.current && e.button === 0) {
                const p = panRef.current;
                panRef.current = null;
                // 单击（无拖动）+ 游标开启 + 有空缺标尺 → 在该位置铺设（先 A 后 B）
                if (!p.moved && settingsRef.current.cursors) {
                  const cur = cursorRef.current;
                  if (cur.a == null || cur.b == null) {
                    const r = overRect();
                    const isY = settingsRef.current.cursorMode === "y";
                    const sy = u.scales.y;
                    const sx = u.scales.x;
                    if (
                      isY &&
                      sy.min != null &&
                      sy.max != null &&
                      e.clientY >= r.top &&
                      e.clientY <= r.bottom
                    ) {
                      const v = u.posToVal(e.clientY - r.top, "y");
                      cursorRef.current =
                        cur.a == null ? { ...cur, a: v } : { ...cur, b: v };
                    } else if (
                      !isY &&
                      sx.min != null &&
                      sx.max != null &&
                      e.clientX >= r.left &&
                      e.clientX <= r.right
                    ) {
                      const t = u.posToVal(e.clientX - r.left, "x");
                      cursorRef.current =
                        cur.a == null ? { ...cur, a: t } : { ...cur, b: t };
                    } else {
                      return;
                    }
                    u.redraw();
                    return;
                  }
                }
              }
              if (boxRef.current && e.button === 1) {
                const b = boxRef.current;
                boxRef.current = null;
                const r = overRect();
                const l = Math.min(b.x0, b.x1) - r.left;
                const rr = Math.max(b.x0, b.x1) - r.left;
                const t = Math.min(b.y0, b.y1) - r.top;
                const bt = Math.max(b.y0, b.y1) - r.top;
                if (rr - l > 6) {
                  u.setScale("x", {
                    min: u.posToVal(l, "x"),
                    max: u.posToVal(rr, "x"),
                  });
                  setFollow(false);
                }
                if (bt - t > 6 && rr - l > 6) {
                  u.setScale("y", {
                    min: u.posToVal(t, "y"),
                    max: u.posToVal(bt, "y"),
                  });
                  yManualRef.current = true;
                }
                u.redraw();
              }
            };
            const onCtx = (e: MouseEvent) => {
              e.preventDefault();
              setMenuPos(null);
              setSub(null);
              setSubPinned(false);
              setMenu({ x: e.clientX, y: e.clientY });
            };
            u.over.addEventListener("mousedown", onDown);
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mousemove", nearCursor);
            window.addEventListener("mouseup", onUp);
            u.root.addEventListener("contextmenu", onCtx);
            removers.push(() => {
              u.over.removeEventListener("mousedown", onDown);
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mousemove", nearCursor);
              window.removeEventListener("mouseup", onUp);
              u.root.removeEventListener("contextmenu", onCtx);
            });
            cleanupRefs.current.push(removers);
          },
        ],
      },
    };

    const aligned = plotStore.buildAligned(FED_CAP);
    const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
    fedXRef.current = aligned.x;
    const u = new uPlot(opts, data, chart);
    uRef.current = u;
    setFollow(true);
    yManualRef.current = false;
    affineRef.current = channels.map(() => null);
    stackMetaRef.current = [];
    if (settings.cursors) {
      if (settings.cursorMode === "y") {
        // Y 范围可能尚未就绪（自动范围在首个 tick 计算），延迟到 tick 初始化
        cursorRef.current = { a: null, b: null };
        yCurInitRef.current = false;
      } else {
        const sx = u.scales.x;
        const lo = sx.min ?? 0;
        const hi = sx.max ?? 1;
        cursorRef.current = { a: lo + (hi - lo) * 0.35, b: lo + (hi - lo) * 0.65 };
      }
    } else {
      cursorRef.current = { a: null, b: null };
    }

    const ro = new ResizeObserver(() => {
      u.setSize({
        width: Math.max(wrap.clientWidth, 80),
        height: Math.max(wrap.clientHeight, 60),
      });
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      while (cleanupRefs.current.length) {
        const arr = cleanupRefs.current.pop();
        arr?.forEach((f) => f());
      }
      u.destroy();
      uRef.current = null;
    };
  }, [plot.channels, plot.settings, themeTick]);

  useEffect(() => {
    const timer = setInterval(() => {
      const u = uRef.current;
      const wrap = wrapRef.current;
      // 面板不可见（宽度为 0，如 dock 标签未激活）时才跳过；
      // 不用 IntersectionObserver——CSS zoom 下其判定不稳定，会把可见面板误判为
      // 不可见，导致数据停更、跟最新按钮"无反应"
      if (!u || !wrap || wrap.clientWidth === 0 || !plotStore.isDirty()) return;
      plotStore.clearDirty();
      const settings = plotStore.getSnapshot().settings;
      const aligned = plotStore.buildAligned(FED_CAP);
      const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
      const snap = plotStore.getSnapshot();
      // 堆叠：先原地仿射变换再 setData —— 只触发一次重绘（旧实现 setData→变换→setScale 三次全量重绘）
      if (settings.stack) {
        const vis = snap.channels
          .map((ch, i) => ({ ch, i }))
          .filter((x) => x.ch.visible);
        const K = Math.max(1, vis.length);
        affineRef.current = snap.channels.map(() => null);
        stackMetaRef.current = vis.map((x) => ({
          name: x.ch.name,
          color: x.ch.color,
          lo: 0,
          hi: 0,
        }));
        vis.forEach((x, slot) => {
          const ys = data[x.i + 1] as (number | null)[];
          let mn = Infinity;
          let mx = -Infinity;
          for (const v of ys) {
            if (v !== null && v !== undefined) {
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
          }
          if (!Number.isFinite(mn)) {
            mn = 0;
            mx = 1;
          }
          const pad = ((mx - mn) || Math.abs(mx) || 1) * 0.1;
          const lo = mn - pad;
          const hi = mx + pad;
          const a = 0.76 / (K * (hi - lo));
          const b = (slot + 0.5) / K - 0.38 / K - a * lo;
          for (let j = 0; j < ys.length; j++) {
            const v = ys[j];
            ys[j] = v === null ? null : a * v + b;
          }
          affineRef.current[x.i] = { a, b };
          stackMetaRef.current[slot] = {
            name: x.ch.name,
            color: x.ch.color,
            lo: mn,
            hi: mx,
          };
        });
      }
      fedXRef.current = aligned.x;
      u.setData(data, false);
      if (panRef.current || boxRef.current) return;
      if (!settings.stack && !yManualRef.current) {
        // Y 自适应只统计当前视野内的点（示波器行为）：
        // 全量统计会让历史极值把 Y 拉爆，滚轮缩放到历史区后波形被压成占满面板
        const xLo = u.scales.x.min;
        const xHi = u.scales.x.max;
        const inView = (j: number) =>
          (xLo == null || (data[0] as number[])[j] >= xLo) &&
          (xHi == null || (data[0] as number[])[j] <= xHi);
        if (settings.yMode === "zero") {
          let m = 0;
          plotStore.getSnapshot().channels.forEach((ch, i) => {
            if (!ch.visible) return;
            const ys = data[i + 1] as (number | null)[];
            for (let j = 0; j < ys.length; j++) {
              const v = ys[j];
              if (v !== null && inView(j) && Math.abs(v) > m) m = Math.abs(v);
            }
          });
          if (m > 0) u.setScale("y", { min: -m * 1.15, max: m * 1.15 });
        } else {
          let mn = Infinity;
          let mx = -Infinity;
          plotStore.getSnapshot().channels.forEach((ch, i) => {
            if (!ch.visible) return;
            const ys = data[i + 1] as (number | null)[];
            for (let j = 0; j < ys.length; j++) {
              const v = ys[j];
              if (v !== null && v !== undefined && inView(j)) {
                if (v < mn) mn = v;
                if (v > mx) mx = v;
              }
            }
          });
          if (mn !== Infinity) {
            const pad = ((mx - mn) || Math.abs(mx) || 1) * 0.1;
            u.setScale("y", { min: mn - pad, max: mx + pad });
          }
        }
      }
      const xs = data[0];
      const last = xs.length ? xs[xs.length - 1] : 0;
      const sx = u.scales.x;
      const span = Math.max(
        (sx.max ?? 0) - (sx.min ?? 0),
        settings.xSource === "time" ? 10 : 200,
      );
      // 浏览态积压：视野右边界之外的新点数量，提示用户回到跟随
      let bl = 0;
      if (sx.max != null) {
        for (let i = xs.length - 1; i >= 0 && xs[i] > sx.max; i--) bl++;
      }
      setBacklog(bl);
      // Y 游标延迟初始化：等 Y 自动范围就绪后按比例落位
      if (
        settings.cursors &&
        settings.cursorMode === "y" &&
        !yCurInitRef.current
      ) {
        const sy = u.scales.y;
        if (sy.min != null && sy.max != null && sy.max > sy.min) {
          cursorRef.current = {
            a: sy.min + (sy.max - sy.min) * 0.35,
            b: sy.min + (sy.max - sy.min) * 0.65,
          };
          yCurInitRef.current = true;
        }
      }
      if (settings.cursors) {
        const cur = cursorRef.current;
        if (cur.a != null && cur.b != null) {
          if (settings.cursorMode === "y") {
            // Y 轴游标：直接测两横线间的 ΔV
            setMeasure({
              dt: fmtVal((cur.b as number) - (cur.a as number)),
              rows: [],
            });
          } else {
          // 在喂给图表的对齐数据上插值：游标存的是 X 轴坐标值（随 xSource 变化），
          // 与 data[0] 同一坐标系；旧实现对原始毫秒时间戳插值导致测量恒钳在首点
          const rows = snap.channels
            .map((ch, i) => ({
              name: ch.name,
              color: ch.color,
              fed: { t: xs as number[], v: data[i + 1] as number[] },
            }))
            .filter((x) => x.fed.t.length > 0)
            .map((x) => {
              const v1 = interpAt(x.fed, cur.a as number);
              const v2 = interpAt(x.fed, cur.b as number);
              return {
                name: x.name,
                color: x.color,
                v1,
                v2,
                dv: v1 != null && v2 != null ? v2 - v1 : null,
              };
            });
          const dSpan = (cur.b as number) - (cur.a as number);
          setMeasure({
            dt:
              settings.xSource === "time"
                ? `${(dSpan * 1000).toFixed(1)} ms`
                : `${dSpan.toFixed(1)} 格`,
            rows,
          });
          }
        } else {
          setMeasure(null);
        }
      } else {
        setMeasure(null);
      }
      if (followXRef.current && xs.length > 1) {
        // 跟随态：X 游标按窗口比例"骑行"，保持相对位置不变
        const cur = cursorRef.current;
        let fa: number | null = null;
        let fb: number | null = null;
        if (
          settings.cursors &&
          settings.cursorMode !== "y" &&
          sx.min != null &&
          sx.max != null &&
          sx.max > sx.min
        ) {
          const s0 = sx.max - sx.min;
          if (cur.a != null) fa = (cur.a - sx.min) / s0;
          if (cur.b != null) fb = (cur.b - sx.min) / s0;
        }
        // 保持总 span 恒定：min/max 之和恰为 span，避免每 tick 5% 复利放大
        u.setScale("x", {
          min: last - span * 0.95,
          max: last + span * 0.05,
        });
        if (fa != null || fb != null) {
          const nmin = last - span * 0.95;
          cursorRef.current = {
            a: fa != null ? nmin + fa * span : cur.a,
            b: fb != null ? nmin + fb * span : cur.b,
          };
          u.redraw();
        }
      } else {
        // 浏览态显式重绘：uPlot 的 setData(data,false) 只更新数据引用、不触发绘制
        // （源码：仅 resetScales!==false 分支才 commit），而 yManual 时又跳过了
        // 唯一的 setScale("y")，导致拖动/缩放后新点永远不上屏（须双击/滚轮才刷新）
        u.redraw();
      }
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, [plot.channels]);

  const autoY = () => {
    const u = uRef.current;
    if (!u) return;
    let min = Infinity;
    let max = -Infinity;
    u.series.forEach((s, i) => {
      if (i === 0 || !s.show) return;
      const ys = u.data[i] as (number | null)[];
      for (const v of ys) {
        if (v !== null && v !== undefined) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    });
    if (min === Infinity) return;
    const pad = ((max - min) || Math.abs(max) || 1) * 0.1;
    u.setScale("y", { min: min - pad, max: max + pad });
  };

  const resetView = () => {
    setFollow(true);
    const u = uRef.current;
    if (u) {
      u.setScale("y", {
        min: undefined as unknown as number,
        max: undefined as unknown as number,
      });
      u.redraw();
    }
  };

  const hasChannels = plot.channels.length > 0;

  return (
    <div className="plot">
      <div className="plot-bar">
        <button
          className="btn"
          onClick={autoY}
          title="Y 轴自动缩放至所有可见曲线全范围（留 10% 余量）"
        >
          Auto
        </button>
        {hasChannels && (
          <button className="btn" onClick={() => plotStore.clearChannels()}>
            清空通道
          </button>
        )}
        <button
          className={`btn ${plot.settings.stack ? "primary" : ""}`}
          onClick={() => plotStore.setSetting({ stack: !plot.settings.stack })}
          title="多通道堆叠：每通道独立归一化，垂直均分显示（量纲不同的通道各看各的）"
        >
          堆叠
        </button>
        <button
          className={`btn ${plot.settings.cursors ? "primary" : ""}`}
          onClick={() => plotStore.setSetting({ cursors: !plot.settings.cursors })}
          title="双游标测量：X 轴（竖线测 Δt）/ Y 轴（横线测 ΔV），模式可在测量框内切换"
        >
          游标
        </button>
        <div className="plot-bar-spacer" />
        {plot.channels.map((ch) => {
          const hz = plotStore.sampleRate(ch.id);
          return (
            <span key={ch.id} className="plot-chip" title={`实际采样率约 ${hz.toFixed(0)} Hz（由设备输出率决定）\n点击名称聚焦该通道（再点恢复全部）`}>
              <input
                type="color"
                className="color-input"
                value={ch.color}
                onChange={(e) => plotStore.setColor(ch.id, e.target.value)}
              />
              <span
                className={`plot-chip-name ${ch.visible ? "" : "off"}`}
                onClick={() => plotStore.toggleSolo(ch.id)}
              >
                {ch.name}
              </span>
              {hz > 0 && <span className="plot-chip-hz">{hz.toFixed(0)}Hz</span>}
              <button className="tpl-del" onClick={() => plotStore.removeChannel(ch.id)}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div
        ref={wrapRef}
        className={`plot-wrap ${dragOver ? "dropping" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
      >
        <div ref={chartRef} className="plot-chart" />
        {!hasChannels && (
          <div className="plot-empty">
            打开左侧「字段图例」的眼睛即可实时绘图
            <br />
            左键拖动平移 · 中键框选缩放 · 双击保形回实时 ·
            滚轮缩放（轴区对应轴） · 右键图表更多设置
          </div>
        )}
        {backlog > 0 && (
          <button
            className="plot-follow-chip"
            onClick={() => setFollow(true)}
            title="回到跟随模式，视野钉住最新数据"
          >
            跟最新 · {backlog} 新点 <IconChevron size={11} />
          </button>
        )}
        {measure && (
          <div className="plot-measure">
            <div className="plot-measure-head">
              游标测量
              <span className="pm-seg">
                <button
                  className={plot.settings.cursorMode === "x" ? "on" : ""}
                  onClick={() => plotStore.setSetting({ cursorMode: "x" })}
                  title="竖线游标：测时间差 Δt"
                >
                  X·Δt
                </button>
                <button
                  className={plot.settings.cursorMode === "y" ? "on" : ""}
                  onClick={() => plotStore.setSetting({ cursorMode: "y" })}
                  title="横线游标：测幅值差 ΔV"
                >
                  Y·ΔV
                </button>
              </span>
              <span>
                {plot.settings.cursorMode === "y"
                  ? "拖动 A/B 横线"
                  : "拖动 A/B 竖线"}
              </span>
              <button
                className="pm-clear"
                onClick={() => {
                  // 只清标尺、不关功能：A/B 置空后可在图上单击重新铺设
                  cursorRef.current = { a: null, b: null };
                  setMeasure(null);
                  uRef.current?.redraw();
                }}
                title="清除 A/B 标尺（功能保持开启，在图上单击可重新铺设）"
              >
                清除
              </button>
            </div>
            <div className="plot-measure-dt">
              {plot.settings.cursorMode === "y" ? "ΔV" : "Δt"} = {measure.dt}
            </div>
            {measure.rows.length > 0 && (
              <>
                <div className="plot-measure-grid plot-measure-head-row">
                  <span />
                  <span>A</span>
                  <span>B</span>
                  <span>Δ</span>
                </div>
                {measure.rows.map((r) => (
                  <div key={r.name} className="plot-measure-grid">
                    <span
                      className="tpl-dot"
                      style={{ background: r.color }}
                      title={r.name}
                    />
                    <span className="pm-name" title={r.name}>
                      {r.name}
                    </span>
                    <span className="pm-val">{fmtVal(r.v1)}</span>
                    <span className="pm-val">{fmtVal(r.v2)}</span>
                    <span className="pm-dv">
                      {r.dv != null ? fmtVal(r.dv) : "—"}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
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
            <div className="ctx-title">图表设置</div>
            <div className="ctx-group">Y 轴</div>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ yMode: "auto" })}
            >
              {plot.settings.yMode === "auto" ? "●" : "○"} 自动范围
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ yMode: "zero" })}
            >
              {plot.settings.yMode === "zero" ? "●" : "○"} 包含零点（对称）
            </button>
            <div
              ref={xRowRef}
              className="ctx-row"
              onMouseEnter={() => { disarmSub(); setSub("x"); }}
              onMouseLeave={() => { if (!subPinned) armSub(); }}
              onClick={() => {
                // 点击展开并钉住：不依赖 hover 时序，避免子菜单还没点到就被 250ms 定时器收起
                setSub((s) => (s === "x" ? null : "x"));
                setSubPinned(sub !== "x");
                disarmSub();
              }}
            >
              <button className="ctx-item">
                <span className="ctx-item-l">
                  X 轴源 <span className="ctx-arrow"><IconChevron size={12} /></span>
                </span>
                <span className="ctx-cur">
                  {plot.settings.xSource === "time"
                    ? "时间"
                    : plot.settings.xSource === "index"
                      ? "序号"
                      : plot.channels.find(
                          (c) => `ch:${c.id}` === plot.settings.xSource,
                        )?.name ?? ""}
                </span>
              </button>
            </div>
            <div
              ref={yRowRef}
              className="ctx-row"
              onMouseEnter={() => { disarmSub(); setSub("y"); }}
              onMouseLeave={() => { if (!subPinned) armSub(); }}
              onClick={() => {
                setSub((s) => (s === "y" ? null : "y"));
                setSubPinned(sub !== "y");
                disarmSub();
              }}
            >
              <button className="ctx-item">
                <span className="ctx-item-l">
                  Y 轴源（通道显隐） <span className="ctx-arrow"><IconChevron size={12} /></span>
                </span>
                <span className="ctx-cur">
                  {plot.channels.filter((c) => c.visible).length}/
                  {plot.channels.length}
                </span>
              </button>
            </div>
            <div className="ctx-group">绘图</div>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ lineStyle: "linear" })}
            >
              {plot.settings.lineStyle === "linear" ? "●" : "○"} 直线连接
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ lineStyle: "step" })}
            >
              {plot.settings.lineStyle === "step" ? "●" : "○"} 台阶（保持末值）
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ lineStyle: "smooth" })}
            >
              {plot.settings.lineStyle === "smooth" ? "●" : "○"} 平滑样条
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ plotMode: "line" })}
            >
              {plot.settings.plotMode === "line" ? "●" : "○"} 连线
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ plotMode: "points" })}
            >
              {plot.settings.plotMode === "points" ? "●" : "○"} 仅画点
            </button>
            <div className="form-row" style={{ padding: "4px 8px" }}>
              <label>线宽</label>
              <select
                className="input"
                value={plot.settings.lineWidth}
                onChange={(e) =>
                  plotStore.setSetting({ lineWidth: Number(e.target.value) })
                }
              >
                {[1, 2, 3].map((w) => (
                  <option key={w} value={w}>
                    {w}px
                  </option>
                ))}
              </select>
            </div>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ grid: !plot.settings.grid })}
            >
              {plot.settings.grid ? "●" : "○"} 网格线
            </button>
            <div className="ctx-group">视图</div>
            <button
              className="ctx-item"
              onClick={() => {
                setFollow(true);
                setMenu(null);
              }}
            >
              {followState ? "●" : "○"} X 轴跟随最新
            </button>
            <button className="ctx-item" onClick={autoY}>
              Auto Y 轴
            </button>
            <button className="ctx-item" onClick={resetView}>
              复位视图
            </button>
          </div>,
          document.body,
        )}
      {menu && sub === "x" && (
        <Flyout anchor={xRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={150}>
          <button
            className="ctx-item"
            onClick={() => {
              plotStore.setSetting({ xSource: "time" });
              setMenu(null);
            }}
          >
            {plot.settings.xSource === "time" ? "●" : "○"} 时间
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              plotStore.setSetting({ xSource: "index" });
              setMenu(null);
            }}
          >
            {plot.settings.xSource === "index" ? "●" : "○"} 序号
          </button>
          {plot.channels.map((ch) => (
            <button
              key={ch.id}
              className="ctx-item"
              onClick={() => {
                plotStore.setSetting({ xSource: `ch:${ch.id}` });
                setMenu(null);
              }}
            >
              {plot.settings.xSource === `ch:${ch.id}` ? "●" : "○"} {ch.name}
            </button>
          ))}
        </Flyout>
      )}
      {menu && sub === "y" && (
        <Flyout anchor={yRowRef.current} zf={zf} onArm={armSub} onDisarm={disarmSub} minWidth={150}>
          {plot.channels.length === 0 && <div className="ctx-group">暂无通道</div>}
          {plot.channels.map((ch) => (
            <button
              key={ch.id}
              className="ctx-item"
              onClick={() => plotStore.toggleVisible(ch.id)}
            >
              <span
                className="tpl-dot"
                style={{ background: ch.color, marginRight: 6 }}
              />
              {ch.visible ? "●" : "○"} {ch.name}
            </button>
          ))}
        </Flyout>
      )}
    </div>
  );
}
