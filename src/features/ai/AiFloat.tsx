import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AiChat } from "./AiChat";
import { IconSparkle } from "../../shared/icons";

/** v2：以「右下角锚点」持久化，窗口尺寸变化时始终贴边不漂移 */
const POS_KEY = "vs.aiFloat.v2";

interface FloatState {
  /** 距窗口右缘的偏移（px，逻辑坐标） */
  right: number;
  /** 距窗口下缘的偏移（px，逻辑坐标） */
  bottom: number;
  w: number;
  h: number;
  min: boolean;
}

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

function vwvh(): { vw: number; vh: number } {
  const zf = zoomFactor();
  return { vw: window.innerWidth / zf, vh: window.innerHeight / zf };
}

function fallbackState(): FloatState {
  const { vh } = vwvh();
  const w = 400;
  const h = Math.min(560, vh - 120);
  return { right: 24, bottom: 24, w, h, min: false };
}

function loadState(): FloatState {
  const fb = fallbackState();
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return fb;
    const p = JSON.parse(raw) as Partial<FloatState>;
    return {
      right: typeof p.right === "number" ? p.right : fb.right,
      bottom: typeof p.bottom === "number" ? p.bottom : fb.bottom,
      w: typeof p.w === "number" ? Math.max(320, p.w) : fb.w,
      h: typeof p.h === "number" ? Math.max(280, p.h) : fb.h,
      min: Boolean(p.min),
    };
  } catch {
    return fb;
  }
}

/** 在 x/y 语义下钳制，再换算回右下角锚点（保证浮窗至少 80px 留在屏内） */
function clampState(s: FloatState): FloatState {
  const { vw, vh } = vwvh();
  const w = Math.min(Math.max(320, s.w), Math.max(320, vw - 40));
  const h = Math.min(Math.max(280, s.h), Math.max(280, vh - 80));
  const x = vw - s.right - w;
  const y = vh - s.bottom - h;
  const cx = Math.min(Math.max(-w + 80, x), vw - 80);
  const cy = Math.min(Math.max(0, y), vh - 48);
  return { ...s, w, h, right: vw - cx - w, bottom: vh - cy - h };
}

export function AiFloat({
  onDock,
  onClose,
}: {
  onDock: () => void;
  onClose: () => void;
}) {
  const [st, setSt] = useState<FloatState>(() => clampState(loadState()));
  const [, setTick] = useState(0);
  const dragRef = useRef<{
    kind: "move" | "resize";
    sx: number;
    sy: number;
    or: number;
    ob: number;
    ow: number;
    oh: number;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(POS_KEY, JSON.stringify(st));
  }, [st]);

  // 窗口缩放 / 缩放系数变化时重钳制（右下角锚点自动跟随）
  useEffect(() => {
    const onResize = () => setSt((s) => clampState(s));
    const onZoom = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("vs-zoom-change", onZoom);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("vs-zoom-change", onZoom);
    };
  }, []);

  const { vw, vh } = vwvh();
  const left = vw - st.right - st.w;
  const top = vh - st.bottom - st.h;

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const zf = zoomFactor();
    const dx = (e.clientX - d.sx) / zf;
    const dy = (e.clientY - d.sy) / zf;
    if (d.kind === "move") {
      setSt((s) =>
        clampState({ ...s, right: d.or - dx, bottom: d.ob - dy }),
      );
    } else {
      setSt((s) =>
        clampState({ ...s, w: d.ow + dx, h: d.oh + dy }),
      );
    }
  };

  const startDrag = (kind: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      sx: e.clientX,
      sy: e.clientY,
      or: st.right,
      ob: st.bottom,
      ow: st.w,
      oh: st.h,
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
        style={{ left, top, width: st.w, height: st.h }}
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
