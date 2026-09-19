import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  channels: [{ id: "a", name: "secret-name" }, { id: "b", name: "B" }],
  data: new Map<string, { t: number[]; v: number[] }>(),
  groups: [{ id: "g1", chX: "a", chY: "b", chZ: "", pairMode: "nearest", pairTolMs: 50,
    transform: { scale: 2, rotX: 0, rotY: 0, rotZ: 0, offX: 1, offY: 0, offZ: 0 },
    model: { src: "D:/private/model.glb" }, notes: "api-key-secret" }],
  read: vi.fn(), triples: vi.fn(), annotations: vi.fn(), save: vi.fn(),
  dirty: vi.fn(), init: vi.fn(), sink: vi.fn(),
}));
vi.mock("../plot/plotStore", () => ({ getSnapshot: () => ({ channels: mocks.channels }),
  getChanData: mocks.read, timeOrigin: () => 100000, clearDirty: mocks.dirty, init: mocks.init }));
vi.mock("../plot3d/plot3dStore", () => ({ GROUP_IDS: ["g1", "g2", "g3"],
  getSnapshot: () => ({ settings: { groups: mocks.groups } }), exportTriples: mocks.triples, setSink: mocks.sink }));
vi.mock("../session/sessionStore", () => ({ getAnnotations: mocks.annotations, init: mocks.init }));
vi.mock("./packageWriter", () => ({ saveAnalysisPackage: mocks.save }));
import { analysisFileKey, buildAnalysisPackage, exportAnalysisPackage, getAnalysisCacheRange, uniformRows } from "./analysisPackage";
import { buildAnalysisSnapshot, type AnalysisSnapshot } from "./analysisSnapshot";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = new Map([
    ["a", { t: [100000, 101000, 102000], v: [1, 2, 3] }],
    ["b", { t: [100000, 101000, 102000], v: [4, 5, 6] }],
  ]);
  mocks.read.mockImplementation((id: string) => mocks.data.get(id));
  mocks.triples.mockReturnValue({ t: [0, 1, 2], x: [3, 5, 7], y: [8, 10, 12], z: [0, 0, 0] });
  mocks.annotations.mockReturnValue([{ ts: 99000, text: "before" }, { ts: 101000, text: "中文\n标注" }, { ts: 103000, text: "after" }]);
  mocks.save.mockResolvedValue({ directory: "D:/exports/new", status: "complete", fileCount: 3, totalBytes: 100 });
});
const base = { modules: ["waveform"] as const, channelIds: ["a"] };
const parseFile = (result: ReturnType<typeof buildAnalysisPackage>, name: string) => JSON.parse(result.files.find(f => f.name === name)!.content);

describe("P87c full cache analysis package", () => {
  it("records frozen request and group parameters without later configuration mutations", () => {
    const requestRange = { mode: "recent" as const, seconds: 2 };
    const snapshot = buildAnalysisSnapshot({ channelIds: ["a"], groupIds: ["g1"], range: requestRange,
      toleranceMs: 25, distanceTolerance: 0.5, maxPointsPerChannel: 2 });
    expect(snapshot.request).toMatchObject({ schema: "vs-analysis-request/v1", channelIds: ["a"], groupIds: ["g1"],
      range: { mode: "recent", seconds: 2 }, toleranceMs: 25, distanceTolerance: 0.5, maxPointsPerChannel: 2 });
    expect(snapshot.groups?.[0]).toMatchObject({ bindings: { x: "a", y: "b", z: null },
      transform: { scale: 2 }, pairing: { mode: "nearest", toleranceMs: 25 } });
    requestRange.seconds = 99;
    expect(snapshot.request?.range).toEqual({ mode: "recent", seconds: 2 });
    expect(snapshot.groups?.[0].transform).not.toBe(mocks.groups[0].transform);
    expect(snapshot.limits?.effectivePointsPerChannel).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("D:/private");
  });
  it("exports frozen evidence only when selected and never changes it with the export window", () => {
    const snapshot = buildAnalysisSnapshot({ channelIds: ["a"], groupIds: ["g1"] });
    const before = JSON.stringify(snapshot);
    const defaults = buildAnalysisPackage({ ...base, snapshot });
    expect(defaults.files.some(f => f.name === "analysis-snapshot.json" || f.name === "group-notes.json")).toBe(false);
    const result = buildAnalysisPackage({ modules: ["metrics"], channelIds: ["a"], snapshot,
      includeSnapshot: true, range: { startMs: 101000, endMs: 101000 } });
    expect(parseFile(result, "metrics.json").results[0].stats.n).toBe(1);
    expect(parseFile(result, "analysis-snapshot.json")).toMatchObject({
      range: { startMs: 100000, endMs: 102000 }, channels: [{ stats: { n: 3 } }], provenance: "recorded" });
    expect(result.meta.files.frozenSnapshot).toBe("analysis-snapshot.json");
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("whitelists nested frozen evidence and explicitly marks legacy provenance missing", () => {
    const snapshot = buildAnalysisSnapshot({ channelIds: ["a"], groupIds: ["g1"] });
    Object.assign(snapshot, { credentials: "SECRET_TOP" });
    Object.assign(snapshot.request!, { model: "SECRET_REQUEST" });
    Object.assign(snapshot.groups![0].transform, { privatePath: "SECRET_TRANSFORM" });
    Object.assign(snapshot.channels[0].stats, { toJSON: () => "SECRET_HOOK" });
    const result = buildAnalysisPackage({ ...base, includeSnapshot: true, snapshot });
    expect(JSON.stringify(result.files)).not.toContain("SECRET_");
    delete snapshot.request; delete snapshot.groups; delete snapshot.limits;
    const legacy = parseFile(buildAnalysisPackage({ ...base, includeSnapshot: true, snapshot }), "analysis-snapshot.json");
    expect(legacy).toMatchObject({ provenance: "unrecorded", request: null, groups: null, limits: null });
    expect(() => buildAnalysisPackage({ ...base, includeSnapshot: true })).toThrow("快照");
  });
  it("exports only selected current notes independently of trajectory CSV and bindings", () => {
    const prior = mocks.groups;
    mocks.groups = [{ ...prior[0], chX: "", chY: "", notes: "current selected note" },
      { ...prior[0], id: "g2", notes: "NOT_SELECTED" }];
    try {
      const result = buildAnalysisPackage({ modules: ["annotations"], groupIds: ["g1"], includeGroupNotes: true });
      expect(parseFile(result, "group-notes.json")).toEqual({ generatedAt: result.meta.generatedAt,
        groups: [{ id: "g1", notes: "current selected note" }] });
      expect(result.meta.files.groupNotes).toBe("group-notes.json");
      expect(JSON.stringify(result.files)).not.toContain("NOT_SELECTED");
      expect(JSON.stringify(result.files)).not.toContain("D:/private");
      expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.triples).not.toHaveBeenCalled();
      expect(() => buildAnalysisPackage({ modules: ["annotations"], groupIds: ["unknown"], includeGroupNotes: true })).toThrow("未知轨迹组");
    } finally { mocks.groups = prior; }
  });
  it("exports beyond the 2000-row preview and defaults to complete cache extent", () => {
    const t = Array.from({ length: 6001 }, (_, i) => 100000 + i);
    mocks.data.set("a", { t, v: t.map((_, i) => i) });
    const result = buildAnalysisPackage(base);
    const csv = result.files.find(f => f.name.endsWith(".csv"))!.content;
    expect(csv.trim().split("\r\n")).toHaveLength(6002);
    expect(result.meta.requestedRange).toEqual({ startMs: 100000, endMs: 106000 });
    expect(csv).toContain("106000,6000");
  });
  it("uniformly covers the sorted inclusive window including endpoints, not first-N", () => {
    mocks.data.set("a", { t: [105, 101, 104, 100, 103, 102], v: [5, 1, 4, 0, 3, 2] });
    const result = buildAnalysisPackage({ ...base, range: { startMs: 101, endMs: 105 }, maxRowsPerSeries: 3 });
    expect(result.files[0].content).toBe("t_ms,value_raw\r\n101,1\r\n103,3\r\n105,5\r\n");
    expect(result.meta.modules.waveform[0]).toMatchObject({ originalRows: 6, matchingRows: 5, outputRows: 3,
      reduced: true, actualRange: { startMs: 101, endMs: 105 } });
    expect(mocks.data.get("a")!.t).toEqual([105, 101, 104, 100, 103, 102]);
  });
  it("converts trajectory relative seconds to source ms before windowing", () => {
    const result = buildAnalysisPackage({ modules: ["trajectory"], groupIds: ["g1"], range: { startMs: 101000, endMs: 102000 } });
    expect(mocks.triples).toHaveBeenCalledWith("g1");
    expect(result.files[0].content).toBe("t_ms,x_raw,y_raw,z_raw\r\n101000,5,10,0\r\n102000,7,12,0\r\n");
    expect(result.meta.modules.trajectory[0]).toMatchObject({ originalRows: 3, matchingRows: 2,
      pairing: { mode: "nearest", configuredToleranceMs: 50 }, transform: { scale: 2, offX: 1 }, planarZ: 0 });
  });
  it("validates all IDs before cache access or fallback-to-g1 export", () => {
    expect(() => buildAnalysisPackage({ ...base, groupIds: ["unknown"] })).toThrow("未知轨迹组");
    expect(() => buildAnalysisPackage({ ...base, channelIds: ["a", "missing"] })).toThrow("未知通道");
    const channels = mocks.channels;
    mocks.channels = channels.filter(c => c.id !== "b");
    expect(() => buildAnalysisPackage({ modules: ["trajectory"], groupIds: ["g1"] })).toThrow("未知通道");
    mocks.channels = channels;
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.triples).not.toHaveBeenCalled();
  });
  it("recomputes metrics from full window before CSV decimation, ignoring stale snapshot", () => {
    mocks.data.set("a", { t: [100000, 101000, 102000], v: [0, 99, 0] });
    const result = buildAnalysisPackage({ ...base, modules: ["waveform", "metrics"], maxRowsPerSeries: 2,
      snapshot: { generatedAt: 1, channels: [{ id: "a", stats: { mean: -100 } }] } as unknown as AnalysisSnapshot });
    expect(result.files[0].content).not.toContain("99");
    expect(parseFile(result, "metrics.json").results[0].stats).toMatchObject({ n: 3, mean: 33, max: 99 });
    expect(result.meta.snapshot).toEqual({ generatedAt: 1, reused: false });
    expect(result.meta.modules.metrics[0]).toMatchObject({ inputRows: 3, outputRows: 1, reduced: false });
  });
  it("selects annotations by source window without copying session metadata", () => {
    const result = buildAnalysisPackage({ modules: ["annotations"], range: { startMs: 101000, endMs: 101000 } });
    expect(parseFile(result, "annotations.json")).toEqual([{ ts: 101000, text: "中文\n标注" }]);
    expect(mocks.triples).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("emits only selected modules, always meta and prompt; marks unavailable sources", () => {
    const result = buildAnalysisPackage({ modules: ["metrics"], channelIds: ["a"] });
    expect(result.files.map(f => f.name).sort()).toEqual(["ai-prompt.md", "meta.json", "metrics.json"]);
    expect(result.meta.unavailable).toHaveProperty("raw");
    expect(result.meta.unavailable).toHaveProperty("parsed");
    expect(result.meta.unavailable).toHaveProperty("ledger");
    expect(mocks.annotations).not.toHaveBeenCalled();
  });
  it("excludes model paths, notes, names and credentials from meta", () => {
    const result = buildAnalysisPackage({ modules: ["waveform", "trajectory"], channelIds: ["a"], groupIds: ["g1"] });
    const meta = JSON.stringify(result.meta);
    for (const secret of ["D:/private", "api-key-secret", "secret-name", "model.glb"]) expect(meta).not.toContain(secret);
    expect(result.meta.fileMap).toContainEqual({ file: analysisFileKey("waveform", "a"), id: "a", kind: "waveform" });
  });
  it("uses safe stable ID file keys independent of selection order", () => {
    expect(analysisFileKey("waveform", "../../CON:中文")).toMatch(/^waveform_[a-f0-9]{16}\.csv$/);
    const one = buildAnalysisPackage(base);
    const two = buildAnalysisPackage({ ...base, channelIds: ["b", "a"] });
    expect(two.meta.fileMap.find(f => f.id === "a")?.file).toBe(one.meta.fileMap[0].file);
  });
  it("keeps duplicate times and invalid values explicit and empty coverage null", () => {
    mocks.data.set("a", { t: [100, 100, NaN, 102], v: [NaN, 5, 3, Infinity] });
    const result = buildAnalysisPackage(base);
    expect(result.files[0].content).toBe("t_ms,value_raw\r\n100,\r\n100,5\r\n102,\r\n");
    expect(result.meta.modules.waveform[0]).toMatchObject({ invalidTimestampRows: 1, outputRows: 3 });
    const empty = buildAnalysisPackage({ ...base, range: { startMs: 999, endMs: 999 } });
    expect(empty.meta.modules.waveform[0]).toMatchObject({ actualRange: null, outputRows: 0 });
  });
  it("rejects invalid windows/caps/modules before writing", () => {
    expect(() => buildAnalysisPackage({ ...base, maxRowsPerSeries: 1 })).toThrow();
    expect(() => buildAnalysisPackage({ ...base, maxRowsPerSeries: 30001 })).toThrow();
    expect(() => buildAnalysisPackage({ ...base, range: { startMs: NaN, endMs: 0 } })).toThrow();
    expect(() => buildAnalysisPackage({ ...base, range: { startMs: 1, endMs: 0 } })).toThrow();
    expect(() => buildAnalysisPackage({ ...base, modules: [] })).toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(uniformRows([0, 1, 2, 3, 4], 2)).toEqual([0, 4]);
  });
  it("bounds total output with uniform allocation", () => {
    const original = mocks.channels;
    mocks.channels = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
    const t = Array.from({ length: 30000 }, (_, i) => i);
    for (const c of mocks.channels) mocks.data.set(c.id, { t, v: t });
    const result = buildAnalysisPackage({ ...base, channelIds: mocks.channels.map(c => c.id) });
    mocks.channels = original;
    expect(result.meta.limits.effectiveRowsPerSeries).toBe(24000);
    for (const entry of result.meta.modules.waveform) expect(entry).toMatchObject({ outputRows: 24000, actualRange: { startMs: 0, endMs: 29999 } });
  });
  it("does not sample, consume dirty, mutate sources or start a sink", () => {
    const before = JSON.stringify([...mocks.data]);
    expect(getAnalysisCacheRange(["a"], ["g1"])).toEqual({ startMs: 100000, endMs: 102000 });
    buildAnalysisPackage({ modules: ["waveform", "trajectory", "metrics", "annotations"], channelIds: ["a"], groupIds: ["g1"] });
    expect(JSON.stringify([...mocks.data])).toBe(before);
    expect(mocks.dirty).not.toHaveBeenCalled(); expect(mocks.init).not.toHaveBeenCalled(); expect(mocks.sink).not.toHaveBeenCalled();
  });
  it("uses the existing non-overwriting writer once and propagates disk failure", async () => {
    await expect(exportAnalysisPackage("D:/exports", base)).resolves.toMatchObject({ status: "complete" });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0]).toBe("D:/exports");
    expect(mocks.save.mock.calls[0][1].some((f: { name: string }) => f.name === "meta.json")).toBe(true);
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(exportAnalysisPackage("D:/exports", base)).rejects.toThrow("disk full");
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});
