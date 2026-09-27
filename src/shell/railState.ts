/**
 * P104-R 左侧导轨的状态源。
 *
 * 单独一个非组件模块，有两个原因，都不是洁癖：
 * 1. `App` 算默认布局与重排 dockview 时要读到"导轨二级面板此刻占不占宽"，
 *    而它不能去 import 一个 React 组件文件（会把整个组件树拖进布局路径）。
 * 2. 组件文件混导出函数会让 Fast Refresh 失效（lint 的 only-export-components 就是钉这个，
 *    B8 的 ChannelRail 犯过一次并回退）。
 *
 * 语义照控制画布原来那个 `sideTab: "widgets" | "commands" | null` 抽屉来（R3 已退役）——
 * 那套"点一下展开、再点一下收起"在本仓库已被实际使用验证过，本模块只是把它升到壳层。
 * 记住上次打开的是哪一项（= 用户要的"常驻"），下次启动还在。
 */
import { SHELL_CHROME, railPanelMaxAvailable } from "./defaultLayout";

/**
 * P105-C：`"channels"` 已删。字段图例搬回「协议」面板的下半区（那里本来就有
 * 一根持久化的上下分割条），导轨这一项就成了空壳 —— 而导轨是**单槽**，
 * 「协议」与「通道」永远不能同屏，把一件事拆成两格才是问题。
 */
export type RailKey = "link" | "templates" | "widgets" | "commands" | "views";

/** 落盘键（开着哪一项）。导出是为了 dev 取证入口能写同一个键，而不是再抄一遍字面量。 */
export const RAIL_PANEL_KEY = "vs.rail.panel";

const KEY = RAIL_PANEL_KEY;

/**
 * 导轨五项的文案。**放这里而不是 `SideRail.tsx`**：
 * B9 的命令面板要列同样的几个目的地，从组件文件里导常量会触发
 * `react-refresh/only-export-components`（本文件头第 2 条讲的就是这个），
 * 而且"导轨有哪几项"本来就是状态源的事，不是渲染的事。
 * 图标仍留在 SideRail —— 那是渲染层的取舍（B12 要重画一整套）。
 */
export const RAIL_ITEMS: readonly { key: RailKey; zh: string; en: string }[] = [
  { key: "link", zh: "接入", en: "Link" },
  { key: "templates", zh: "协议", en: "Protocol" },
  { key: "widgets", zh: "控件", en: "Widgets" },
  { key: "commands", zh: "命令", en: "Commands" },
  { key: "views", zh: "视图", en: "Views" },
];

const listeners = new Set<() => void>();

function read(): RailKey | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v !== "0" ? (v as RailKey) : null;
  } catch {
    return null;
  }
}

let current: RailKey | null = read();

export function railPanel(): RailKey | null {
  return current;
}

/** 传同一个 key = 收起（"再点一次隐藏"）；传 null 也是收起 */
export function toggleRailPanel(next: RailKey | null): void {
  current = current === next ? null : next;
  persist();
}

/** 强制展开某一项（不是切换）。给"这一步要看的控件住在导轨里"的调用方用——
 *  入门引导的高亮环找不到收起状态的锚点，静默退化成居中卡片，
 *  所以它得先把那一项打开。落盘与点击一致：引导走完后面板留着，不算打扰。 */
export function openRailPanel(next: RailKey): void {
  if (current === next) return;
  current = next;
  persist();
}

function persist(): void {
  try {
    localStorage.setItem(KEY, current ?? "0");
  } catch {
    /* 无 localStorage：只在内存里生效 */
  }
  listeners.forEach((f) => f());
}

export function subscribeRail(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/* ============================ P105-D：二级面板宽度 ============================ */

/** 默认宽度（逻辑 CSS px）。它仍是 `SHELL_CHROME.railPanelW`，也就是 theme.css 里
 *  `var(--rail-w, 300px)` 的那个**回退值** —— `defaultLayout.test.ts` 比对这两个数。
 *  P105-D 之前这里是硬编码 300，改一处忘一处就会让"布局算的分母"与"画出来的宽"错位。 */
export const RAIL_PANEL_DEFAULT = SHELL_CHROME.railPanelW;
/**
 * 允许拖到多窄。用户 2026-09-28 裁定：**允许更窄，遮住一部分可以接受**——
 * "如果用户觉得遮住了看不见，他还可以自己拖动一下"。所以这里从 220 降到 180，
 * 代价由裁切承担（`.lk-ctl { overflow: hidden }`），不再靠"抬高下限"回避。
 *
 * 一条不能含糊的边界：裁切只发生在**这一行的控件列**里，面板自己仍然可拖宽，
 * 而且 P3 那批的教训仍然成立 —— 所以 180 之下不再允许（再小就是整颗控件点不到了，
 * 不是"少看半行字"）。`check-style` 的 I 门看着这条：它禁的是用 `overflow:hidden`
 * 去裁**工具条**，而工具条那条路我们没走（工具条改成换行/滚动）。
 */
export const RAIL_PANEL_MIN = 180;
/** 硬上限；比它更严的是视口算出来的那个（`railPanelMaxAvailable`），二者取小。 */
export const RAIL_PANEL_MAX = 460;

/** 拖出来的宽度独立于"开着哪一项"存 —— 换一项不该把上次的宽度忘掉。 */
const W_KEY = "vs.rail.panel.w";

/** 当下允许的最大宽度：硬上限与"画布还剩得下主区+右栏下限"取小，再保底到 MIN。 */
function maxW(): number {
  return Math.max(RAIL_PANEL_MIN, Math.min(RAIL_PANEL_MAX, railPanelMaxAvailable()));
}

function clampW(v: number): number {
  return Math.min(Math.max(RAIL_PANEL_MIN, v), maxW());
}

function readW(): number {
  try {
    const v = Number(localStorage.getItem(W_KEY));
    return Number.isFinite(v) && v >= RAIL_PANEL_MIN ? clampW(v) : RAIL_PANEL_DEFAULT;
  } catch {
    return RAIL_PANEL_DEFAULT;
  }
}

let panelW = readW();

/** 当前宽度（逻辑 px）。**CSS 与布局分母都必须走它**：两者一旦各说各话，
 *  就是"面板画得比布局以为的宽"，而那是 P3 那批"控件被裁到点不到"的成因。 */
export function railPanelW(): number {
  return panelW;
}

export function setRailPanelW(next: number): void {
  const v = clampW(next);
  if (v === panelW) return;
  panelW = v;
  try {
    localStorage.setItem(W_KEY, String(v));
  } catch {
    /* 无 localStorage：只在内存里生效 */
  }
  listeners.forEach((f) => f());
}

/** 双击 sash 复位。与 `TemplatesPanel` 那根分割条同一手势语言，所以不再往设置页加开关。 */
export function resetRailPanelW(): void {
  setRailPanelW(RAIL_PANEL_DEFAULT);
}

/** 允许拖到的区间，给拖拽那侧当钳制用（也方便测试断言"窄窗下上限自己收紧"）。 */
export function railPanelBounds(): { min: number; max: number } {
  return { min: RAIL_PANEL_MIN, max: maxW() };
}

/**
 * 拖宽之后再缩小窗口，存档值会超过当下上限。这里重新夹一次并通知：
 * 不这么做的话 CSS 用旧值、`gridSize()` 用新值，两者错位比"不能拖"更糟。
 * 只在数值真的变了才通知，避免每次 resize 都触发一次 dockview 重排。
 */
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    const v = clampW(panelW);
    if (v === panelW) return;
    panelW = v;
    listeners.forEach((f) => f());
  });
}

/** 二级面板当前占掉的宽度（逻辑 px），给布局分母用。收起 = 0。 */
export function railWidth(): number {
  return current ? panelW : 0;
}
