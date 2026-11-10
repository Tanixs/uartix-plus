/**
 * 面板放置互斥：同一 panelId 只能存在于「停靠」或「内嵌」其中一处。
 *
 * 为什么必须互斥：数据层按面板 id 门控（panelActivity.isOpen），视图态也按 id 注册；
 * 两处同时挂载会得到两个 WebGL/uPlot 实例、两份相机状态，还违背"面板没开不跑数据"。
 * 因此这里不做复制，只做移动；目标已存在就返回具体原因让 UI 提示。
 */
import {
  EMBED_PANEL_MIN,
  isEmbedPanelId,
} from "../features/controls/embedPanels";
import * as controlsStore from "../features/controls/controlsStore";
import * as panelActivity from "./panelActivity";

export type PanelPlacement = "dock" | "embed" | "closed";

export type PlacementRejectReason =
  | "unknown-panel"
  | "docked"
  | "already-embedded"
  | "locked"
  | "page-missing"
  | "page-too-small"
  | "no-space";

export type PlacePanelResult =
  | { ok: true; cardId: string }
  | { ok: false; reason: PlacementRejectReason };

/** 当前面板落在哪：停靠优先（dock 里开着就不可能同时内嵌，由互斥保证）。 */
export function panelPlacementOf(panelId: string): PanelPlacement {
  if (panelActivity.isDocked(panelId)) return "dock";
  if (controlsStore.findEmbedCard(panelId)) return "embed";
  return "closed";
}

/**
 * 把面板放进画布。调用前应已完成 capturePanelView(panelId)（若它当前挂载在 dock），
 * 成功后再移除 dock 面板并挂载卡片；失败时调用方 discardPanelView 回滚暂存。
 */
export function placePanelInCanvas(pageId: string, panelId: string): PlacePanelResult {
  if (!isEmbedPanelId(panelId)) return { ok: false, reason: "unknown-panel" };
  if (panelActivity.isDocked(panelId)) return { ok: false, reason: "docked" };
  const r = controlsStore.addEmbedCard(pageId, panelId);
  if (r.ok) return r;
  return r.reason === "duplicate"
    ? { ok: false, reason: "already-embedded" }
    : { ok: false, reason: r.reason };
}

/** 卡片能否在当前页面放下（不写状态，供拖拽悬停时提前给出禁止/允许反馈）。 */
export function canPlacePanelInCanvas(
  pageId: string,
  panelId: string,
): { ok: true } | { ok: false; reason: PlacementRejectReason } {
  if (!isEmbedPanelId(panelId)) return { ok: false, reason: "unknown-panel" };
  if (panelActivity.isDocked(panelId)) return { ok: false, reason: "docked" };
  if (controlsStore.findEmbedCard(panelId)) return { ok: false, reason: "already-embedded" };
  const page = controlsStore.getSnapshot().pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, reason: "page-missing" };
  const min = EMBED_PANEL_MIN[panelId];
  if (page.cols < min.w || (page.rows || 48) < min.h) {
    return { ok: false, reason: "page-too-small" };
  }
  return { ok: true };
}
