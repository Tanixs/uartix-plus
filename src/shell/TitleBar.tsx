import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import * as serialStore from "../features/serial/serialStore";
import { useSyncExternalStore } from "react";
import type { IfaceKind } from "../features/serial/serialStore";
import { t } from "../i18n/strings";
import { IconChevron, IconSparkle, IconCheck, IconPuzzle, IconSettings } from "../shared/icons";
import { pendingBadge } from "../features/market/marketBrowse";
import { useAwaitingCount } from "../features/market/useMarketPending";
import iconPlain from "../assets/icon-plain.svg";

const IFACE_LABEL: Record<IfaceKind, string> = {
  serial: t("iface.serial"),
  "tcp-client": t("iface.tcpClient"),
  "tcp-server": t("iface.tcpServer"),
  udp: t("iface.udp"),
  ble: t("iface.ble"),
};

const IFACE_ITEMS: { key: IfaceKind; ready: boolean }[] = [
  { key: "serial", ready: true },
  { key: "tcp-client", ready: true },
  { key: "tcp-server", ready: true },
  { key: "udp", ready: true },
  { key: "ble", ready: true },
];

function tbSvg(children: React.ReactNode) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

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
        <span className={`tb-iface-dot${s.status === "connected" ? " on" : ""}`} />
        {IFACE_LABEL[s.iface]}
        <span className="tb-iface-caret"><IconChevron size={11} dir="down" /></span>
      </button>
      {open && (
        <div className="tb-menu">
          <span className="tb-menu-title">{t("iface.title")}</span>
          {IFACE_ITEMS.map((it) => (
            <button
              key={it.key}
              className={`tb-menu-item${s.iface === it.key ? " on" : ""}`}
              title={`${t("iface.title")}：${IFACE_LABEL[it.key]}`}
              onClick={() => {
                if (s.status === "connected" || s.status === "reconnecting") {
                  void serialStore.closePort();
                }
                serialStore.setIface(it.key);
                setOpen(false);
              }}
            >
              {IFACE_LABEL[it.key]}
              {s.iface === it.key ? <em className="tb-menu-check"><IconCheck /></em> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 纯浏览器（npm run dev 直开）没有 Tauri 内核，getCurrentWindow() 构造即抛；降级为 no-op 桩以便浏览器验证 UI。
 * tauri 环境行为不变。
 * 桩里**列全被调到的方法**：少一个就是整页被错误边界接管（`innerSize` 漏掉时就是这样，
 * 于是"纯浏览器验证通道"这条我们自己依赖的路直接废掉——见 §8-46：兜底要兜得住实际调用面）。
 */
function getWinSafe(): ReturnType<typeof getCurrentWindow> {
  try {
    return getCurrentWindow();
  } catch {
    const p = <T,>(v: T): Promise<T> => Promise.resolve(v);
    const size = () => p({ width: 0, height: 0 });
    const pos = () => p({ x: 0, y: 0 });
    return {
      onResized: () => p(() => {}),
      onMoved: () => p(() => {}),
      isMaximized: () => p(false),
      isFocused: () => p(true),
      innerSize: size,
      outerSize: size,
      innerPosition: pos,
      outerPosition: pos,
      scaleFactor: () => p(1),
      startDragging: () => p(undefined),
      toggleMaximize: () => p(undefined),
      maximize: () => p(undefined),
      unmaximize: () => p(undefined),
      setAlwaysOnTop: () => p(undefined),
      minimize: () => p(undefined),
      close: () => p(undefined),
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
}

export function TitleBar({
  onOpenSettings,
  onOpenHelp,
  onOpenAi,
  onOpenLibrary,
}: {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenAi: () => void;
  /** 打开设置页的「插件管理」那一栏（标题栏那颗的去向） */
  onOpenLibrary: () => void;
}) {
  const win = getWinSafe();
  const [maxed, setMaxed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  /** 装包请求里"等你点"的那几条：正在跑的不算（催你做不了的事比不催更坏） */
  const awaitingBadge = pendingBadge(useAwaitingCount());
  useEffect(() => {
    // 版本号动态读取（tauri.conf.json 单一来源），硬编码会随发版遗忘
    void getVersion().then((v) => setVer(v)).catch(() => setVer(null));
  }, []);
  useEffect(() => {
    let un1: () => void = () => {};
    /**
     * P96-K3：窗口几何自诊断。无边框（decorations:false）窗口的最大化矩形是最容易出事的
     * 一处（真机反馈：双击标题栏后"中间放大、四边被裁"），而它出错时前端完全无感。
     * 读数常驻 `window.__tbLast`（与 `window.__p3d()` 同族，CDP/控制台可直接取），
     * 只有"内容比工作区还大"这种异常才打日志——那正是边缘被裁的形状。
     */
    const probe = () => {
      void Promise.all([
        win.innerSize(), win.outerSize(), win.innerPosition(), win.outerPosition(), win.isMaximized(),
        currentMonitor(),
      ]).then(([iw, ow, ip, op, mx, mon]) => {
        const info = {
          t: Date.now(),
          inner: [iw.width, iw.height],
          outer: [ow.width, ow.height],
          innerPos: [ip.x, ip.y],
          outerPos: [op.x, op.y],
          maximized: mx,
          monitor: mon ? [mon.position.x, mon.position.y, mon.size.width, mon.size.height] : null,
          workArea: mon
            ? [mon.workArea.position.x, mon.workArea.position.y, mon.workArea.size.width, mon.workArea.size.height]
            : null,
          scale: mon?.scaleFactor ?? null,
          css: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
        };
        (window as unknown as { __tbLast?: unknown }).__tbLast = info;
        if (mon && (iw.width > mon.workArea.size.width || iw.height > mon.workArea.size.height)) {
          console.warn("[TB诊断] 窗口内容大于工作区，边缘会被裁：", JSON.stringify(info));
        }
      }).catch(() => undefined);
    };
    const unP = win.onResized(() => {
      void win.isMaximized().then((v) => setMaxed(v));
      probe();
    }).then((u) => {
      un1 = u;
    });
    void win.isMaximized().then((v) => setMaxed(v));
    probe();
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
      {/* P96-K3：图标不再当最大化把手。旧实现它带 data-tauri-drag-region，而根节点的
          onDoubleClick 白名单只排除了 .tb-btn/.tb-iface/.tb-menu ⇒ 双击图标 ≡ 双击标题栏，
          直接落进无边框窗口那条最容易出事的最大化路径。拖动仍然可用（根节点 onMouseDown
          的 startDragging 会收到冒泡）。 */}
      <div
        className="tb-brand"
        onDoubleClick={(e) => { e.stopPropagation(); }}
        title="Uartix+"
      >
        <img
          src={iconPlain}
          alt=""
          width={16}
          height={16}
          style={{ filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))" }}
          draggable={false}
        />
        Uartix+
        <span className="tb-ver">{ver ?? ""}</span>
      </div>
      <IfaceMenu />
      <div className="tb-spacer" data-tauri-drag-region />
      <button className="tb-btn" title="AI 助手 (Ctrl+K)" data-tour="ai" onClick={onOpenAi}>
        <IconSparkle />
      </button>
      {/* 直达插件管理：开的是设置页那一栏，不另写一个插件库窗口；市场在里面的那颗按钮后面。
          data-tour 是入门引导第 9 步的高亮锚点（`tourSteps.test.ts` 钉它必须在源码里存在——
          锚点写错不会报错，只会让引导悄悄退化成漂浮卡片，所以宁可用一条守卫来核）。 */}
      <button
        className={`tb-btn${awaitingBadge ? " tb-attn" : ""}`}
        title="插件管理"
        aria-label={awaitingBadge ? `插件管理，${awaitingBadge} 条装包请求等你确认` : "插件管理"}
        data-tour="plugins"
        onClick={onOpenLibrary}
      >
        <IconPuzzle size={16} />
        {awaitingBadge ? <span className="tb-badge">{awaitingBadge}</span> : null}
      </button>
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
