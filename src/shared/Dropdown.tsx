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
    /* §19：CSS zoom 下 vh/vw 双重缩放。实测（1098×824 窗口）：`.ui-dropdown` 的
       `calc(100vh - 16px)` 在 110% 档把浮层撑到超出窗口 74px、125% 档 196px——
       底部那几项就点不到了。`innerHeight` 是视觉像素、不随 zoom 变，而写进 style 的
       长度会被再放大 zf 倍，所以要按 zf 折算。与下面 left/top 的 ÷zf 是同一个换算。
       F2 给 `.ctx-menu` 用的是静态 420px 上限；这里按屏算，高屏不必被一视同仁地截短。
       必须在量 r.height 之前写：翻到上方那支判断用的就是这个高度。 */
    el.style.maxHeight = `${Math.max(160, (window.innerHeight - 16) / zf)}px`;
    el.style.maxWidth = `${Math.min(340, (window.innerWidth - 16) / zf)}px`;
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
      data-elev="4"
      role="menu"
      style={{ left: -9999, top: -9999, visibility: "hidden" }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
