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
export const EMBED_PANEL_IDS = ["plot2d", "hexview"] as const;
export type EmbedPanelId = (typeof EMBED_PANEL_IDS)[number];

/** 视图形态：只存在于画布，没有停靠页签，因此不参与"移回停靠"。 */
export const EMBED_VIEW_IDS = ["attitude3d", "trajectory3d"] as const;
export type EmbedViewId = (typeof EMBED_VIEW_IDS)[number];

export const EMBED_IDS = [...EMBED_PANEL_IDS, ...EMBED_VIEW_IDS] as const;
export type EmbedId = EmbedPanelId | EmbedViewId;

export type EmbedKind = "panel" | "view";

/**
 * 每 id 最小格数（1 格 ≈ 60px）：低于它就装不下坐标轴/图例、Hex 列头，或转不动模型。
 * 姿态视图取 4×3：模型是立体件，3×2 在 60px 格下只有 172×112，机臂会糊成一团。
 * 轨迹视图取 5×4：要同时容下轴标签与最多三行图例，4×3 在浅色下会挤在一起。
 */
export const EMBED_ID_MIN: Record<EmbedId, { w: number; h: number }> = {
  plot2d: { w: 4, h: 3 },
  hexview: { w: 3, h: 2 },
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
  attitude3d: "姿态 3D 模型",
  trajectory3d: "3D 轨迹视图",
};
const TITLES_EN: Record<EmbedId, string> = {
  plot2d: "2D Plot",
  hexview: "Hex Stream",
  attitude3d: "3D Attitude Model",
  trajectory3d: "3D Trajectory View",
};

/** 卡片默认名：整板与停靠页签同名，视图单独起名（它只代表模型那一块）。 */
export function embedName(id: EmbedId): string {
  return getLocale() === "en" ? TITLES_EN[id] : TITLES_ZH[id];
}

/**
 * 内嵌视图态：切换「停靠 ↔ 内嵌」时随卡片搬运的最小状态集。
 * - 2D：uPlot 当前 x/y 区间 + 是否跟随；
 * - Hex：滚动位置（最后可见字节列，等价 scrollOffset）；
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
  id: EmbedId,
  raw: unknown,
): EmbedPanelViewState | null {
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
  if (id === "attitude3d" || id === "trajectory3d") return null;
  const off = finite(r.scrollOffset);
  if (off === null || off < 0) return null;
  return { scrollOffset: Math.round(off) };
}
