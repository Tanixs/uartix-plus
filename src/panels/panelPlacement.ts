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
  type EmbedPanelViewState,
} from "../features/controls/embedPanels";
import * as controlsStore from "../features/controls/controlsStore";
import { tx } from "../i18n/strings";
import { closeDockPanel, isDockReady, openDockPanel } from "../shell/dockBridge";
import * as panelActivity from "./panelActivity";
import { capturePanelView, discardPanelView } from "./viewState";

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
export function placePanelInCanvas(
  pageId: string,
  panelId: string,
  viewState?: EmbedPanelViewState | null,
): PlacePanelResult {
  if (!isEmbedPanelId(panelId)) return { ok: false, reason: "unknown-panel" };
  if (panelActivity.isDocked(panelId)) return { ok: false, reason: "docked" };
  const r = controlsStore.addEmbedCard(pageId, panelId, viewState);
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

function mapStoreReason(
  reason: Exclude<controlsStore.EmbedAddResult, { ok: true }>["reason"],
): PlacementRejectReason {
  return reason === "duplicate" ? "already-embedded" : reason;
}

/**
 * 停靠 → 内嵌（也用于"从控件库拖入一个本来没开的白名单面板"）。
 *
 * 顺序：先干跑画布容量 → capture 视野 → 关停靠 → 落卡。
 * 干跑必须早于关闭：画布放不下时不能先把用户的停靠页签关掉再告诉他失败。
 */
export function movePanelToCanvas(panelId: string): PlacePanelResult {
  if (!isEmbedPanelId(panelId)) return { ok: false, reason: "unknown-panel" };
  if (panelActivity.isEmbedded(panelId) || controlsStore.findEmbedCard(panelId)) {
    return { ok: false, reason: "already-embedded" };
  }
  const page = controlsStore.activePage();
  if (!page) return { ok: false, reason: "page-missing" };
  const dry = controlsStore.canAddEmbedCard(page.id, panelId);
  if (!dry.ok) return { ok: false, reason: mapStoreReason(dry.reason) };

  const docked = panelActivity.isDocked(panelId);
  const view = docked ? capturePanelView(panelId) : null;
  if (docked && !closeDockPanel(panelId)) {
    discardPanelView(panelId);
    return { ok: false, reason: "docked" };
  }
  const r = controlsStore.addEmbedCard(page.id, panelId, view);
  if (!r.ok) {
    discardPanelView(panelId);
    // 已关停靠却落卡失败：把页签开回去，别让面板凭空消失。
    if (docked) openDockPanel(panelId);
    return { ok: false, reason: mapStoreReason(r.reason) };
  }
  return r;
}

/**
 * 内嵌 → 停靠。
 *
 * 先 capture 再删卡：视图态只存在于当前实例里，删完就抓不到了。
 * dock 未就绪时**不动卡片**——宁可这次失败，也不能把面板从画布上抹掉却没有落点。
 */
export function movePanelToDock(
  pageId: string,
  card: controlsStore.EmbedCard,
): { ok: true } | { ok: false; reason: "dock-unavailable" } {
  if (!isDockReady()) return { ok: false, reason: "dock-unavailable" };
  const view = capturePanelView(card.panelId);
  controlsStore.removeCard(pageId, card.id);
  if (!openDockPanel(card.panelId)) {
    // 极端情况（注入的 opener 失效）：把卡片加回去，保持"至少有一个落点"。
    controlsStore.addEmbedCard(pageId, card.panelId, view);
    discardPanelView(card.panelId);
    return { ok: false, reason: "dock-unavailable" };
  }
  return { ok: true };
}

/**
 * 拒绝原因 → 用户可读的一句话。不写 default：以后新增原因时 tsc 会逼着补文案，
 * 而不是又回到"只在控制台里静默失败"。
 */
export function placementRejectText(reason: PlacementRejectReason): string {
  switch (reason) {
    case "docked":
      return tx(
        "该面板正在停靠区显示；请从页签的「内嵌到控制画布」进入，或先关闭停靠页签",
        "This panel is docked — use “Embed in control canvas” on its tab, or close the tab first",
      );
    case "already-embedded":
      return tx("该面板已经在控制画布内嵌了", "This panel is already embedded in the control canvas");
    case "no-space":
      return tx(
        "当前控制页没有放得下的空位：先挪开卡片或新建一页",
        "No free space on this control page — move cards aside or add a page",
      );
    case "page-too-small":
      return tx(
        "当前控制页太小，放不下这个面板的最小尺寸",
        "This control page is too small for the panel's minimum size",
      );
    case "page-missing":
      return tx("找不到当前控制页", "The current control page no longer exists");
    case "locked":
      return tx("Operator 只读：不能修改控制画布", "Operator read-only: the control canvas cannot be changed");
    case "unknown-panel":
      return tx("这个面板不支持内嵌到控制画布", "This panel cannot be embedded in the control canvas");
  }
}
