import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromDisplaySeconds, getSnapshot, locate, publishDisplayRange, setLinked, subscribe, toDisplaySeconds } from "./timeCursorStore";

describe("shared time cursor", () => {
  beforeEach(() => { locate(null, "plot2d"); setLinked(true); });
  it("round-trips source milliseconds including a zero origin", () => {
    for (const origin of [0, 1720000000000]) {
      expect(fromDisplaySeconds(toDisplaySeconds(origin + 1234, origin), origin)).toBe(origin + 1234);
    }
  });
  it("maps a timeline ratio through the plot origin, not the session duration", () => {
    const origin = 1700000000000;
    const ratio = 0.25;
    const plotEndSeconds = 12;
    const timestamp = fromDisplaySeconds(ratio * plotEndSeconds, origin);
    expect(timestamp).toBe(origin + 3000);
    expect(toDisplaySeconds(timestamp, origin)).toBe(3);
    const sessionStart = origin - 10000;
    const sessionEnd = origin + 30000;
    expect((timestamp - sessionStart) / (sessionEnd - sessionStart)).toBe(0.325);
  });
  it("rejects non-finite coordinates without notifying", () => {
    const listener = vi.fn(); const off = subscribe(listener);
    const previous = getSnapshot();
    expect(locate(NaN, "plot3d")).toBe(false);
    expect(locate(Infinity, "plot3d")).toBe(false);
    expect(getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled(); off();
  });
  it("publishes once and does not echo identical updates", () => {
    const listener = vi.fn(); const off = subscribe(listener);
    locate(1200, "plot2d"); locate(1200, "plot2d");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot().tsMs).toBe(1200); off();
  });
  it("publishes ordered A/B bounds in source milliseconds and clears incomplete selections", () => {
    publishDisplayRange(4, 1, 2500, true);
    expect(getSnapshot().rangeMs).toEqual([3500, 6500]);
    expect(getSnapshot().tsMs).toBeNull();
    const listener = vi.fn(); const off = subscribe(listener);
    publishDisplayRange(1, 4, 2500, true);
    expect(listener).not.toHaveBeenCalled();
    publishDisplayRange(1, null, 2500, true);
    expect(getSnapshot().rangeMs).toBeNull();
    publishDisplayRange(0, 2, 0, true);
    expect(getSnapshot().rangeMs).toEqual([0, 2000]);
    publishDisplayRange(0, 2, 0, false);
    expect(getSnapshot().rangeMs).toBeNull();
    publishDisplayRange(NaN, 2, 0, true);
    expect(getSnapshot().rangeMs).toBeNull();
    off();
  });
  it("supports follow, unlink and lifecycle cleanup", () => {
    const listener = vi.fn(); const off = subscribe(listener);
    setLinked(false); locate(0, "annotation"); locate(null, "plot3d");
    expect(getSnapshot()).toMatchObject({ linked: false, tsMs: null });
    off(); const calls = listener.mock.calls.length;
    setLinked(true); expect(listener).toHaveBeenCalledTimes(calls);
  });
});
