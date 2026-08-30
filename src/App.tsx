import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
} from "dockview-react";
import { panelComponents, PANEL_TITLES } from "./panels/panels";
import { SerialToolbar } from "./features/serial/SerialToolbar";
import { TitleBar } from "./shell/TitleBar";
import { IconColumns } from "./shared/icons";
import type { IfaceKind } from "./features/serial/serialStore";
import type { WorkspacePreset } from "./features/settings/settingsStore";
import {
  getSnapshot as getSettingsSnapshot,
  useSettings,
} from "./features/settings/settingsStore";
import * as controlsStore from "./features/controls/controlsStore";
import { SettingsModal } from "./features/settings/SettingsModal";
import { HelpModal } from "./features/help/HelpModal";
import type { PanelId } from "./ipc/types";
import * as serialStore from "./features/serial/serialStore";
import * as templateStore from "./features/protocol/templateStore";
import * as framesStore from "./features/table/framesStore";
import * as plotStore from "./features/plot/plotStore";
import * as attitudeStore from "./features/attitude/attitudeStore";
import * as variableStore from "./features/controls/variableStore";
import * as fcStore from "./features/framecanvas/frameStore";
import * as telemetryStore from "./features/protocol/telemetryStore";
import { t } from "./i18n/strings";

const LAYOUT_KEY = "vs.layout.v2";

function applyDefaultLayout(api: DockviewApi, preset: WorkspacePreset = "proto") {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const leftW = Math.max(240, Math.round(w * 0.25));
  const rightW = Math.max(260, Math.round(w * 0.25));
  const midW = Math.max(480, w - leftW - rightW);
  const bottomH = Math.round(h * 0.5);
  const bottomColW = Math.max(280, Math.round(midW / 2));

  api.addPanel({
    id: "templates",
    component: "templates",
    title: "协议模板",
    minimumWidth: 200,
  });

  if (preset === "console") {
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: "Hex 数据流",
      initialWidth: midW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: "控制台",
      initialHeight: Math.round(h * 0.4),
      minimumHeight: 140,
      position: { referencePanel: "hexview", direction: "below" },
    });
    api.addPanel({
      id: "controls",
      component: "controls",
      title: "控制画布",
      initialWidth: rightW,
      minimumWidth: 230,
      position: { referencePanel: "hexview", direction: "right" },
    });
    api.getPanel("hexview")?.api.setActive();
    return;
  }

  if (preset === "video") {
    api.addPanel({
      id: "video",
      component: "video",
      title: PANEL_TITLES.video,
      initialWidth: midW + rightW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: PANEL_TITLES.hexview,
      initialHeight: Math.round(h * 0.35),
      minimumHeight: 140,
      position: { referencePanel: "video", direction: "below" },
    });
    api.addPanel({
      id: "properties",
      component: "properties",
      title: PANEL_TITLES.properties,
      initialWidth: rightW,
      minimumWidth: 230,
      position: { referencePanel: "video", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: "控制台",
      initialHeight: Math.round(h * 0.3),
      minimumHeight: 120,
      position: { referencePanel: "properties", direction: "below" },
    });
    api.getPanel("video")?.api.setActive();
    return;
  }

  const centerPanels =
    preset === "analyze"
      ? (["plot2d", "hexview", "console"] as const)
      : (["framecanvas", "hexview", "console"] as const);

  const first = centerPanels[0];
  api.addPanel({
    id: first,
    component: first,
    title: PANEL_TITLES[first as PanelId],
    initialWidth: midW + rightW,
    position: { referencePanel: "templates", direction: "right" },
  });
  for (let i = 1; i < centerPanels.length; i++) {
    api.addPanel({
      id: centerPanels[i],
      component: centerPanels[i],
      title: PANEL_TITLES[centerPanels[i] as PanelId],
      position: { referencePanel: first, direction: "within" },
    });
  }
  if (preset === "attitude") {
    api.addPanel({
      id: "view3d",
      component: "view3d",
      title: "3D 姿态",
      position: { referencePanel: first, direction: "within" },
    });
  }
  api.addPanel({
    id: "properties",
    component: "properties",
    title: "属性",
    initialWidth: rightW,
    minimumWidth: 230,
    minimumHeight: 260,
    position: { referencePanel: first, direction: "right" },
  });
  const bottomMain = preset === "attitude" ? "table" : "table";
  api.addPanel({
    id: bottomMain,
    component: bottomMain,
    title: PANEL_TITLES[bottomMain as PanelId],
    initialHeight: bottomH,
    minimumHeight: 140,
    position: { referencePanel: first, direction: "below" },
  });
  if (preset !== "analyze") {
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: "2D 曲线",
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "table", direction: "right" },
    });
  }
  if (preset === "analyze") {
    api.addPanel({
      id: "view3d",
      component: "view3d",
      title: "3D 姿态",
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "plot2d", direction: "right" },
    });
  }
  api.addPanel({
    id: "controls",
    component: "controls",
    title: "控制画布",
    initialHeight: bottomH,
    minimumHeight: 120,
    position: { referencePanel: "properties", direction: "below" },
  });
  api.getPanel(first)?.api.setActive();
}

export default function App() {
  const settings = useSettings();
  const theme = settings.theme;
  const [editLayout, setEditLayout] = useState(false);
  const [perfOn, setPerfOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [groupBoxes, setGroupBoxes] = useState<
    { id: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const apiRef = useRef<DockviewApi | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const tele = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
  renderTick += 1;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.zoom = `${settings.zoom}%`;
  }, [settings.zoom]);

  useEffect(() => {
    if (perfOn !== settings.perfHud) setPerfOn(settings.perfHud);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.perfHud]);

  useEffect(() => {
    serialStore.init();
    templateStore.init();
    telemetryStore.init();
    framesStore.init();
    plotStore.init();
    attitudeStore.init();
    variableStore.init();
    fcStore.init();
    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
    };
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    api.onDidLayoutChange(() => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
    });
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved) as SerializedDockview);
        return;
      } catch {
        localStorage.removeItem(LAYOUT_KEY);
      }
    }
    applyDefaultLayout(api, getSettingsSnapshot().workspace);
  }, []);

  useEffect(() => {
    if (!editLayout) {
      setGroupBoxes([]);
      return;
    }
    const compute = () => {
      const api = apiRef.current;
      const shell = shellRef.current;
      if (!api || !shell) return;
      const shellRect = shell.getBoundingClientRect();
      setGroupBoxes(
        api.groups.map((g) => {
          const r = g.element.getBoundingClientRect();
          return {
            id: g.id,
            left: r.left - shellRect.left,
            top: r.top - shellRect.top,
            width: r.width,
            height: r.height,
          };
        }),
      );
    };
    compute();
    const timer = window.setInterval(compute, 400);
    window.addEventListener("resize", compute);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", compute);
    };
  }, [editLayout]);

  const addGroupInDirection = (
    groupId: string,
    dir: "left" | "right" | "above" | "below",
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const group = api.groups.find((g) => g.id === groupId);
    const ref = group?.panels[group.panels.length - 1];
    const rect = group?.element.getBoundingClientRect();
    const horizontal = dir === "left" || dir === "right";
    const half = rect ? (horizontal ? rect.width : rect.height) / 2 : undefined;
    api.addPanel({
      id: `ph-${crypto.randomUUID()}`,
      component: "placeholder",
      title: "空显示区",
      ...(horizontal
        ? { initialWidth: Math.max(170, Math.round(half ?? 260)) }
        : { initialHeight: Math.max(130, Math.round(half ?? 200)) }),
      ...(ref
        ? { position: { referencePanel: ref.id, direction: dir } }
        : {}),
    });
  };

  const clearGroup = (groupId: string) => {
    const api = apiRef.current;
    if (!api) return;
    const group = api.groups.find((g) => g.id === groupId);
    group?.panels.forEach((p) => api.removePanel(p));
  };

  const resetLayout = (preset: WorkspacePreset = "proto") => {
    const api = apiRef.current;
    if (!api) return;
    localStorage.removeItem(LAYOUT_KEY);
    api.clear();
    applyDefaultLayout(api, preset);
    if (preset === "attitude") {
      const exists = controlsStore
        .getSnapshot()
        .pages.some((p) => p.name === "姿态调参");
      if (!exists) {
        controlsStore.importPage({
          name: "姿态调参",
          cols: 12,
          rows: 8,
          cards: Array.from({ length: 6 }, (_, i) => ({
            type: "slider",
            name: `参数${i + 1}`,
            x: (i % 3) * 4,
            y: Math.floor(i / 3) * 2,
            w: 2,
            h: 1,
          })),
        });
      }
    }
  };

  const addOrFocusPanel = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const exist = api.getPanel(id);
    if (exist) {
      exist.api.setActive();
      return;
    }
    const groups = api.groups;
    const ref =
      api.activePanel ??
      (groups.length
        ? groups[groups.length - 1].panels[
            groups[groups.length - 1].panels.length - 1
          ]
        : null);
    api.addPanel({
      id,
      component: id,
      title: PANEL_TITLES[id as PanelId],
      ...(ref
        ? { position: { referencePanel: ref.id, direction: "within" as const } }
        : {}),
    });
  };

  const statusText =
    serial.status === "connected"
      ? serial.iface === "serial"
        ? `${t("st.connected")} ${serial.config.port} @ ${serial.config.baud}`
        : `${t("st.connected")} ${serial.portName ?? ""}`
      : serial.status === "reconnecting"
        ? t("st.reconnecting")
        : t("st.disconnected");

  const bpsText =
    serial.bps >= 1024
      ? `${(serial.bps / 1024).toFixed(1)} KB/s`
      : `${serial.bps} B/s`;

  return (
    <div
      className="app"
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
          return;
        e.preventDefault();
      }}
    >
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} onOpenHelp={() => setHelpOpen(true)} />
      <header className="toolbar">
        {serial.iface === "serial" ? (
          <SerialToolbar />
        ) : (
          <NetIfaceBar kind={serial.iface} />
        )}
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <select
            className="input"
            value=""
            title="重新添加显示区：选择面板名即加入当前活动分组；全部关闭时将新建满屏显示区"
            onChange={(e) => {
              if (e.target.value) addOrFocusPanel(e.target.value);
            }}
          >
            <option value="">+ 面板</option>
            {Object.entries(PANEL_TITLES).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button
            className={`btn icon-btn${editLayout ? " warn" : ""}`}
            onClick={() => setEditLayout((v) => !v)}
            title="编辑显示区布局：沿显示区边缘的 + 号向对应方向新建空显示区"
          >
            <IconColumns />
          </button>
        </div>
      </header>
      <div className="app-shell" ref={shellRef}>
        <DockviewReact
          components={panelComponents}
          onReady={onReady}
          className={
            theme === "dark" ? "dockview-theme-dark" : "dockview-theme-light"
          }
        />
        {editLayout &&
          groupBoxes.map((g) => (
            <div
              key={g.id}
              className="layout-edit-group"
              style={{ left: g.left, top: g.top, width: g.width, height: g.height }}
            >
              <button
                className="le-btn le-left"
                title="向左新建显示区"
                onClick={() => addGroupInDirection(g.id, "left")}
              >
                +
              </button>
              <button
                className="le-btn le-right"
                title="向右新建显示区"
                onClick={() => addGroupInDirection(g.id, "right")}
              >
                +
              </button>
              <button
                className="le-btn le-top"
                title="向上新建显示区"
                onClick={() => addGroupInDirection(g.id, "above")}
              >
                +
              </button>
              <button
                className="le-btn le-bottom"
                title="向下新建显示区"
                onClick={() => addGroupInDirection(g.id, "below")}
              >
                +
              </button>
              <button
                className="le-clear"
                title="清空该显示区内所有面板（显示区随之消失）"
                onClick={() => clearGroup(g.id)}
              >
                清空
              </button>
            </div>
          ))}
      </div>
      <footer className="statusbar">
        <span className="status-left">
          <span className={`dot ${serial.status}`} />
          {statusText}
          {serial.error && <span className="status-error">{serial.error}</span>}
          {perfOn && <PerfHud />}
        </span>
        <span className="status-right">
          RX {serial.rxTotal} B · TX {serial.txTotal} B · {bpsText} · 帧{" "}
          {tele.stats.total}/错 {tele.stats.errors}
        </span>
      </footer>
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onResetLayout={(p) => resetLayout(p)}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

let renderTick = 0;

function NetIfaceBar({ kind }: { kind: IfaceKind }) {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染
  const label =
    kind === "tcp-client"
      ? t("iface.tcpClient")
      : kind === "tcp-server"
        ? t("iface.tcpServer")
        : t("iface.udp");
  const busy = s.status === "connected" || s.status === "reconnecting";
  return (
    <div className="toolbar-group">
      <button
        className={`btn${busy ? " warn" : ""}`}
        title={busy ? t("tb.disconnect") : t("tb.connect")}
        onClick={() => (busy ? serialStore.closePort() : serialStore.openPort())}
      >
        <span className={`dot ${busy ? "connected" : "disconnected"}`} />
        {busy ? t("tb.disconnect") : t("tb.connect")}
      </button>
      {kind !== "tcp-server" && (
        <input
          className="input"
          value={s.net.remoteHost}
          disabled={busy}
          title={t("tb.remoteHost")}
          placeholder={t("tb.remoteHost")}
          onChange={(e) => serialStore.setNet({ remoteHost: e.target.value })}
        />
      )}
      {kind !== "tcp-server" && (
        <input
          className="input baud"
          value={String(s.net.remotePort)}
          disabled={busy}
          title={t("tb.remotePort")}
          onChange={(e) => serialStore.setNet({ remotePort: Number(e.target.value) || 0 })}
        />
      )}
      {kind !== "tcp-client" && (
        <input
          className="input baud"
          value={String(s.net.localPort)}
          disabled={busy}
          title={kind === "tcp-server" ? t("tb.localPort") : t("tb.localPortUdp")}
          onChange={(e) => serialStore.setNet({ localPort: Number(e.target.value) || 0 })}
        />
      )}
      <span className="iface-soon">{busy && s.portName ? `${label} · ${s.portName}` : label}</span>
    </div>
  );
}

function PerfHud() {
  const [info, setInfo] = useState({ fps: 0, long: 0, render: 0 });
  const state = useRef({ frames: 0, long: 0, raf: 0 });
  useEffect(() => {
    const s = state.current;
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration > 50) s.long += 1;
        }
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch {
      po = null;
    }
    const loop = () => {
      s.frames += 1;
      s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);
    const timer = setInterval(() => {
      setInfo({ fps: s.frames, long: s.long, render: renderTick });
      s.frames = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(s.raf);
      clearInterval(timer);
      po?.disconnect();
    };
  }, []);
  return (
    <span className="perf-hud" title="每秒刷新：FPS / >50ms 长任务累计 / React 渲染次数">
      {info.fps}fps · 长{info.long} · 渲{info.render}
    </span>
  );
}
