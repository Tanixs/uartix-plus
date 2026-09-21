import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 通用下拉浮层（P90 C2）：portal 到 body + fixed 定位，锚定触发按钮下方展开。
 * 存在的理由：工具栏/输入区都带 overflow，容器内 absolute 弹层会被裁到只剩几像素
 * （§8-20 红线）；同时统一「点外关闭 / Escape 关闭 / 焦点归还」三件事。
 * 定位一律直接写 DOM style，绝不在 layout effect 里 setState（P88c 无限重渲染白屏教训）。
 */
export function Dropdown(props: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { anchor, open, onClose, align = "start" } = props;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el || !anchor || !anchor.isConnected) return;
    const zf = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const ar = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? ar.right - r.width : ar.left;
    left = Math.min(Math.max(8, left), Math.max(8, vw - r.width - 8));
    let top = ar.bottom + 4;
    if (top + r.height > vh - 8) top = Math.max(8, ar.top - r.height - 4);
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      anchor?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={`ui-dropdown${props.className ? ` ${props.className}` : ""}`}
      role="menu"
      style={{ left: -9999, top: -9999, visibility: "hidden" }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
