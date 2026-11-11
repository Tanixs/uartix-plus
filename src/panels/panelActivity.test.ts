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

  it("refreshes the snapshot when only visibility changes", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "plot2d", visible: true }]);
    const shown = a.getSnapshot();
    // 页签切后台：open 不变、visible 变。快照必须跟着变，否则消费方看到的
    // 可见集与 isVisible() 是两个真值（P0 回归取证时正是这样对不上）。
    a.syncPanels([{ id: "plot2d", visible: false }]);
    expect(a.isVisible("plot2d")).toBe(false);
    expect(a.getSnapshot()).not.toBe(shown);
    expect(a.getSnapshot()).toBe("plot2d|");
  });

  it("keeps a scrolled-out embed card open but not visible", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "controls", visible: true }]);
    a.setEmbeddedPanels(["plot2d"], "controls");
    a.setEmbeddedCardVisible("plot2d", false);
    expect(a.isOpen("plot2d")).toBe(true);
    expect(a.isVisible("plot2d")).toBe(false);

    // 滚回视口：数据泵没停过，渲染门控重新打开。
    a.setEmbeddedCardVisible("plot2d", true);
    expect(a.isVisible("plot2d")).toBe(true);
  });

  it("drops viewport-hidden marks when the embed set is replaced", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "controls", visible: true }]);
    a.setEmbeddedPanels(["plot2d"], "controls");
    a.setEmbeddedCardVisible("plot2d", false);
    // 切页：卡片集合清空，隐藏标记不能留到下一次挂载。
    a.setEmbeddedPanels([], "controls");
    a.setEmbeddedPanels(["plot2d"], "controls");
    expect(a.isVisible("plot2d")).toBe(true);
  });

  it("clears a stale hidden mark on unmount", async () => {
    const a = await import("./panelActivity");
    a.syncPanels([{ id: "controls", visible: true }]);
    a.setEmbeddedPanels(["hexview"], "controls");
    a.setEmbeddedCardVisible("hexview", false);
    a.clearEmbeddedCardVisibility("hexview");
    expect(a.isVisible("hexview")).toBe(true);
  });
});
