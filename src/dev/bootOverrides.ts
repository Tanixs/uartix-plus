/**
 * P104-B0 可验性基建：dev-only 启动覆盖。
 *
 * 为什么需要它：整窗自动化只能截到「用户上次留下的那一个状态」，而 P104 每一批都要在
 * 9 预设 × 4 缩放档 × 亮暗主题 的组合下取证。没有这层入口，「每批我自己验收」对
 * 默认布局以下的东西就只是形式。
 *
 * 三条硬规矩：
 *  1. 生产构建必须完全 inert —— 判定收敛在 devBootEnabled() 这个纯函数里，由测试钉住；
 *  2. 白名单外的参数一律丢弃：宁可回到用户原状，也不把脏值写进 settings；
 *  3. 覆盖 preset 时必须同时清掉已存布局，否则 applyDefaultLayout 根本不会跑
 *     （onReady 是「存档优先」）。这条不写出来，下一个改这里的人会误判「preset 没生效」。
 */
import {
  patch,
  SETTINGS_TAB_PLUGINS,
  THEME_LIST,
  WORKSPACE_PRESETS,
  type Settings,
  type ThemeMode,
  type WorkspacePreset,
} from "../features/settings/settingsStore";
import {
  LAYOUT_KEY_CORRUPT,
  LAYOUT_KEY_V2,
  LAYOUT_KEY_V3,
} from "../features/settings/layoutEnvelope";
import { WELCOME_SEEN_KEY } from "../shell/welcomeSlides";
import { openRailPanel, RAIL_ITEMS, type RailKey } from "../shell/railState";
import { LOCALE_LIST, type Locale } from "../i18n/strings";
import type { IfaceKind } from "../features/serial/serialStore";

/**
 * `?iface=` 认的取值。这里**不 import `linkSummary.ts` 的 `IFACE_ITEMS`**：
 * 那个模块 value-import 了 serialStore（连带 Tauri 事件与 invoke），
 * 把它拉进 dev 覆盖层等于给取证脚手架接上整条串口运行时。
 * 漂移由 `bootOverrides.test.ts` 钉：它拿这份表与 `IFACE_ITEMS` 逐项比，
 * 所以改名会当场红（新增一种接口则只是"拍不到那一张"，不会拍错）。
 */
const IFACE_LIST: readonly IfaceKind[] = ["serial", "tcp-client", "tcp-server", "udp", "ble"];

/**
 * 与 settingsStore.normalize 同一份档位表；改这里必须同步改那边。
 *
 * `LAYOUT_KEY` 原来是这里**自己声明的一份 `"vs.layout.v2"` 字面量**（第二真值）。
 * B13① 把存档键升到 v3 之后，如果这里还写着 v2，`?preset=` 就会去删一个不再被读的键 ——
 * 已存布局没清掉 ⇒ `applyDefaultLayout` 根本不跑（onReady 是"存档优先"），
 * 表现是"preset 参数静默失效"，而且不报任何错。所以改成从 `layoutEnvelope` 引。
 */
export const ZOOM_STEPS = [90, 100, 110, 125];
export { LAYOUT_KEY_V3 as LAYOUT_KEY } from "../features/settings/layoutEnvelope";

export interface DevBootOverrides {
  preset?: WorkspacePreset;
  theme?: ThemeMode;
  zoom?: number;
  /** `?tour=7` —— 直接从第 7 步开跑（取证用：引导的某一步长什么样，不必点七次） */
  tourAt?: number;
  /**
   * `?welcome=0` 压住首启欢迎卡（截干净界面用）；`?welcome=1` 每次都弹（验收反复看同一张卡）。
   *
   * 这里原来叫 `tourOff`（`?tour=0` 压住"首启自动弹引导"）。B7 把自动弹撤了，
   * 那个开关就没有可压的东西了——留一个什么都不做的参数比删掉它更坏：
   * 下一个人会以为它还在管某件事。
   */
  welcomeOff?: boolean;
  welcomeForce?: boolean;
  /** `?rail=link` —— 启动就把导轨的某一项展开（取证用：新 profile 的 localStorage 是空的） */
  rail?: RailKey;
  /**
   * `?iface=tcp-client` —— 启动就切到某个数据接口。
   * P115-F13 起串口**参数**（口/波特率/数据位/校验/停止位/流控）已落盘，但**接口类别**
   * （serial/tcp/…，本参数管的就是它）仍是内存态：重启回 serial。所以不靠这个入口
   * 还是拍不到其余四种接口的参数区 —— P105-E 的验收要求五套各一张。
   * 消费点在 `LinkPanel` 的挂载 effect 里（与 `devTourAt` 同一手法），
   * 生产构建恒为 undefined。
   */
  iface?: IfaceKind;
  /**
   * `?lang=en` —— 启动即换语言。P105-F 的验收要拍"英文界面下还剩几处中文"，
   * 而无头截图点不了设置页那两颗语言单选，所以和 `?theme=` 一样走 settings patch。
   * 取值表来自 `i18n/strings` 的 `LOCALE_LIST`（有哪几种语言只有一处答案）。
   */
  lang?: Locale;
  /**
   * `?open=settings/model` / `?open=ai` —— 启动就把某个"打开态"摆出来（P111-A2）。
   *
   * 为什么需要它：P110-B3/B4 那两处界面被判不合格，而我交出去之前**一眼都没看过**——
   * 理由写的是"无头浏览器点不到设置页"。设置页是纯 DOM，无头截图本来就拍得到，
   * 缺的只是"启动后自动打开它"这一个入口。补上它，界面改判的验收证据就不该再等用户实拍。
   *
   * 取值表：视图名在这张白名单里；设置页那一页的 key 走 `DEV_SETTINGS_TABS`。
   * 未知 key **丢掉 tab 但保留视图**（打开到默认页），因为 SettingsModal 是
   * `useState(initialTab ?? "general")`：把 "bogus" 递进去会得到一个空白内容区，
   * 那比拍不到更坏——它会让人以为页面本身是空的。
   */
  open?: DevOpenView;
  settingsTab?: string;
  /** `?open=panel/framecanvas`：取证时直接打开某枚面板（id 由 App 侧对着面板表校验） */
  openPanel?: string;
  /**
   * `?probe=overflow` —— 把"内容画到自己格子外面"的元素描红并在角落报个数（P113-A 取证）。
   *
   * 为什么需要它：用户报"拖窄面板后行与行叠在一起"，而这类问题的现场**只在某个宽度上出现**，
   * 光读 CSS 只能列出候选、不能定案。P111-A 补的是"拍得到打开态"，这一条补的是"量得到溢出"。
   */
  probeOverflow?: boolean;
  /** `?railw=220` —— 启动就把导轨二级面板钉到某个宽度（配合 `?probe=overflow` 复现窄档） */
  railw?: number;
  /**
   * `?click=<css 选择器>` —— 挂载后自动点一下那个元素（P113 加）。
   *
   * 为什么要有：弹窗、浮层、展开态这些**点一下才出现**的界面，无头截图拍不到，
   * 于是"我自己验收"对它们就只剩"我相信代码"。给一个通用的点击入口，
   * 比给每个弹窗各加一个 `?dialog=xxx` 参数诚实得多 —— 后者会长成一屏专用开关。
   * 只点第一个命中项，且只 dispatch 一次点击；它不改数据，点错顶多是拍不到图。
   */
  click?: string;
  /** 仅在 preset 生效时才连带置真；?layout=keep 可豁免 */
  resetLayout: boolean;
}

/** `?open=` 认的视图。`ai` = AI 助手面板（它默认可能没开）。 */
export const DEV_OPEN_VIEWS = ["settings", "ai", "panel"] as const;
export type DevOpenView = (typeof DEV_OPEN_VIEWS)[number];

/**
 * 设置页导航项的 key。这里**不 import `SettingsModal`**：那个模块 value-import 了
 * 半个应用（串口、任务中心、档案表…），把它拉进取证层等于给截图脚手架接上整条运行时。
 * 漂移由 `bootOverrides.test.ts` 钉：它读 SettingsModal 的源文本，逐项比这份表。
 *
 * 插件那一格写的是 `SETTINGS_TAB_PLUGINS` 而不是字面量「ext」——
 * `marketUi.test.ts` 有一条门专门拦「标签键长出第二处」（它是全文搜那个带引号的字面量，连注释都算），
 * 抄字面量当场被判红（本批实测）。
 */
export const DEV_SETTINGS_TABS = [
  "general", "appearance", "workspace", "data", "monitor", "io", "ai", "model",
  SETTINGS_TAB_PLUGINS, "mcp", "about",
] as const;

/** 纯函数：把「能不能生效」与 import.meta.env 解耦，好让测试能同时钉住两侧。缺省即拒绝。 */
export function devBootEnabled(env?: { dev?: boolean; prod?: boolean }): boolean {
  return env?.dev === true && env?.prod !== true;
}

export function parseDevBoot(search: string): DevBootOverrides {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const o: DevBootOverrides = { resetLayout: false };

  const preset = q.get("preset");
  if (preset && (WORKSPACE_PRESETS as readonly string[]).includes(preset)) {
    o.preset = preset as WorkspacePreset;
    // 存档优先 ⇒ 不清布局，preset 就是个哑参数
    o.resetLayout = q.get("layout") !== "keep";
  }

  const theme = q.get("theme");
  if (theme && THEME_LIST.includes(theme as ThemeMode)) o.theme = theme as ThemeMode;

  const zoom = Number(q.get("zoom"));
  if (Number.isFinite(zoom) && ZOOM_STEPS.includes(zoom)) o.zoom = zoom;

  const at = Number(q.get("tour"));
  // 只收 >=1 的整数步号；?tour=0 那一档随"首启自动弹引导"一起撤了（见 DevBootOverrides 的注释）
  if (Number.isInteger(at) && at >= 1) o.tourAt = at;

  if (q.get("welcome") === "0") o.welcomeOff = true;
  else if (Number.isFinite(Number(q.get("welcome"))) && Number(q.get("welcome")) >= 1)
    o.welcomeForce = true;

  // 导轨项走 RAIL_ITEMS 白名单（与导轨本身同一份事实源），不在这份表里的值一律丢
  const rail = q.get("rail");
  if (rail && RAIL_ITEMS.some((i) => i.key === rail)) o.rail = rail as RailKey;

  const iface = q.get("iface");
  if (iface && (IFACE_LIST as readonly string[]).includes(iface)) o.iface = iface as IfaceKind;

  const lang = q.get("lang");
  if (lang && (LOCALE_LIST as readonly string[]).includes(lang)) o.lang = lang as Locale;

  // `?open=settings/model`：视图与页 key 一起给；也接受只给视图（`?open=ai`）
  const open = q.get("open");
  if (open) {
    const [view, tab] = open.split("/");
    if ((DEV_OPEN_VIEWS as readonly string[]).includes(view)) {
      o.open = view as DevOpenView;
      if (view === "panel") o.openPanel = tab && /^[\w-]{1,40}$/.test(tab) ? tab : undefined;
      else if (tab && (DEV_SETTINGS_TABS as readonly string[]).includes(tab)) o.settingsTab = tab;
    }
  }

  if (q.get("probe") === "overflow") o.probeOverflow = true;
  const railw = Number(q.get("railw"));
  // 只认"拖得出来的那段"：越界就当没给，不去 clamp（clamp 会让 200 静默变成 220，
  // 而取证要的恰恰是"200 那一档长什么样"）
  if (Number.isFinite(railw) && railw >= 120 && railw <= 640) o.railw = Math.round(railw);
  const click = q.get("click");
  if (click && click.length <= 120) o.click = click;
  return o;
}

/**
 * App 用：取证开关（`?probe=overflow` / `?railw=` / `?click=`）。生产构建恒为关。
 * 与 `devOpenRequest` 同一闸门、同一理由：这是脚手架，不是产品路径。
 */
export function devForensics(
  search: string,
  env: { dev?: boolean; prod?: boolean } = { dev: import.meta.env.DEV, prod: import.meta.env.PROD },
): { probeOverflow: boolean; railw?: number; click?: string } {
  if (!devBootEnabled(env)) return { probeOverflow: false };
  const o = parseDevBoot(search);
  return {
    probeOverflow: !!o.probeOverflow,
    ...(o.railw ? { railw: o.railw } : {}),
    ...(o.click ? { click: o.click } : {}),
  };
}

export function hasDevBoot(o: DevBootOverrides): boolean {
  return Boolean(
    o.preset || o.theme || o.zoom || o.lang || o.tourAt !== undefined || o.rail || o.iface ||
    o.open || o.openPanel || o.probeOverflow || o.railw !== undefined || o.click !== undefined ||
    o.welcomeOff || o.welcomeForce || o.resetLayout,
  );
}

/**
 * App 用：启动要摆出哪个"打开态"。生产构建恒为 undefined（同一个 `devBootEnabled` 闸门）。
 * 一次性的：App 消费完就当作没这回事，用户之后关设置不会被重新弹开。
 */
export function devOpenRequest(
  search: string,
  env: { dev?: boolean; prod?: boolean } = { dev: import.meta.env.DEV, prod: import.meta.env.PROD },
): { view: DevOpenView; tab?: string; panel?: string } | undefined {
  if (!devBootEnabled(env)) return undefined;
  const o = parseDevBoot(search);
  return o.open ? { view: o.open, tab: o.settingsTab, panel: o.openPanel } : undefined;
}

/**
 * 应用覆盖，返回**实际生效**的那份（未启用/无有效参数时返回空壳，便于调用方打日志）。
 * 刻意不抛异常：这是取证脚手架，它坏的时候应该是「什么都没改」而不是白屏。
 */
export function applyDevBoot(
  search: string,
  env: { dev?: boolean; prod?: boolean } = {
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
  },
): DevBootOverrides {
  const parsed = parseDevBoot(search);
  if (!devBootEnabled(env) || !hasDevBoot(parsed)) return { resetLayout: false };

  try {
    if (parsed.resetLayout) {
      // 三个键都要清：只清 v3 的话，下次启动会从"迁移留下的 v2 备份"里再读回来，
      // 于是 ?preset= 看着像没生效（本文件头讲的就是这个形状的坑）。
      localStorage.removeItem(LAYOUT_KEY_V3);
      localStorage.removeItem(LAYOUT_KEY_V2);
      localStorage.removeItem(LAYOUT_KEY_CORRUPT);
    }
    if (parsed.welcomeOff) localStorage.setItem(WELCOME_SEEN_KEY, "1");
    else if (parsed.welcomeForce) localStorage.removeItem(WELCOME_SEEN_KEY);
    // 走 railState 的 setter，**不是**直接 setItem：本文件 value-import 了 railState，
    // 它在求值期就把 localStorage 读过一遍存进模块变量了 —— 只写存储的话
    // 内存态还是旧的 null，表现就是"?rail= 静默失效、面板不开"（实测撞上过一次）。
    if (parsed.rail) openRailPanel(parsed.rail);
  } catch {
    /* 无 localStorage 的环境（node 测试）：覆盖退化为「只改内存 settings」 */
  }

  const p: Partial<Settings> = {};
  if (parsed.preset) p.workspace = parsed.preset;
  if (parsed.theme) p.theme = parsed.theme;
  if (parsed.zoom) p.zoom = parsed.zoom;
  if (parsed.lang) p.locale = parsed.lang;
  if (Object.keys(p).length) patch(p);

  return parsed;
}

/**
 * TourHost 用：`?tour=N` 里的 N 是 `TOUR_STEPS` 的**数组下标**（0 = 欢迎卡，
 * 1 = 第 1 步「连接设备」……），不是界面上"第 N 步"那个编号——
 * 编号是派生出来的（欢迎卡也占一格），拿它当下标会差一步。
 * 生产构建恒为 undefined：判定同样走 devBootEnabled()。
 */
export function devTourAt(
  search: string = typeof location !== "undefined" ? location.search : "",
  env: { dev?: boolean; prod?: boolean } = {
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
  },
): number | undefined {
  return devBootEnabled(env) ? parseDevBoot(search).tourAt : undefined;
}

/**
 * 欢迎卡用：`?welcome=2` 直接看第 2 张（下标 1）。
 *
 * 为什么需要它：无头截图**点不了圆点**，而这个软件里的图必须被拍到才算验收过——
 * 与 `?tour=N` 同一个理由。`0`/`1` 仍然只管"压住/强开"，所以这里只认 >=2 的卡号。
 * 生产构建恒为 undefined（同一个 devBootEnabled 闸门）。
 */
export function devWelcomeAt(
  search: string = typeof location !== "undefined" ? location.search : "",
  env: { dev?: boolean; prod?: boolean } = {
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
  },
): number | undefined {
  if (!devBootEnabled(env)) return undefined;
  const n = Number(new URLSearchParams(search.replace(/^\?/, "")).get("welcome"));
  return Number.isInteger(n) && n >= 2 ? n - 1 : undefined;
}

/**
 * LinkPanel 用：`?iface=tcp-client` 启动即切到那个接口（生产恒 undefined）。
 * 与 `devTourAt` 同一手法 —— 消费点在组件的挂载 effect 里，
 * 这样 bootOverrides 不必 value-import 串口运行时。
 */
export function devIface(
  search: string = typeof location !== "undefined" ? location.search : "",
  env: { dev?: boolean; prod?: boolean } = {
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
  },
): IfaceKind | undefined {
  return devBootEnabled(env) ? parseDevBoot(search).iface : undefined;
}

/**
 * RailPanel 用：`?railw=420` 直接给一个拖拽后的宽度（P105-D 的验收要拍到"变宽之后"的样子，
 * 而无头截图做不了拖拽）。仍然走 `setRailPanelW` 的钳制，所以它拍出来的是**合法范围内**的宽度，
 * 不会截出一个真机上拖不出来的状态。生产恒 undefined。
 */
export function devRailW(
  search: string = typeof location !== "undefined" ? location.search : "",
  env: { dev?: boolean; prod?: boolean } = {
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
  },
): number | undefined {
  if (!devBootEnabled(env)) return undefined;
  const n = Number(new URLSearchParams(search.replace(/^\?/, "")).get("railw"));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
