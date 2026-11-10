import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("panel activity union", () => {
  it("opens on dock panels and distinguishes dock from embed", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([
      { id: "plot2d", visible: true },
      { id: "hexview", visible: false },
    ]);
    expect(a.isOpen("plot2d")).toBe(true);
    expect(a.isVisible("plot2d")).toBe(true);
    expect(a.isOpen("hexview")).toBe(true);
    expect(a.isVisible("hexview")).toBe(false);
    expect(a.isDocked("plot2d")).toBe(true);
    expect(a.isEmbedded("plot2d")).toBe(false);
  });

  it("counts an embedded panel as open and visible only while its host is visible", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "controls", visible: true }]);
    a.setEmbeddedPanels(["plot2d"], "controls");
    expect(a.isOpen("plot2d")).toBe(true);
    expect(a.isVisible("plot2d")).toBe(true);
    expect(a.isDocked("plot2d")).toBe(false);
    expect(a.isEmbedded("plot2d")).toBe(true);

    // 控制画布被切到后台页签：卡片还挂着（数据可继续进缓冲），但不算可见（不渲染）。
    a.syncPanels([{ id: "controls", visible: false }]);
    expect(a.isOpen("plot2d")).toBe(true);
    expect(a.isVisible("plot2d")).toBe(false);

    // 关掉内嵌卡片：面板彻底关闭，数据泵应停。
    a.setEmbeddedPanels([], "controls");
    expect(a.isOpen("plot2d")).toBe(false);
  });

  it("takes the union of dock and embed without touching business checks", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "plot2d", visible: true }, { id: "controls", visible: true }]);
    a.setEmbeddedPanels(["hexview"], "controls");
    expect(a.isOpen("plot2d")).toBe(true);
    expect(a.isOpen("hexview")).toBe(true);
    expect(a.isDocked("hexview")).toBe(false);
    expect(a.isEmbedded("hexview")).toBe(true);
  });

  it("emits only when the effective sets change", async () => {
    const a = await import("./panelActivity");
    const listener = vi.fn();
    a.subscribe(listener);
    a.syncPanels([{ id: "plot2d", visible: true }]);
    expect(listener).toHaveBeenCalledTimes(1);
    a.syncPanels([{ id: "plot2d", visible: true }]);
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = a.getSnapshot();
    expect(a.getSnapshot()).toBe(snap);
  });
});
