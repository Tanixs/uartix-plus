import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
} from "dockview-react";
import { panelComponents, PANEL_TITLES, panelTitleOf } from "./panels/panels";
import * as panelActivity from "./panels/panelActivity";
import { SerialToolbar } from "./features/serial/SerialToolbar";
import { TitleBar } from "./shell/TitleBar";
import { IconColumns } from "./shared/icons";
import type { IfaceKind } from "./features/serial/serialStore";
import type { WorkspacePreset } from "./features/settings/settingsStore";
import { JsonDropImport } from "./features/settings/JsonDropImport";
import { AiFloat } from "./features/ai/AiFloat";
import { WidgetFloats } from "./features/ai/WidgetFloats";
import { startWidgetHub } from "./features/ai/widgetHub";
import { startExtRuntime } from "./features/ai/extRuntime";
import {
  getExt as getExtSnapshot,
  useExtensions,
} from "./features/ai/extensionStore";
import * as chatStore from "./features/ai/chatStore";
import { onAiScene, onOpenSettings, onPop } from "./features/ai/aiBus";
import { onRequestOpenExtPanel } from "./features/ai/extBus";
import { subscribeAppBus } from "./features/ai/appBus";
import {
  backupAutoLayout,
  getLayout,
  saveLayout,
} from "./features/settings/layoutsStore";
import {
  getSnapshot as getSettingsSnapshot,
  patch,
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
import { notifyLocale, t, tx, useLocale } from "./i18n/strings";
import { takeIpcLatency } from "./ipc/ipcLatency";

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
    title: panelTitleOf("templates"),
    minimumWidth: 200,
  });

  if (preset === "console") {
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: panelTitleOf("hexview"),
      initialWidth: midW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
      initialHeight: Math.round(h * 0.4),
      minimumHeight: 140,
      position: { referencePanel: "hexview", direction: "below" },
    });
    api.addPanel({
      id: "controls",
      component: "controls",
      title: panelTitleOf("controls"),
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
      title: panelTitleOf("video"),
      initialWidth: midW + rightW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: panelTitleOf("hexview"),
      initialHeight: Math.round(h * 0.35),
      minimumHeight: 140,
      position: { referencePanel: "video", direction: "below" },
    });
    api.addPanel({
      id: "properties",
      component: "properties",
      title: panelTitleOf("properties"),
      initialWidth: rightW,
      minimumWidth: 230,
      position: { referencePanel: "video", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
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
    title: panelTitleOf(first),
    initialWidth: midW + rightW,
    position: { referencePanel: "templates", direction: "right" },
  });
  for (let i = 1; i < centerPanels.length; i++) {
    api.addPanel({
      id: centerPanels[i],
      component: centerPanels[i],
      title: panelTitleOf(centerPanels[i]),
      position: { referencePanel: first, direction: "within" },
    });
  }
  if (preset === "attitude") {
    api.addPanel({
      id: "view3d",
      component: "view3d",
      title: panelTitleOf("view3d"),
      position: { referencePanel: first, direction: "within" },
    });
  }
  api.addPanel({
    id: "properties",
    component: "properties",
    title: panelTitleOf("properties"),
    initialWidth: rightW,
    minimumWidth: 230,
    minimumHeight: 260,
    position: { referencePanel: first, direction: "right" },
  });
  const bottomMain = preset === "attitude" ? "table" : "table";
  api.addPanel({
    id: bottomMain,
    component: bottomMain,
    title: panelTitleOf(bottomMain),
    initialHeight: bottomH,
    minimumHeight: 140,
    position: { referencePanel: first, direction: "below" },
  });
  if (preset !== "analyze") {
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: panelTitleOf("plot2d"),
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "table", direction: "right" },
    });
  }
  if (preset === "analyze") {
    api.addPanel({
      id: "view3d",
      component: "view3d",
      title: panelTitleOf("view3d"),
      initialWidth: bottomColW,
      minimumWidth: 240,
      position: { referencePanel: "plot2d", direction: "right" },
    });
  }
  api.addPanel({
    id: "controls",
    component: "controls",
    title: panelTitleOf("controls"),
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
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [groupBoxes, setGroupBoxes] = useState<
    { id: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const apiRef = useRef<DockviewApi | null>(null);
  const syncPanelsRef = useRef<(() => void) | null>(null);
  const retitlePanelsRef = useRef<(() => void) | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const exts = useExtensions();
  const extPanelOptions = exts.exts.filter((e) => e.type === "panel" && e.enabled);
  renderTick += 1;

  useEffect(() => {
    // 跟随系统时监听系统配色变化；navy 归暗色系、ocean 归亮色系（dockview 基础主题）
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const base =
        theme === "system"
          ? mq.matches
            ? "dark"
            : "light"
          : theme === "navy" || theme === "dark" || theme === "glaze"
            ? "dark"
            : "light"; // light / ocean / matcha / amber / begonia 均归亮色系（dockview 基础主题）
      document.documentElement.dataset.theme =
        theme === "system" ? base : theme;
    };
    apply();
    const onChange = () => {
      setSysDark(mq.matches);
      apply();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const dockBase =
    theme === "system"
      ? sysDark
        ? "dark"
        : "light"
      : theme === "navy" || theme === "dark" || theme === "glaze"
        ? "dark"
        : "light"; // light / ocean / matcha / amber / begonia 均归亮色系

  useEffect(() => {
    document.documentElement.style.zoom = `${settings.zoom}%`;
    // 通知浮窗类组件重算逻辑坐标（zoom 改变 vw/vh 语义但不触发 resize）
    window.dispatchEvent(new Event("vs-zoom-change"));
  }, [settings.zoom]);

  // 语言切换 → 驱动订阅 useLocale 的深度面板重渲染（P33 i18n）；页签名同步重挂
  useEffect(() => {
    notifyLocale();
    retitlePanelsRef.current?.();
  }, [settings.locale]);

  // 保险：dockview 容器类名 DOM 级同步（部分版本对 className prop 变化不响应，
  // 导致主题切换后面板框架停留在旧配色；变量覆写已解耦，这里兜底类名本身）
  useEffect(() => {
    const el = shellRef.current?.querySelector?.(
      ".dockview-theme-dark, .dockview-theme-light",
    );
    if (el) {
      el.classList.toggle("dockview-theme-dark", dockBase === "dark");
      el.classList.toggle("dockview-theme-light", dockBase !== "dark");
    }
  }, [dockBase]);

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
    void chatStore.init();
    startWidgetHub();
    startExtRuntime();
    const unScene = onAiScene((req) => {
      setAiOpen(true);
      chatStore.pushScene(req.scene, req.payload);
    });
    const unExtPanel = onRequestOpenExtPanel((extId) => {
      addOrFocusPanel(`ext-panel-${extId}`);
    });
    // AI App Action：打开面板 / 切工作区预设（来自脚本、小部件、自定义卡片）
    const unAppBus = subscribeAppBus((msg) => {
      if (msg.kind === "openPanel") {
        addOrFocusPanel(msg.panel);
      } else if (msg.kind === "applyPreset") {
        patch({ workspace: msg.preset as WorkspacePreset });
        resetLayout(msg.preset as WorkspacePreset);
      }
    });
    const unSettings = onOpenSettings((tab) => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    });
    const unPop = onPop(() => {
      chatStore.setFloatOpen(true);
      setAiOpen(true);
      const api = apiRef.current;
      const panel = api?.getPanel("ai");
      if (api && panel) api.removePanel(panel);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      unScene();
      unExtPanel();
      unAppBus();
      unSettings();
      unPop();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
    };
  }, []);

  useEffect(() => {
    chatStore.setFloatOpen(aiOpen);
  }, [aiOpen]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    // 面板开/关与前后台状态 → panelActivity（store 门控与渲染节流的依据）。
    // panel.api.isVisible 由 dockview 维护：所在标签组前台页签 = true。
    const syncPanels = () => {
      panelActivity.syncPanels(
        api.panels.map((p) => ({ id: p.id, visible: p.api.isVisible })),
      );
    };
    syncPanelsRef.current = syncPanels;
    syncPanels();
    // 页签名语言感知：按当前语言重挂标题（占位区 ph-* 除外；扩展面板取扩展名）
    const retitlePanels = () => {
      for (const p of api.panels) {
        if (p.id.startsWith("ph-")) continue;
        const want = panelTitleOf(p.id);
        if (p.title !== want) p.api.setTitle(want);
      }
    };
    retitlePanelsRef.current = retitlePanels;
    // 稳定主题作用域：面板根 DOM 挂 data-panel=<组件名>，主题/样式层不再依赖易变类名
    const tagPanel = (p: { type?: string; window?: HTMLElement | null }) => {
      if (p.window && p.type) p.window.setAttribute("data-panel", p.type);
    };
    api.onDidAddPanel((e) => {
      tagPanel(e as unknown as { type?: string; window?: HTMLElement | null });
      retitlePanels();
      syncPanels();
    });
    api.onDidRemovePanel(syncPanels);
    api.onDidActivePanelChange(syncPanels);
    api.onDidLayoutChange(() => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
    });
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved) as SerializedDockview);
        retitlePanels();
        syncPanels();
        return;
      } catch {
        localStorage.removeItem(LAYOUT_KEY);
      }
    }
    applyDefaultLayout(api, getSettingsSnapshot().workspace);
    retitlePanels();
    syncPanels();
    // 兜底：布局恢复/首帧渲染后可见性可能尚未稳定，延迟再同步一次
    window.setTimeout(syncPanels, 200);
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
      title: tx("空显示区", "Empty area"),
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
    // 切内置预设前：把当前布局快照到「自动备份」槽，随时可切回
    try {
      if (api.panels.length > 0) backupAutoLayout(api.toJSON());
    } catch {
      /* 快照失败不阻塞切换 */
    }
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

  /** 应用自定义布局槽位 */
  const applyLayoutSlot = (slotId: string) => {
    const api = apiRef.current;
    if (!api) return false;
    const slot = getLayout(slotId);
    if (!slot) return false;
    try {
      localStorage.removeItem(LAYOUT_KEY);
      api.clear();
      api.fromJSON(slot.layout as SerializedDockview);
      syncPanelsRef.current?.();
      return true;
    } catch {
      return false;
    }
  };

  /** 另存当前布局为命名槽位 */
  const saveCurrentLayout = (name: string): boolean => {
    const api = apiRef.current;
    if (!api || api.panels.length === 0) return false;
    try {
      saveLayout(name, api.toJSON());
      return true;
    } catch {
      return false;
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
    // AI 扩展面板：id 形如 ext-panel-<extId>，统一走 aiExtPanel 宿主组件
    if (id.startsWith("ext-panel-")) {
      const ext = getExtSnapshot(id.slice("ext-panel-".length));
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
        component: "aiExtPanel",
        title: `${ext?.name ?? tx("AI 面板", "AI Panel")}`,
        params: { extId: id.slice("ext-panel-".length) },
        ...(ref
          ? { position: { referencePanel: ref.id, direction: "within" as const } }
          : {}),
      });
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
      title: panelTitleOf(id as PanelId),
      ...(ref
        ? { position: { referencePanel: ref.id, direction: "within" as const } }
        : {}),
    });
  };

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
      <TitleBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenAi={() => setAiOpen((v) => !v)}
      />
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
            title={tx("重新添加显示区：选择面板名即加入当前活动分组；全部关闭时将新建满屏显示区", "Re-add a display area: picking a panel joins the active group; when all are closed a full-screen area is created")}
            onChange={(e) => {
              if (e.target.value) addOrFocusPanel(e.target.value);
            }}
          >
            <option value="">{tx("+ 面板", "+ Panel")}</option>
            {Object.entries(PANEL_TITLES()).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
            {extPanelOptions.length > 0 && (
              <optgroup label={tx("AI 扩展面板", "AI extension panels")}>
                {extPanelOptions.map((e) => (
                  <option key={`ext-panel-${e.id}`} value={`ext-panel-${e.id}`}>
                    {e.name}（AI）
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className={`btn icon-btn${editLayout ? " warn" : ""}`}
            onClick={() => setEditLayout((v) => !v)}
            title={tx("编辑显示区布局：沿显示区边缘的 + 号向对应方向新建空显示区", "Edit layout: use the + buttons on area edges to add empty areas in that direction")}
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
            dockBase === "dark" ? "dockview-theme-dark" : "dockview-theme-light"
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
                title={tx("向左新建显示区", "Add area to the left")}
                onClick={() => addGroupInDirection(g.id, "left")}
              >
                +
              </button>
              <button
                className="le-btn le-right"
                title={tx("向右新建显示区", "Add area to the right")}
                onClick={() => addGroupInDirection(g.id, "right")}
              >
                +
              </button>
              <button
                className="le-btn le-top"
                title={tx("向上新建显示区", "Add area above")}
                onClick={() => addGroupInDirection(g.id, "above")}
              >
                +
              </button>
              <button
                className="le-btn le-bottom"
                title={tx("向下新建显示区", "Add area below")}
                onClick={() => addGroupInDirection(g.id, "below")}
              >
                +
              </button>
              <button
                className="le-clear"
                title={tx("清空该显示区内所有面板（显示区随之消失）", "Close all panels in this area (the area disappears with them)")}
                onClick={() => clearGroup(g.id)}
              >
                {tx("清空", "Clear")}
              </button>
            </div>
          ))}
      </div>
      <StatusBar perfOn={perfOn} />
      {settingsOpen && (
        <SettingsModal
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
          onResetLayout={(p) => resetLayout(p)}
          onApplyLayout={(id) => applyLayoutSlot(id)}
          onSaveLayout={(name) => saveCurrentLayout(name)}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {aiOpen && (
        <AiFloat
          onDock={() => {
            setAiOpen(false);
            addOrFocusPanel("ai");
          }}
          onClose={() => setAiOpen(false)}
        />
      )}
      <WidgetFloats />
      <JsonDropImport />
    </div>
  );
}

let renderTick = 0;

/** 状态栏叶子组件：独立订阅串口状态+计数器与遥测统计。
 *  收流期间计数器 5Hz 变化只重渲染这个小叶子，不再拖着整个 App 重渲染 */
function StatusBar({ perfOn }: { perfOn: boolean }) {
  const subBoth = (cb: () => void) => {
    const u1 = serialStore.subscribe(cb);
    const u2 = serialStore.subscribeCounters(cb);
    return () => {
      u1();
      u2();
    };
  };
  const serial = useSyncExternalStore(subBoth, serialStore.getSnapshot);
  const tele = useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getSnapshot);
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
    <footer className="statusbar">
      <span className="status-left">
        <span className={`dot ${serial.status}`} />
        {statusText}
        {serial.error && <span className="status-error">{serial.error}</span>}
        {perfOn && <PerfHud />}
      </span>
      <span className="status-right">
        RX {serial.rxTotal} B · TX {serial.txTotal} B · {bpsText} · {tx("帧", "fr")}{" "}
        {tele.stats.total}/{tx("错", "err")} {tele.stats.errors}
      </span>
    </footer>
  );
}

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
      {kind === "tcp-server" && (
        <select
          className="input"
          value={s.net.localHost}
          disabled={busy}
          title={tx("服务端监听地址：0.0.0.0 接受所有网卡连接，指定网卡则只接受发往该地址的连接", "Listen address: 0.0.0.0 accepts connections on all NICs; a specific address only accepts connections sent to it")}
          onChange={(e) => serialStore.setNet({ localHost: e.target.value })}
        >
          <option value="0.0.0.0">0.0.0.0 ({tx("所有地址都将开启侦听", "listen on all addresses")})</option>
          <option value="127.0.0.1">127.0.0.1 ({tx("本地回环地址", "loopback only")})</option>
          {s.localAddrs.map((a) => (
            <option key={a.ip} value={a.ip}>
              {a.ip} ({a.name})
            </option>
          ))}
          {s.net.localHost &&
            s.net.localHost !== "0.0.0.0" &&
            s.net.localHost !== "127.0.0.1" &&
            !s.localAddrs.some((a) => a.ip === s.net.localHost) && (
              <option value={s.net.localHost}>{s.net.localHost} ({tx("自定义", "custom")})</option>
            )}
        </select>
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
  useLocale();
  const [info, setInfo] = useState({ fps: 0, long: 0, render: 0, ipc: 0, ipcMax: 0 });
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
      const ipc = takeIpcLatency();
      setInfo({
        fps: s.frames,
        long: s.long,
        render: renderTick,
        ipc: Math.round(ipc.avg),
        ipcMax: Math.round(ipc.max),
      });
      s.frames = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(s.raf);
      clearInterval(timer);
      po?.disconnect();
    };
  }, []);
  return (
    <span
      className="perf-hud"
      title={tx("每秒刷新：FPS / >50ms 长任务累计 / React 渲染次数 / IPC 投递延迟（均值·峰值，主线程积压时飙升）", "Per-second: FPS / >50ms long tasks / React renders / IPC delivery latency (avg·peak, spikes when the main thread backs up)")}
    >
      {info.fps}fps · {tx("长", "lt")}{info.long} · {tx("渲", "ren")}{info.render} · IPC{info.ipc}/{info.ipcMax}ms
    </span>
  );
}
