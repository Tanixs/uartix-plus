import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
} from "dockview-react";
import { panelComponents, PANEL_TITLES } from "./panels/panels";
import { SerialToolbar } from "./features/serial/SerialToolbar";
import * as serialStore from "./features/serial/serialStore";
import * as templateStore from "./features/protocol/templateStore";
import * as framesStore from "./features/table/framesStore";
import * as plotStore from "./features/plot/plotStore";
import * as attitudeStore from "./features/attitude/attitudeStore";
import * as variableStore from "./features/controls/variableStore";
import type { PanelId, ThemeMode } from "./ipc/types";

const THEME_KEY = "vs.theme";
const LAYOUT_KEY = "vs.layout.v2";

function applyDefaultLayout(api: DockviewApi) {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const leftW = clamp(Math.round(w * 0.16), 190, 330);
  const rightW = clamp(Math.round(w * 0.18), 240, 400);
  const centerW = Math.max(400, w - leftW - rightW);
  const bottomH = clamp(Math.round(h * 0.34), 170, 420);
  const ctrlH = clamp(Math.round(h * 0.3), 150, 380);
  const bottomColW = clamp(Math.round(centerW / 3), 240, 560);

  api.addPanel({
    id: "templates",
    component: "templates",
    title: "协议模板",
    minimumWidth: 180,
  });
  api.addPanel({
    id: "hexview",
    component: "hexview",
    title: "Hex 数据流",
    initialWidth: centerW,
    position: { referencePanel: "templates", direction: "right" },
  });
  api.addPanel({
    id: "console",
    component: "console",
    title: "控制台",
    position: { referencePanel: "hexview", direction: "within" },
  });
  api.addPanel({
    id: "properties",
    component: "properties",
    title: "属性",
    initialWidth: rightW,
    minimumWidth: 230,
    minimumHeight: 260,
    position: { referencePanel: "hexview", direction: "right" },
  });
  api.addPanel({
    id: "controls",
    component: "controls",
    title: "控制画布",
    initialHeight: ctrlH,
    minimumHeight: 120,
    position: { referencePanel: "properties", direction: "below" },
  });
  api.addPanel({
    id: "table",
    component: "table",
    title: "数据表格",
    initialHeight: bottomH,
    minimumHeight: 140,
    position: { referencePanel: "hexview", direction: "below" },
  });
  api.addPanel({
    id: "plot2d",
    component: "plot2d",
    title: "2D 曲线",
    initialWidth: bottomColW,
    minimumWidth: 240,
    position: { referencePanel: "table", direction: "right" },
  });
  api.addPanel({
    id: "view3d",
    component: "view3d",
    title: "3D 姿态",
    initialWidth: bottomColW,
    minimumWidth: 240,
    position: { referencePanel: "plot2d", direction: "right" },
  });
  api.getPanel("hexview")?.api.setActive();
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() =>
    localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark",
  );
  const [editLayout, setEditLayout] = useState(false);
  const [groupBoxes, setGroupBoxes] = useState<
    { id: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const apiRef = useRef<DockviewApi | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    serialStore.init();
    templateStore.init();
    framesStore.init();
    plotStore.init();
    attitudeStore.init();
    variableStore.init();
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
    applyDefaultLayout(api);
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

  const toggleTheme = () => {
    setTheme((t) => {
      const next: ThemeMode = t === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  };

  const resetLayout = () => {
    const api = apiRef.current;
    if (!api) return;
    localStorage.removeItem(LAYOUT_KEY);
    api.clear();
    applyDefaultLayout(api);
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
      ? `已连接 ${serial.config.port} @ ${serial.config.baud}`
      : serial.status === "reconnecting"
        ? "连接断开，自动重连中…"
        : "未连接";

  const bpsText =
    serial.bps >= 1024
      ? `${(serial.bps / 1024).toFixed(1)} KB/s`
      : `${serial.bps} B/s`;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          Uartix+
          <span className="chip">M5</span>
        </div>
        <SerialToolbar />
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
          <select className="input" defaultValue="proto" title="工作区预设">
            <option value="proto">预设：协议调试</option>
            <option value="analyze" disabled>
              预设：数据分析
            </option>
            <option value="attitude" disabled>
              预设：姿态调参
            </option>
            <option value="console" disabled>
              预设：纯串口
            </option>
          </select>
          <button
            className={`btn ${editLayout ? "warn" : ""}`}
            onClick={() => setEditLayout((v) => !v)}
            title="编辑显示区布局：沿显示区边缘的 + 号向对应方向新建空显示区"
          >
            编辑布局
          </button>
          <button
            className="btn"
            onClick={resetLayout}
            title="清除当前布局，按窗口尺寸恢复默认自动布局"
          >
            重置布局
          </button>
          <button className="btn" onClick={toggleTheme} title="切换明暗主题">
            ◐ {theme === "dark" ? "暗色" : "亮色"}
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
        </span>
        <span className="status-right">
          RX {serial.rxTotal} B · TX {serial.txTotal} B · {bpsText} · 帧{" "}
          {proto.stats.total}/错 {proto.stats.errors}
        </span>
      </footer>
    </div>
  );
}
