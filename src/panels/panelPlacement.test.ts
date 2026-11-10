import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/operator/lock", () => ({ guardLocked: () => false }));
vi.mock("../i18n/strings", () => ({ getLocale: () => "zh" }));

beforeEach(() => {
  vi.resetModules();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("panel placement mutex", () => {
  it("refuses to embed a panel that is still docked", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([{ id: "plot2d", visible: true }]);
    const placement = await import("./panelPlacement");
    expect(placement.panelPlacementOf("plot2d")).toBe("dock");
    expect(placement.placePanelInCanvas("page", "plot2d")).toEqual({
      ok: false,
      reason: "docked",
    });
  });

  it("places a whitelisted closed panel once and then reports the duplicate", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const store = await import("../features/controls/controlsStore");
    const pageId = store.getSnapshot().activePageId;
    const placement = await import("./panelPlacement");

    expect(placement.panelPlacementOf("plot2d")).toBe("closed");
    const first = placement.placePanelInCanvas(pageId, "plot2d");
    expect(first.ok).toBe(true);
    expect(placement.panelPlacementOf("plot2d")).toBe("embed");
    expect(placement.placePanelInCanvas(pageId, "plot2d")).toEqual({
      ok: false,
      reason: "already-embedded",
    });
  });

  it("rejects panels outside the P1 whitelist", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const store = await import("../features/controls/controlsStore");
    const pageId = store.getSnapshot().activePageId;
    const placement = await import("./panelPlacement");
    expect(placement.placePanelInCanvas(pageId, "modbus")).toEqual({
      ok: false,
      reason: "unknown-panel",
    });
  });
});
