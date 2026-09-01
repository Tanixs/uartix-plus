import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import * as plotStore from "./plotStore";
import { useSettings } from "../settings/settingsStore";
import { Flyout } from "../../shared/Flyout";
import {
  IconChevron,
  IconCursorX,
  IconCursorY,
  IconStack,
  IconAutoY,
  IconFitView,
  IconTrash,
} from "../../shared/icons";

function fmtVal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (!Number.isFinite(v)) return "—";
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

/** 游标测量面板位置持久化（布局像素，相对 .plot-wrap 左下锚点）。
 *  未保存过位置时返回 null → 使用 CSS 默认（X 左下、Y 右下），避免窄容器下溢出 */
const PANEL_POS_KEY = "vs.plotPanelPos";
type PanelPos = { l: number; b: number };
function readPanelPos(which: "x" | "y"): PanelPos | null {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Record<"x" | "y", PanelPos>>;
      const v = p[which];
      if (v && Number.isFinite(v.l) && Number.isFinite(v.b))
        return { l: Math.max(0, v.l), b: Math.max(0, v.b) };
    }
  } catch {
    /* 回退默认 */
  }
  return null;
}
function writePanelPos(which: "x" | "y", pos: PanelPos) {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    const p = (raw ? JSON.parse(raw) : {}) as Record<"x" | "y", PanelPos>;
    p[which] = pos;
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(p));
  } catch {
    /* 存储不可用则仅本次会话生效 */
  }
}

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

/** 统计可见通道在 [xLo,xHi] 内的 Y 极值（null=不限范围）；yMode=zero 时对称于 0 */
function yRangeOf(
  data: uPlot.AlignedData,
  channels: { visible: boolean }[],
  xLo: number | null | undefined,
  xHi: number | null | undefined,
  yMode: string,
): [number, number] | null {
  const xs = data[0] as number[];
  const inView = (j: number) =>
    (xLo == null || xs[j] >= xLo) && (xHi == null || xs[j] <= xHi);
  if (yMode === "zero") {
    let m = 0;
    channels.forEach((ch, i) => {
      if (!ch.visible) return;
      const ys = data[i + 1] as (number | null)[];
      for (let j = 0; j < ys.length; j++) {
        const v = ys[j];
        if (v !== null && v !== undefined && inView(j) && Math.abs(v) > m)
          m = Math.abs(v);
      }
    });
    return m > 0 ? [-m * 1.15, m * 1.15] : null;
  }
  let mn = Infinity;
  let mx = -Infinity;
  channels.forEach((ch, i) => {
    if (!ch.visible) return;
    const ys = data[i + 1] as (number | null)[];
    for (let j = 0; j < ys.length; j++) {
      const v = ys[j];
      if (v === null || v === undefined || !inView(j)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  });
  if (mn === Infinity) return null;
  const pad = (mx - mn || Math.abs(mx) || 1) * 0.1;
  return [mn - pad, mx + pad];
}

/** 游标测量面板数据（X=时间游标 / Y=幅值游标，两套独立） */
interface Measure {
  mode: "x" | "y";
  /** 游标 A：x 模式为时间值，y 模式为幅值（堆叠下已换算聚焦通道原始值） */
  a: number;
  b: number | null;
  /** b - a */
  d: number | null;
  /** x 模式：各可见通道在 A/B 时刻的取值 */
  rows: {
    name: string;
    color: string;
    v1: number | null;
    v2: number | null;
    dv: number | null;
  }[];
  /** y 模式（堆叠）：读数所依据的聚焦通道 */
  focus: { name: string; color: string } | null;
}

/** 堆叠槽位 → 该槽位通道索引（与 stackMetaRef 的 slot 顺序一致） */
function stackSlotOf(norm: number, k: number): number {
  return Math.min(k - 1, Math.max(0, Math.floor(norm * k)));
}

/** 构建测量数据：游标 A 放置后即显示，B 齐全时补充 Δ */
function buildMeasure(
  pair: { a: number | null; b: number | null },
  mode: "x" | "y",
  stack: boolean,
  xs: number[],
  channels: { id: string; name: string; color: string; visible: boolean }[],
  data: uPlot.AlignedData,
  affine: ({ a: number; b: number } | null)[],
  slots: { ci: number; name: string; color: string }[],
): Measure | null {
  if (pair.a == null) return null;
  if (mode === "x") {
    const ax = pair.a;
    const bx = pair.b ?? null;
    const rows = channels.map((ch, i) => {
      const fed = { t: xs, v: data[i + 1] as number[] };
      const v1 = fed.t.length ? interpAt(fed, ax) : null;
      const v2 = bx != null && fed.t.length ? interpAt(fed, bx) : null;
      return {
        name: ch.name,
        color: ch.color,
        v1,
        v2,
        dv: v1 != null && v2 != null ? v2 - v1 : null,
      };
    });
    return {
      mode,
      a: ax,
      b: bx,
      d: bx != null ? bx - ax : null,
      rows,
      focus: null,
    };
  }
  // y 模式：堆叠下游标存的是归一化位置，按聚焦通道换算原始值
  const solo = channels.filter((ch) => ch.visible);
  const rawOf = (norm: number): { v: number; focus: { name: string; color: string } | null } => {
    if (!stack) return { v: norm, focus: solo.length === 1 ? { name: solo[0].name, color: solo[0].color } : null };
    const k = Math.max(1, slots.length);
    const slot = slots[stackSlotOf(norm, k)];
    if (!slot) return { v: norm, focus: null };
    const af = affine[slot.ci];
    return {
      v: af ? (norm - af.b) / af.a : norm,
      focus: { name: slot.name, color: slot.color },
    };
  };
  const ra = rawOf(pair.a);
  const rb = pair.b != null ? rawOf(pair.b) : null;
  return {
    mode,
    a: ra.v,
    b: rb ? rb.v : null,
    d: rb ? rb.v - ra.v : null,
    rows: [],
    focus: ra.focus,
  };
}

/** 拖拽游标的瞬时状态（X/Y 游标各自独立，单自由度） */
type CursorDrag = {
  mode: "x" | "y";
  which: "a" | "b";
};

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
  /** 指针相对 over 左上角的原始屏幕像素偏移（move 钩子据此换算 CSS 空间） */
  const rawMRef = useRef({ l: -10, t: -10 });
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
  /** 可见通道最新点的显示 X 值（「最新」线锚点；视窗裁剪下 u.data 末尾不可靠） */
  const latestDispRef = useRef<number | null>(null);
  /** 全量数据首点的显示 X 值（「起」线锚点；视窗裁剪下 u.data 开头不可靠） */
  const startDispRef = useRef<number | null>(null);
  const yManualRef = useRef(false);
  const affineRef = useRef<({ a: number; b: number } | null)[]>([]);
  const stackMetaRef = useRef<
    { ci: number; name: string; color: string; lo: number; hi: number }[]
  >([]);
  /** 时间游标（垂直线）：a/b 为 X 轴数值 */
  const xCurRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null });
  /** 幅值游标（水平线）：a/b 为 Y 轴数值（堆叠下为归一化位置） */
  const yCurRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null });
  const cursorDragRef = useRef<CursorDrag | null>(null);
  const [backlog, setBacklog] = useState(0);
  const backlogRef = useRef(0);
  const measureKeyRef = useRef("");
  const [measureX, setMeasureX] = useState<Measure | null>(null);
  const [measureY, setMeasureY] = useState<Measure | null>(null);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const settingsRef = useRef(plot.settings);
  settingsRef.current = plot.settings;
  const xSourceRef = useRef(plot.settings.xSource);
  xSourceRef.current = plot.settings.xSource;

  /**
   * 游标测量面板位置（布局像素，相对 .plot-wrap 左下）。两套面板可各自拖动，
   * 避免遮挡曲线；位置持久化。null = 未拖动过，使用 CSS 默认（X 左下 / Y 右下）。
   */
  const [mpX, setMpX] = useState<PanelPos | null>(() => readPanelPos("x"));
  const [mpY, setMpY] = useState<PanelPos | null>(() => readPanelPos("y"));
  const mpXRef = useRef(mpX);
  const mpYRef = useRef(mpY);
  mpXRef.current = mpX;
  mpYRef.current = mpY;
  const panelDragRef = useRef<
    | null
    | { which: "x" | "y"; startX: number; startY: number; baseL: number; baseB: number }
  >(null);

  const startPanelDrag = (which: "x" | "y") => (e: React.PointerEvent) => {
    // 标题栏上的按钮（清除）不参与拖拽
    if ((e.target as HTMLElement).closest("button")) return;
    const cur = which === "x" ? mpXRef.current : mpYRef.current;
    // 首次拖动时以当前 CSS 落点为基准，避免面板“跳”到 0,0
    const rect = (e.currentTarget.closest(".plot-measure") as HTMLElement)?.getBoundingClientRect();
    const wrapRect = wrapRef.current?.getBoundingClientRect();
    const base = cur ?? {
      l: rect && wrapRect ? rect.left - wrapRect.left : 10,
      b: rect && wrapRect ? wrapRect.bottom - rect.bottom : 10,
    };
    panelDragRef.current = {
      which,
      startX: e.clientX,
      startY: e.clientY,
      baseL: base.l,
      baseB: base.b,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const movePanelDrag = (e: React.PointerEvent) => {
    const d = panelDragRef.current;
    if (!d) return;
    const z = parseFloat(document.documentElement.style.zoom) / 100 || 1;
    const wrap = wrapRef.current;
    const dl = (e.clientX - d.startX) / z;
    const db = -(e.clientY - d.startY) / z;
    const maxL = Math.max(0, (wrap?.clientWidth ?? 400) - 150);
    const maxB = Math.max(0, (wrap?.clientHeight ?? 300) - 60);
    const next = {
      l: Math.min(maxL, Math.max(0, d.baseL + dl)),
      b: Math.min(maxB, Math.max(0, d.baseB + db)),
    };
    if (d.which === "x") setMpX(next);
    else setMpY(next);
  };
  const endPanelDrag = (e: React.PointerEvent) => {
    const d = panelDragRef.current;
    if (!d) return;
    panelDragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放 */
    }
    const pos = d.which === "x" ? mpXRef.current : mpYRef.current;
    if (pos) writePanelPos(d.which, pos);
  };
  /** 面板内 pointer 事件统一分发：仅拖标题栏，内容区交互不受影响 */
  const panelPointerProps = (which: "x" | "y") => ({
    onPointerDown: startPanelDrag(which),
    onPointerMove: movePanelDrag,
    onPointerUp: endPanelDrag,
    onPointerCancel: endPanelDrag,
  });

  const setFollow = (v: boolean) => {
    followXRef.current = v;
    setFollowState(v);
  };

  /** X 轴坐标值 → 显示字符串（xSource=time 时值是相对首点的秒数） */
  const fmtX = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    if (xSourceRef.current === "time") return `${v.toFixed(3)} s`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(3);
  };

  /** 相对秒刻度：短标签（34s / 5m / 1.2h），避免 epoch 秒长串互相压字 */
  const fmtTickSec = (v: number): string => {
    const a = Math.abs(v);
    if (a >= 7200) return `${+(v / 3600).toFixed(1)}h`;
    if (a >= 150) return `${Math.round(v / 60)}m`;
    return `${Math.round(v * 10) / 10}s`;
  };

  /** 游标测量面板同步：两套游标各自独立；数据/位置不变则跳过 setState。
   *  注意：u.data 是视窗裁剪后的数据，游标可能在视野外 → 测量一律基于全量缓存 */
  const syncMeasure = () => {
    const u = uRef.current;
    const st = settingsRef.current;
    let key = "";
    let mx: Measure | null = null;
    let my: Measure | null = null;
    if (u && (st.cursorX || st.cursorY)) {
      const snap = plotStore.getSnapshot();
      const full = plotStore.fullAligned();
      const data = [full.x, ...full.cols] as uPlot.AlignedData;
      if (st.cursorX) {
        mx = buildMeasure(
          xCurRef.current,
          "x",
          st.stack,
          full.x,
          snap.channels,
          data,
          affineRef.current,
          stackMetaRef.current,
        );
      }
      if (st.cursorY) {
        my = buildMeasure(
          yCurRef.current,
          "y",
          st.stack,
          full.x,
          snap.channels,
          data,
          affineRef.current,
          stackMetaRef.current,
        );
      }
      const xa = xCurRef.current;
      const ya = yCurRef.current;
      key = `${st.cursorX ? 1 : 0}${st.cursorY ? 1 : 0}|${xa.a?.toFixed(4) ?? "-"}|${xa.b?.toFixed(4) ?? "-"}|${ya.a?.toFixed(4) ?? "-"}|${ya.b?.toFixed(4) ?? "-"}|${full.x.length}`;
    }
    if (key !== measureKeyRef.current) {
      measureKeyRef.current = key;
      setMeasureX(mx);
      setMeasureY(my);
    }
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

  // 右键菜单关闭闭环：外部按下 / Escape / 滚轮 立即关；
  // 指针离开菜单（含级联浮层）超过宽限期自动关——解决"移开鼠标菜单还挂着"
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

  // 仅重建 uPlot 所需的结构性设置参与依赖；cursors/yAuto 走 ref 实时生效，
  // 避免切换游标时销毁重建图表（会丢失当前缩放/浏览位置）
  const structuralSig = JSON.stringify({
    grid: plot.settings.grid,
    xSource: plot.settings.xSource,
    plotMode: plot.settings.plotMode,
    lineWidth: plot.settings.lineWidth,
    lineStyle: plot.settings.lineStyle,
    stack: plot.settings.stack,
    yMode: plot.settings.yMode,
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    const chart = chartRef.current;
    if (!wrap || !chart) return;
    const channels = plot.channels;
    const st = plot.settings;
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
    const CUR_A = "#18b893";
    const CUR_B = "#e8a13c";
    const rawM = rawMRef.current;

    const opts: uPlot.Options = {
      width: Math.max(wrap.clientWidth, 80),
      height: Math.max(wrap.clientHeight, 60),
      // 十字线改由自绘 DOM 承担：uPlot 的 DOM 游标把 getBoundingClientRect 得到的
      // 屏幕像素直接写进 style.transform，会被全局 CSS zoom 再放大一次 →
      // 针尖与十字中心不重合（界面缩放 ≠100% 时必然出现）
      cursor: {
        x: false,
        y: false,
        drag: { x: false, y: false },
        points: { size: 4 },
        // uPlot 内部 mouse = clientX - rect.left（屏幕像素），但 posToVal 按
        // CSS 像素处理 → zoom≠1 时图例悬停取值/交叉点系统性偏移。
        // 必须从 rawM（原始屏幕像素）换算而非对入参除 z：updateCursor 会被
        // commit 路径反复调用并原地改写 mouseLeft1，对入参再除会累积漂移
        move: () => {
          const z = parseFloat(document.documentElement.style.zoom) / 100 || 1;
          return [rawM.l / z, rawM.t / z];
        },
      },
      legend: { show: true, live: true },
      // 框选由我们自绘（中键），关掉 uPlot 的 DOM 选区层（它同样会被 CSS zoom 放大错位）
      select: {
        show: false,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      } as uPlot.Options["select"],
      scales: {
        // time 源现在喂「相对秒」数值，按普通数值轴分刻度即可
        // （time:true 会让 uPlot 按 epoch 日期取整分刻度，与相对值不匹配）
        x: { time: false, auto: false },
        // y 必须显式 auto:false（非堆叠也要）：uPlot 的 setScales 里有
        // `pendScales[x] != null && sc.auto()` —— 每次 setScale("x") 都会把
        // auto 状态的 y 重新塞进自动缩放队列。跟随态每 120ms 设一次 x，
        // 于是 Y 被反复拉成全量数据范围（堆叠模式因已声明 auto:false 才没这问题）
        y: st.stack
          ? { auto: false, range: (): [number, number] => [0, 1] }
          : { auto: false },
      },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: st.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          labelSize: 0,
          font: '10px "Cascadia Mono", Consolas, monospace',
          // 相对秒数：短标签 + 加大最小间距，杜绝长数字互相压字
          space: 88,
          values:
            st.xSource === "time"
              ? (_u, splits) => splits.map(fmtTickSec)
              : (_u, splits) =>
                  splits.map((v) =>
                    Number.isInteger(v) ? String(v) : v.toFixed(2),
                  ),
        },
        {
          stroke: axisColor,
          grid: { stroke: st.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          font: '10px "Cascadia Mono", Consolas, monospace',
          values: (_u, splits) => (st.stack ? [] : splits.map((v) => fmtVal(v))),
        },
      ],
      series: [
        {},
        ...channels.map((ch) => ({
          label: ch.name,
          stroke: ch.color,
          width: st.plotMode === "points" ? 0 : st.lineWidth,
          show: ch.visible,
          spanGaps: true,
          paths:
            st.stack && st.lineStyle === "smooth"
              ? LINE_PATHS.linear
              : LINE_PATHS[st.lineStyle],
          points: { show: st.plotMode === "points", size: 3 },
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
                const ex = frac < 0 ? u.bbox.left : u.bbox.left + u.bbox.width;
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
            /** 水平游标线：2px 横线 + 左右三角旗标 + 徽标；越界时画边缘指示 */
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
                const ey = frac < 0 ? u.bbox.top : u.bbox.top + u.bbox.height;
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
              // 起/最新都锚定全量数据的真实端点：视窗裁剪下 xs 只是视野片段，
              // 端点在视野外时 drawV 自动降级为边缘箭头指示
              const sv = startDispRef.current;
              if (sv != null) drawV(sv, dimColor, true, "起");
              // 「最新」锚定可见通道的真实末点（合并轴末尾/窗口末尾都可能超前）
              const lv = latestDispRef.current;
              if (lv != null) drawV(lv, accent, false, "最新");
            }
            const cur = settingsRef.current;
            if (cur.stack) {
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
                const py = u.bbox.top + (1 - (i + 0.5) / K) * u.bbox.height;
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
            // 时间游标（垂直标尺）：A/B 竖线 + 之间半透明测量带
            if (cur.cursorX) {
              const c = xCurRef.current;
              if (
                c.a != null &&
                c.b != null &&
                sx.min != null &&
                sx.max != null &&
                sx.max > sx.min
              ) {
                const x0 = u.bbox.left + ((Math.min(c.a, c.b) - sx.min) / (sx.max - sx.min)) * u.bbox.width;
                const x1 = u.bbox.left + ((Math.max(c.a, c.b) - sx.min) / (sx.max - sx.min)) * u.bbox.width;
                ctx.save();
                ctx.fillStyle = hexA(CUR_A, 0.06);
                ctx.fillRect(x0, u.bbox.top, Math.max(0, x1 - x0), u.bbox.height);
                ctx.restore();
              }
              (["a", "b"] as const).forEach((k) => {
                const v = c[k];
                if (v == null) return;
                drawV(v, k === "a" ? CUR_A : CUR_B, false, `X·${k.toUpperCase()}`);
              });
            }
            // 幅值游标（水平标尺）：A/B 横线 + 之间测量带
            if (cur.cursorY) {
              const c = yCurRef.current;
              const sy = u.scales.y;
              if (c.a != null && c.b != null && sy.min != null && sy.max != null && sy.max > sy.min) {
                const y0 = u.bbox.top + ((sy.max - Math.max(c.a, c.b)) / (sy.max - sy.min)) * u.bbox.height;
                const y1 = u.bbox.top + ((sy.max - Math.min(c.a, c.b)) / (sy.max - sy.min)) * u.bbox.height;
                ctx.save();
                ctx.fillStyle = hexA(CUR_B, 0.05);
                ctx.fillRect(u.bbox.left, y0, u.bbox.width, Math.max(0, y1 - y0));
                ctx.restore();
              }
              (["a", "b"] as const).forEach((k) => {
                const v = c[k];
                if (v == null) return;
                drawH(v, k === "a" ? CUR_A : CUR_B, `Y·${k.toUpperCase()}`);
              });
            }
            const box = boxRef.current;
            if (box) {
              // 屏幕像素 → 画布像素走纯比例映射（分子分母同为屏幕像素，zoom/dpr 自动抵消）；
              // 旧实现 cv.width/rect.width 混入 dpr 且没除 zoom → 框选矩形跟鼠标错位
              const r = u.over.getBoundingClientRect();
              const bx0 = (Math.min(box.x0, box.x1) - r.left) / Math.max(1, r.width);
              const bx1 = (Math.max(box.x0, box.x1) - r.left) / Math.max(1, r.width);
              const by0 = (Math.min(box.y0, box.y1) - r.top) / Math.max(1, r.height);
              const by1 = (Math.max(box.y0, box.y1) - r.top) / Math.max(1, r.height);
              const l = u.bbox.left + bx0 * u.bbox.width;
              const t = u.bbox.top + by0 * u.bbox.height;
              const w = (bx1 - bx0) * u.bbox.width;
              const h = (by1 - by0) * u.bbox.height;
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
            const over = u.over;
            const overRect = () => over.getBoundingClientRect();
            // 屏幕坐标 ↔ 数值：统一用 over 矩形（与渲染同一线性映射），
            // 规避 uPlot posToVal 的 _min/_max 刻度取整偏差与全局 CSS zoom 造成的错位
            const xToVal = (clientX: number): number | null => {
              const s = u.scales.x;
              const r = overRect();
              if (s.min == null || s.max == null || s.max === s.min || r.width === 0)
                return null;
              const f = (clientX - r.left) / r.width;
              return s.min + f * (s.max - s.min);
            };
            const yToVal = (clientY: number): number | null => {
              const s = u.scales.y;
              const r = overRect();
              if (s.min == null || s.max == null || s.max === s.min || r.height === 0)
                return null;
              const f = (clientY - r.top) / r.height;
              return s.max - f * (s.max - s.min);
            };
            const valToScreenX = (val: number): number | null => {
              const s = u.scales.x;
              const r = overRect();
              if (s.min == null || s.max == null || s.max === s.min || r.width === 0)
                return null;
              return r.left + ((val - s.min) / (s.max - s.min)) * r.width;
            };
            const valToScreenY = (val: number): number | null => {
              const s = u.scales.y;
              const r = overRect();
              if (s.min == null || s.max == null || s.max === s.min || r.height === 0)
                return null;
              return r.top + ((s.max - val) / (s.max - s.min)) * r.height;
            };
            const zoomX = (clientX: number, k: number) => {
              const s = u.scales.x;
              const min = s.min ?? 0;
              const max = s.max ?? 1;
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
              const t = min + frac * (max - min);
              u.setScale("x", { min: t - (t - min) * k, max: t + (max - t) * k });
              setFollow(false);
            };
            const zoomY = (clientY: number, k: number) => {
              const s = u.scales.y;
              if (s.min == null || s.max == null) return;
              let min = s.min;
              let max = s.max;
              if (min === max) {
                min -= 1;
                max += 1;
              }
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
              const v = max - frac * (max - min);
              u.setScale("y", { min: v - (v - min) * k, max: v + (max - v) * k });
              // 手动接管 Y 只在 yAuto 关闭时生效：yAuto 开启时用户调整仅
              // 在本次交互期间生效，松手后继续自动贴合（“始终占满视野”）
              if (!settingsRef.current.yAuto) yManualRef.current = true;
            };
            // 捕获阶段拦截：uPlot 在 over 上自带 dblclick → autoScaleX()（X 拉到全量范围），
            // 会与我们"双击删游标/双击回实时"冲突。root 捕获先于 over 目标监听器执行，
            // stopPropagation 后由我们全权处理
            const onDbl = (e: MouseEvent) => {
              e.stopPropagation();
              const st = settingsRef.current;
              // 双击落在某游标线附近 → 删除该游标（X=竖线看横向距离，Y=横线看纵向距离）
              if (st.cursorX || st.cursorY) {
                const xc = xCurRef.current;
                const yc = yCurRef.current;
                const nearXLine = (v: number | null) => {
                  if (v == null) return false;
                  const px = valToScreenX(v);
                  return px != null && Math.abs(e.clientX - px) <= 12;
                };
                const nearYLine = (v: number | null) => {
                  if (v == null) return false;
                  const py = valToScreenY(v);
                  return py != null && Math.abs(e.clientY - py) <= 12;
                };
                if (st.cursorY && nearYLine(yc.b)) {
                  yCurRef.current = { ...yc, b: null };
                  u.redraw();
                  syncMeasure();
                  return;
                }
                if (st.cursorY && nearYLine(yc.a)) {
                  yCurRef.current = { ...yc, a: null };
                  u.redraw();
                  syncMeasure();
                  return;
                }
                if (st.cursorX && nearXLine(xc.b)) {
                  xCurRef.current = { ...xc, b: null };
                  u.redraw();
                  syncMeasure();
                  return;
                }
                if (st.cursorX && nearXLine(xc.a)) {
                  xCurRef.current = { ...xc, a: null };
                  u.redraw();
                  syncMeasure();
                  return;
                }
              }
              // 双击空白 = 保形回实时：保持当前窗宽，仅平移到最新数据
              setFollow(true);
              yManualRef.current = false;
              const last = latestDispRef.current;
              if (last != null) {
                const s = u.scales.x;
                const span = Math.max(
                  (s.max ?? 0) - (s.min ?? 0),
                  settingsRef.current.xSource === "time" ? 10 : 200,
                );
                u.setScale("x", { min: last - span * 0.95, max: last + span * 0.05 });
              }
            };
            u.root.addEventListener("dblclick", onDbl, true);
            u.root.addEventListener(
              "wheel",
              (e) => {
                e.preventDefault();
                const rect = overRect();
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
                if (inYZone) zoomY(e.clientY, k);
                else if (inXZone) zoomX(e.clientX, k);
                else {
                  zoomX(e.clientX, k);
                  zoomY(e.clientY, k);
                }
              },
              { passive: false },
            );

            // 命中检测：X（竖线，看横向距离）/ Y（横线，看纵向距离）各自独立
            const hitTest = (e: PointerEvent): CursorDrag | null => {
              const st = settingsRef.current;
              const TOL = 9;
              let best: CursorDrag | null = null;
              let bestDist = Infinity;
              const consider = (
                mode: "x" | "y",
                which: "a" | "b",
                v: number | null,
                dist: number,
              ) => {
                if (v == null || dist > TOL || dist >= bestDist) return;
                bestDist = dist;
                best = { mode, which };
              };
              if (st.cursorX) {
                const c = xCurRef.current;
                const pa = valToScreenX(c.a ?? NaN);
                const pb = valToScreenX(c.b ?? NaN);
                if (pa != null) consider("x", "a", c.a, Math.abs(e.clientX - pa));
                if (pb != null) consider("x", "b", c.b, Math.abs(e.clientX - pb));
              }
              if (st.cursorY) {
                const c = yCurRef.current;
                const pa = valToScreenY(c.a ?? NaN);
                const pb = valToScreenY(c.b ?? NaN);
                if (pa != null) consider("y", "a", c.a, Math.abs(e.clientY - pa));
                if (pb != null) consider("y", "b", c.b, Math.abs(e.clientY - pb));
              }
              return best;
            };

            const onDown = (e: PointerEvent) => {
              const r = overRect();
              if (
                e.clientX < r.left ||
                e.clientX > r.right ||
                e.clientY < r.top ||
                e.clientY > r.bottom
              )
                return;
              if (e.button !== 0) {
                if (e.button === 1) {
                  boxRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
                  over.setPointerCapture(e.pointerId);
                  e.preventDefault();
                }
                return;
              }
              // 捕获指针：pointerup 必定回到 over，杜绝 mouseup 丢失导致的拖拽/缩放卡死
              over.setPointerCapture(e.pointerId);
              const drag = hitTest(e);
              if (drag) {
                cursorDragRef.current = drag;
                e.preventDefault();
                return;
              }
              const s = u.scales.x;
              const sy = u.scales.y;
              panRef.current = {
                x0: e.clientX,
                y0: e.clientY,
                minX: s.min ?? 0,
                maxX: s.max ?? 1,
                minY: sy.min ?? 0,
                maxY: sy.max ?? 1,
                moved: false,
              };
              e.preventDefault();
            };
            const onMove = (e: PointerEvent) => {
              const cd = cursorDragRef.current;
              if (cd) {
                const nv = cd.mode === "x" ? xToVal(e.clientX) : yToVal(e.clientY);
                if (nv != null) {
                  const ref = cd.mode === "x" ? xCurRef : yCurRef;
                  ref.current = { ...ref.current, [cd.which]: nv };
                  u.redraw();
                  syncMeasure();
                }
                return;
              }
              if (panRef.current) {
                const p = panRef.current;
                if (!p.moved && Math.abs(e.clientX - p.x0) + Math.abs(e.clientY - p.y0) < 4)
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
                // yAuto 开启时不锁手动 Y：拖完后继续自动贴合视野
                if (dvy !== 0 && !settingsRef.current.yAuto) yManualRef.current = true;
              }
              if (boxRef.current) {
                const b = boxRef.current;
                b.x1 = e.clientX;
                b.y1 = e.clientY;
                u.redraw();
              }
            };
            const onUp = (e: PointerEvent) => {
              try {
                if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
              } catch {
                /* 已释放 */
              }
              const cd = cursorDragRef.current;
              if (cd && e.button === 0) {
                cursorDragRef.current = null;
                // 单击（无位移）落在游标线上不放置新游标，直接结束
                return;
              }
              if (panRef.current && e.button === 0) {
                const p = panRef.current;
                panRef.current = null;
                // 单击空白 → 在点击处铺设游标（X 放竖线先 A 后 B；Y 放横线先 A 后 B）
                if (!p.moved) {
                  const st = settingsRef.current;
                  const nx = xToVal(e.clientX);
                  const ny = yToVal(e.clientY);
                  if (nx != null && ny != null && (st.cursorX || st.cursorY)) {
                    if (st.cursorX) {
                      const c = xCurRef.current;
                      if (c.a == null || c.b == null)
                        xCurRef.current = { ...c, [c.a == null ? "a" : "b"]: nx };
                    }
                    if (st.cursorY) {
                      const c = yCurRef.current;
                      if (c.a == null || c.b == null)
                        yCurRef.current = { ...c, [c.a == null ? "a" : "b"]: ny };
                    }
                    u.redraw();
                    syncMeasure();
                  }
                }
              }
              if (boxRef.current && e.button === 1) {
                const b = boxRef.current;
                boxRef.current = null;
                const l = Math.min(b.x0, b.x1);
                const rr = Math.max(b.x0, b.x1);
                const t = Math.min(b.y0, b.y1);
                const bt = Math.max(b.y0, b.y1);
                const x0v = xToVal(l);
                const x1v = xToVal(rr);
                const yTopv = yToVal(t);
                const yBotv = yToVal(bt);
                if (rr - l > 6 && x0v != null && x1v != null) {
                  u.setScale("x", { min: x0v, max: x1v });
                  setFollow(false);
                }
                if (bt - t > 6 && yTopv != null && yBotv != null) {
                  u.setScale("y", { min: yBotv, max: yTopv });
                  if (!settingsRef.current.yAuto) yManualRef.current = true;
                }
                u.redraw();
              }
            };
            // 空闲态光标反馈：靠近游标线 → 对应方向 resize 光标
            const onHover = (e: PointerEvent) => {
              if (panRef.current || boxRef.current || cursorDragRef.current) return;
              const st = settingsRef.current;
              if (!st.cursorX && !st.cursorY) {
                over.style.cursor = "";
                return;
              }
              const TOL = 9;
              let css = "";
              let best = Infinity;
              const near = (v: number | null, screen: number | null, dir: "x" | "y") => {
                if (v == null || screen == null) return;
                const d = Math.abs((dir === "x" ? e.clientX : e.clientY) - screen);
                if (d <= TOL && d < best) {
                  best = d;
                  css = dir === "x" ? "ew-resize" : "ns-resize";
                }
              };
              if (st.cursorX) {
                const c = xCurRef.current;
                near(c.a, valToScreenX(c.a ?? NaN), "x");
                near(c.b, valToScreenX(c.b ?? NaN), "x");
              }
              if (st.cursorY) {
                const c = yCurRef.current;
                near(c.a, valToScreenY(c.a ?? NaN), "y");
                near(c.b, valToScreenY(c.b ?? NaN), "y");
              }
              over.style.cursor = css;
            };
            const onCtx = (e: MouseEvent) => {
              e.preventDefault();
              setMenuPos(null);
              setSub(null);
              setSubPinned(false);
              setMenu({ x: e.clientX, y: e.clientY });
            };
            // 自绘十字线：uPlot 的 DOM 游标在 CSS zoom 下会被二次放大（错位根因），
            // 这里用「屏幕像素 ÷ zoom = 布局像素」写 transform，针尖与十字中心严格重合
            const crossV = document.createElement("div");
            const crossH = document.createElement("div");
            crossV.className = "plot-cross-v";
            crossH.className = "plot-cross-h";
            crossV.style.display = "none";
            crossH.style.display = "none";
            // prepend：让 uPlot 的悬停交叉点（后插入）始终浮于十字线之上
            over.insertBefore(crossV, over.firstChild);
            over.insertBefore(crossH, over.firstChild);
            const onEnter = () => {
              crossV.style.display = "";
              crossH.style.display = "";
            };
            const onLeave = () => {
              rawM.l = -10;
              rawM.t = -10;
              crossV.style.display = "none";
              crossH.style.display = "none";
              hoverTip.style.display = "none";
            };
            const onCross = (e: PointerEvent) => {
              const r = overRect();
              if (r.width === 0 || r.height === 0) return;
              // 全局 CSS zoom：屏幕像素 ÷ zoom = 布局像素（transform 走布局像素空间）
              const z = parseFloat(document.documentElement.style.zoom) / 100 || 1;
              rawM.l = e.clientX - r.left;
              rawM.t = e.clientY - r.top;
              crossV.style.transform = `translateX(${rawM.l / z}px)`;
              crossH.style.transform = `translateY(${rawM.t / z}px)`;
              updateHoverTip(r, z);
            };
            // 指针十字最近点读数：找与竖线交点最接近曲线的通道，淡显其 x/y 值
            const hoverTip = document.createElement("div");
            hoverTip.className = "plot-hover-tip";
            hoverTip.style.display = "none";
            over.appendChild(hoverTip);
            const updateHoverTip = (r: DOMRect, z: number) => {
              const st = settingsRef.current;
              const xs = u.data[0] as number[];
              const sy = u.scales.y;
              if (!xs.length || sy.min == null || sy.max == null) {
                hoverTip.style.display = "none";
                return;
              }
              // 统一布局像素空间：屏幕像素 ÷ zoom
              const lw = r.width / z;
              const lh = r.height / z;
              const lp = rawM.l / z;
              const lq = rawM.t / z;
              const fracX = Math.min(1, Math.max(0, lp / Math.max(1, lw)));
              const xv = (u.scales.x.min ?? 0) + fracX * ((u.scales.x.max ?? 1) - (u.scales.x.min ?? 0));
              let bestI = -1;
              let bestDy = Infinity;
              let bestV: number | null = null;
              for (let i = 0; i < channels.length; i++) {
                if (!channels[i].visible) continue;
                const fed = { t: xs, v: u.data[i + 1] as number[] };
                const raw = interpAt(fed, xv);
                if (raw == null) continue;
                // 堆叠：曲线画的是归一化值，屏幕位置按仿射换算；读数按原始值
                const af = affineRef.current[i];
                const disp = st.stack && af ? af.a * raw + af.b : raw;
                const screenY = ((sy.max - disp) / (sy.max - sy.min)) * lh;
                const d = Math.abs(screenY - lq);
                if (d < bestDy) {
                  bestDy = d;
                  bestI = i;
                  bestV = raw;
                }
              }
              // 距离曲线太远（>28 布局像素）不显示，避免无意义读数
              if (bestI < 0 || bestDy > 28 || bestV == null) {
                hoverTip.style.display = "none";
                return;
              }
              hoverTip.textContent = `${fmtX(xv)} · ${fmtVal(bestV)}`;
              hoverTip.style.display = "";
              // 贴着交点右上方淡显；靠近右缘翻到左侧
              const tipLeft = lp + 120 > lw - 10 ? lp - 118 : lp + 10;
              const tipTop = Math.min(Math.max(lq - 26, 2), lh - 20);
              hoverTip.style.transform = `translate(${tipLeft}px, ${tipTop}px)`;
              hoverTip.style.color = channels[bestI].color;
            };
            over.addEventListener("pointerdown", onDown);
            over.addEventListener("pointermove", onMove);
            over.addEventListener("pointerup", onUp);
            over.addEventListener("pointercancel", onUp);
            over.addEventListener("pointermove", onHover);
            over.addEventListener("pointerenter", onEnter);
            over.addEventListener("pointermove", onCross);
            over.addEventListener("pointerleave", onLeave);
            u.root.addEventListener("contextmenu", onCtx);
            removers.push(() => {
              over.removeEventListener("pointerdown", onDown);
              over.removeEventListener("pointermove", onMove);
              over.removeEventListener("pointerup", onUp);
              over.removeEventListener("pointercancel", onUp);
              over.removeEventListener("pointermove", onHover);
              over.removeEventListener("pointerenter", onEnter);
              over.removeEventListener("pointermove", onCross);
              over.removeEventListener("pointerleave", onLeave);
              crossV.remove();
              crossH.remove();
              hoverTip.remove();
              u.root.removeEventListener("contextmenu", onCtx);
              u.root.removeEventListener("dblclick", onDbl, true);
            });
            cleanupRefs.current.push(removers);
          },
        ],
      },
    };

    const initFull = plotStore.fullAligned();
    // 初始锚定可见末点（合并轴末点会被隐藏通道拉长）
    const initLast = plotStore.lastVisibleX();
    latestDispRef.current = initLast;
    startDispRef.current = initFull.x.length ? initFull.x[0] : null;
    let aligned: { x: number[]; cols: (number | null)[][] };
    if (initLast != null && st.xSource === "time") {
      const span0 = 30;
      aligned = plotStore.buildAlignedWindow(initLast - span0, initLast, FED_CAP);
    } else {
      aligned = plotStore.buildAligned(FED_CAP);
    }
    const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
    fedXRef.current = aligned.x;
    const u = new uPlot(opts, data, chart);
    uRef.current = u;
    setFollow(true);
    yManualRef.current = false;
    affineRef.current = channels.map(() => null);
    stackMetaRef.current = [];
    // 默认不自动铺设游标：由用户在图区单击放置（旧实现按全量范围 35%/65% 落位，
    // 跟随态下视野只显示最近窗口，游标会“飞到”视野外很远处）
    if (!st.cursorX) xCurRef.current = { a: null, b: null };
    if (!st.cursorY) yCurRef.current = { a: null, b: null };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot.channels, structuralSig, themeTick]);

  // 游标开关切换时立即重绘 + 关闭时清空对应游标，无需重建图表
  useEffect(() => {
    if (!plot.settings.cursorX) xCurRef.current = { a: null, b: null };
    if (!plot.settings.cursorY) yCurRef.current = { a: null, b: null };
    if (plot.settings.yAuto) yManualRef.current = false;
    measureKeyRef.current = "";
    syncMeasure();
    uRef.current?.redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot.settings.cursorX, plot.settings.cursorY, plot.settings.yAuto]);

  // 堆叠切换：Y 刻度域在 [0,1] 归一化与原始值之间互换，旧幅值游标数值失效 → 清空
  useEffect(() => {
    yCurRef.current = { a: null, b: null };
    measureKeyRef.current = "";
    syncMeasure();
    uRef.current?.redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot.settings.stack]);

  useEffect(() => {
    const timer = setInterval(() => {
      const u = uRef.current;
      const wrap = wrapRef.current;
      // 面板不可见（宽度为 0，如 dock 标签未激活）或整窗隐藏时才跳过；
      // 不用 IntersectionObserver——CSS zoom 下其判定不稳定，会把可见面板误判为
      // 不可见，导致数据停更、跟最新按钮“无反应”
      if (!u || !wrap || wrap.clientWidth === 0 || document.hidden) return;
      if (!plotStore.isDirty()) return;
      plotStore.clearDirty();
      const settings = plotStore.getSnapshot().settings;
      const snap = plotStore.getSnapshot();
      // —— 视窗计算：跟随态钉住可见最新点，浏览态用当前比例尺 ——
      const sx0 = u.scales.x;
      const curSpan = Math.max(
        (sx0.max ?? 0) - (sx0.min ?? 0),
        settings.xSource === "time" ? 10 : 200,
      );
      const full = plotStore.fullAligned();
      // 统一锚点 = 可见通道末点：合并轴/喂数末点会被仍在到货的隐藏通道拉长
      // （如 0x51 持续到货而可见的 0x52 已停止 → 末点在可见曲线前方），导致
      // 「最新」线漂移、跟随窗跟着空跑。lastVisibleX 保证曲线末端/最新线/窗三者重合
      const lastDisp = plotStore.lastVisibleX();
      startDispRef.current = full.x.length ? full.x[0] : null;
      let wLo: number;
      let wHi: number;
      if (followXRef.current && lastDisp != null) {
        wLo = lastDisp - curSpan * 0.95;
        wHi = lastDisp + curSpan * 0.05;
      } else if (sx0.min != null && sx0.max != null) {
        wLo = sx0.min;
        wHi = sx0.max;
      } else {
        wLo = full.x[0] ?? 0;
        wHi = full.x[full.x.length - 1] ?? 1;
      }
      // 视窗裁剪喂数：重绘成本只与视野内点数相关（卡顿根治点）
      const aligned = plotStore.buildAlignedWindow(wLo, wHi, FED_CAP);
      const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
      // 堆叠：先原地仿射变换再 setData —— 只触发一次重绘
      if (settings.stack) {
        const vis = snap.channels
          .map((ch, i) => ({ ch, i }))
          .filter((x) => x.ch.visible);
        const K = Math.max(1, vis.length);
        affineRef.current = snap.channels.map(() => null);
        stackMetaRef.current = vis.map((x) => ({
          ci: x.i,
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
          const pad = (mx - mn || Math.abs(mx) || 1) * 0.1;
          const lo = mn - pad;
          const hi = mx + pad;
          const a = 0.76 / (K * (hi - lo));
          const b = (slot + 0.5) / K - 0.38 / K - a * lo;
          // 变换写入新数组：plotStore 的对齐缓存跨 tick 复用同一批 cols 引用，
          // 原地改写会把归一化值当成原始值反复叠加
          const out: (number | null)[] = new Array(ys.length);
          for (let j = 0; j < ys.length; j++) {
            const v = ys[j];
            out[j] = v === null ? null : a * v + b;
          }
          data[x.i + 1] = out;
          affineRef.current[x.i] = { a, b };
          stackMetaRef.current[slot] = {
            ci: x.i,
            name: x.ch.name,
            color: x.ch.color,
            lo: mn,
            hi: mx,
          };
        });
      }
      fedXRef.current = aligned.x;
      // 锚点一律用可见末点 lastDisp：喂数末点（合并轴）可能含隐藏通道在
      // lastDisp 之后的点，用它会让「最新」线跑到可见曲线前方
      const anchor = lastDisp;
      latestDispRef.current = anchor;
      u.setData(data, false);
      // 拖拽/框选进行中：跳过一切会移动视口的操作，但仍显式重绘，
      // 让新数据实时上屏（旧实现此处 return 会漏掉 redraw → 卡住不动）
      const interacting = !!panRef.current || !!boxRef.current || !!cursorDragRef.current;
      if (!interacting && settings.yAuto && !settings.stack) {
        // Y 自适应只统计当前视野内的点（示波器行为）
        const r = yRangeOf(data, snap.channels, u.scales.x.min, u.scales.x.max, settings.yMode);
        if (r) u.setScale("y", { min: r[0], max: r[1] });
      } else if (!settings.stack && u.scales.y.min == null) {
        // yAuto 关闭且从未设过 Y：首帧做一次全量适配，否则 uPlot auto:false 下无范围 → 空白
        const r = yRangeOf(data, snap.channels, null, null, settings.yMode);
        if (r) u.setScale("y", { min: r[0], max: r[1] });
      }
      const xs = data[0];
      const sx = u.scales.x;
      const span = Math.max(
        (sx.max ?? 0) - (sx.min ?? 0),
        settings.xSource === "time" ? 10 : 200,
      );
      // 浏览态积压：视野右边界之外的新点数量（基于全量缓存二分，值不变不触发重渲染）
      let bl = 0;
      if (!followXRef.current && sx.max != null) {
        bl = plotStore.countAfterDisplay(sx.max);
      }
      if (bl !== backlogRef.current) {
        backlogRef.current = bl;
        setBacklog(bl);
      }
      // 游标测量：X（时间）/ Y（幅值）两套独立同步
      syncMeasure();
      if (followXRef.current && anchor != null && xs.length > 1) {
        // 跟随态：时间游标按窗口比例“骑行”，保持相对位置不变
        const c = xCurRef.current;
        let fa: number | null = null;
        let fb: number | null = null;
        if (settings.cursorX && sx.min != null && sx.max != null && sx.max > sx.min) {
          const s0 = sx.max - sx.min;
          if (c.a != null) fa = (c.a - sx.min) / s0;
          if (c.b != null) fb = (c.b - sx.min) / s0;
        }
        // 锚定喂数末点：与「最新」线、曲线末端三者在同一位置
        u.setScale("x", { min: anchor - span * 0.95, max: anchor + span * 0.05 });
        if (fa != null || fb != null) {
          const nmin = anchor - span * 0.95;
          xCurRef.current = {
            a: c.a != null && fa != null ? nmin + fa * span : c.a,
            b: c.b != null && fb != null ? nmin + fb * span : c.b,
          };
          u.redraw();
        }
      } else {
        // 浏览态 / 拖拽中显式重绘：uPlot 的 setData(data,false) 只更新数据引用、不触发绘制
        u.redraw();
      }
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, [plot.channels]);

  /** 一次性把 Y 适配到当前视野（不改变 yAuto 开关） */
  const fitYToView = () => {
    const u = uRef.current;
    if (!u || u.scales.y == null) return;
    const r = yRangeOf(u.data, plotStore.getSnapshot().channels, u.scales.x.min, u.scales.x.max, "fit");
    if (r) u.setScale("y", { min: r[0], max: r[1] });
    yManualRef.current = false;
  };

  /**
   * Auto 键（一次性执行，区别于 yAuto 连续开关）：X/Y 一步适配到全部数据的
   * 最佳观察范围——带边距、不顶格铺满，数据不贴边。执行后退出跟随、视野保持
   * 静态，直到用户再次操作（滚轮/拖动/跟最新）。与“双击回实时”互补：
   * 双击=保形只平移到最新，Auto=重新取景。
   */
  const fitView = () => {
    const u = uRef.current;
    if (!u) return;
    const full = plotStore.fullAligned();
    const n = full.x.length;
    if (!n) return;
    let x0 = full.x[0];
    let x1 = full.x[n - 1];
    if (x1 - x0 < 1e-9) {
      x0 -= 1;
      x1 += 1;
    }
    const padX = (x1 - x0) * 0.02;
    const lo = x0 - padX;
    const hi = x1 + padX;
    setFollow(false);
    yManualRef.current = false;
    // 先按目标视野重新喂数再设轴，避免 120ms 内曲线缺段闪断
    const aligned = plotStore.buildAlignedWindow(lo, hi, FED_CAP);
    const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
    fedXRef.current = aligned.x;
    u.setData(data, false);
    u.setScale("x", { min: lo, max: hi });
    if (!settingsRef.current.stack) {
      const r = yRangeOf(data, plotStore.getSnapshot().channels, lo, hi, settingsRef.current.yMode);
      if (r) u.setScale("y", { min: r[0], max: r[1] });
    }
    u.redraw();
  };

  const resetView = () => {
    setFollow(true);
    yManualRef.current = false;
    const u = uRef.current;
    if (!u || u.scales.y == null) return;
    // y 已显式 auto:false，setScale(y, undefined) 不再触发 uPlot 内部自适应；
    // 复位语义 = 回实时 + Y 全量适配（yAuto 开着时下一 tick 会按视野接管）
    if (!settingsRef.current.stack) {
      const r = yRangeOf(u.data, plotStore.getSnapshot().channels, null, null, settingsRef.current.yMode);
      if (r) u.setScale("y", { min: r[0], max: r[1] });
    }
    u.redraw();
  };

  const hasChannels = plot.channels.length > 0;
  const cursorXOn = plot.settings.cursorX;
  const cursorYOn = plot.settings.cursorY;
  const anyCursor = cursorXOn || cursorYOn;
  const hasXCursor = cursorXOn && !!(measureX || xCurRef.current.a != null || xCurRef.current.b != null);
  const hasYCursor = cursorYOn && !!(measureY || yCurRef.current.a != null || yCurRef.current.b != null);

  return (
    <div className="plot">
      <div className="plot-bar">
        <button
          className={`icon-btn ${plot.settings.yAuto ? "primary" : ""}`}
          onClick={() => {
            const next = !plot.settings.yAuto;
            plotStore.setSetting({ yAuto: next });
            if (next) yManualRef.current = false;
          }}
          title={
            plot.settings.yAuto
              ? "Y 轴随视野自动缩放：开（波形始终占满面板）"
              : "Y 轴随视野自动缩放：关（视野固定，波形更稳）"
          }
        >
          <IconAutoY />
        </button>
        <button
          className="icon-btn"
          onClick={fitView}
          title="Auto 自适应（执行一次）：X/Y 轴一步适配到全部数据的最佳观察范围（带边距），与 Y 轴连续自动缩放相互独立"
        >
          <IconFitView />
        </button>
        {hasChannels && (
          <button
            className="icon-btn"
            onClick={() => plotStore.clearChannels()}
            title="清空所有通道"
          >
            <IconTrash />
          </button>
        )}
        <button
          className={`icon-btn ${plot.settings.stack ? "primary" : ""}`}
          onClick={() => plotStore.setSetting({ stack: !plot.settings.stack })}
          title="多通道堆叠：每通道独立归一化，垂直均分显示（量纲不同的通道各看各的）"
        >
          <IconStack />
        </button>
        <button
          className={`icon-btn ${cursorXOn ? "primary" : ""}`}
          onClick={() => plotStore.setSetting({ cursorX: !cursorXOn })}
          title="时间游标（垂直标尺）：开启后在图上单击依次放置 A、B，测 Δt 与各通道取值差"
        >
          <IconCursorX />
        </button>
        <button
          className={`icon-btn ${cursorYOn ? "primary" : ""}`}
          onClick={() => plotStore.setSetting({ cursorY: !cursorYOn })}
          title="幅值游标（水平标尺）：开启后在图上单击依次放置 A、B，测 ΔV（堆叠模式按聚焦通道原始值）"
        >
          <IconCursorY />
        </button>
        <div className="plot-bar-spacer" />
        {plot.channels.map((ch) => {
          const hz = plotStore.sampleRate(ch.id);
          return (
            <span
              key={ch.id}
              className="plot-chip"
              title={`实际采样率约 ${hz.toFixed(0)} Hz（由设备输出率决定）\n点击名称聚焦该通道（再点恢复全部）`}
            >
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
        {anyCursor && !hasXCursor && !hasYCursor && (
          <div className="plot-cursor-hint">
            点击图表依次放置游标 <b>A</b>、<b>B</b>；拖动线条微调，双击线条删除
            {cursorXOn && cursorYOn ? "（时间游标=竖线，幅值游标=横线，同点铺设）" : ""}
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
        <div className="plot-measure-col">
        {measureX && (
          <div
            className="plot-measure"
            style={mpX ? { left: mpX.l, bottom: mpX.b, right: "auto" } : undefined}
          >
            <div className="plot-measure-head pm-drag" {...panelPointerProps("x")}>
              时间游标
              <span className="pm-hint">拖动竖线 / 双击删除</span>
              <button
                className="pm-clear"
                onClick={() => {
                  // 只清标尺、不关功能：A/B 置空后可在图上单击重新铺设
                  xCurRef.current = { a: null, b: null };
                  measureKeyRef.current = "";
                  setMeasureX(null);
                  uRef.current?.redraw();
                }}
                title="清除时间游标（功能保持开启，在图上单击可重新铺设）"
              >
                清除
              </button>
            </div>
            <div className="pm-pos">
              <span className="pm-tag a">A</span>
              <span className="pm-coord">{fmtX(measureX.a)}</span>
              <span className="pm-tag b">B</span>
              <span className="pm-coord">
                {measureX.b == null ? <i>点击图表放置 B</i> : fmtX(measureX.b)}
              </span>
            </div>
            {measureX.b != null && (
              <div className="plot-measure-dt">Δt = {fmtX(measureX.d)}</div>
            )}
            {measureX.rows.length > 0 && (
              <>
                <div className="plot-measure-grid plot-measure-head-row">
                  <span />
                  <span />
                  <span>V@A</span>
                  <span>V@B</span>
                  <span>ΔV</span>
                </div>
                {measureX.rows.map((r) => (
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
        {measureY && (
          <div
            className="plot-measure plot-measure-y"
            style={mpY ? { left: mpY.l, bottom: mpY.b, right: "auto" } : undefined}
          >
            <div className="plot-measure-head pm-drag" {...panelPointerProps("y")}>
              幅值游标
              <span className="pm-hint">拖动横线 / 双击删除</span>
              <button
                className="pm-clear"
                onClick={() => {
                  yCurRef.current = { a: null, b: null };
                  measureKeyRef.current = "";
                  setMeasureY(null);
                  uRef.current?.redraw();
                }}
                title="清除幅值游标（功能保持开启，在图上单击可重新铺设）"
              >
                清除
              </button>
            </div>
            <div className="pm-pos">
              <span className="pm-tag a">A</span>
              <span className="pm-coord">{fmtVal(measureY.a)}</span>
              <span className="pm-tag b">B</span>
              <span className="pm-coord">
                {measureY.b == null ? <i>点击图表放置 B</i> : fmtVal(measureY.b)}
              </span>
            </div>
            {measureY.b != null && (
              <div className="plot-measure-dt">ΔV = {fmtVal(measureY.d)}</div>
            )}
            {measureY.focus && (
              <div className="pm-focus">
                <span className="tpl-dot" style={{ background: measureY.focus.color }} />
                {measureY.focus.name}
              </div>
            )}
          </div>
        )}
        </div>
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
            <button
              className="ctx-item"
              onClick={() => {
                const next = !plot.settings.yAuto;
                plotStore.setSetting({ yAuto: next });
                if (next) yManualRef.current = false;
              }}
            >
              {plot.settings.yAuto ? "●" : "○"} Y 轴随视野自动缩放
            </button>
            <button className="ctx-item" onClick={fitView}>
              Auto 自适应（X/Y 一步取景，执行一次）
            </button>
            <div
              ref={xRowRef}
              className="ctx-row"
              onMouseEnter={() => {
                disarmSub();
                setSub("x");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                setSub((s) => (s === "x" ? null : "x"));
                setSubPinned(sub !== "x");
                disarmSub();
              }}
            >
              <button className="ctx-item">
                <span className="ctx-item-l">
                  X 轴源{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
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
              onMouseEnter={() => {
                disarmSub();
                setSub("y");
              }}
              onMouseLeave={() => {
                if (!subPinned) armSub();
              }}
              onClick={() => {
                setSub((s) => (s === "y" ? null : "y"));
                setSubPinned(sub !== "y");
                disarmSub();
              }}
            >
              <button className="ctx-item">
                <span className="ctx-item-l">
                  Y 轴源（通道显隐）{" "}
                  <span className="ctx-arrow">
                    <IconChevron size={12} />
                  </span>
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
              onClick={() => plotStore.setSetting({ cursorX: !plot.settings.cursorX })}
            >
              {plot.settings.cursorX ? "●" : "○"} 时间游标（垂直标尺 Δt）
            </button>
            <button
              className="ctx-item"
              onClick={() => plotStore.setSetting({ cursorY: !plot.settings.cursorY })}
            >
              {plot.settings.cursorY ? "●" : "○"} 幅值游标（水平标尺 ΔV）
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                setFollow(true);
                setMenu(null);
              }}
            >
              {followState ? "●" : "○"} X 轴跟随最新
            </button>
            <button className="ctx-item" onClick={fitYToView}>
              Y 轴适配视野
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
