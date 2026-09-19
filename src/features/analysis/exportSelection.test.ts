import { describe, expect, it, vi } from "vitest";
import { initialExportSelection } from "./exportSelection";
import type { AnalysisSnapshot } from "./analysisSnapshot";

type SnapshotSelection = Pick<AnalysisSnapshot, "channels" | "trajectories" | "range">;
const snapshot = (): SnapshotSelection => ({
  channels: [{ id: "selected" }] as SnapshotSelection["channels"],
  trajectories: [{ id: "g2" }] as SnapshotSelection["trajectories"],
  range: { startMs: 100, endMs: 200 },
});

describe("export dialog initial selection", () => {
  it("uses recorded request IDs even when an empty cache produced no result rows", () => {
    const request: NonNullable<AnalysisSnapshot["request"]> = {
      schema: "vs-analysis-request/v1", channelIds: ["requested"], groupIds: ["g1"],
      range: { mode: "cache" }, toleranceMs: 100, distanceTolerance: 0,
      compare: null, unit: "raw", maxPointsPerChannel: 30000,
    };
    const selection = initialExportSelection({ channels: [], trajectories: [], range: null, request }, [], vi.fn());
    expect(selection).toEqual({ channelIds: ["requested"], groupIds: ["g1"], range: null });
    selection.channelIds.push("other");
    expect(request.channelIds).toEqual(["requested"]);
  });
  it("inherits the frozen result selection without reading the current cache", () => {
    const cache = vi.fn();
    expect(initialExportSelection(snapshot(), ["other"], cache)).toEqual({
      channelIds: ["selected"], groupIds: ["g2"], range: { startMs: 100, endMs: 200 },
    });
    expect(cache).not.toHaveBeenCalled();
  });
  it("preserves empty selections and a null frozen range", () => {
    const cache = vi.fn();
    expect(initialExportSelection({ channels: [], trajectories: [], range: null }, ["other"], cache))
      .toEqual({ channelIds: [], groupIds: [], range: null });
    expect(cache).not.toHaveBeenCalled();
  });
  it("copies IDs and range so later export edits cannot change frozen evidence", () => {
    const frozen = snapshot();
    const selection = initialExportSelection(frozen, [], vi.fn());
    selection.channelIds.push("other");
    selection.groupIds[0] = "g1";
    selection.range!.startMs = 0;
    expect(frozen).toEqual(snapshot());
  });
  it("reads the selected current cache only when no snapshot was supplied", () => {
    const defaults = ["a", "b"];
    const range = { startMs: 0, endMs: 20 };
    const cache = vi.fn(() => range);
    const selection = initialExportSelection(undefined, defaults, cache);
    expect(cache).toHaveBeenCalledExactlyOnceWith(["a", "b"], []);
    expect(selection).toEqual({ channelIds: defaults, groupIds: [], range });
    expect(selection.channelIds).not.toBe(defaults);
    expect(selection.range).not.toBe(range);
  });
});
