import { describe, expect, it } from "vitest";
import { rectsOverlap } from "./embedVisibility";

const view = { left: 0, top: 0, right: 400, bottom: 300 };

describe("embed viewport visibility", () => {
  it("treats a card fully inside the viewport as visible", () => {
    expect(rectsOverlap({ left: 40, top: 30, right: 240, bottom: 180 }, view)).toBe(true);
  });

  it("keeps a partially scrolled card visible", () => {
    expect(rectsOverlap({ left: -60, top: 10, right: 40, bottom: 90 }, view)).toBe(true);
    expect(rectsOverlap({ left: 360, top: 260, right: 520, bottom: 420 }, view)).toBe(true);
  });

  it("rejects a card fully outside, including edge-touching", () => {
    expect(rectsOverlap({ left: 400, top: 0, right: 500, bottom: 100 }, view)).toBe(false);
    expect(rectsOverlap({ left: 0, top: 300, right: 100, bottom: 400 }, view)).toBe(false);
  });

  it("rejects zero-size rects so a hidden panel never counts as visible", () => {
    expect(rectsOverlap({ left: 10, top: 10, right: 10, bottom: 40 }, view)).toBe(false);
    expect(rectsOverlap(view, { left: 0, top: 0, right: 0, bottom: 0 })).toBe(false);
  });
});
