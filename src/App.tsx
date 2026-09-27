import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  SerializedDockview,
  type IDockviewPanel,
} from "dockview-react";
import { panelComponents, PANEL_TITLES, panelTitleOf } from "./panels/panels";
import { applyDefaultLayout, gridSize } from "./shell/defaultLayout";
import {
  panelGroupsAddable,
  getRecentPanels,
  isRetiredPanel,
  panelGroupLabel,
  pushRecentPanel,
} from "./panels/panelMenu";
import * as panelActivity from "./panels/panelActivity";
import { IdentityBar, ToolBar, LinkCapsule } from "./shell/TopBars";
import { InfoBar } from "./shell/InfoBar";
import { SideRail } from "./shell/SideRail";
import { PanelChromeActions } from "./shell/PanelChromeActions";
import { railWidth, setRailPanelW, subscribeRail, toggleRailPanel, openRailPanel, type RailKey } from "./shell/railState";
import { CommandPalette } from "./shell/CommandPalette";
import { buildCommands, type PaletteDeps } from "./shell/commandRegistry";
import { Welcome } from "./shell/Welcome";
import { markWelcomeSeen, welcomeSeen } from "./shell/welcomeSlides";
import { devForensics, devOpenRequest, devWelcomeAt } from "./dev/bootOverrides";
import { type RailActions } from "./shell/RailPanel";
import { IfaceAction } from "./features/serial/ifaces";
import { ModbusBadge } from "./features/modbus/ModbusBadge";
import { IconLayoutEdit } from "./shared/icons";
import { confirmDialog } from "./shared/Dialog";
import { applyUiZoom } from "./shared/zoom";
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
  clearStoredLayout,
  saveLayout,
  getSnapshot as getLayoutsSnapshot,
  subscribe as subscribeLayouts,
} from "./features/settings/layoutsStore";
import * as tourStore from "./features/tour/tourStore";
import { TOUR_STEPS } from "./features/tour/tourSteps";
import { useChrome } from "./features/settings/chromeStore";
import { applyLayoutJson, looksLikeLayoutJson } from "./features/settings/applyLayout";
import {
  LAYOUT_KEY_CORRUPT,
  LAYOUT_KEY_V2,
  LAYOUT_KEY_V3,
  packEnvelope,
  unwrapEnvelope,
} from "./features/settings/layoutEnvelope";
import {
  getSnapshot as getSettingsSnapshot,
  patch,
  useSettings,
} from "./features/settings/settingsStore";
import * as controlsStore from "./features/controls/controlsStore";
import { SettingsModal } from "./features/settings/SettingsModal";
import { HelpModal } from "./features/help/HelpModal";
import { TourHost } from "./features/tour/TourHost";
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
import { notifyLocale, tx, useLocale } from "./i18n/strings";
import { takeIpcLatency } from "./ipc/ipcLatency";
import { subscribeReplayClock } from "./features/analysis/timeNavigation";
import { subscribeAnalysisAi } from "./features/analysis/analysisAi";
import AnalysisExportDialog from "./features/analysis/AnalysisExportDialog";
import type { AnalysisSnapshot } from "./features/analysis/analysisSnapshot";
import { subscribeAnalysisExport } from "./features/analysis/analysisExportEvents";
import { installFxStylesheet } from "./features/agent/fxRecipes";

// P104-B1：键名收敛到 layoutsStore 单处导出（OperatorGen 曾硬编码同一字面量，是第二真值）

/** 导出仅为可测性：它此前零覆盖，两个算术 bug（templates 被挤到最小宽、分母未除缩放）因此长期存活。
 *  B13 会重写拓扑，届时连同一组不变量测试一起搬进独立模块。 */

/** 退役面板的"打开"意图改派给谁：面板没了，需求还在。
 *  App 是唯一同时知道 `PanelId` 与导轨项的装配层，所以映射写在这、不写进 `panelMenu`。 */
const RAIL_OF_RETIRED: Record<string, RailKey> = { templates: "templates" };

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** P104-B7：一次性首启欢迎轮播。`?welcome=0|1` 在 React 挂载前就改好这个键（bootOverrides）。 */
  const [welcomeOpen, setWelcomeOpen] = useState(() => !welcomeSeen());
  const tourSnap = useSyncExternalStore(tourStore.subscribe, tourStore.getSnapshot);
  const closeWelcome = () => {
    markWelcomeSeen();
    setWelcomeOpen(false);
  };
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
    // P104-B1：缩放统一走 shared/zoom —— 它同时写 style.zoom 与 --zoom 根变量，
    // 并派发 vs-zoom-change（zoom 改变 vw/vh 语义但不触发 resize，浮窗要靠它重钳制）。
    applyUiZoom(settings.zoom);
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
        clearStoredLayout();
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
    // P111-A2：`?open=settings/ai` —— 把取证要拍的那个"打开态"直接摆出来。
    // 一次性：这个 effect 依赖表为空、只跑一次，用户之后关掉它不会被重新弹开。
    // 没有这层入口，P110-B3/B4 那种"界面交出去之前自己一眼没看"就会重演——
    // 设置页是纯 DOM，无头截图本来拍得到，缺的只是"启动后自动打开"这一句话。
    const devOpen = devOpenRequest(location.search);
    if (devOpen?.view === "settings") {
      setSettingsTab(devOpen.tab);
      setSettingsOpen(true);
    } else if (devOpen?.view === "ai") {
      setAiOpen(true);
    }
    // P113-A：`?railw=220&probe=overflow` —— 钉住导轨二级面板的宽度，再把"内容画到自己格子外面"
    // 的元素描红。拖窄才复现得出的叠字，光读 CSS 只能列候选、定不了案；这两个开关让它变成一张图。
    // 动态 import：不叫它的时候连模块都不下载，产品路径一行 CSS 都不加。
    const forensic = devForensics(location.search);
    if (forensic.railw) setRailPanelW(forensic.railw);
    // 这里**不能提前 return**：下面还要挂 unPop / onKey / 防拖拽导航，且它们的清理都在
    // 本 effect 末尾那一个 return 里 —— 中途 return 会让取证模式下的应用少一半监听器，
    // 而"只在 ?probe= 时坏"的 bug 最难查。所以只记一个 timer，交给同一个清理去撤。
    let probeTimer = 0;
    if (forensic.probeOverflow || forensic.click) {
      probeTimer = window.setTimeout(() => {
        if (forensic.probeOverflow) void import("./dev/overflowAudit").then(({ probeOverflowNow }) => probeOverflowNow());
        // `?click=` 点一下才出现的界面（弹窗、浮层、展开态）：不点就只能"相信代码"
        if (forensic.click) document.querySelector<HTMLElement>(forensic.click)?.click();
      }, 1400);
    }
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
        return;
      }
      /* P104-B9：命令面板。刻意**不抢 Ctrl+K** —— 那是 AI 的既有开关，
         抢它等于让一批人的肌肉记忆静默失效，而这类失效不会报错、只会"手感不对"。
         用户 2026-09-25 判定：AI 保留 Ctrl+K，面板走 Ctrl+Shift+P。
         （`metaKey` 那半是给 macOS 的；本仓目前只在 Windows 上验过，
         没验过的键位不该装作可用 —— 但绑定本身无害，先一起挂上。） */
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === "p" || e.key === "P")
      ) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      if (probeTimer) window.clearTimeout(probeTimer);
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
    /* P104-R 遗留：老 v2 存档与命名布局槽里残留的 `templates` 面板，恢复后不要摆出来。
       注册表与 `PanelId` 都留着（B13 才正式退役），所以旧存档照常反序列化、
       用户存的布局文件一个字不改；但内容已搬进导轨「协议」，画布上再摆一份
       就是同一事实的第二个落点。

       "隐藏"在这里只能落成 close()：dockview 8.2 的 `DockviewPanelApi` 声明是
       `Omit<GridviewPanelApi, "setVisible" | ...>`——面板级 setVisible 被显式摘掉了，
       也没有 hidden-container 之类的概念。关的是**这个实例**，不是那个面板：
       组件仍注册，`addOrFocusPanel("templates")` 随时能再开回来。

       挂在 onDidAddPanel 上而不是三条 fromJSON 路径各补一次：启动恢复、布局槽、
       Operator 部署包都走这里，写三处就是三个真值。
       关闭延到微任务——`onDidAddPanel` 还在 dockview 自己的派发栈上，
       当场 removePanel 是重入。 */
    const retireOnAdd = (p: IDockviewPanel) => {
      if (!isRetiredPanel(p.id)) return;
      queueMicrotask(() => {
        if (api.getPanel(p.id)) p.api.close();
      });
    };
    api.onDidAddPanel((e) => {
      tagPanel(e);
      retitlePanels();
      syncPanels();
      retireOnAdd(e);
    });
    api.onDidRemovePanel(syncPanels);
    api.onDidActivePanelChange(syncPanels);
    /* P104-B13①：存档读写走版本信封。
       旧写法在 `fromJSON` 抛异常时 `localStorage.removeItem(LAYOUT_KEY)` ——
       那是**静默删掉用户自己摆的布局**。布局不像主题，改坏了没有"撤销"，
       用户看到的直接是"我摆好的东西没了"。现在改成：坏档挪进 `vs.layout.corrupt` 留着，
       界面退回默认拓扑，取证时那份原样档还在。 */
    const persistLayout = () => {
      try {
        localStorage.setItem(LAYOUT_KEY_V3, packEnvelope(api.toJSON()));
      } catch {
        /* 存档写不进去（配额 / 隐私模式）不该让工作台崩掉 */
      }
    };
    api.onDidLayoutChange(persistLayout);
    const raw = localStorage.getItem(LAYOUT_KEY_V3) ?? localStorage.getItem(LAYOUT_KEY_V2);
    const unwrapped = unwrapEnvelope(raw, looksLikeLayoutJson);
    if (unwrapped && unwrapped.kind !== "bad") {
      try {
        api.fromJSON(unwrapped.layout as SerializedDockview);
        // 读到的是裸的 v2 档 ⇒ 就地升级成 v3 信封。v2 键**故意留着**当后悔药，
        // 所以下面 persist 之后仍会同时存在两份；清理的时机不是这次。
        persistLayout();
        retitlePanels();
        syncPanels();
        return;
      } catch {
        /* 装不上：留着原档，落到默认布局 */
      }
    }
    if (unwrapped?.kind === "bad") {
      try {
        localStorage.setItem(LAYOUT_KEY_CORRUPT, unwrapped.raw);
      } catch {
        /* 连备份都写不下就算了，至少别白屏 */
      }
    }
    applyDefaultLayout(api, getSettingsSnapshot().workspace, panelTitleOf, railWidth());
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

  /* P104-B13③：编辑布局时的组框覆盖层。
     原先是 `setInterval(compute, 400)` —— 每 400ms 重排一次 React，且**永远滞后半秒**：
     拖完分隔条要等一下框才跟上，快速连续操作时看到的是旧位置。

     换成"观察我们真正要画的那些元素"：组元素本身在拖分栏时会改尺寸，
     所以 ResizeObserver 直接盯 `g.element` 就是最准的信号，
     不需要猜 dockview 的哪个事件覆盖了哪种改动。
     组的增删走 onDidAddGroup / onDidRemoveGroup 重新挂观察器；
     onDidLayoutChange 兜住"尺寸没变但位置变了"（如面板移动）；
     window resize 兜住整格外部尺寸变化。

     已知边界：ResizeObserver 在页面被遮挡时不发（B8、R 遗留都撞过这一刀）。
     这里可以接受——编辑布局时用户必然看着窗口；自动化取证要验的是"初始一致"，
     不是"拖拽实时性"。 */
  useEffect(() => {
    if (!editLayout) {
      setGroupBoxes([]);
      return;
    }
    let raf = 0;
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
    /** 一帧只算一次：拖分栏时 RO 会以指针频率连发，不去抖就是每帧一次 setState */
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    const ro = new ResizeObserver(schedule);
    const rewatch = () => {
      const api = apiRef.current;
      if (!api) return;
      ro.disconnect();
      for (const g of api.groups) ro.observe(g.element);
    };

    compute();
    rewatch();
    const subs = [
      apiRef.current?.onDidAddGroup(schedule),
      apiRef.current?.onDidRemoveGroup(schedule),
      apiRef.current?.onDidLayoutChange(schedule),
    ];
    const onResize = () => {
      schedule();
      rewatch();
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      for (const s of subs) (s as { dispose?: () => void })?.dispose?.();
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
    clearStoredLayout();
    api.clear();
    applyDefaultLayout(api, preset, panelTitleOf, railWidth());
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
    clearStoredLayout();
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

  /* P104-B9：命令面板的条目。
     `openPanels` 不另立状态——读 `panelActivity`（导轨「视图」也读它），
     并把它的版本串塞进 useMemo 依赖，这样"哪些面板开着"仍然是**一个**真值。 */
  const paletteActivity = useSyncExternalStore(panelActivity.subscribe, panelActivity.getSnapshot);
  const layoutsSnapshot = useSyncExternalStore(subscribeLayouts, getLayoutsSnapshot);
  const sessionSnap = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const protoSnap = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const paletteCommands = useMemo(() => {
    const api = apiRef.current;
    const slots = layoutsSnapshot.slots.map((s) => ({ id: s.id, name: s.name }));
    const deps: PaletteDeps = {
      panelTitleOf,
      openPanel: (id) => addOrFocusPanel(id),
      openPanels: api ? api.panels.map((p) => p.id) : [],
      applyPreset: (p) => resetLayout(p),
      resetLayout: () => resetLayout(getSettingsSnapshot().workspace),
      editLayout: () => setEditLayout((v) => !v),
      slots,
      applySlot: (id) => applyLayoutSlot(id),
      openRail: (key) => openRailPanel(key),
      toggleConnect: () => {
        // 与工具栏那颗「连接」同一支 store 调用，不另开一条路
        if (serialStore.getSnapshot().status === "connected" || serialStore.getSnapshot().status === "reconnecting") void serialStore.closePort();
        else void serialStore.openPort();
      },
      connected: serial.status === "connected" || serial.status === "reconnecting",
      toggleRecord: () => {
        const st = sessionStore.getSnapshot().state;
        if (st === "recording") void sessionStore.stopRecord();
        else void sessionStore.startRecord();
      },
      recording: sessionSnap.state === "recording",
      toggleDemo: () => void templateStore.toggleDemo(),
      demoOn: protoSnap.demoRunning,
      openAi: () => setAiOpen(true),
      openMarket: () => setMarketOpen(true),
      openSettings: (tab) => {
        setSettingsTab(tab);
        setSettingsOpen(true);
      },
      openHelp: () => setHelpOpen(true),
      restartTour: () => tourStore.start(TOUR_STEPS),
      setTheme: (mode) => patch({ theme: mode as typeof settings.theme }),
      setLocale: (loc) => patch({ locale: loc }),
      setZoom: (pct) => patch({ zoom: pct as 90 | 100 | 110 | 125 }),
      locale: settings.locale,
      zoom: settings.zoom,
    };
    return buildCommands(deps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteActivity, layoutsSnapshot, serial.status, sessionSnap.state, protoSnap.demoRunning, settings.locale, settings.zoom, settings.theme]);

  const railActions: RailActions = {
    editLayout,
    onToggleEditLayout: () => setEditLayout((v) => !v),
    onApplyLayoutSlot: (id) => {
      applyLayoutSlot(id);
    },
    onSaveLayout: saveCurrentLayout,
  };

  /**
   * 导轨二级面板开合会改画布宽。dockview 靠 ResizeObserver 自己重排，但那条通知
   * 绑在渲染帧上（页面被遮挡时不发，B8 实测撞到过：面板组仍按旧宽度排着、右边整条压在导轨底下）。
   * 所以这里不赌它——开合后直接拿公开出口 api.layout() 按新的网格尺寸重排一次。
   */
  useEffect(
    () =>
      subscribeRail(() => {
        const api = apiRef.current;
        if (!api) return;
        const g = gridSize(railWidth());
        api.layout(g.w, g.h);
      }),
    [],
  );

  const addOrFocusPanel = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    // B6：记录「最近使用」（打开与聚焦都算一次真实使用）
    setRecentPanels(pushRecentPanel(id));
    /* R 遗留：已退役的面板不再往画布上摆——内容搬进导轨了，摆出来就是同一事实的
       第二个落点。但"打开协议模板"这个**意图**是真实的（AI 的 openPanel、老代码里
       可能还留着的调用都走这条路），所以把它改派到导轨对应那一项，而不是静默什么都不做。
       B13 从 `PanelId` 里正式摘掉 templates 时，这条分支连同 `RETIRED_PANELS` 一起删。 */
    if (isRetiredPanel(id)) {
      toggleRailPanel(RAIL_OF_RETIRED[id]);
      return;
    }
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
          /* P104-B5 起链路段就瘦成"看一眼 + 按一下"；R4 再走一步：
             接口切换器也搬进导轨「接入」，这里只剩只读胶囊 + 连接动作 + Modbus 徽标。
             参数编辑（串口的 8N1、网络的地址端口、蓝牙的扫描与特征）是配置一次
             用一天的东西，不该常年占着顶栏。 */
          <div className="toolbar-group">
            <IfaceAction kind={serial.iface} />
            <LinkCapsule />
            {/* Modbus 服务在跑就必须看得见（面板可能已关）⇒ 常驻条，不跟参数进面板 */}
            <ModbusBadge />
          </div>
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
              {panelGroupsAddable().map((g) => (
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
              className={`btn icon-btn${editLayout ? " on" : ""}`}
              onClick={() => setEditLayout((v) => !v)}
              title={tx("编辑显示区布局：沿显示区边缘的 + 号向对应方向新建空显示区", "Edit layout: use the + buttons on area edges to add empty areas in that direction")}
            >
              <IconLayoutEdit />
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
      {/* P104-R2：顶部两条横栏。身份栏 38（品牌 / AI·插件·设置·帮助 / 窗口，零表单控件）
          + 工具栏 34（工作区预设 + chromeStore 装配好的三段）。
          B5 的合成条把这两件事糊在一行，读起来就是"标题栏很乱"。 */}
      <IdentityBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenAi={() => setAiOpen((v) => !v)}
        onOpenLibrary={() => {
          /* 这颗开的是设置页的插件管理栏——复用现成页，不再造第三个插件库窗口 */
          setSettingsTab(SETTINGS_TAB_PLUGINS);
          setSettingsOpen(true);
        }}
      />
      <ToolBar segs={chromeSegNodes} onApplyPreset={(p) => resetLayout(p)} />
      <OperatorBanner onExit={() => operatorStore.exit()} />
      {/* R1：左侧只有**一条**导轨。B5 的活动导轨（.rail）砍掉了——它按 PANEL_GROUPS
          分组，但用户要的是按"库"分（接入/协议/通道/控件/命令/视图），
          而"组内有面板开着"这个信息本身没有可操作价值。开面板的入口搬进「视图」项。
          导轨与它的二级面板都住在 dockview 外面：不占面板槽、不进序列化、不加 PanelId。
          必须在 .app-shell **之前**——二级面板要往右长，dockview 被往右挤。 */}
      <div className="app-body">
        <SideRail actions={railActions} />
        <div className="app-shell" ref={shellRef}>
          <DockviewReact
            components={panelComponents}
            onReady={onReady}
            dndStrategy="pointer"
            /* P104-B10：页签条右侧的动作区。没登记动作的面板这里什么都不画，
               所以铺开可以一个一个来；回退只要摘掉这一行。 */
            rightHeaderActionsComponent={PanelChromeActions}
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
      </div>
      {/* P104-B5：信息栏——计数从一整块不可点的字符串变成通往各自主人的入口 */}
      <InfoBar perfNode={perfOn ? <PerfHud /> : null} onOpenPanel={addOrFocusPanel} />
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
      {/* P104-B7：引导一激活本卡就让位——TourOverlay 量的是真实控件的矩形，
          卡片盖在上面时高亮环会套到浮层自己身上，引导当场失真。 */}
      {welcomeOpen && !tourSnap.active && (
        <Welcome
          dark={dockBase === "dark"}
          initial={devWelcomeAt() ?? 0}
          onStartTour={() => {
            closeWelcome();
            tourStore.start(TOUR_STEPS);
          }}
          onRunDemo={() => {
            closeWelcome();
            void templateStore.toggleDemo();
          }}
          onDismiss={closeWelcome}
        />
      )}
      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}
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
                "录制回放：记录解析后的帧流，帧画布/2D/表格/3D/变量等全部内容可随时回放；串口/网络/演示源均可录制。与控制台的「记录日志」是两件事（那只写文件，不可回放）",
                "Record for replay: captures parsed frames — frame canvas/2D/table/3D/variables all replayable; works for serial/net/demo sources. Different from Console’s log recording, which only writes a file",
              )
        }
      >
        <span className="rec-dot" />
        {tx("录制回放", "Record")}
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
