import { useEffect, useRef, useState } from "react";
import {
  getCurrentWindow,
  currentMonitor,
  primaryMonitor,
  LogicalSize,
  LogicalPosition,
  type Window,
} from "@tauri-apps/api/window";
import { getSnapshot, type AiExtension } from "./extensionStore";
import { WidgetFrame, type WidgetFrameHandle } from "./WidgetFrame";
import type { WidgetMenuItem } from "./widgetShell";

/** 桌面挂件头部高度（px，与 .aiw-desktop-head 的 26px 对应；无边框形态为 0） */
const HEAD_H = 26;

export function WidgetDesktop() {
  const [widget, setWidget] = useState<AiExtension | null>(null);
  const [miss, setMiss] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [through, setThrough] = useState(false);
  const throughTimer = useRef<number | null>(null);
  const frameHandle = useRef<WidgetFrameHandle>(null);
  // 手动增量拖拽状态：基准位置 + 累计偏移 + 屏幕边界（逻辑像素）
  const dragState = useRef<{
    base: { x: number; y: number } | null;
    acc: { x: number; y: number };
    bounds: { w: number; h: number } | null;
    winW: number;
    winH: number;
    chain: Promise<void>;
  }>({ base: null, acc: { x: 0, y: 0 }, bounds: null, winW: 280, winH: 240, chain: Promise.resolve() });
  const bare = widget?.chrome === "none";

  useEffect(() => {
    const id = location.hash.replace("#/aiwidget-desktop/", "");
    const find = () => {
      const w =
        getSnapshot().exts.find((x) => x.id === id && x.type === "widget") ?? null;
      setWidget(w);
      setMiss(!w);
    };
    find();
    // 扩展列表变化（localStorage 跨窗口同步）时立即响应；轮询仅作兜底
    const onStorage = (e: StorageEvent) => {
      if (e.key === "vs.aiExts") find();
    };
    window.addEventListener("storage", onStorage);
    const t = window.setInterval(find, 2000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(t);
    };
  }, []);

  // 无边框形态：整页背景透明（Tauri 窗口创建时已带 transparent:true）
  useEffect(() => {
    if (!bare) return;
    document.documentElement.classList.add("aiw-transparent-root");
    return () => document.documentElement.classList.remove("aiw-transparent-root");
  }, [bare]);

  const close = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  /** 点击穿透：60 秒后自动恢复，避免窗口再也点不到 */
  const setCursorThrough = async (win: Window, on: boolean) => {
    await win.setIgnoreCursorEvents(on);
    setThrough(on);
    if (throughTimer.current !== null) window.clearTimeout(throughTimer.current);
    if (on) {
      throughTimer.current = window.setTimeout(() => {
        void win.setIgnoreCursorEvents(false).then(() => setThrough(false));
      }, 60_000);
    }
  };

  // 内容高度上报 → 窗口高度自适应（无边框形态无标题栏占位）
  const handleHeight = (h: number) => {
    void getCurrentWindow()
      .setSize(new LogicalSize(window.innerWidth, h + (bare ? 0 : HEAD_H)))
      .catch(() => undefined);
  };

  // 手动增量拖拽：dragDelta 串行应用（避免异步取位置竞态），带屏幕钳制
  const applyDragDelta = (dx: number, dy: number) => {
    const st = dragState.current;
    st.chain = st.chain.then(async () => {
      const win = getCurrentWindow();
      try {
        if (!st.base) {
          const p = await win.outerPosition();
          const s = (await win.scaleFactor()) || 1;
          st.base = { x: p.x / s, y: p.y / s };
          st.acc = { x: 0, y: 0 };
          const mon = (await currentMonitor()) ?? (await primaryMonitor());
          if (mon) {
            const ms = mon.scaleFactor || 1;
            st.bounds = { w: mon.size.width / ms, h: mon.size.height / ms };
          }
          const sz = await win.innerSize();
          st.winW = sz.width / s;
          st.winH = sz.height / s;
        }
        const b = st.base;
        let nx = b.x + st.acc.x + dx;
        let ny = b.y + st.acc.y + dy;
        if (st.bounds) {
          nx = Math.min(Math.max(nx, 24 - st.winW), st.bounds.w - 24);
          ny = Math.min(Math.max(ny, 0), st.bounds.h - 24);
        }
        st.acc.x = nx - b.x;
        st.acc.y = ny - b.y;
        await win.setPosition(new LogicalPosition(nx, ny));
      } catch {
        st.base = null;
      }
    });
  };

  const onWin = async (req: { action: string } & Record<string, unknown>) => {
    const win = getCurrentWindow();
    switch (req.action) {
      case "dragDelta":
        applyDragDelta(Number(req.dx) || 0, Number(req.dy) || 0);
        break;
      case "dragEnd":
        dragState.current.base = null;
        break;
      case "move": {
        const x = Number(req.x);
        const y = Number(req.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          await win.setPosition(new LogicalPosition(x, y));
          dragState.current.base = null;
        }
        break;
      }
      case "moveBy": {
        applyDragDelta(Number(req.dx) || 0, Number(req.dy) || 0);
        dragState.current.base = null;
        break;
      }
      case "size": {
        const w = Number(req.w);
        const h = Number(req.h);
        if (Number.isFinite(w) && Number.isFinite(h) && w >= 60 && h >= 40) {
          await win.setSize(new LogicalSize(w, h));
          dragState.current.base = null;
        }
        break;
      }
      case "alwaysOnTop":
        await win.setAlwaysOnTop(req.on !== false);
        setPinned(req.on !== false);
        break;
      case "ignoreCursorEvents":
        await setCursorThrough(win, req.on !== false);
        break;
      case "close":
        await close();
        break;
      case "get": {
        const p = await win.outerPosition();
        const sz = await win.innerSize();
        const s = await win.scaleFactor();
        return { data: { x: p.x / s, y: p.y / s, w: sz.width / s, h: sz.height / s } };
      }
      default:
        break;
    }
  };

  const togglePin = () => {
    const next = !pinned;
    void getCurrentWindow().setAlwaysOnTop(next).then(() => setPinned(next));
  };
  const toggleThrough = () => {
    void setCursorThrough(getCurrentWindow(), !through);
  };

  const sysMenu = (): WidgetMenuItem[] => [
    { label: "窗口置顶", checked: pinned, onClick: togglePin },
    { label: "点击穿透（60 秒后恢复）", checked: through, onClick: toggleThrough },
    { label: "重新加载", onClick: () => window.location.reload() },
    { label: "关闭挂件", danger: true, onClick: () => void close() },
  ];

  return (
    <div
      className={`aiw-desktop${bare ? " bare" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        frameHandle.current?.showMenu(e.clientX, e.clientY);
      }}
    >
      {!bare && (
        <div
          className="aiw-desktop-head"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            void getCurrentWindow().startDragging();
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            void close();
          }}
        >
          <span className="aiw-float-title">{widget?.name ?? "AI 挂件"}</span>
          <button className="ai-float-btn" title="关闭" onClick={() => void close()}>
            <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </div>
      )}
      <div className="aiw-desktop-body">
        {widget ? (
          <WidgetFrame
            ref={frameHandle}
            widget={{ id: widget.id, name: widget.name, html: widget.html ?? "" }}
            isDesktop
            bare={bare}
            onHeight={handleHeight}
            onWin={onWin}
            sysMenu={sysMenu}
          />
        ) : miss ? (
          <div className="aiw-desktop-miss">
            挂件不存在或已被删除
            <button className="btn" onClick={() => void close()}>
              关闭窗口
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
