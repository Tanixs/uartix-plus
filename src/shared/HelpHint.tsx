import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function HelpHint({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    const a = ref.current;
    if (!open || !el || !a) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const ar = a.getBoundingClientRect();
    const zf = Number(getComputedStyle(document.documentElement).zoom) || 1;
    let left = ar.left + ar.width / 2 - r.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    let top = ar.top - r.height - 8;
    if (top < 8) top = ar.bottom + 8;
    top = Math.max(8, top);
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });

  return (
    <>
      <span
        ref={ref}
        className="help-hint"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        ?
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            className="help-bubble"
            style={{ left: -9999, top: -9999, visibility: "hidden" }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
