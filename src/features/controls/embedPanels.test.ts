import { describe, expect, it } from "vitest";
import {
  EMBED_ID_ASPECT,
  EMBED_ID_MIN,
  EMBED_IDS,
  embedKindOf,
  embedName,
  isEmbedId,
  isEmbedViewId,
  sanitizeEmbedViewState,
} from "./embedPanels";

describe("embed whitelist", () => {
  it("keeps whole panels and views in one table", () => {
    expect([...EMBED_IDS]).toEqual(["plot2d", "hexview", "attitude3d"]);
    expect(embedKindOf("plot2d")).toBe("panel");
    expect(embedKindOf("attitude3d")).toBe("view");
    expect(isEmbedViewId("attitude3d")).toBe(true);
    expect(isEmbedId("modbus")).toBe(false);
    expect(isEmbedId(null)).toBe(false);
  });

  it("gives the attitude view a 4x3 minimum and a locked 4:3 aspect", () => {
    expect(EMBED_ID_MIN.attitude3d).toEqual({ w: 4, h: 3 });
    expect(EMBED_ID_ASPECT.attitude3d).toBeCloseTo(4 / 3);
    // 数据面不锁比例：横长一点更有用
    expect(EMBED_ID_ASPECT.plot2d).toBeUndefined();
    expect(EMBED_ID_ASPECT.hexview).toBeUndefined();
  });

  it("names every target in both languages", () => {
    for (const id of EMBED_IDS) expect(embedName(id).length).toBeGreaterThan(0);
  });
});

describe("embed view state", () => {
  it("keeps a valid 2D window and rejects inverted ranges", () => {
    expect(
      sanitizeEmbedViewState("plot2d", {
        xMin: 0,
        xMax: 10,
        yMin: -1,
        yMax: 1,
        follow: true,
      }),
    ).toEqual({ xMin: 0, xMax: 10, yMin: -1, yMax: 1, follow: true });
    expect(
      sanitizeEmbedViewState("plot2d", { xMin: 5, xMax: 5, yMin: 0, yMax: 1 }),
    ).toBeNull();
  });

  it("rounds the hex scroll offset and rejects negatives", () => {
    expect(sanitizeEmbedViewState("hexview", { scrollOffset: 31.6 })).toEqual({
      scrollOffset: 32,
    });
    expect(sanitizeEmbedViewState("hexview", { scrollOffset: -2 })).toBeNull();
  });

  it("has nothing to carry for the attitude view", () => {
    expect(sanitizeEmbedViewState("attitude3d", { anything: 1 })).toBeNull();
  });
});
