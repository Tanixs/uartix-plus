import type uPlot from "uplot";

export function fmtVal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

export function hexA(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 游标测量面板位置持久化（布局像素，相对 .plot-wrap 左下锚点）。
 *  未保存过位置时返回 null → 使用 CSS 默认（X 左下、Y 右下），避免窄容器下溢出 */
const PANEL_POS_KEY = "vs.plotPanelPos";
export type PanelPos = { l: number; b: number };
export function readPanelPos(which: "x" | "y"): PanelPos | null {
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
export function writePanelPos(which: "x" | "y", pos: PanelPos) {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    const p = (raw ? JSON.parse(raw) : {}) as Record<"x" | "y", PanelPos>;
    p[which] = pos;
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(p));
  } catch {
    /* 存储不可用则仅本次会话生效 */
  }
}

/** 游标测量：按时间在通道数据上线性插值取值 */
export function interpAt(
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
export function yRangeOf(
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
export interface Measure {
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
export function stackSlotOf(norm: number, k: number): number {
  return Math.min(k - 1, Math.max(0, Math.floor(norm * k)));
}

/** 构建测量数据：游标 A 放置后即显示，B 齐全时补充 Δ */
export function buildMeasure(
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
