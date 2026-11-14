/**
 * 画布内嵌白名单：两种形态共用一张卡片。
 *
 * - **整板**（panel）：把停靠区那一整块面板搬进画布，带它自己的工具栏/设置区（2D 曲线、Hex）。
 * - **视图**（view）：只渲染"内容那一块"，不挂面板 chrome（姿态 3D 模型）。
 *
 * 这里是「哪些东西可以进控制画布」的唯一出处：控件库、导入校验、放置互斥都查这张表。
 * 不在表里的 id 即使被手工写进 JSON 也会在导入时被丢弃并计数——重工作台面板
 * （AI / Modbus / 序列器 / 编排器）内部布局在卡片尺寸下不可用，不能靠数据绕过。
 */
import { getLocale } from "../../i18n/strings";

/** 整板形态：有对应的停靠面板，可与停靠区互相搬。 */
export const EMBED_PANEL_IDS = [
  "plot2d",
  "hexview",
  "datatable",
  "xray",
  "spectrum",
  "sequencer",
  "sendbuild",
] as const;
export type EmbedPanelId = (typeof EMBED_PANEL_IDS)[number];

/**
 * 整板 id → 停靠面板 id。数据门控、停靠互斥、移回停靠仍按停靠 id 记账：
 * `datatable` 是给"画布里的数据表格"起的名字，停靠页签一直叫 `table`；
 * 其余整板两者同名（映射到自身），保留映射表是为了让调用点不再拼字符串。
 */
export const EMBED_PANEL_DOCK_ID: Record<EmbedPanelId, string> = {
  plot2d: "plot2d",
  hexview: "hexview",
  datatable: "table",
  xray: "xray",
  spectrum: "spectrum",
  sequencer: "sequencer",
  sendbuild: "sendbuild",
};

export function dockIdOf(id: EmbedPanelId): string {
  return EMBED_PANEL_DOCK_ID[id];
}

/**
 * 视图形态：只渲染内容区，不参与"移回停靠"。
 * 姿态/轨迹是纯画布视图；哨兵/帧画布虽然停靠区也有页签，但这里按"视图"
 * 处理（从控件库直接落卡，不从页签搬），避免把多栏工作台当成可随意搬动的整板。
 */
export const EMBED_VIEW_IDS = [
  "attitude3d",
  "trajectory3d",
  "sentinel",
  "framecanvas",
] as const;
export type EmbedViewId = (typeof EMBED_VIEW_IDS)[number];

export const EMBED_IDS = [...EMBED_PANEL_IDS, ...EMBED_VIEW_IDS] as const;
export type EmbedId = EmbedPanelId | EmbedViewId;

/**
 * 插件面板（动态整板）：卡片 `panelId` 直接复用它的停靠 id
 * `plugin-view-<插件id>:<面板id>`。
 *
 * 不另造一条参数通道（不给卡片加 `plugin: {…}` 字段）：一个 id 同时回答
 * "哪块面板"与"要不要走 iframe 宿主"，导入/互斥/去重全部沿用现有的按 id 记账。
 * 前缀与 `panelBridge.PLUGIN_VIEW_PREFIX` 必须一致，由单测钉住。
 */
export const PLUGIN_EMBED_PREFIX = "plugin-view-";
export type PluginPanelEmbedId = `${typeof PLUGIN_EMBED_PREFIX}${string}:${string}`;
/** 画布卡片能承载的全部目标：静态白名单 + 任意插件面板。 */
export type EmbedTargetId = EmbedId | PluginPanelEmbedId;

const PLUGIN_EMBED_RE = /^plugin-view-([^:\s]+):([^:\s]+)$/;

export function parsePluginEmbedId(
  v: unknown,
): { pluginId: string; panelId: string } | null {
  if (typeof v !== "string") return null;
  const m = PLUGIN_EMBED_RE.exec(v);
  if (!m) return null;
  return { pluginId: m[1], panelId: m[2] };
}

export function isPluginEmbedId(v: unknown): v is PluginPanelEmbedId {
  return parsePluginEmbedId(v) !== null;
}

export function isEmbedTargetId(v: unknown): v is EmbedTargetId {
  return isEmbedId(v) || isPluginEmbedId(v);
}

/** 有停靠页签、可双向搬动的目标：整板与插件面板；静态视图不算。 */
export function isEmbedPanelTarget(
  v: unknown,
): v is EmbedPanelId | PluginPanelEmbedId {
  return isEmbedPanelId(v) || isPluginEmbedId(v);
}

/**
 * 停靠页签 id → 该页签上「内嵌到控制画布」应落卡的目标 id。
 *
 * 页签条只有停靠 id（`table` / `view3d` / `plot3d`），而卡片用的是白名单 id
 * （`datatable` / `attitude3d` / `trajectory3d`）。这张映射让入口只写一份：
 * 页签条按它自动长出按钮，面板自己不必各注册一遍。
 *
 * 只收用户点名的 8 类（5 个整板 + 姿态 3D / 3D 轨迹 / 哨兵）；
 * 帧画布当前仍按 E6 的"先关页签"处理，未进这张表。
 */
export function embedTargetForDockPanel(dockId: string): EmbedTargetId | null {
  if (isEmbedPanelId(dockId)) return dockId;
  switch (dockId) {
    case "table":
      return "datatable";
    case "view3d":
      return "attitude3d";
    case "plot3d":
      return "trajectory3d";
    case "sentinel":
      return "sentinel";
    default:
      return null;
  }
}

/**
 * 插件面板的最小格数。5×4（60px 格下 300×240）不是按某个插件量出来的——
 * 插件界面由作者决定，宿主能给的只有一条下限：低于它，任何带工具栏的页面都排不开。
 */
export const PLUGIN_PANEL_MIN = { w: 5, h: 4 } as const;

/** 目标 id 的最小格数（静态表 or 插件面板默认值）。 */
export function embedMinOf(id: EmbedTargetId): { w: number; h: number } {
  return isEmbedId(id) ? EMBED_ID_MIN[id] : PLUGIN_PANEL_MIN;
}

/** 目标 id 的宽高比锁（只有两种 3D 视图有）。 */
export function embedAspectOf(id: EmbedTargetId): number | undefined {
  return isEmbedId(id) ? EMBED_ID_ASPECT[id] : undefined;
}

export type EmbedKind = "panel" | "view";

/**
 * 每 id 最小格数（1 格 ≈ 60px）：低于它就装不下坐标轴/图例、Hex 列头，或转不动模型。
 * 姿态视图取 4×3：模型是立体件，3×2 在 60px 格下只有 172×112，机臂会糊成一团。
 * 轨迹视图取 5×4：要同时容下轴标签与最多三行图例，4×3 在浅色下会挤在一起。
 */
export const EMBED_ID_MIN: Record<EmbedId, { w: number; h: number }> = {
  plot2d: { w: 4, h: 3 },
  hexview: { w: 3, h: 2 },
  // 数据表格 4×4：工具条 + 列头 + 至少 6 行数据；4×3 在 60px 格下只剩 3 行，筛选后常常空白。
  datatable: { w: 4, h: 4 },
  // X-Ray 4×4：参数行两排 + 样本条 + 16×14 的字节网格；再窄列熵条会糊成一片。
  xray: { w: 4, h: 4 },
  // 频谱 4×3：工具条一排可换行 + 一张图 + 摘要行，图高至少 4~5 格才有分辨力。
  spectrum: { w: 4, h: 3 },
  // 序列器 6×5：工具行可换行 + 步骤列表；5×4 下步骤的字段摘要会被截成两三个字。
  sequencer: { w: 6, h: 5 },
  // TX 组帧台 5×4：字节网格按 MIN_COLS=4 收缩 + 96px 块栏 + 尺；5×4 在 22px 格下能放下
  // 4 列 × 7 行，再窄工具行与底部备注只能整行换行、把网格挤没。
  sendbuild: { w: 5, h: 4 },
  // 哨兵 6×5：报警时间线与 232px 通道栏并排，5×4 下通道栏会把时间线压到只剩图标宽度。
  sentinel: { w: 6, h: 5 },
  // 帧画布 5×4：工具条可换行 + 一屏至少 6 行帧格；再窄字段名会互相压。
  framecanvas: { w: 5, h: 4 },
  attitude3d: { w: 4, h: 3 },
  trajectory3d: { w: 5, h: 4 },
};

/**
 * 需要锁宽的 id → 宽高比（w / h）。
 * 姿态视图锁 4:3：模型在 16:9 扁条里上下会留白，而在竖条里机臂会被裁掉。
 * 轨迹视图同样锁 4:3：竖条会裁掉轴标签，扁条会把三维轨迹压成一条。
 * 只对视图形态生效；2D/Hex 是数据面，横长一点更有用，不锁。
 */
export const EMBED_ID_ASPECT: Partial<Record<EmbedId, number>> = {
  attitude3d: 4 / 3,
  trajectory3d: 4 / 3,
};

/**
 * 需要「锁定交互」按钮的视图：只有自带指针相机/旋转的 3D 视图。
 * 哨兵、帧画布是普通数据视图，锁上反而让用户点不动，别跟着 isEmbedViewId 走。
 */
export const EMBED_POINTER_LOCK_IDS = ["attitude3d", "trajectory3d"] as const;

export function hasPointerLock(id: unknown): boolean {
  return typeof id === "string" && (EMBED_POINTER_LOCK_IDS as readonly string[]).includes(id);
}

export function isEmbedPanelId(v: unknown): v is EmbedPanelId {
  return typeof v === "string" && (EMBED_PANEL_IDS as readonly string[]).includes(v);
}

export function isEmbedViewId(v: unknown): v is EmbedViewId {
  return typeof v === "string" && (EMBED_VIEW_IDS as readonly string[]).includes(v);
}

export function isEmbedId(v: unknown): v is EmbedId {
  return isEmbedPanelId(v) || isEmbedViewId(v);
}

export function embedKindOf(id: EmbedId): EmbedKind {
  return isEmbedViewId(id) ? "view" : "panel";
}

const TITLES_ZH: Record<EmbedId, string> = {
  plot2d: "2D 曲线",
  hexview: "Hex 数据流",
  datatable: "数据表格",
  xray: "结构发现 X-Ray",
  spectrum: "频谱分析",
  sequencer: "序列器",
  sendbuild: "TX 组帧台",
  sentinel: "哨兵",
  framecanvas: "帧画布",
  attitude3d: "姿态 3D 模型",
  trajectory3d: "3D 轨迹视图",
};
const TITLES_EN: Record<EmbedId, string> = {
  plot2d: "2D Plot",
  hexview: "Hex Stream",
  datatable: "Data Table",
  xray: "X-Ray Discovery",
  spectrum: "Spectrum",
  sequencer: "Sequencer",
  sendbuild: "TX Frame Builder",
  sentinel: "Sentinel",
  framecanvas: "Frame Canvas",
  attitude3d: "3D Attitude Model",
  trajectory3d: "3D Trajectory View",
};

/** 卡片默认名：整板与停靠页签同名，视图单独起名（它只代表模型那一块）。 */
export function embedName(id: EmbedTargetId): string {
  // 插件面板的名字由插件清单给，卡片创建时会把面板标题写进 card.name；
  // 这里只是"还没拿到标题"时的兜底，不引插件仓库（白名单模块不该依赖插件引擎）。
  if (!isEmbedId(id)) return getLocale() === "en" ? "Plugin panel" : "插件面板";
  return getLocale() === "en" ? TITLES_EN[id] : TITLES_ZH[id];
}

/**
 * 内嵌视图态：切换「停靠 ↔ 内嵌」时随卡片搬运的最小状态集。
 * - 2D：uPlot 当前 x/y 区间 + 是否跟随；
 * - Hex：滚动位置（最后可见字节列，等价 scrollOffset）；
 * - 表格 / X-Ray / 频谱：工具栏与局部排序不跨形态搬运，返回 null；
 * - 姿态视图 / 轨迹视图：没有可搬的视野（相机只在画布内，切走即重来），返回 null。
 */
export interface Plot2DEmbedViewState {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  follow: boolean;
}
export interface HexViewEmbedViewState {
  scrollOffset: number;
}
export type EmbedPanelViewState = Plot2DEmbedViewState | HexViewEmbedViewState;

function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 按 id 收敛视图态；字段不完整一律视为「没有可恢复状态」，宁可回到默认视野也不喂 NaN。 */
export function sanitizeEmbedViewState(
  id: EmbedTargetId,
  raw: unknown,
): EmbedPanelViewState | null {
  // 插件面板没有可搬的视野状态（停靠与卡片各自重建 iframe）。
  if (!isEmbedId(id)) return null;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (id === "plot2d") {
    const xMin = finite(r.xMin);
    const xMax = finite(r.xMax);
    const yMin = finite(r.yMin);
    const yMax = finite(r.yMax);
    if (xMin === null || xMax === null || yMin === null || yMax === null) return null;
    if (xMax <= xMin || yMax <= yMin) return null;
    return { xMin, xMax, yMin, yMax, follow: Boolean(r.follow) };
  }
  // 只有 Hex 能把滚动位置带过去；其余整板（表格/X-Ray/频谱）与两种视图没有可搬状态。
  if (id !== "hexview") return null;
  const off = finite(r.scrollOffset);
  if (off === null || off < 0) return null;
  return { scrollOffset: Math.round(off) };
}
