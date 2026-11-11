import { describe, expect, it } from "vitest";
import { panelViewId } from "../plugins/engine/panelBridge";
import {
  EMBED_ID_ASPECT,
  EMBED_ID_MIN,
  EMBED_IDS,
  PLUGIN_PANEL_MIN,
  dockIdOf,
  embedKindOf,
  embedMinOf,
  embedName,
  hasPointerLock,
  isEmbedId,
  isEmbedPanelTarget,
  isEmbedTargetId,
  isEmbedViewId,
  isPluginEmbedId,
  parsePluginEmbedId,
  sanitizeEmbedViewState,
} from "./embedPanels";

describe("embed whitelist", () => {
  it("keeps whole panels and views in one table", () => {
    expect([...EMBED_IDS]).toEqual([
      "plot2d",
      "hexview",
      "datatable",
      "xray",
      "spectrum",
      "sequencer",
      "sendbuild",
      "attitude3d",
      "trajectory3d",
      "sentinel",
      "framecanvas",
    ]);
    expect(embedKindOf("plot2d")).toBe("panel");
    expect(embedKindOf("datatable")).toBe("panel");
    expect(embedKindOf("xray")).toBe("panel");
    expect(embedKindOf("spectrum")).toBe("panel");
    expect(embedKindOf("sequencer")).toBe("panel");
    expect(embedKindOf("sendbuild")).toBe("panel");
    expect(embedKindOf("attitude3d")).toBe("view");
    expect(embedKindOf("trajectory3d")).toBe("view");
    expect(embedKindOf("sentinel")).toBe("view");
    expect(embedKindOf("framecanvas")).toBe("view");
    expect(isEmbedViewId("attitude3d")).toBe(true);
    expect(isEmbedViewId("trajectory3d")).toBe(true);
    // 整板 3D 轨迹仍不可嵌：它是独立的停靠面板，不是视图
    expect(isEmbedId("plot3d")).toBe(false);
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

  it("gives the trajectory view a 5x4 minimum and the same 4:3 lock", () => {
    expect(EMBED_ID_MIN.trajectory3d).toEqual({ w: 5, h: 4 });
    expect(EMBED_ID_ASPECT.trajectory3d).toBeCloseTo(4 / 3);
  });

  it("gives the wave-1 data panels their own minimums and no aspect lock", () => {
    expect(EMBED_ID_MIN.datatable).toEqual({ w: 4, h: 4 });
    expect(EMBED_ID_MIN.xray).toEqual({ w: 4, h: 4 });
    expect(EMBED_ID_MIN.spectrum).toEqual({ w: 4, h: 3 });
    for (const id of ["datatable", "xray", "spectrum"] as const) {
      expect(EMBED_ID_ASPECT[id]).toBeUndefined();
    }
  });

  it("maps only the data table to a differently-named dock panel", () => {
    expect(dockIdOf("datatable")).toBe("table");
    for (const id of ["plot2d", "hexview", "xray", "spectrum", "sequencer", "sendbuild"] as const) {
      expect(dockIdOf(id)).toBe(id);
    }
  });

  it("keeps wave-3 panels at 5x4 and no aspect lock", () => {
    expect(EMBED_ID_MIN.sendbuild).toEqual({ w: 5, h: 4 });
    expect(EMBED_ID_ASPECT.sendbuild).toBeUndefined();
    expect(hasPointerLock("sendbuild")).toBe(false);
  });

  it("accepts plugin panels as dynamic whole panels, but not as views or static ids", () => {
    const id = "plugin-view-acme.serial-console:bode";
    // 前缀只有一份真值：停靠 id 生成器造出来的 id 必须被白名单认。
    expect(isPluginEmbedId(panelViewId("acme.serial-console", "bode"))).toBe(true);
    expect(panelViewId("acme.serial-console", "bode")).toBe(id);
    expect(isPluginEmbedId(id)).toBe(true);
    expect(parsePluginEmbedId(id)).toEqual({ pluginId: "acme.serial-console", panelId: "bode" });
    expect(isEmbedTargetId(id)).toBe(true);
    expect(isEmbedPanelTarget(id)).toBe(true);
    expect(isEmbedId(id)).toBe(false);
    expect(isEmbedViewId(id)).toBe(false);
    // 形状不对的一律不认：缺面板段、带空格、前缀不对
    for (const bad of ["plugin-view-acme", "plugin-view-a:b:c", "plugin-view-a: b", "plugin-vi", 42, null]) {
      expect(isPluginEmbedId(bad)).toBe(false);
    }
    expect(embedMinOf(id)).toEqual(PLUGIN_PANEL_MIN);
    expect(embedMinOf("sendbuild")).toEqual({ w: 5, h: 4 });
    expect(embedName(id).length).toBeGreaterThan(0);
    expect(sanitizeEmbedViewState(id, { scrollOffset: 3 })).toBeNull();
  });

  it("gives wave-2 views their own minimums and only locks 3D cameras", () => {
    expect(EMBED_ID_MIN.sequencer).toEqual({ w: 6, h: 5 });
    expect(EMBED_ID_MIN.sentinel).toEqual({ w: 6, h: 5 });
    expect(EMBED_ID_MIN.framecanvas).toEqual({ w: 5, h: 4 });
    expect(hasPointerLock("attitude3d")).toBe(true);
    expect(hasPointerLock("trajectory3d")).toBe(true);
    expect(hasPointerLock("sentinel")).toBe(false);
    expect(hasPointerLock("framecanvas")).toBe(false);
    expect(hasPointerLock("sequencer")).toBe(false);
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

  it("has nothing to carry for either view", () => {
    expect(sanitizeEmbedViewState("attitude3d", { anything: 1 })).toBeNull();
    expect(sanitizeEmbedViewState("trajectory3d", { anything: 1 })).toBeNull();
  });

  it("does not misread a data panel's payload as the hex scroll offset", () => {
    for (const id of [
      "datatable",
      "xray",
      "spectrum",
      "sequencer",
      "sentinel",
      "framecanvas",
    ] as const) {
      expect(sanitizeEmbedViewState(id, { scrollOffset: 32 })).toBeNull();
    }
  });
});
