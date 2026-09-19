import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  state: { state: "idle", firstTs: 1000, lastTs: 5000, posMs: 0, lastSpeed: 0 },
  seek: vi.fn(async () => true), pause: vi.fn(async () => true),
  listeners: new Set<() => void>(),
}));
vi.mock("../session/sessionStore", () => ({
  getSnapshot: () => mock.state,
  seek: mock.seek, pause: mock.pause,
  subscribe: (cb: () => void) => { mock.listeners.add(cb); return () => mock.listeners.delete(cb); },
}));
import { navigateTime, previewTime, subscribeReplayClock } from "./timeNavigation";
import * as cursor from "./timeCursorStore";

describe("time navigation contract", () => {
  beforeEach(() => {
    mock.state = { state: "idle", firstTs: 1000, lastTs: 5000, posMs: 0, lastSpeed: 0 };
    mock.seek.mockReset().mockResolvedValue(true);
    mock.pause.mockReset().mockResolvedValue(true);
    mock.listeners.clear(); cursor.locate(null, "session"); cursor.setLinked(true);
  });
  it("a 2D time selection reaches a 3D subscriber without moving a camera or seeking live data", async () => {
    const receive3D = vi.fn();
    const off = cursor.subscribe(() => {
      const selected = cursor.getSnapshot();
      if (selected.linked && selected.tsMs !== null && selected.source !== "plot3d") {
        receive3D(cursor.toDisplaySeconds(selected.tsMs, 1000));
      }
    });
    await navigateTime(2500, "plot2d");
    expect(receive3D).toHaveBeenCalledExactlyOnceWith(1.5);
    expect(mock.seek).not.toHaveBeenCalled(); off();
  });
  it("preview propagates but never seeks", () => {
    mock.state.state = "playing";
    previewTime(3000, "plot2d");
    expect(cursor.getSnapshot().tsMs).toBe(3000);
    expect(mock.seek).not.toHaveBeenCalled();
  });
  it("keeps a drag preview while session progress arrives", () => {
    mock.state.state = "playing";
    const off = subscribeReplayClock();
    previewTime(3000, "plot2d");
    mock.state.posMs = 200; mock.listeners.forEach(cb => cb());
    expect(cursor.getSnapshot().tsMs).toBe(3000);
    expect(mock.seek).not.toHaveBeenCalled();
    off();
  });
  it("a paused replay click seeks once, retains zero speed and re-pauses", async () => {
    mock.state.state = "paused";
    await navigateTime(3000, "annotation");
    expect(mock.seek).toHaveBeenCalledExactlyOnceWith(0.5, 0);
    expect(mock.pause).toHaveBeenCalledTimes(1);
    expect(cursor.getSnapshot().tsMs).toBe(3000);
  });
  it("playing replay does not pause and progress cannot trigger another seek", async () => {
    mock.state.state = "playing";
    const off = subscribeReplayClock();
    await navigateTime(2000, "plot3d");
    mock.state.posMs = 1200; mock.listeners.forEach(cb => cb());
    expect(mock.seek).toHaveBeenCalledTimes(1);
    expect(mock.pause).not.toHaveBeenCalled();
    expect(cursor.getSnapshot().tsMs).toBe(2200); off();
    expect(mock.listeners.size).toBe(0);
  });
  it("rejects timestamps outside replay and zero-duration sessions", async () => {
    mock.state.state = "paused";
    await navigateTime(999, "annotation"); await navigateTime(NaN, "plot2d");
    mock.state.lastTs = mock.state.firstTs;
    await navigateTime(1000, "annotation");
    expect(mock.seek).not.toHaveBeenCalled();
  });
  it("does not publish a failed seek as success", async () => {
    mock.state.state = "paused"; mock.seek.mockResolvedValue(false);
    await navigateTime(2000, "plot2d");
    expect(cursor.getSnapshot().tsMs).toBeNull();
    expect(mock.pause).not.toHaveBeenCalled();
  });
  it("serializes in-flight seeks and merges queued selections to the latest", async () => {
    mock.state.state = "playing";
    let finish!: (ok: boolean) => void;
    mock.seek.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const first = navigateTime(2000, "plot2d");
    await navigateTime(3000, "plot2d"); await navigateTime(4000, "plot3d");
    expect(mock.seek).toHaveBeenCalledTimes(1);
    finish(true); await first;
    expect(mock.seek.mock.calls).toEqual([[0.25, 0], [0.75, 0]]);
    expect(cursor.getSnapshot().tsMs).toBe(4000);
  });
});
