import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 菜单级联浮层：portal 到 body，锚定任意元素右侧展开（空间不足自动翻左、垂直夹紧、zoom 补偿）。
 * 定位直接写 DOM style，绝不 setState（曾因 layout effect 里 setPos 新对象导致无限重渲染白屏）。
 */
export function Flyout(props: {
  anchor: HTMLElement | null;
  zf: number;
  onArm?: () => void;
  onDisarm?: () => void;
  minWidth?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const a = props.anchor;
    if (!el || !a || !a.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;
    const ar = a.getBoundingClientRect();
    const zf = props.zf || 1;
    let left = ar.right + 4;
    if (left + r.width > window.innerWidth - 8) left = ar.left - r.width - 4;
    left = Math.max(8, left);
    let top = ar.top - 6;
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - r.height - 8));
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu ctx-flyout"
      style={{
        left: -9999,
        top: -9999,
        visibility: "hidden",
        ...(props.minWidth ? { minWidth: props.minWidth } : null),
      }}
      onMouseEnter={props.onDisarm}
      onMouseLeave={props.onArm}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.children}
    </div>,
    document.body,
  );
}
