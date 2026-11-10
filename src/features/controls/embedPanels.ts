/**
 * 画布内嵌面板白名单（P1：2D 曲线 + Hex 数据流）。
 *
 * 这里是「哪些面板可以进控制画布」的唯一出处：控件库、导入校验、放置互斥都查这张表。
 * 不在表里的面板即使被手工写进 JSON 也会在导入时被丢弃并计数——重工作台面板
 * （AI / Modbus / 序列器 / 编排器）内部布局在卡片尺寸下不可用，不能靠数据绕过。
 */
import { getLocale } from "../../i18n/strings";

export const EMBED_PANEL_IDS = ["plot2d", "hexview"] as const;
export type EmbedPanelId = (typeof EMBED_PANEL_IDS)[number];

/** 每面板最小格数（1 格 ≈ 60px）：低于它就装不下坐标轴/图例或 Hex 列头。 */
export const EMBED_PANEL_MIN: Record<EmbedPanelId, { w: number; h: number }> = {
  plot2d: { w: 4, h: 3 },
  hexview: { w: 3, h: 2 },
};

export function isEmbedPanelId(v: unknown): v is EmbedPanelId {
  return typeof v === "string" && (EMBED_PANEL_IDS as readonly string[]).includes(v);
}

const TITLES_ZH: Record<EmbedPanelId, string> = {
  plot2d: "2D 曲线",
  hexview: "Hex 数据流",
};
const TITLES_EN: Record<EmbedPanelId, string> = {
  plot2d: "2D Plot",
  hexview: "Hex Stream",
};

/** 卡片默认名：与停靠页签同名，用户不会看到两种叫法。 */
export function embedPanelName(id: EmbedPanelId): string {
  return getLocale() === "en" ? TITLES_EN[id] : TITLES_ZH[id];
}

/**
 * 内嵌视图态：切换「停靠 ↔ 内嵌」时随卡片搬运的最小状态集。
 * - 2D：uPlot 当前 x/y 区间 + 是否跟随；
 * - Hex：滚动位置（最后可见字节列，等价 scrollOffset）。
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

/** 按 panelId 收敛视图态；字段不完整一律视为「没有可恢复状态」，宁可回到默认视野也不喂 NaN。 */
export function sanitizeEmbedViewState(
  panelId: EmbedPanelId,
  raw: unknown,
): EmbedPanelViewState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (panelId === "plot2d") {
    const xMin = finite(r.xMin);
    const xMax = finite(r.xMax);
    const yMin = finite(r.yMin);
    const yMax = finite(r.yMax);
    if (xMin === null || xMax === null || yMin === null || yMax === null) return null;
    if (xMax <= xMin || yMax <= yMin) return null;
    return { xMin, xMax, yMin, yMax, follow: Boolean(r.follow) };
  }
  const off = finite(r.scrollOffset);
  if (off === null || off < 0) return null;
  return { scrollOffset: Math.round(off) };
}
