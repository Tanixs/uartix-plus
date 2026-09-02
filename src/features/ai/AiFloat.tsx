import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AiChat } from "./AiChat";
import { IconSparkle } from "../../shared/icons";

const POS_KEY = "vs.aiFloat";

interface FloatState {
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
}

function loadState(): FloatState {
  const fallback: FloatState = {
    x: Math.max(24, window.innerWidth - 420),
    y: Math.max(80, Math.round(window.innerHeight * 0.12)),
    w: 400,
    h: Math.min(560, window.innerHeight - 160),
    min: false,
  };
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<FloatState>;
    return {
      x: typeof p.x === "number" ? p.x : fallback.x,
      y: typeof p.y === "number" ? p.y : fallback.y,
      w: typeof p.w === "number" ? Math.max(320, p.w) : fallback.w,
      h: typeof p.h === "number" ? Math.max(280, p.h) : fallback.h,
      min: Boolean(p.min),
    };
  } catch {
    return fallback;
  }
}

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

function clampState(s: FloatState): FloatState {
  const zf = zoomFactor();
  const vw = window.innerWidth / zf;
  const vh = window.innerHeight / zf;
  return {
    ...s,
    x: Math.min(Math.max(-s.w + 80, s.x), vw - 80),
    y: Math.min(Math.max(0, s.y), vh - 48),
    w: Math.min(Math.max(320, s.w), Math.max(320, vw - 40)),
    h: Math.min(Math.max(280, s.h), Math.max(280, vh - 80)),
  };
}

export function AiFloat({
  onDock,
  onClose,
}: {
  onDock: () => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<FloatState>(() => clampState(loadState()));
  const dragRef = useRef<{
    kind: "move" | "resize";
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(POS_KEY, JSON.stringify(st));
  }, [st]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const zf = zoomFactor();
      const dx = (e.clientX - d.sx) / zf;
      const dy = (e.clientY - d.sy) / zf;
      if (d.kind === "move") {
        setSt((s) => clampState({ ...s, x: d.ox + dx, y: d.oy + dy }));
      } else {
        setSt((s) => clampState({ ...s, w: d.ow + dx, h: d.oh + dy }));
      }
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

  const startDrag = (kind: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      sx: e.clientX,
      sy: e.clientY,
      ox: st.x,
      oy: st.y,
      ow: st.w,
      oh: st.h,
    };
  };

  return createPortal(
    st.min ? (
      <button
        className="ai-bubble"
        title="展开 AI 助手（Ctrl+K）"
        onClick={() => setSt((s) => ({ ...s, min: false }))}
      >
        <IconSparkle />
      </button>
    ) : (
      <div
        className="ai-float"
        style={{ left: st.x, top: st.y, width: st.w, height: st.h }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="ai-float-head"
          onPointerDown={startDrag("move")}
          onDoubleClick={() => setSt((s) => ({ ...s, min: true }))}
        >
          <span className="ai-float-title">
            <IconSparkle />
            AI 助手
          </span>
          <button className="ai-float-btn" title="最小化到气泡" onClick={() => setSt((s) => ({ ...s, min: true }))}>
            <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button className="ai-float-btn" title="关闭浮窗" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </div>
        <div className="ai-float-body">
          <AiChat onDock={onDock} />
        </div>
        <div className="ai-float-grip" onPointerDown={startDrag("resize")} />
      </div>
    ),
    document.body,
  );
}
