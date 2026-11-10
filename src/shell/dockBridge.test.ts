import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview";
import * as bridge from "./dockBridge";

function fakeApi(panels: string[] = []) {
  const active = vi.fn();
  const close = vi.fn();
  const api = {
    getPanel: (id: string) =>
      panels.includes(id) ? { api: { setActive: active, close } } : undefined,
    addPanel: vi.fn(),
  };
  return { api: api as unknown as DockviewApi, active, close, raw: api };
}

beforeEach(() => {
  bridge.unregisterDockApi(null);
});

describe("dock bridge", () => {
  it("reports not ready before App registers", () => {
    expect(bridge.isDockReady()).toBe(false);
    expect(bridge.openDockPanel("plot2d")).toBe(false);
    expect(bridge.closeDockPanel("plot2d")).toBe(false);
  });

  it("focuses an existing dock panel instead of opening a second one", () => {
    const f = fakeApi(["plot2d"]);
    bridge.registerDockApi(f.api, vi.fn());
    expect(bridge.openDockPanel("plot2d")).toBe(true);
    expect(f.active).toHaveBeenCalledTimes(1);
  });

  it("opens through the injected opener and verifies the panel appeared", () => {
    const f = fakeApi();
    const open = vi.fn((id: string) => {
      // App 的实现会同步 addPanel；这里模拟成"opener 跑完就能 getPanel 到"。
      f.raw.getPanel = (x: string) => (x === id ? { api: { setActive: f.active, close: f.close } } : undefined);
    });
    bridge.registerDockApi(f.api, open);
    expect(bridge.openDockPanel("hexview")).toBe(true);
    expect(open).toHaveBeenCalledWith("hexview");
  });

  it("closes only panels that are actually docked", () => {
    const f = fakeApi(["plot2d"]);
    bridge.registerDockApi(f.api, vi.fn());
    expect(bridge.closeDockPanel("hexview")).toBe(false);
    expect(bridge.closeDockPanel("plot2d")).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("goes dark again after unregister", () => {
    const f = fakeApi(["plot2d"]);
    bridge.registerDockApi(f.api, vi.fn());
    bridge.unregisterDockApi(f.api);
    expect(bridge.isDockReady()).toBe(false);
    expect(bridge.openDockPanel("plot2d")).toBe(false);
  });
});
