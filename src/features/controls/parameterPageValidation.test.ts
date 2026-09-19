import { describe, expect, it } from "vitest";
import type { ControlPage, ControlsSnapshot, SliderCard } from "./controlsStore";
import { buildDebugPreset } from "./debugPreset";
import { captureParameterPage, requireCurrentParameterPage } from "./parameterPageValidation";

function fixture(): ControlPage {
  let id = 0;
  return { ...buildDebugPreset("Debug", [
    { id: "kp", name: "Kp", min: 0, max: 10, step: 1, value: 2, unit: "" },
    { id: "ki", name: "Ki", min: -5, max: 5, step: 0.5, value: 0, unit: "" },
  ], () => `card-${++id}` as `${string}-${string}-${string}-${string}-${string}`), id: "page-1", locked: false };
}
const snapshot = (page: ControlPage): ControlsSnapshot => ({ pages: [page], activePageId: page.id });
const slider = (page: ControlPage) => page.cards[0] as SliderCard;

describe("parameter page preview validation", () => {
  it("returns the freshly read page, not the captured object", () => {
    const page = fixture();
    const captured = captureParameterPage(page);
    const current = structuredClone(page);
    expect(requireCurrentParameterPage(snapshot(current), captured)).toBe(current);
  });

  it("rejects a page switch even when the original page still exists", () => {
    const page = fixture();
    expect(() => requireCurrentParameterPage({ ...snapshot(page), activePageId: "another" },
      captureParameterPage(page))).toThrow("Page changed");
  });

  it("rejects deletion of the captured page", () => {
    const captured = captureParameterPage(fixture());
    expect(() => requireCurrentParameterPage({ pages: [], activePageId: captured.pageId }, captured))
      .toThrow("definitions changed");
  });

  const changes: [string, (page: ControlPage) => void][] = [
    ["removed profile", page => { delete page.debugProfile; }],
    ["profile schema", page => { Object.assign(page.debugProfile!, { schema: "other" }); }],
    ["profile version", page => { Object.assign(page.debugProfile!, { version: 2 }); }],
    ["card ID", page => { slider(page).id = "replacement"; }],
    ["name", page => { slider(page).name = "Changed"; }],
    ["parameter ID", page => { slider(page).managed!.paramId = "replacement"; }],
    ["managed schema", page => { Object.assign(slider(page).managed!, { schema: "other" }); }],
    ["managed role", page => { slider(page).managed!.role = "blocked"; }],
    ["removed metadata", page => { delete slider(page).managed; }],
    ["card type", page => { Object.assign(slider(page), { type: "button" }); }],
    ["minimum", page => { slider(page).min = -1; }],
    ["maximum", page => { slider(page).max = 11; }],
    ["step", page => { slider(page).step = 0.5; }],
    ["default", page => { slider(page).defaultValue = 3; }],
    ["non-finite bound", page => { slider(page).max = Infinity; }],
    ["removed parameter", page => { page.cards.shift(); }],
    ["added duplicate parameter", page => { page.cards.push({ ...slider(page), id: "duplicate" }); }],
  ];
  it.each(changes)("rejects %s changes including in-place mutations", (_name, mutate) => {
    const page = fixture();
    const captured = captureParameterPage(page);
    mutate(page);
    expect(() => requireCurrentParameterPage(snapshot(page), captured)).toThrow("definitions changed");
  });

  it("allows reordering, geometry, page title and unrelated action changes", () => {
    const page = fixture();
    const captured = captureParameterPage(page);
    slider(page).x = 9;
    slider(page).w = 2;
    page.name = "Renamed";
    page.cols = 20;
    page.cards[1].name = "Readback display";
    page.cards.reverse();
    expect(requireCurrentParameterPage(snapshot(page), captured)).toBe(page);
  });

  it("rejects a batch before a caller can apply even its first draft", () => {
    const page = fixture();
    const captured = captureParameterPage(page);
    const drafts = new Map<string, number>();
    slider(page).step = 2;
    const apply = () => {
      const current = requireCurrentParameterPage(snapshot(page), captured);
      for (const card of current.cards) drafts.set(card.id, 1);
    };
    expect(apply).toThrow();
    expect(drafts.size).toBe(0);
  });
});
