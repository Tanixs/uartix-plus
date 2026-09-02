import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWidgets, setOpen } from "./widgetStore";
import { WidgetFrame } from "./WidgetFrame";

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

function SingleFloat({
  id,
  name,
  html,
  index,
}: {
  id: string;
  name: string;
  html: string;
  index: number;
}) {
  const [pos, setPos] = useState({ x: window.innerWidth - 320, y: 80 + index * 40 });
  const [height, setHeight] = useState(160);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const zf = zoomFactor();
      setPos({ x: d.ox + (e.clientX - d.sx) / zf, y: d.oy + (e.clientY - d.sy) / zf });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const widget = { id, name, html, createdAt: 0 };
  return createPortal(
    <div className="aiw-float" style={{ left: pos.x, top: pos.y }}>
      <div
        className="aiw-float-head"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
        }}
      >
        <span className="aiw-float-title">{name}</span>
        <button
          className="ai-float-btn"
          title="弹出为桌面挂件（独立置顶小窗）"
          onClick={async () => {
            const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            void setOpen(id, false);
            new WebviewWindow(`aiwidget-${id.slice(0, 8)}`, {
              url: `${location.origin}${location.pathname}#/aiwidget-desktop/${id}`,
              title: name,
              width: 280,
              height: 240,
              alwaysOnTop: true,
              decorations: false,
            });
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 4h5v5" /><path d="M20 4l-7 7" /><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></svg>
        </button>
        <button className="ai-float-btn" title="收起" onClick={() => setOpen(id, false)}>
          <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
      </div>
      <div className="aiw-float-body" style={{ height }}>
        <WidgetFrame widget={widget} isDesktop={false} onHeight={setHeight} />
      </div>
    </div>,
    document.body,
  );
}

export function WidgetFloats() {
  const ws = useWidgets();
  const opened = ws.widgets.filter((w) => ws.openIds.includes(w.id));
  return (
    <>
      {opened.map((w, i) => (
        <SingleFloat key={w.id} id={w.id} name={w.name} html={w.html} index={i} />
      ))}
    </>
  );
}
