import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plot2DEmbedViewState } from "../features/controls/embedPanels";

beforeEach(() => {
  vi.resetModules();
});

const view: Plot2DEmbedViewState = {
  xMin: 1,
  xMax: 2,
  yMin: -1,
  yMax: 1,
  follow: false,
};

describe("panel view-state handoff", () => {
  it("captures from the mounted adapter and restores into the next instance", async () => {
    const s = await import("./viewState");
    const capture = vi.fn(() => view);
    const off = s.registerPanelView("plot2d", { capture, restore: vi.fn() });
    expect(s.capturePanelView("plot2d")).toEqual(view);

    // 卸载旧实例（注销），挂载新实例：注册时立即消费 pending，一帧内恢复
    off();
    const restore = vi.fn();
    s.registerPanelView("plot2d", { capture: () => null, restore });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(view);

    // pending 是一次性的：再挂一次不应重放旧视野
    const restoreAgain = vi.fn();
    s.registerPanelView("plot2d", { capture: () => null, restore: restoreAgain });
    expect(restoreAgain).not.toHaveBeenCalled();
  });

  it("returns null when nothing is mounted or capture has no usable view", async () => {
    const s = await import("./viewState");
    expect(s.capturePanelView("plot2d")).toBeNull();
    s.registerPanelView("hexview", {
      capture: () => ({ scrollOffset: 128 }),
      restore: vi.fn(),
    });
    expect(s.capturePanelView("hexview")).toEqual({ scrollOffset: 128 });
  });

  it("can discard a stash when the switch is aborted", async () => {
    const s = await import("./viewState");
    s.registerPanelView("plot2d", { capture: () => view, restore: vi.fn() });
    s.capturePanelView("plot2d");
    s.discardPanelView("plot2d");
    const restore = vi.fn();
    s.registerPanelView("plot2d", { capture: () => null, restore });
    expect(restore).not.toHaveBeenCalled();
  });
});
