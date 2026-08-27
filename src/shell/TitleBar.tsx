import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as serialStore from "../features/serial/serialStore";
import { useSyncExternalStore } from "react";
import type { IfaceKind } from "../features/serial/serialStore";

const IFACE_LABEL: Record<IfaceKind, string> = {
  serial: "串口",
  "tcp-client": "TCP 客户端",
  "tcp-server": "TCP 服务端",
  udp: "UDP",
};

const IFACE_ITEMS: { key: IfaceKind; label: string; ready: boolean }[] = [
  { key: "serial", label: "串口", ready: true },
  { key: "tcp-client", label: "TCP 客户端", ready: false },
  { key: "tcp-server", label: "TCP 服务端", ready: false },
  { key: "udp", label: "UDP", ready: false },
];

function tbSvg(children: React.ReactNode) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const IconSettings = () =>
  tbSvg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  );

const IconHelp = () =>
  tbSvg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.4-3 4" />
      <line x1="12" y1="17.5" x2="12.01" y2="17.5" />
    </>,
  );

const IconPin = () =>
  tbSvg(
    <>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-.89 1.55l-1.72.9A2 2 0 0 0 5.34 15z" />
    </>,
  );

const IfaceMenu = () => {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="tb-iface" ref={ref}>
      <button className="tb-btn tb-iface-btn" onClick={() => setOpen((v) => !v)} title="数据接口">
        <span className={`tb-iface-dot${s.iface === "serial" && s.status === "connected" ? " on" : ""}`} />
        {IFACE_LABEL[s.iface]}
        <span className="tb-iface-caret">▾</span>
      </button>
      {open && (
        <div className="tb-menu">
          <span className="tb-menu-title">数据接口</span>
          {IFACE_ITEMS.map((it) => (
            <button
              key={it.key}
              className={`tb-menu-item${s.iface === it.key ? " on" : ""}`}
              disabled={!it.ready}
              title={it.ready ? `切换到 ${it.label}` : "即将支持，后续版本提供"}
              onClick={() => {
                serialStore.setIface(it.key);
                setOpen(false);
              }}
            >
              {it.label}
              {s.iface === it.key ? <em className="tb-menu-check">✓</em> : null}
              {!it.ready && <em className="tb-menu-soon">即将支持</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export function TitleBar({
  onOpenSettings,
  onOpenHelp,
}: {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const win = getCurrentWindow();
  const [maxed, setMaxed] = useState(false);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    let un1: () => void = () => {};
    const unP = win.onResized(() => {
      void win.isMaximized().then((v) => setMaxed(v));
    }).then((u) => {
      un1 = u;
    });
    void win.isMaximized().then((v) => setMaxed(v));
    return () => {
      un1();
      void unP;
    };
  }, [win]);

  return (
    <div
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const el = e.target as HTMLElement;
        if (el.closest(".tb-btn, .tb-iface, .tb-menu")) return;
        void win.startDragging();
      }}
      onDoubleClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest(".tb-btn, .tb-iface, .tb-menu")) return;
        void win.toggleMaximize();
      }}
    >
      <div className="tb-brand" data-tauri-drag-region>
        Uartix+
        <span className="tb-ver">0.1.0</span>
      </div>
      <IfaceMenu />
      <div className="tb-spacer" data-tauri-drag-region />
      <button className="tb-btn" title="设置" onClick={onOpenSettings}>
        <IconSettings />
      </button>
      <button className="tb-btn" title="帮助与入门" onClick={onOpenHelp}>
        <IconHelp />
      </button>
      <span className="tb-sep" />
      <button
        className={`tb-btn${pinned ? " on" : ""}`}
        title={pinned ? "取消窗口置顶" : "窗口置顶"}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          void win.setAlwaysOnTop(next);
        }}
      >
        <IconPin />
      </button>
      <button className="tb-btn" title="最小化" onClick={() => void win.minimize()}>
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      <button className="tb-btn" title={maxed ? "还原" : "最大化"} onClick={() => void win.toggleMaximize()}>
        {maxed ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M5 16V5a1 1 0 0 1 1-1h11" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" /></svg>
        )}
      </button>
      <button className="tb-btn tb-close" title="关闭" onClick={() => void win.close()}>
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
      </button>
    </div>
  );
}
