/**
 * P174-R4：v3 插件贡献的**主窗口内**小部件（无边框透明只是其中一种表现）。
 *
 * 不是系统级置顶窗口：每个小部件是一个 iframe 浮层，跟面板共用同一套 srcdoc 沙箱与
 * `uartix` 桥；位置存 localStorage，关闭只影响本次会话（enabled 不变）。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { getSnapshot, ensureLoaded, subscribe, type InstalledPlugin } from "./pluginEngine";
import { panelEnabled } from "./repo";
import type { PluginWidgetDecl } from "./manifest";
import { PluginViewPanel } from "./PluginViewPanel";
import { hideWidget, useHiddenWidgets, widgetKey } from "./widgetVisibility";

const POS_KEY = "vs.pluginWidgets.v1";
const CHROME_H = 22;
const MIN_VISIBLE = 24;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function loadPositions(): Record<string, Rect> {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, Rect> = {};
    for (const [k, v] of Object.entries(raw)) {
      const r = v as Partial<Rect>;
      if (typeof r.x === "number" && typeof r.y === "number" && typeof r.w === "number" && typeof r.h === "number") {
        out[k] = { x: r.x, y: r.y, w: r.w, h: r.h };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePosition(key: string, rect: Rect): void {
  try {
    const all = loadPositions();
    all[key] = rect;
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    /* 配额/隐私模式：位置不持久化，不影响功能 */
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function WidgetFloat(props: { entry: InstalledPlugin; decl: PluginWidgetDecl; index: number }) {
  useLocale();
  const key = widgetKey(props.entry.id, props.decl.id);
  const [rect, setRect] = useState<Rect>(() => {
    const saved = loadPositions()[key];
    if (saved) return saved;
    const w = props.decl.width ?? 320;
    const h = props.decl.height ?? 200;
    const p = props.decl.defaultPosition;
    return {
      x: clamp(p?.x ?? window.innerWidth - w - 24 - props.index * 24, MIN_VISIBLE - w, window.innerWidth - MIN_VISIBLE),
      y: clamp(p?.y ?? 80 + props.index * 40, 0, window.innerHeight - MIN_VISIBLE),
      w,
      h,
    };
  });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setRect((cur) => ({
        ...cur,
        x: clamp(d.ox + (e.clientX - d.sx), MIN_VISIBLE - cur.w, window.innerWidth - MIN_VISIBLE),
        y: clamp(d.oy + (e.clientY - d.sy), 0, window.innerHeight - MIN_VISIBLE),
      }));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      savePosition(key, rectRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [key]);

  function startDrag(e: ReactPointerEvent): void {
    if (e.button !== 0) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: rect.x, oy: rect.y };
  }

  const transparent = props.decl.transparent === true;
  return (
    <div
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h + (transparent ? 0 : CHROME_H),
        zIndex: 900 + props.index,
        display: "flex",
        flexDirection: "column",
        background: transparent ? "transparent" : "var(--bg-panel)",
        border: transparent ? "none" : "1px solid var(--border)",
        borderRadius: "var(--radius-m)",
        boxShadow: transparent ? "none" : "var(--shadow-pop)",
        overflow: "hidden",
        pointerEvents: props.decl.clickThrough ? "none" : "auto",
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          height: transparent ? 0 : CHROME_H,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: transparent ? 0 : "0 6px 0 8px",
          background: "var(--bg)",
          borderBottom: transparent ? "none" : "1px solid var(--border)",
          fontSize: "var(--fs-xs)",
          color: "var(--text-dim)",
          cursor: "move",
          userSelect: "none",
          position: transparent ? "absolute" : "relative",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1,
        }}
      >
        {transparent ? null : <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.decl.title}</span>}
        <span style={{ flex: 1 }} />
        {transparent ? (
          <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--text-faint)", opacity: 0.35, cursor: "move" }} />
        ) : (
          <button className="btn" style={{ padding: "0 6px", lineHeight: "18px" }} onClick={() => hideWidget(key)} aria-label={tx("隐藏小部件", "Hide widget")}>
            ×
          </button>
        )}
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        <PluginViewPanel bare params={{ pluginId: props.entry.id, panelId: props.decl.id, kind: "widget" }} />
      </div>
    </div>
  );
}

export function PluginWidgetLayer() {
  useLocale();
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const hidden = useHiddenWidgets();
  useEffect(() => {
    void ensureLoaded();
  }, []);

  const items: { entry: InstalledPlugin; decl: PluginWidgetDecl }[] = [];
  for (const entry of repo.entries) {
    if (!panelEnabled(entry)) continue;
    for (const w of entry.manifest.contributes.widgets ?? []) items.push({ entry, decl: w });
  }

  return (
    <>
      {items
        .filter((x) => !hidden.includes(widgetKey(x.entry.id, x.decl.id)))
        .map((x, i) => (
          <WidgetFloat key={widgetKey(x.entry.id, x.decl.id)} entry={x.entry} decl={x.decl} index={i} />
        ))}
    </>
  );
}
