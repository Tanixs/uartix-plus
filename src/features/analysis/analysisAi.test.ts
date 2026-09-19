import { describe, expect, it, vi } from "vitest";
import { analysisAiText, ANALYSIS_AI_MAX_CHARS, subscribeAnalysisAi } from "./analysisAi";
import { dispatchAnalysisEvent, refreshAnalysis, clearAnalysis } from "./analysisStore";
import { invokeAiScene } from "../ai/aiBus";
import type { AnalysisSnapshot } from "./analysisSnapshot";
import { computeStatistics, METRICS_VERSION } from "./metrics";

vi.mock("../ai/aiBus", () => ({ invokeAiScene: vi.fn() }));
vi.mock("./analysisSnapshot", () => ({ buildAnalysisSnapshot: () => fixture() }));

function fixture(): AnalysisSnapshot {
  return {
    algorithmVersion: METRICS_VERSION, generatedAt: 1234, selection: { mode: "cache" },
    range: { startMs: 0, endMs: 1000 }, source: "raw-channel-cache",
    channels: [{ id: "x", stats: computeStatistics({ t: [0, 1000], v: [1, 3] }, { startMs: 0, endMs: 1000 }, "m") }],
    trajectories: [], comparison: null, coverage: { channels: [], truncated: false },
  };
}

describe("analysis AI evidence bridge", () => {
  it("includes request tolerances and bounds oversized parameter lists", () => {
    const input = fixture();
    input.request = { schema: "vs-analysis-request/v1", channelIds: Array(1000).fill("x".repeat(10000)),
      groupIds: Array(1000).fill("g".repeat(10000)), range: { mode: "recent", seconds: 3 },
      toleranceMs: 25, distanceTolerance: 0.75, compare: null, unit: "m", maxPointsPerChannel: 100 };
    Object.assign(input.request, { credentials: "SECRET_PARAMETER" });
    const serialized = analysisAiText(input);
    expect(serialized.length).toBeLessThanOrEqual(ANALYSIS_AI_MAX_CHARS);
    expect(serialized).not.toContain("SECRET_PARAMETER");
    expect(JSON.parse(serialized)).toMatchObject({ summaryOmitted: true,
      parameters: { provenance: "recorded", toleranceMs: 25, distanceTolerance: 0.75, rangeMode: "recent" } });
    expect(input.request.channelIds).toHaveLength(1000);
  });
  it("marks old snapshots' request parameters as unrecorded", () => {
    expect(JSON.parse(analysisAiText(fixture())).parameters).toMatchObject({
      provenance: "unrecorded", toleranceMs: null, distanceTolerance: null, channelIds: null,
    });
  });
  it("preserves source time, values and units without copying unrelated properties", () => {
    const input = fixture();
    Object.assign(input, { connection: "SECRET_CONNECTION", notes: "SECRET_NOTE", raw: ["SECRET_RAW"] });
    Object.assign(input.channels[0].stats, { password: "SECRET_PASSWORD" });
    const serialized = analysisAiText(input);
    expect(serialized).not.toContain("SECRET_");
    expect(JSON.parse(serialized)).toMatchObject({
      range: { startMs: 0, endMs: 1000 }, source: "raw-channel-cache",
      channels: [{ id: "x", n: 2, mean: 2, unit: "m" }], comparison: null,
    });
    expect(serialized).toContain("not-necessarily-Unix");
  });

  it("bounds the summary, reports omissions and leaves the input unchanged", () => {
    const input = fixture();
    input.channels = Array.from({ length: 100 }, () => ({ ...input.channels[0], id: "a".repeat(10000) }));
    input.coverage.truncated = true;
    const serialized = analysisAiText(input);
    expect(serialized.length).toBeLessThanOrEqual(ANALYSIS_AI_MAX_CHARS);
    const result = JSON.parse(serialized);
    expect(result.summaryOmitted).toBe(true);
    expect(result.snapshotTruncated).toBe(true);
    expect(result.channels.length).toBeLessThanOrEqual(16);
    expect(result.channels[0].id.length).toBe(128);
    expect(input.channels).toHaveLength(100);
    expect(input.channels[0].id).toHaveLength(10000);
  });

  it("converts nonfinite evidence to missing instead of inventing values", () => {
    const input = fixture();
    input.channels[0].stats.mean = NaN;
    input.channels[0].stats.slope = Infinity;
    expect(JSON.parse(analysisAiText(input)).channels[0]).toMatchObject({ mean: null, slopePerSecond: null });
  });

  it("only an explicit AI event dispatches the scene and unsubscribe removes the listener", () => {
    vi.mocked(invokeAiScene).mockClear();
    clearAnalysis();
    const target = new EventTarget();
    const unsubscribe = subscribeAnalysisAi(target);
    expect(invokeAiScene).not.toHaveBeenCalled();
    refreshAnalysis({});
    expect(invokeAiScene).not.toHaveBeenCalled();
    dispatchAnalysisEvent("vs-analysis-export", target);
    expect(invokeAiScene).not.toHaveBeenCalled();
    dispatchAnalysisEvent("vs-analysis-ai", target);
    expect(invokeAiScene).toHaveBeenCalledExactlyOnceWith("inertial", { text: analysisAiText(fixture()) });
    unsubscribe();
    dispatchAnalysisEvent("vs-analysis-ai", target);
    expect(invokeAiScene).toHaveBeenCalledTimes(1);
    clearAnalysis();
  });
});
