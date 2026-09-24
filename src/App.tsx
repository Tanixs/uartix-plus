import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
  type IDockviewPanel,
} from "dockview-react";
import { panelComponents, PANEL_TITLES, panelTitleOf } from "./panels/panels";
import {
  PANEL_GROUPS,
  getRecentPanels,
  panelGroupLabel,
  pushRecentPanel,
} from "./panels/panelMenu";
import * as panelActivity from "./panels/panelActivity";
import { SerialToolbar } from "./features/serial/SerialToolbar";
import { TitleBar } from "./shell/TitleBar";
import { IconColumns } from "./shared/icons";
import { confirmDialog } from "./shared/Dialog";
import type { IfaceKind } from "./features/serial/serialStore";
import { SETTINGS_TAB_PLUGINS, type WorkspacePreset } from "./features/settings/settingsStore";
import { JsonDropImport } from "./features/settings/JsonDropImport";
import { AiFloat } from "./features/ai/AiFloat";
import { WidgetFloats } from "./features/ai/WidgetFloats";
import { SentinelFloat } from "./features/sentinel/SentinelPanel";
import * as sentinelStore from "./features/sentinel/sentinelStore";
import { startWidgetHub } from "./features/ai/widgetHub";
import { applyStyleExts, startExtRuntime } from "./features/ai/extRuntime";
import { activeThemeFacts, subscribeStyleApply } from "./styles/themeFacts";
import {
  getExt as getExtSnapshot,
  useExtensions,
} from "./features/ai/extensionStore";
import * as chatStore from "./features/ai/chatStore";
import { onAiScene, onOpenSettings, onPop } from "./features/ai/aiBus";
import { onRequestOpenExtPanel } from "./features/ai/extBus";
import { subscribeAppBus } from "./features/ai/appBus";
import { MarketDialog } from "./features/market/MarketDialog";
import { InstallConfirm } from "./features/market/InstallConfirm";
import {
  backupAutoLayout,
  getLayout,
  saveLayout,
} from "./features/settings/layoutsStore";
import { useChrome } from "./features/settings/chromeStore";
import { applyLayoutJson } from "./features/settings/applyLayout";
import {
  getSnapshot as getSettingsSnapshot,
  patch,
  useSettings,
} from "./features/settings/settingsStore";
import * as controlsStore from "./features/controls/controlsStore";
import { SettingsModal } from "./features/settings/SettingsModal";
import { HelpModal } from "./features/help/HelpModal";
import { TourHost } from "./features/tour/TourHost";
import * as vdevStore from "./features/vdev/vdevStore";
import type { PanelId } from "./ipc/types";
import * as serialStore from "./features/serial/serialStore";
import * as sessionStore from "./features/session/sessionStore";
import * as operatorStore from "./features/operator/operatorStore";
import * as xferStore from "./features/xfer/xferStore";
import * as templateStore from "./features/protocol/templateStore";
import * as framesStore from "./features/table/framesStore";
import * as plotStore from "./features/plot/plotStore";
import * as attitudeStore from "./features/attitude/attitudeStore";
import * as variableStore from "./features/controls/variableStore";
import * as fcStore from "./features/framecanvas/frameStore";
import * as telemetryStore from "./features/protocol/telemetryStore";
import * as mcpServer from "./features/mcp/mcpServer";
import { notifyLocale, t, tx, useLocale } from "./i18n/strings";
import { takeIpcLatency } from "./ipc/ipcLatency";
import { subscribeReplayClock } from "./features/analysis/timeNavigation";
import { subscribeAnalysisAi } from "./features/analysis/analysisAi";
import AnalysisExportDialog from "./features/analysis/AnalysisExportDialog";
import type { AnalysisSnapshot } from "./features/analysis/analysisSnapshot";
import { subscribeAnalysisExport } from "./features/analysis/analysisExportEvents";
import { installFxStylesheet } from "./features/agent/fxRecipes";

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

  if (preset === "calib") {
    // 3D 校准（P82③）：3D 轨迹主视 + 帧画布堆叠，右侧 2D 曲线看原始通道，底部控制台
    api.addPanel({
      id: "plot3d",
      component: "plot3d",
      title: panelTitleOf("plot3d"),
      initialWidth: midW + rightW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "framecanvas",
      component: "framecanvas",
      title: panelTitleOf("framecanvas"),
      position: { referencePanel: "plot3d", direction: "within" },
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: panelTitleOf("plot2d"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "plot3d", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "plot3d", direction: "below" },
    });
    api.getPanel("plot3d")?.api.setActive();
    return;
  }

  if (preset === "auto") {
    // 自动化（P82③）：编排器居中，序列器左、哨兵右，底部曲线+控制台——无模板锚点（自动化场景协议已就绪）
    api.addPanel({
      id: "sequencer",
      component: "sequencer",
      title: panelTitleOf("sequencer"),
      initialWidth: leftW,
      minimumWidth: 260,
    });
    api.addPanel({
      id: "orchestrator",
      component: "orchestrator",
      title: panelTitleOf("orchestrator"),
      initialWidth: midW,
      position: { referencePanel: "sequencer", direction: "right" },
    });
    api.addPanel({
      id: "sentinel",
      component: "sentinel",
      title: panelTitleOf("sentinel"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "orchestrator", direction: "right" },
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: panelTitleOf("plot2d"),
      initialHeight: bottomH,
      minimumHeight: 140,
      position: { referencePanel: "orchestrator", direction: "below" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
      position: { referencePanel: "plot2d", direction: "within" },
    });
    api.getPanel("orchestrator")?.api.setActive();
    return;
  }

  if (preset === "modbus") {
    // 工业 Modbus（P82③）：工作台居中，右侧指令工厂所在控制台，底部 Hex + 表格
    api.addPanel({
      id: "modbus",
      component: "modbus",
      title: panelTitleOf("modbus"),
      initialWidth: midW + rightW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
      initialWidth: rightW,
      minimumWidth: 260,
      position: { referencePanel: "modbus", direction: "right" },
    });
    api.addPanel({
      id: "hexview",
      component: "hexview",
      title: panelTitleOf("hexview"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "modbus", direction: "below" },
    });
    api.addPanel({
      id: "table",
      component: "table",
      title: panelTitleOf("table"),
      position: { referencePanel: "hexview", direction: "right" },
    });
    api.getPanel("modbus")?.api.setActive();
    return;
  }

  if (preset === "vdev") {
    // 虚拟设备（P82③）：工坊居中，右侧曲线即时观察，底部帧画布 + 控制台
    api.addPanel({
      id: "vdev",
      component: "vdev",
      title: panelTitleOf("vdev"),
      initialWidth: midW,
      position: { referencePanel: "templates", direction: "right" },
    });
    api.addPanel({
      id: "plot2d",
      component: "plot2d",
      title: panelTitleOf("plot2d"),
      initialWidth: rightW,
      minimumWidth: 240,
      position: { referencePanel: "vdev", direction: "right" },
    });
    api.addPanel({
      id: "framecanvas",
      component: "framecanvas",
      title: panelTitleOf("framecanvas"),
      initialHeight: bottomH,
      minimumHeight: 120,
      position: { referencePanel: "vdev", direction: "below" },
    });
    api.addPanel({
      id: "console",
      component: "console",
      title: panelTitleOf("console"),
      position: { referencePanel: "framecanvas", direction: "right" },
    });
    api.getPanel("vdev")?.api.setActive();
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
  api.addPanel({
    id: "table",
    component: "table",
    title: panelTitleOf("table"),
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
    // P82③：分析预设右下从 3D 姿态换成频谱——与 2D 共享通道，"分析"主题更聚焦
    api.addPanel({
      id: "spectrum",
      component: "spectrum",
      title: panelTitleOf("spectrum"),
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
  useEffect(subscribeReplayClock, []);
  useEffect(subscribeAnalysisAi, []);
  const settings = useSettings();
  const theme = settings.theme;
  const [editLayout, setEditLayout] = useState(false);
  const [perfOn, setPerfOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 插件市场只在这里渲染一份：插件库与标题栏两颗按钮都只发 `openMarket` 信号 */
  const [marketOpen, setMarketOpen] = useState(false);
  const [analysisExport, setAnalysisExport] = useState<{ snapshot?: AnalysisSnapshot } | null>(null);
  useEffect(() => subscribeAnalysisExport((snapshot) => setAnalysisExport({ snapshot })), []);
  const [aiOpen, setAiOpen] = useState(false);
  const [groupBoxes, setGroupBoxes] = useState<
    { id: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const apiRef = useRef<DockviewApi | null>(null);
  const syncPanelsRef = useRef<(() => void) | null>(null);
  const retitlePanelsRef = useRef<(() => void) | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  const operator = operatorStore.useOperator(); // P67：只读模式横幅 + 布局应用
  const exts = useExtensions();
  const extPanelOptions = exts.exts.filter((e) => e.type === "panel" && e.enabled);
  // B6：「最近使用」置顶（会话内响应式；跨会话持久在 localStorage）
  const [recentPanels, setRecentPanels] = useState<string[]>(() => getRecentPanels());
  renderTick += 1;

  useEffect(() => {
    /**
     * P99b-N5：主题落地只有 `extRuntime.applyStyleExts()` 一个出口（详设 R7）。
     * 这里以前自己写 `documentElement.dataset.theme`，并且**自己判 `system` 解析成 light 还是 dark**——
     * 同一段判断在 `SettingsModal` 与 `appActions.setTheme` 里还各有一份副本（三份里任何一份
     * 改了内置归类，另外两份就悄悄错）。现在三个触发点都只是"东西变了，重算一遍"。
     */
    const apply = () => applyStyleExts();
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  /**
   * dockview 基础类跟的是**当前在画那一枚**的明暗归属，不是 `settings.theme`——
   * 同级之后插件主题也可能是在画的那枚（内置那一枚只是"停用插件后回到的那个"）。
   */
  const dockBase = useSyncExternalStore(subscribeStyleApply, () => activeThemeFacts().scheme);

  useEffect(() => {
    document.documentElement.style.zoom = `${settings.zoom}%`;
    // 通知浮窗类组件重算逻辑坐标（zoom 改变 vw/vh 语义但不触发 resize）
    window.dispatchEvent(new Event("vs-zoom-change"));
  }, [settings.zoom]);

  // P97-I3：动效配方表（CSS 由 fxRecipes.ts 生成，theme.css 里不留平行清单；显式调用，不做求值期副作用）
  useEffect(() => {
    installFxStylesheet();
  }, []);

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

  // 减弱动效：html.no-motion 全局禁动画/过渡（CSS 规则见 theme.css）
  useEffect(() => {
    document.documentElement.classList.toggle("no-motion", settings.reduceMotion);
  }, [settings.reduceMotion]);

  useEffect(() => {
    serialStore.init();
    templateStore.init();
    telemetryStore.init();
    framesStore.init();
    plotStore.init();
    attitudeStore.init();
    variableStore.init();
    fcStore.init();
    sessionStore.init();
    xferStore.init();
    sentinelStore.init();
    operatorStore.init(); // 持久化的 Operator 部署包 → 恢复只读模式
    mcpServer.init();
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
      } else if (msg.kind === "closePanel") {
        const api = apiRef.current;
        const panel = api?.getPanel(msg.panel);
        if (api && panel) api.removePanel(panel);
      } else if (msg.kind === "applyPreset") {
        patch({ workspace: msg.preset as WorkspacePreset });
        resetLayout(msg.preset as WorkspacePreset);
      } else if (msg.kind === "openMarket") {
        setMarketOpen(true);
      } else if (msg.kind === "applyLayout") {
        // P99a-D1b：插件库「应用此布局」。布局 JSON 由包带来，执行权仍只在这里（dockview api 不出 App）
        const api = apiRef.current;
        localStorage.removeItem(LAYOUT_KEY);
        msg.done(applyLayoutJson(api, msg.layout, {
          before: () => {
            if (api) backupAutoLayout(api.toJSON());
          },
          after: afterLayoutChange,
        }));
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
    // 稳定主题作用域：面板内容根挂 data-panel=<组件名>，主题/样式层不再依赖易变类名。
    // 成员名要以 dockview 8 的声明为准：`panel.window` / `panel.type` 在 IDockviewPanel 上
    // 根本不存在（旧写法靠一对 as unknown as 按住 tsc，于是这行属性从来没写过——
    // 引导的面板步与编排器面板截图都静默死了）。
    const tagPanel = (p: IDockviewPanel) => {
      p.view.content.element.setAttribute("data-panel", p.view.contentComponent);
    };
    api.onDidAddPanel((e) => {
      tagPanel(e);
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

  // Operator 部署包布局（P67-O2）：激活时整屏应用；切换前把当前布局快照到自动备份槽
  useEffect(() => {
    const lay = operator.pkg?.payload.layout;
    const api = apiRef.current;
    if (!lay || !api) return;
    try {
      if (!operator.restored && api.panels.length > 0) backupAutoLayout(api.toJSON());
      api.clear();
      api.fromJSON(lay as SerializedDockview);
      retitlePanelsRef.current?.();
      syncPanelsRef.current?.();
    } catch {
      /* 布局不兼容则保持现状 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator.pkg]);

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
            x: (i % 3) * 2,
            y: Math.floor(i / 3),
            w: 2,
            h: 1,
          })),
        });
      }
    }
  };

  /** 布局换了之后的统一收尾：面板标题按语言重挂 + 可见性同步（三处应用点共用，别再各写一遍） */
  const afterLayoutChange = () => {
    retitlePanelsRef.current?.();
    syncPanelsRef.current?.();
  };

  /** 应用自定义布局槽位 */
  const applyLayoutSlot = (slotId: string) => {
    const slot = getLayout(slotId);
    if (!slot) return false;
    // 命名槽与插件布局都是"整屏覆盖"，动手前先把当前布局快照进自动备份槽：点错了有地方回
    const api = apiRef.current;
    localStorage.removeItem(LAYOUT_KEY);
    return applyLayoutJson(api, slot.layout, {
      before: () => {
        if (api) backupAutoLayout(api.toJSON());
      },
      after: afterLayoutChange,
    }) === null;
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
    // B6：记录「最近使用」（打开与聚焦都算一次真实使用）
    setRecentPanels(pushRecentPanel(id));
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

  // P88b-3：插件库「加入工作区」→ 打开对应影子扩展面板（ext-panel-<影子ID>）
  const openExtPanelRef = useRef<(id: string) => void>(null);
  openExtPanelRef.current = addOrFocusPanel;
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) openExtPanelRef.current?.(`ext-panel-${detail}`);
    };
    window.addEventListener("ux:open-ext-panel", h);
    return () => window.removeEventListener("ux:open-ext-panel", h);
  }, []);

  // P103 批2：工具栏三段分区（接口参数 ｜ 会话 ｜ 面板与布局）。顺序与显隐由 chromeStore 驱动
  // （chrome_set 工具的落点）；段间竖线分隔，spacer 永远垫在最后一段之前（默认序 = 布局段贴右，同旧版）。
  const chrome = useChrome();
  const chromeSegs = chrome.order.filter((s) => !chrome.hidden.includes(s));
  const chromeSegNodes: ReactNode[] = [];
  chromeSegs.forEach((seg, i) => {
    if (i > 0) {
      chromeSegNodes.push(
        i === chromeSegs.length - 1 && chromeSegs.length > 1 ? (
          <div key="__spacer" className="toolbar-spacer" />
        ) : (
          <div key={`__sep-${seg}`} className="toolbar-sep" />
        ),
      );
    }
    chromeSegNodes.push(
      <div key={seg} className={`toolbar-seg toolbar-seg-${seg}`}>
        {seg === "connect" ? (
          serial.iface === "serial" ? (
            <SerialToolbar />
          ) : serial.iface === "ble" ? (
            <BleIfaceBar />
          ) : (
            <NetIfaceBar kind={serial.iface} />
          )
        ) : seg === "session" ? (
          <SessionBar />
        ) : (
          <div className="toolbar-group">
            <select
              className="input"
              value=""
              title={tx("重新添加显示区：选择面板名即加入当前活动分组；全部关闭时将新建满屏显示区", "Re-add a display area: picking a panel joins the active group; when all are closed a full-screen area is created")}
              onChange={(e) => {
                if (e.target.value) addOrFocusPanel(e.target.value);
              }}
            >
              <option value="" hidden>{tx("+ 面板", "+ Panel")}</option>
              {recentPanels.length > 0 && (
                <optgroup label={tx("最近使用", "Recently used")}>
                  {recentPanels.map((id) => (
                    <option key={`recent-${id}`} value={id}>
                      {panelTitleOf(id)}
                    </option>
                  ))}
                </optgroup>
              )}
              {PANEL_GROUPS.map((g) => (
                <optgroup key={g.key} label={panelGroupLabel(g)}>
                  {g.ids.map((id) => (
                    <option key={id} value={id}>
                      {PANEL_TITLES()[id]}
                    </option>
                  ))}
                </optgroup>
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
        )}
      </div>,
    );
  });

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
        onOpenLibrary={() => {
          /* 标题栏那颗开的是设置页的插件管理栏——复用现成页，不再造第三个插件库窗口 */
          setSettingsTab(SETTINGS_TAB_PLUGINS);
          setSettingsOpen(true);
        }}
        onOpenAi={() => setAiOpen((v) => !v)}
      />
      {/* P103 批2：三段内容在上方按 chromeStore 顺序拼好（data-tour 锚点全在各段组件内部，未动） */}
      <header className="toolbar">{chromeSegNodes}</header>
      <OperatorBanner onExit={() => operatorStore.exit()} />
      <div className="app-shell" ref={shellRef}>
        <DockviewReact
          components={panelComponents}
          onReady={onReady}
          dndStrategy="pointer"
          theme={{
            name: "uartix",
            className:
              dockBase === "dark" ? "dockview-theme-dark" : "dockview-theme-light",
            colorScheme: dockBase === "dark" ? "dark" : "light",
            dndOverlayMounting: "absolute",
          }}
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
      {marketOpen && <MarketDialog onClose={() => setMarketOpen(false)} />}
      {analysisExport && <AnalysisExportDialog snapshot={analysisExport.snapshot} onClose={() => setAnalysisExport(null)} />}
      {aiOpen && (
        <AiFloat
          onDock={() => {
            setAiOpen(false);
            addOrFocusPanel("ai");
          }}
          onClose={() => setAiOpen(false)}
        />
      )}
      {/* 装包确认卡：全局只这一份。以前挂在插件库弹窗里，关掉弹窗就没人看得见它——
          而命令行那句"请在应用里点装入"指的就是这里（N4 收的那笔账） */}
      <InstallConfirm />
      <WidgetFloats />
      <SentinelFloat />
      <JsonDropImport />
      <TourHost />
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
  const demo = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const vdev = useSyncExternalStore(vdevStore.subscribe, vdevStore.getSnapshot);
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
        {/* C17：演示源在跑时状态栏不再误报「未连接」——数据明明在流动 */}
        {demo.demoRunning && (
          <span
            className="status-demo"
            title={tx("内置演示源运行中（协议面板可停止）", "Built-in demo source running (stop it in the protocol panel)")}
          >
            {tx("演示源", "Demo")}
          </span>
        )}
        {vdev.running && (
          <span
            className="status-demo"
            title={tx(`虚拟设备「${vdev.device ?? ""}」运行中（虚拟设备工坊可停止）`, `Virtual device "${vdev.device ?? ""}" running (stop it in the workshop)`)}
          >
            {tx("虚拟设备", "VDev")}
          </span>
        )}
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
  const onToggle = async () => {
    if (!busy) {
      await serialStore.openPort();
      return;
    }
    // 录制中禁止断开：录制 tap 在 Rust 侧持续接管帧流，断开会截断会话
    if (sessionStore.isRecording()) {
      serialStore.setError(tx("录制中禁止断开连接", "Cannot disconnect while recording"));
      return;
    }
    await serialStore.closePort();
  };
  return (
    <div className="toolbar-group">
      <button
        className={`btn${busy ? " warn" : ""}`}
        title={busy ? t("tb.disconnect") : t("tb.connect")}
        onClick={() => void onToggle()}
      >
        <span className={`dot ${busy ? "connected" : "disconnected"}`} />
        {busy ? t("tb.disconnect") : t("tb.connect")}
      </button>
      {kind !== "tcp-client" && (
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

/** Operator 只读模式横幅（P67-O2）：包名 + 只读说明 + 退出。
 *  只读范围：协议模板/控制页/命令库（store 门禁）；连接/发送/监视/回放不受限。 */
function OperatorBanner({ onExit }: { onExit: () => void }) {
  const op = operatorStore.useOperator();
  useLocale();
  if (!op.pkg) return null;
  return (
    <div className="op-banner" role="status">
      <span className="op-badge">Operator</span>
      <span className="op-name">{op.pkg.meta.name}</span>
      {op.pkg.meta.description && <span className="op-desc">{op.pkg.meta.description}</span>}
      <span className="op-hint">
        {tx("配置只读：可连接设备、发送命令、查看数据", "Read-only: connect devices, send commands, view data")}
      </span>
      <span style={{ flex: 1 }} />
      <button
        className="btn"
        onClick={() => {
          void (async () => {
            if (await confirmDialog(tx("退出 Operator 模式？已导入的配置将解除只读保护", "Exit operator mode? Imported configuration will become editable"))) {
              onExit();
            }
          })();
        }}
      >
        {tx("退出 Operator 模式", "Exit operator mode")}
      </button>
    </div>
  );
}

/** BLE 接口栏（P48）：扫描 → 选设备 → 连接；通知流/发送路由在 Rust ble.rs，
 *  状态与收发事件与串口/网络完全同源（serial:state + binbus），本组件只做选择与触发。 */
function BleIfaceBar() {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染
  const busy = s.status === "connected" || s.status === "reconnecting";
  const onToggle = async () => {
    if (!busy) {
      await serialStore.openPort();
      return;
    }
    // 录制中禁止断开：录制 tap 在 Rust 侧持续接管帧流，断开会截断会话
    if (sessionStore.isRecording()) {
      serialStore.setError(tx("录制中禁止断开连接", "Cannot disconnect while recording"));
      return;
    }
    await serialStore.closePort();
  };
  const onScan = async () => {
    try {
      if (s.bleScanning) {
        await serialStore.bleScanStop();
      } else {
        await serialStore.bleScanStart();
      }
    } catch {
      /* 错误已在状态栏展示 */
    }
  };
  return (
    <div className="toolbar-group">
      <button
        className={`btn${busy ? " warn" : ""}`}
        title={busy ? t("tb.disconnect") : t("tb.connect")}
        onClick={() => void onToggle()}
      >
        <span className={`dot ${busy ? "connected" : "disconnected"}`} />
        {busy ? t("tb.disconnect") : t("tb.connect")}
      </button>
      <button
        className={`btn${s.bleScanning ? " warn" : ""}`}
        disabled={busy}
        title={
          s.bleScanning
            ? tx("停止扫描", "Stop scanning")
            : tx("扫描附近 BLE 设备（列表按信号强度排序，每秒刷新）", "Scan nearby BLE devices (list sorted by signal strength, refreshed every second)")
        }
        onClick={() => void onScan()}
      >
        {s.bleScanning ? tx("停止扫描", "Stop scan") : tx("扫描", "Scan")}
      </button>
      <select
        className="input"
        value={s.bleDeviceId}
        disabled={busy}
        title={tx("BLE 设备：需支持透传（Nordic UART 或可写+可通知特征对）", "BLE device: must support transparent transfer (Nordic UART or a writable+notifiable characteristic pair)")}
        onChange={(e) => serialStore.setBleDevice(e.target.value)}
      >
        <option value="">
          {s.bleDevices.length
            ? tx("选择设备", "Select device")
            : tx("先点「扫描」发现设备", "Click “Scan” to discover devices")}
        </option>
        {s.bleDevices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name || tx("(未命名)", "(unnamed)")} — {d.id} · {d.rssi} dBm
          </option>
        ))}
      </select>
      {s.bleChars.length > 0 && (
        <>
          <select
            className="input"
            value={s.bleWriteChar}
            title={tx(
              "写特征（发数据）：默认自动选择；非标准透传设备可手动指定",
              "Write characteristic (TX): auto-selected by default; pick manually for non-standard devices",
            )}
            onChange={(e) => {
              serialStore.setBleCharSel({ bleWriteChar: e.target.value });
              void serialStore.applyBleChars();
            }}
          >
            <option value="">{tx("写特征：自动", "Write char: auto")}</option>
            {s.bleChars
              .filter((c) => c.kind.includes("write"))
              .map((c) => (
                <option key={c.uuid} value={c.uuid}>
                  {c.uuid.slice(0, 8)}… · {c.kind}
                </option>
              ))}
          </select>
          <select
            className="input"
            value={s.bleNotifyChar}
            title={tx(
              "收特征（notify/indicate）：默认自动选择；非标准透传设备可手动指定",
              "Notify characteristic (RX): auto-selected by default; pick manually for non-standard devices",
            )}
            onChange={(e) => {
              serialStore.setBleCharSel({ bleNotifyChar: e.target.value });
              void serialStore.applyBleChars();
            }}
          >
            <option value="">{tx("收特征：自动", "Notify char: auto")}</option>
            {s.bleChars
              .filter((c) => c.kind.includes("notify") || c.kind.includes("indicate"))
              .map((c) => (
                <option key={c.uuid} value={c.uuid}>
                  {c.uuid.slice(0, 8)}… · {c.kind}
                </option>
              ))}
          </select>
        </>
      )}
      <span className="iface-soon">{busy && s.portName ? `BLE · ${s.portName}` : "BLE"}</span>
    </div>
  );
}

/** 全局会话录制钮（16.2）：连接条右侧，录制/停止/保存/放弃。
 *  全局能力不依赖任何面板开合；录制中时长红点脉冲。 */
function SessionBar() {
  const s = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  useSettings(); // 语言切换时随设置重渲染
  if (s.state === "recording") {
    return (
      <div className="toolbar-group">
        <button
          className="btn sess-rec on"
          onClick={() => void sessionStore.stopRecord()}
          title={tx(
            "停止录制（内容保留在内存，可保存或放弃）",
            "Stop recording (kept in memory; save or discard)",
          )}
        >
          <span className="rec-dot" />
          {sessionStore.fmtDur(s.durationMs)}
        </button>
      </div>
    );
  }
  if (s.state === "recorded") {
    return (
      <div className="toolbar-group">
        <button
          className="btn"
          onClick={() => void sessionStore.saveSession()}
          title={tx(
            "把当前会话保存为 .usess 文件",
            "Save the current session as a .usess file",
          )}
        >
          {tx("保存会话", "Save session")}
        </button>
        <button
          className="btn"
          onClick={() => void sessionStore.discardSession()}
          title={tx(
            "放弃当前会话（未保存内容将丢失）",
            "Discard the current session (unsaved content is lost)",
          )}
        >
          {tx("放弃", "Discard")}
        </button>
      </div>
    );
  }
  return (
    <div className="toolbar-group">
      <button
        className="btn sess-rec"
        disabled={s.state === "playing" || s.state === "paused"}
        onClick={() => void sessionStore.startRecord()}
        title={
          s.state === "playing" || s.state === "paused"
            ? tx("回放中无法录制，请先停止回放", "Cannot record during replay; stop replay first")
            : tx(
                "录制会话：记录解析后的帧流，帧画布/2D/表格/3D/变量等全部内容可随时回放；串口/网络/演示源均可录制",
                "Record session: captures parsed frames — frame canvas/2D/table/3D/variables all replayable; works for serial/net/demo sources",
              )
        }
      >
        <span className="rec-dot" />
        {tx("录制", "Rec")}
      </button>
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
