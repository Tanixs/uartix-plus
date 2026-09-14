import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 列表拖拽共享内核（P75 B3）——编排器画布与序列器步骤树共用。
 *
 * 旧实现（两处各自为政的 window pointer 方案）的病灶：
 * 1. 无 setPointerCapture / pointercancel 兜底 → 指针移出窗口后事件丢失，拖拽"卡死"；
 * 2. 每次 pointermove 直接 setState（drop 指示）→ 整棵面板树重渲染 + elementFromPoint
 *    + getBoundingClientRect + 递归 findNode 全套重算 → 高频下掉帧，"像拖不动"；
 * 3. 无 ghost、无光标反馈 → 按下后没有任何"拖起来了"的观感，直到恰好扫过别的行才出现指示条。
 *
 * 本内核的对策：
 * - setPointerCapture + pointercancel/blur 兜底，Esc 取消；
 * - rAF 合帧：move 事件只记录坐标，命中测试/指示器/ghost/自动滚动每帧至多跑一次；
 * - 行矩形缓存：拖拽开始时快照全部行，滚动/缩放才失效重建；命中为纯 Y 带二分，
 *   不再做 elementFromPoint/递归查树（消费者需要时自行探测）；
 * - 落点指示与 ghost 全部直写 DOM（类切换 / transform），拖拽期间主树零 setState；
 * - 4px 激活阈值：按住不动或误触不会误落，点击语义保留；
 * - ghost 经 portal 挂 body，跟随指针（按根节点 zoom 修正），grabbing 光标 + 禁选中。
 *
 * 消费者职责（onFrame）：从 hover(ratio) + 自家节点索引算出落点语义（before/after/in）、
 * 返回 { mark, data }；mark 直写指示类，data 在松手时原样交给 onDrop。
 */

export type DragPos = "before" | "after" | "in";

/** 一行在拖拽期间的视口纵带（缓存态，滚动即失效） */
export interface RowBand {
  top: number;
  bottom: number;
}

/** Y 带命中结果：行索引 + 指针在行内的纵向比例（0 顶 / 1 底） */
export interface RowHit {
  index: number;
  ratio: number;
}

/**
 * 在按 top 升序的行带中命中 clientY 所在行；行间空隙 ≤ tolPx 时吸附到最近行
 * （ratio 取 0/1，即"贴上沿=before / 贴下沿=after"），空隙过大（组卡之间）返回 null。
 * 纯函数：二分查找，O(log n)，供内核每帧调用与单测。
 */
export function pickRow(bands: RowBand[], y: number, tolPx = 14): RowHit | null {
  if (bands.length === 0) return null;
  // 二分：最后一个 top <= y 的行
  let lo = 0;
  let hi = bands.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bands[mid].top <= y) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i >= 0 && y <= bands[i].bottom) {
    const h = Math.max(1, bands[i].bottom - bands[i].top);
    return { index: i, ratio: Math.min(1, Math.max(0, (y - bands[i].top) / h)) };
  }
  const dPrev = i >= 0 ? y - bands[i].bottom : Infinity;
  const dNext = i + 1 < bands.length ? bands[i + 1].top - y : Infinity;
  if (dPrev <= dNext && dPrev <= tolPx) return { index: i, ratio: 1 };
  if (dNext < dPrev && dNext <= tolPx) return { index: i + 1, ratio: 0 };
  return null;
}

/** Y 带命中的行（消费者按 ratio 决定 before/after/in） */
export interface DragHover {
  rowId: string;
  el: HTMLElement;
  ratio: number;
}

/** 每帧输入：指针视口坐标 + Y 带命中行（不在任何行上为 null） */
export interface DragFrame {
  x: number;
  y: number;
  hover: DragHover | null;
}

/** 落点指示：内核直接切换 el 上的 CSS 类（与 React 主树解耦） */
export interface DragMark {
  el: HTMLElement;
  cls: string;
}

/** onFrame 的返回：mark 之外的落点语义由消费者自定义，松手时原样交给 onDrop */
export interface DragDecision<D> {
  mark: DragMark | null;
  data: D;
}

export interface ListDragOpts<P, D> {
  /** 行选择器，如 "[data-orch-row]" */
  rowSelector: string;
  /** 行 id 所在的 dataset 键（camelCase），如 "orchRow" */
  rowIdAttr: string;
  /** 滚动画布选择器（同时限定行快照范围 + 自动滚动目标），如 ".orch-canvas" */
  scrollSelector: string;
  /** 每帧回调：返回落点决策；返回 null = 当前不是有效落点 */
  onFrame: (payload: P, frame: DragFrame) => DragDecision<D> | null;
  /** 松手回调：最后一次非 null 决策的 data（无则不触发） */
  onDrop: (payload: P, data: D) => void;
  /** ghost 内容（可选；不传则无 ghost，仅光标反馈） */
  renderGhost?: (payload: P) => ReactNode;
}

interface Sess<P, D> {
  payload: P;
  startX: number;
  startY: number;
  px: number;
  py: number;
  active: boolean;
  rows: { id: string; el: HTMLElement }[];
  rects: RowBand[] | null;
  scrollEl: HTMLElement | null;
  raf: number;
  mark: DragMark | null;
  last: DragDecision<D> | null;
  size: { w: number; h: number } | null;
  cleanup: () => void;
}

const ACTIVATE_PX = 4;
const EDGE_MARGIN = 44;
const GAP_TOL_PX = 14;

/**
 * 用法：
 *   const drag = useListDrag<P, D>({ ... });
 *   <span onPointerDown={(e) => drag.begin(e, payload)}>柄</span>
 *   {drag.ghost}
 */
export function useListDrag<P, D>(opts: ListDragOpts<P, D>) {
  // 回调经 ref 转发：面板 500ms tick 等重渲染后，拖拽中读到的一直是最新闭包
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessRef = useRef<Sess<P, D> | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [ghostPayload, setGhostPayload] = useState<P | null>(null);

  const applyMark = (s: Sess<P, D>, mark: DragMark | null) => {
    const cur = s.mark;
    if (cur && mark && cur.el === mark.el && cur.cls === mark.cls) return;
    if (cur) cur.el.classList.remove(cur.cls);
    if (mark) mark.el.classList.add(mark.cls);
    s.mark = mark;
  };

  const moveGhost = (s: Sess<P, D>) => {
    const el = ghostRef.current;
    if (!el) return;
    if (!s.size) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) s.size = { w: r.width, h: r.height };
    }
    const zf = Number(getComputedStyle(document.documentElement).zoom) || 1;
    let x = s.px + 14;
    let y = s.py + 18;
    const w = s.size?.w ?? 0;
    const h = s.size?.h ?? 0;
    if (w > 0 && x + w > window.innerWidth - 8) x = s.px - w - 10;
    if (h > 0 && y + h > window.innerHeight - 8) y = s.py - h - 10;
    x = Math.max(8, x);
    y = Math.max(8, y);
    // portal 挂在 body 下，受根节点 zoom 缩放：视口 px → 本地 px
    el.style.transform = `translate(${x / zf}px, ${y / zf}px)`;
  };

  const autoScroll = (s: Sess<P, D>) => {
    const sc = s.scrollEl;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    let v = 0;
    if (s.py < r.top + EDGE_MARGIN) v = -Math.ceil((1 - Math.max(0, s.py - r.top) / EDGE_MARGIN) * 16);
    else if (s.py > r.bottom - EDGE_MARGIN) v = Math.ceil((1 - Math.max(0, r.bottom - s.py) / EDGE_MARGIN) * 16);
    if (v !== 0) {
      sc.scrollTop += v;
      s.rects = null; // 滚动后矩形缓存失效
    }
  };

  const tick = () => {
    const s = sessRef.current;
    if (!s || !s.active) return;
    autoScroll(s);
    if (s.rects === null) {
      s.rects = s.rows.map(({ el }) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
    }
    const hit = pickRow(s.rects, s.py, GAP_TOL_PX);
    const hover: DragHover | null = hit
      ? { rowId: s.rows[hit.index].id, el: s.rows[hit.index].el, ratio: hit.ratio }
      : null;
    const dec = optsRef.current.onFrame(s.payload, { x: s.px, y: s.py, hover });
    s.last = dec;
    applyMark(s, dec?.mark ?? null);
    moveGhost(s);
    s.raf = requestAnimationFrame(tick);
  };

  const finish = (drop: boolean) => {
    const s = sessRef.current;
    sessRef.current = null;
    if (!s) return;
    s.cleanup();
    cancelAnimationFrame(s.raf);
    applyMark(s, null);
    document.documentElement.classList.remove("drag-active");
    setGhostPayload(null);
    if (!s.active || !drop || !s.last) return;
    optsRef.current.onDrop(s.payload, s.last.data);
  };

  const activate = (s: Sess<P, D>) => {
    s.active = true;
    document.documentElement.classList.add("drag-active");
    setGhostPayload(s.payload);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    };
    const invalidate = () => {
      s.rects = null;
    };
    s.scrollEl?.addEventListener("scroll", invalidate, { passive: true });
    window.addEventListener("resize", invalidate);
    window.addEventListener("keydown", onKey);
    const base = s.cleanup;
    s.cleanup = () => {
      base();
      s.scrollEl?.removeEventListener("scroll", invalidate);
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("keydown", onKey);
    };
    s.raf = requestAnimationFrame(tick);
  };

  /** 拖柄的 onPointerDown 入口 */
  const begin = (e: React.PointerEvent, payload: P) => {
    if (e.button !== 0) return;
    if (sessRef.current) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 指针已释放等异常不致命：window 监听仍兜底
    }
    const o = optsRef.current;
    const sc = document.querySelector<HTMLElement>(o.scrollSelector);
    const rows = (sc ?? document).querySelectorAll<HTMLElement>(o.rowSelector);
    const move = (ev: PointerEvent) => {
      const s = sessRef.current;
      if (!s) return;
      s.px = ev.clientX;
      s.py = ev.clientY;
      if (!s.active) {
        const dx = ev.clientX - s.startX;
        const dy = ev.clientY - s.startY;
        if (dx * dx + dy * dy > ACTIVATE_PX * ACTIVATE_PX) activate(s);
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    const sess: Sess<P, D> = {
      payload,
      startX: e.clientX,
      startY: e.clientY,
      px: e.clientX,
      py: e.clientY,
      active: false,
      rows: Array.from(rows).map((el) => ({ id: el.dataset[o.rowIdAttr] ?? "", el })),
      rects: null,
      scrollEl: sc,
      raf: 0,
      mark: null,
      last: null,
      size: null,
      cleanup: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
      },
    };
    sessRef.current = sess;
  };

  const ghost =
    ghostPayload && opts.renderGhost
      ? createPortal(
          <div ref={ghostRef} className="drag-ghost" style={{ transform: "translate(-9999px, -9999px)" }}>
            {opts.renderGhost(ghostPayload)}
          </div>,
          document.body,
        )
      : null;

  return { begin, ghost };
}
