import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeStatistics, computeTrajectory, compareTrajectories, METRICS_VERSION } from "./metrics";
import { buildAnalysisSnapshot } from "./analysisSnapshot";
import * as analysisStore from "./analysisStore";
import { IDENTITY_TRANSFORM } from "../plot3d/smoothing";

const fixture = vi.hoisted(() => ({
  data: new Map<string, { t: number[]; v: number[] }>(),
  groups: [] as { id: string; chX: string; chY: string; chZ: string; transform: { rotX: number; rotY: number; rotZ: number; offX: number; offY: number; offZ: number; scale: number } }[],
  read: vi.fn(), aligned: vi.fn(), clearDirty: vi.fn(),
}));
vi.mock("../plot/plotStore", () => ({
  getSnapshot: () => ({ channels: [...fixture.data.keys()].map((id) => ({ id })) }),
  getChanData: (id: string) => { fixture.read(id); return fixture.data.get(id); },
  buildAligned: fixture.aligned, clearDirty: fixture.clearDirty,
}));
vi.mock("../plot3d/plot3dStore", () => ({ getSnapshot: () => ({ settings: { groups: fixture.groups } }) }));

const range = { startMs: 0, endMs: 3000 };
const trajectory = (t: number[], x: number[]) => ({ t, x, y: t.map(() => 0), z: t.map(() => 0) });

beforeEach(() => {
  fixture.data.clear(); fixture.groups = []; vi.clearAllMocks(); analysisStore.clearAnalysis();
});

describe("trajectory metrics", () => {
  it("measures path length/displacement with range and unit metadata", () => {
    const r = computeTrajectory({ t: [0, 1000, 2000, 4000], x: [0, 3, 3, 99], y: [0, 0, 4, 99], z: [0, 0, 0, 99] }, range, "m");
    expect(r).toMatchObject({ n: 3, length: 7, displacement: 5, segments: 2, range, unit: "m", algorithmVersion: METRICS_VERSION });
  });
  it("breaks segments at invalid points and avoids invented empty lengths", () => {
    const r = computeTrajectory(trajectory([0, 1000, 2000, 3000], [0, NaN, 2, 4]), range);
    expect(r).toMatchObject({ n: 3, invalid: 1, length: 2, displacement: 4, segments: 1 });
    expect(r.coverage.validFraction).toBe(0.75);
    expect(computeTrajectory(trajectory([], []), range).length).toBeNull();
    expect(() => computeTrajectory({ t: [0], x: [], y: [0], z: [0] }, range)).toThrow(RangeError);
  });
  it("compares within time tolerance, including final endpoint, never extrapolating", () => {
    const a = trajectory([0, 1000, 2000, 3000], [0, 1, 2, 3]);
    const b = trajectory([500, 1500, 2500], [0.5, 1.5, 2.5]);
    const r = compareTrajectories(a, b, range, 500, 0.5, "m");
    expect(r).toMatchObject({ n: 2, unmatched: 2, maxDev: 0.5, meanDev: 0.5, inToleranceFraction: 1 });
    expect(r.coverage.matchedFraction).toBe(0.5);
    expect(compareTrajectories(a, b, range, 499).n).toBe(0);
    expect(compareTrajectories(a, a, range, 0).n).toBe(4);
    expect(compareTrajectories(a, a, range, 0).maxDev).toBe(0);
    expect(compareTrajectories(a, b, { startMs: 0, endMs: 400 }, 9999).n).toBe(0);
    expect(() => compareTrajectories(a, b, range, -1)).toThrow(RangeError);
  });
  it("rejects invalid nearest values and handles singleton/empty references", () => {
    const a = trajectory([0, 1000, 2000], [0, 1, 2]);
    expect(compareTrajectories(a, trajectory([0, 1000, 2000], [0, NaN, 2]), range, 2000).n).toBe(2);
    expect(compareTrajectories(a, trajectory([1000], [1]), range, 5000).n).toBe(1);
    expect(compareTrajectories(a, trajectory([], []), range, 5000).meanDev).toBeNull();
  });
});

describe("bounded analysis snapshot and manual store", () => {
  it("validates every ID before getChanData, including stale group bindings", () => {
    fixture.data.set("x", { t: [0], v: [1] });
    expect(() => buildAnalysisSnapshot({ channelIds: ["x", "ghost"] })).toThrow(RangeError);
    fixture.groups.push({ id: "g1", chX: "x", chY: "ghost", chZ: "", transform: { ...IDENTITY_TRANSFORM } });
    expect(() => buildAnalysisSnapshot({ groupIds: ["g1"] })).toThrow(RangeError);
    expect(() => buildAnalysisSnapshot({ groupIds: ["g99"] })).toThrow(RangeError);
    expect(fixture.read).not.toHaveBeenCalled();
  });
  it("supports cache/recent/custom, bounded tails, and never consumes dirty/aligned", () => {
    const source = { t: [0, 1000, 2000, 3000], v: [1, 2, 3, 4] };
    fixture.data.set("x", source);
    const r = buildAnalysisSnapshot({ channelIds: ["x"], maxPointsPerChannel: 2 });
    expect(r.channels[0].stats).toMatchObject({ n: 2, mean: 3.5 });
    expect(r.coverage).toMatchObject({ truncated: true, channels: [{ cached: 4, retained: 2, truncated: true }] });
    const recent = buildAnalysisSnapshot({ channelIds: ["x"], range: { mode: "recent", seconds: 1 } });
    expect(recent.range).toEqual({ startMs: 2000, endMs: 3000 });
    expect(recent.channels[0].stats.n).toBe(2);
    expect(buildAnalysisSnapshot({ channelIds: ["x"], range: { mode: "custom", startMs: 1500, endMs: 2500 } }).channels[0].stats.mean).toBe(3);
    source.v[3] = 99;
    expect(r.channels[0].stats.mean).toBe(3.5);
    expect(fixture.aligned).not.toHaveBeenCalled(); expect(fixture.clearDirty).not.toHaveBeenCalled();
  });
  it("rejects invalid options, and bounds oversized virtual caches", () => {
    expect(() => buildAnalysisSnapshot({ range: { mode: "recent", seconds: 0 } })).toThrow(RangeError);
    expect(() => buildAnalysisSnapshot({ range: { mode: "custom", startMs: 2, endMs: 1 } })).toThrow(RangeError);
    expect(() => buildAnalysisSnapshot({ maxPointsPerChannel: 30001 })).toThrow(RangeError);
    expect(() => buildAnalysisSnapshot({ toleranceMs: NaN })).toThrow(RangeError);
    fixture.data.set("x", { t: Array.from({ length: 30001 }, (_, i) => i), v: Array(30001).fill(1) });
    const r = buildAnalysisSnapshot({ channelIds: ["x"] });
    expect(r.channels[0].stats.n).toBe(30000); expect(r.coverage.truncated).toBe(true);
    expect(buildAnalysisSnapshot().range).toBeNull();
  });
  it("selects an older custom window before applying the copy limit", () => {
    fixture.data.set("x", { t: Array.from({ length: 40000 }, (_, i) => i), v: Array.from({ length: 40000 }, (_, i) => i) });
    const r = buildAnalysisSnapshot({ channelIds: ["x"], range: { mode: "custom", startMs: 0, endMs: 10 } });
    expect(r.channels[0].stats).toMatchObject({ n: 11, mean: 5 });
    expect(r.coverage.truncated).toBe(false);
    expect(buildAnalysisSnapshot({ channelIds: ["x"] }).range).toEqual({ startMs: 0, endMs: 39999 });
  });
  it("uses raw planar axes and transforms, compares groups, and honors range before pairing", () => {
    fixture.data.set("x", { t: [0, 1000, 2000], v: [0, 1, 2] });
    fixture.data.set("y", { t: [0, 1000, 2000], v: [0, 0, 0] });
    fixture.groups = [1, 2].map((scale) => ({ id: `g${scale}`, chX: "x", chY: "y", chZ: "", transform: { ...IDENTITY_TRANSFORM, scale } }));
    const r = buildAnalysisSnapshot({ compare: { a: "g1", b: "g2" }, toleranceMs: 0, distanceTolerance: 1 });
    expect(r.trajectories.map((g) => g.stats.length)).toEqual([2, 4]);
    expect(r.comparison?.stats).toMatchObject({ n: 3, maxDev: 2, meanDev: 1, inToleranceFraction: 2 / 3 });
    fixture.data.set("y", { t: [0, 2000], v: [0, 0] });
    const isolated = buildAnalysisSnapshot({ groupIds: ["g1"], range: { mode: "custom", startMs: 500, endMs: 1500 }, toleranceMs: 9999 });
    expect(isolated.trajectories[0].stats.n).toBe(0);
    expect(isolated.trajectories[0].stats.invalid).toBe(1);
  });
  it("store refreshes only explicitly and emits cloned result-only events", () => {
    fixture.data.set("x", { t: [0, 1000], v: [1, 3] });
    const cb = vi.fn(); const unsub = analysisStore.subscribe(cb);
    const target = new EventTarget();
    expect(analysisStore.dispatchAnalysisEvent("vs-analysis-ai", target)).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled();
    analysisStore.refreshAnalysis({ channelIds: ["x"] });
    expect(cb).toHaveBeenCalledTimes(1);
    for (const name of ["vs-analysis-export", "vs-analysis-ai"] as const) {
      const listener = vi.fn((e: Event) => {
        const detail = (e as CustomEvent).detail;
        expect(detail).toEqual(analysisStore.getSnapshot().result);
        expect(detail).not.toBe(analysisStore.getSnapshot().result);
        expect(Object.keys(detail.channels[0])).toEqual(["id", "stats"]);
        detail.channels.length = 0;
      });
      target.addEventListener(name, listener);
      expect(analysisStore.dispatchAnalysisEvent(name, target)).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
    }
    expect(analysisStore.getSnapshot().result?.channels.length).toBe(1);
    expect(analysisStore.refreshAnalysis({ channelIds: ["ghost"] })).toBeNull();
    expect(analysisStore.getSnapshot().error).toBeTruthy();
    expect(analysisStore.getSnapshot().result).toBeNull();
    unsub(); analysisStore.clearAnalysis(); expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("computeStatistics", () => {
  it("computes sample statistics, OLS per second and timestamp gaps", () => {
    const r = computeStatistics({ t: [0, 1000, 2000], v: [1, 3, 5] }, range, "deg");
    expect(r).toMatchObject({ n: 3, invalid: 0, min: 1, max: 5, mean: 3, std: 2, slope: 2 });
    expect(r.rms).toBeCloseTo(Math.sqrt(35 / 3));
    expect(r.algorithmVersion).toBe(METRICS_VERSION);
    expect(r.units).toEqual({ value: "deg", slope: "deg/s", timeGap: "ms", count: "samples" });
    expect(r.range).toEqual(range);
    expect(r.range).not.toBe(range);
    expect(r.coverage).toEqual({ total: 3, validFraction: 1, firstMs: 0, lastMs: 2000, unlocated: 0 });
    expect(r.timeGap).toEqual({ n: 2, minMs: 1000, maxMs: 1000, meanMs: 1000, duplicateTimes: 0 });
  });

  it("includes boundaries, excludes outside values and never extrapolates", () => {
    const r = computeStatistics({ t: [-1, 0, 1000, 3000, 3001], v: [999, 1, 2, 3, 999] }, range);
    expect(r.n).toBe(3);
    expect(r.mean).toBe(2);
    const empty = computeStatistics({ t: [0, 3000], v: [1, 3] }, { startMs: 1000, endMs: 2000 });
    expect(empty.n).toBe(0);
    expect(empty.mean).toBeNull();
    expect(empty.coverage.firstMs).toBeNull();
  });

  it("counts invalid in-range values and unlocated timestamps separately", () => {
    const r = computeStatistics({ t: [0, 1000, 2000, 3000, NaN, 4000], v: [2, NaN, Infinity, 4, 8, NaN] }, range);
    expect(r.n).toBe(2);
    expect(r.invalid).toBe(2);
    expect(r.mean).toBe(3);
    expect(r.coverage).toMatchObject({ total: 4, validFraction: 0.5, unlocated: 1 });
    expect(r.timeGap.maxMs).toBe(3000);
  });

  it("reports null for unavailable stats rather than zeros or NaN", () => {
    const empty = computeStatistics({ t: [], v: [] }, range);
    expect([empty.min, empty.max, empty.mean, empty.rms, empty.std, empty.slope]).toEqual(Array(6).fill(null));
    expect(empty.coverage.validFraction).toBeNull();
    const one = computeStatistics({ t: [0], v: [5] }, range);
    expect(one.std).toBeNull();
    expect(one.slope).toBeNull();
    expect(one.rms).toBe(5);
    const invalid = computeStatistics({ t: [0], v: [NaN] }, range);
    expect(invalid.coverage.validFraction).toBe(0);
  });

  it("sorts only a copy and records duplicate timestamps", () => {
    const t = Object.freeze([2000, 0, 1000, 1000]);
    const v = Object.freeze([2, 2, 2, 2]);
    const r = computeStatistics({ t, v }, range);
    expect(r.timeGap).toMatchObject({ n: 2, duplicateTimes: 1, meanMs: 1000 });
    expect(r.std).toBe(0);
    expect(r.slope).toBe(0);
    expect(t).toEqual([2000, 0, 1000, 1000]);
    expect(computeStatistics({ t: [1, 1], v: [1, 2] }, range).slope).toBeNull();
  });

  it("uses actual elapsed time for uneven sampling at epoch offsets", () => {
    const base = 1_700_000_000_000;
    const r = computeStatistics({ t: [base, base + 100, base + 3000], v: [7, 6.8, 1] }, { startMs: base, endMs: base + 3000 });
    expect(r.slope).toBeCloseTo(-2);
    expect(r.timeGap).toMatchObject({ minMs: 100, maxMs: 2900, meanMs: 1500 });
  });

  it("keeps RMS finite when direct squaring would overflow", () => {
    const r = computeStatistics({ t: [0, 1], v: [1e200, 1e200] }, range);
    expect(r.rms).toBe(1e200);
    expect(r.std).toBe(0);
    expect(r.slope).toBe(0);
  });

  it("rejects malformed range and length mismatch", () => {
    for (const r of [{ startMs: 2, endMs: 1 }, { startMs: NaN, endMs: 1 }, { startMs: 0, endMs: Infinity }]) {
      expect(() => computeStatistics({ t: [], v: [] }, r)).toThrow(RangeError);
    }
    expect(() => computeStatistics({ t: [0], v: [] }, range)).toThrow(RangeError);
  });
});
