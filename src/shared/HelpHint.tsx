import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function HelpHint({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || !bubbleRef.current) return;
    const r = ref.current.getBoundingClientRect();
    const bw = bubbleRef.current.offsetWidth;
    const bh = bubbleRef.current.offsetHeight;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = r.top - bh - 8;
    if (top < 8) top = r.bottom + 8;
    setPos({ left, top });
  }, [open, text]);

  return (
    <>
      <span
        ref={ref}
        className="help-hint"
        onMouseEnter={() => {
          setPos(null);
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
      >
        ?
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            className="help-bubble"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
