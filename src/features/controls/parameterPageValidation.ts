import type { ControlPage, ControlsSnapshot } from "./controlsStore";

export interface ParameterPageCapture {
  readonly pageId: string;
  readonly signature: string;
}

/** Only definition/identity fields matter: layout changes do not invalidate drafts. */
function definitionSignature(page: ControlPage): string {
  return JSON.stringify([
    page.debugProfile?.schema, page.debugProfile?.version,
    page.cards.filter(card => card.type === "slider" && card.managed?.role === "parameter")
      .map(card => {
        if (card.type !== "slider") throw new Error("Expected slider");
        return [card.id, card.name, card.managed?.schema, card.managed?.role, card.managed?.paramId,
          card.min, card.max, card.step, card.defaultValue];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ], (_key, value: unknown) => typeof value === "number" && !Number.isFinite(value)
    ? { nonFinite: String(value) } : value);
}

/** Capture strings, not object references, so later in-place edits cannot alter the baseline. */
export function captureParameterPage(page: ControlPage): ParameterPageCapture {
  return Object.freeze({ pageId: page.id, signature: definitionSignature(page) });
}

/** Pure guard. Call with a freshly read store snapshot immediately before the entire local update. */
export function requireCurrentParameterPage(
  current: ControlsSnapshot, captured: ParameterPageCapture,
): ControlPage {
  if (current.activePageId !== captured.pageId) {
    throw new Error("页面已切换，请关闭并重新打开参数集。 / Page changed; close and reopen parameter sets.");
  }
  const page = current.pages.find(item => item.id === captured.pageId);
  if (!page || definitionSignature(page) !== captured.signature) {
    throw new Error("参数定义已变化，请关闭并重新打开以刷新预览。 / Parameter definitions changed; close and reopen to refresh the preview.");
  }
  return page;
}
