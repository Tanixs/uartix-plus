import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../features/operator/lock", () => ({ guardLocked: () => false }));
vi.mock("../i18n/strings", () => ({ getLocale: () => "zh", tx: (zh: string) => zh }));

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

  it("moves a closed panel into the active page through the same guard", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const placement = await import("./panelPlacement");
    const r = placement.movePanelToCanvas("hexview");
    expect(r.ok).toBe(true);
    expect(placement.panelPlacementOf("hexview")).toBe("embed");
    // 第二次走的是"已内嵌"，而不是再放一张。
    expect(placement.movePanelToCanvas("hexview")).toEqual({
      ok: false,
      reason: "already-embedded",
    });
  });

  it("refuses to remove a card when the dock bridge is not ready", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const store = await import("../features/controls/controlsStore");
    const pageId = store.getSnapshot().activePageId;
    const placement = await import("./panelPlacement");
    expect(placement.movePanelToCanvas("plot2d").ok).toBe(true);
    const card = store.findEmbedCard("plot2d");
    expect(card).not.toBeNull();
    expect(placement.movePanelToDock(pageId, card!.card)).toEqual({
      ok: false,
      reason: "dock-unavailable",
    });
    // 失败不能把卡片抹掉：落点仍然是内嵌。
    expect(store.findEmbedCard("plot2d")).not.toBeNull();
  });

  it("adds a view straight from the gallery and caps it at one instance", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const placement = await import("./panelPlacement");
    expect(placement.panelPlacementOf("attitude3d")).toBe("closed");
    const first = placement.addEmbedFromGallery("attitude3d");
    expect(first.ok).toBe(true);
    expect(placement.panelPlacementOf("attitude3d")).toBe("embed");
    // 视图没有停靠对应物，第二张只能被上限挡住
    expect(placement.addEmbedFromGallery("attitude3d")).toEqual({
      ok: false,
      reason: "view-limit",
    });
  });

  it("caps the trajectory view independently from the attitude view", async () => {
    const activity = await import("./panelActivity");
    activity.syncPanels([]);
    const store = await import("../features/controls/controlsStore");
    const placement = await import("./panelPlacement");
    // 先把姿势视图占满，再放轨迹视图：两者的上限分开计，不能互相挤占
    expect(placement.addEmbedFromGallery("attitude3d").ok).toBe(true);
    expect(placement.addEmbedFromGallery("trajectory3d").ok).toBe(true);
    expect(placement.addEmbedFromGallery("trajectory3d")).toEqual({
      ok: false,
      reason: "view-limit",
    });
    expect(store.findEmbedCard("trajectory3d")).not.toBeNull();
  });

  it("has readable text for every reject reason", async () => {
    const placement = await import("./panelPlacement");
    const reasons = [
      "unknown-panel",
      "docked",
      "already-embedded",
      "view-limit",
      "locked",
      "page-missing",
      "page-too-small",
      "no-space",
    ] as const;
    for (const r of reasons) {
      expect(placement.placementRejectText(r).length).toBeGreaterThan(0);
    }
  });
});
