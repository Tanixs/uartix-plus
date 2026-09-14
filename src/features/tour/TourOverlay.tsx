/**
 * 教学引导浮层（P78a）：SVG evenodd 挖孔聚光灯 + portal 气泡。
 *
 * 坐标全部走「屏幕像素 ÷ document zoom」（项目指针红线；与 OrchDropdown/SentinelFloat 同法）。
 * 遮罩纯视觉不拦截点击（用户仍可操作高亮目标，如真的去点眼睛）；气泡按钮是唯一交互入口。
 * 目标定位 rAF 循环跟随（拖动分栏/滚动时挖孔不脱靶）；目标在宽限期内没出现 → 降级为居中卡片继续讲。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as tourStore from "./tourStore";
import { tx, useLocale } from "../../i18n/strings";
import { IconClose } from "../../shared/icons";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

export function TourOverlay() {
  useLocale();
  const s = useSyncExternalStore(tourStore.subscribe, tourStore.getSnapshot);
  const step = s.active ? s.steps[s.idx] : undefined;
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  const centered = !step?.selector || missing;

  // 目标矩形 rAF 跟随：只在变化超阈值时 setState，静止零渲染
  useEffect(() => {
    if (!s.active || !step?.selector) {
      setRect(null);
      setMissing(!step?.selector);
      return;
    }
    setRect(null);
    setMissing(false);
    const grace = (step.settleMs ?? 600) + 2200;
    const t0 = performance.now();
    let raf = 0;
    let last: Rect | null = null;
    const tick = () => {
      const el = document.querySelector(step.selector!);
      if (el) {
        const r = el.getBoundingClientRect();
        const zf = zoomFactor();
        const next: Rect = { x: r.left / zf, y: r.top / zf, w: r.width / zf, h: r.height / zf };
        if (
          next.w > 0 &&
          next.h > 0 &&
          (!last || Math.abs(last.x - next.x) > 0.5 || Math.abs(last.y - next.y) > 0.5 || Math.abs(last.w - next.w) > 0.5 || Math.abs(last.h - next.h) > 0.5)
        ) {
          last = next;
          setRect(next);
        }
      } else if (!last && performance.now() - t0 > grace) {
        setMissing(true); // 宽限期后仍找不到 → 居中卡片降级
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [s.active, s.idx, step?.selector, step?.settleMs]);

  // 键盘闭环：Enter/→ 下一步，Esc 退出（输入框聚焦时忽略）
  useEffect(() => {
    if (!s.active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") tourStore.stop();
      else if (e.key === "Enter" || e.key === "ArrowRight") tourStore.next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.active]);

  // 气泡定位：measure → 直写 DOM style（Flyout 教训：定位不 setState）
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !s.active) return;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth / zoomFactor();
    const vh = window.innerHeight / zoomFactor();
    let left: number;
    let top: number;
    if (centered || !rect) {
      left = (vw - w) / 2;
      top = (vh - h) / 2;
    } else {
      left = rect.x + rect.w / 2 - w / 2;
      top = rect.y + rect.h + 14;
      if (top + h > vh - 10) top = Math.max(10, rect.y - h - 14);
      left = Math.min(Math.max(10, left), vw - w - 10);
    }
    pop.style.left = `${Math.max(10, left)}px`;
    pop.style.top = `${Math.max(10, top)}px`;
    pop.style.visibility = "visible";
  }, [centered, rect, s.idx, s.active]);

  if (!s.active || !step) return null;
  const last = s.idx >= s.steps.length - 1;

  // 外框用固定超大矩形：evenodd 照常挖孔，且不受窗口 resize 影响
  const maskPath = rect
    ? `M-4000 -4000 H14000 V14000 H-4000 Z M${r(rect.x)} ${r(rect.y)} h${r(rect.w)} v${r(rect.h)} h${-r(rect.w)} Z`
    : null;

  return (
    <>
      {maskPath && (
        <svg className="tour-mask" width="100%" height="100%">
          <path d={maskPath} fillRule="evenodd" />
        </svg>
      )}
      {rect && (
        <div
          className="tour-ring"
          style={{ left: rect.x - 6, top: rect.y - 6, width: rect.w + 12, height: rect.h + 12 }}
        />
      )}
      {createPortal(
        <div
          ref={popRef}
          className={`tour-pop${centered ? " center" : ""}`}
          style={{ left: -9999, top: -9999, visibility: "hidden" }}
          role="dialog"
          aria-modal="true"
        >
          <button className="tour-pop-x" title={tx("退出引导", "Quit tour")} onClick={() => tourStore.stop()}>
            <IconClose />
          </button>
          <div className="tour-pop-n">
            {tx(`第 ${s.idx + 1} 步 · 共 ${s.total} 步`, `Step ${s.idx + 1} of ${s.total}`)}
          </div>
          <div className="tour-pop-h">{tx(step.title.zh, step.title.en)}</div>
          <div className="tour-pop-b">{tx(step.body.zh, step.body.en)}</div>
          <div className="tour-pop-foot">
            <button className="btn sm" disabled={s.idx === 0} onClick={() => tourStore.prev()}>
              {tx("上一步", "Back")}
            </button>
            <span className="tour-sp" />
            <button className="btn primary sm" onClick={() => tourStore.next()}>
              {last ? tx("完成", "Finish") : tx("下一步", "Next")}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

const r = (v: number): number => Math.round(v * 10) / 10;
