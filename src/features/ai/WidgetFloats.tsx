import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useExtensions, setOpen, type AiExtension } from "./extensionStore";
import { WidgetFrame, type WidgetFrameHandle } from "./WidgetFrame";
import { popWidgetToDesktop, type WidgetMenuItem } from "./widgetShell";

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function SingleFloat({
  id,
  name,
  html,
  chrome,
  index,
}: {
  id: string;
  name: string;
  html: string;
  chrome?: "none";
  index: number;
}) {
  const bare = chrome === "none";
  const [pos, setPos] = useState({ x: window.innerWidth - 320, y: 80 + index * 40 });
  const [size, setSize] = useState({ w: bare ? 200 : 260, h: 160 });
  const boxRef = useRef<HTMLDivElement>(null);
  const frameHandle = useRef<WidgetFrameHandle>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // 标题栏拖拽（非无边框形态）
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

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
  };

  // 钳制：至少 24px 留在视口内，永不丢失
  const moveByDelta = useCallback((dx: number, dy: number) => {
    setPos((p) => ({
      x: clamp(p.x + dx, 24 - sizeRef.current.w, window.innerWidth - 24),
      y: clamp(p.y + dy, 0, window.innerHeight - 24),
    }));
  }, []);

  const onWin = useCallback(
    async (req: { action: string } & Record<string, unknown>) => {
      switch (req.action) {
        case "dragDelta":
          moveByDelta(Number(req.dx) || 0, Number(req.dy) || 0);
          break;
        case "dragEnd":
          break;
        case "move": {
          const x = Number(req.x);
          const y = Number(req.y);
          if (Number.isFinite(x) && Number.isFinite(y))
            setPos({
              x: clamp(x, 24 - sizeRef.current.w, window.innerWidth - 24),
              y: clamp(y, 0, window.innerHeight - 24),
            });
          break;
        }
        case "moveBy":
          moveByDelta(Number(req.dx) || 0, Number(req.dy) || 0);
          break;
        case "size": {
          const w = Number(req.w);
          const h = Number(req.h);
          setSize((s) => ({
            w: Number.isFinite(w) && w >= 60 && w <= 1200 ? w : s.w,
            h: Number.isFinite(h) && h >= 40 && h <= 2000 ? h : s.h,
          }));
          break;
        }
        case "close":
          setOpen(id, false);
          break;
        case "popOut":
          popWidgetToDesktop({ id, name, chrome });
          break;
        case "get":
          return {
            data: { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h },
          };
        default:
          break;
      }
    },
    [id, name, chrome, moveByDelta],
  );

  const sysMenu = useCallback(
    (): WidgetMenuItem[] => [
      { label: "弹出为桌面挂件", onClick: () => popWidgetToDesktop({ id, name, chrome }) },
      { label: "关闭浮窗", danger: true, onClick: () => setOpen(id, false) },
    ],
    [id, name, chrome],
  );

  return createPortal(
    <div
      ref={boxRef}
      className={`aiw-float${bare ? " bare" : ""}`}
      style={{ left: pos.x, top: pos.y, width: size.w }}
      onContextMenu={(e) => {
        e.preventDefault();
        frameHandle.current?.showMenu(e.clientX, e.clientY);
      }}
    >
      {!bare && (
        <div className="aiw-float-head" onPointerDown={startDrag}>
          <span className="aiw-float-title">{name}</span>
          <button
            className="ai-float-btn"
            title="弹出为桌面挂件（独立置顶小窗）"
            onClick={() => popWidgetToDesktop({ id, name, chrome })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 4h5v5" /><path d="M20 4l-7 7" /><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></svg>
          </button>
          <button className="ai-float-btn" title="收起" onClick={() => setOpen(id, false)}>
            <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </div>
      )}
      <div className="aiw-float-body" style={{ height: size.h }}>
        <WidgetFrame
          ref={frameHandle}
          widget={{ id, name, html }}
          isDesktop={false}
          bare={bare}
          onHeight={(h) => setSize((s) => ({ ...s, h }))}
          onWin={onWin}
          sysMenu={sysMenu}
        />
      </div>
    </div>,
    document.body,
  );
}

/** 应用内小部件浮窗：打开中的 widget 类型扩展 */
export function WidgetFloats() {
  const es = useExtensions();
  const opened = es.exts.filter(
    (e) => e.type === "widget" && e.enabled && es.openIds.includes(e.id),
  );
  return (
    <>
      {opened.map((w: AiExtension, i) => (
        <SingleFloat
          key={w.id}
          id={w.id}
          name={w.name}
          html={w.html ?? ""}
          chrome={w.chrome}
          index={i}
        />
      ))}
    </>
  );
}
