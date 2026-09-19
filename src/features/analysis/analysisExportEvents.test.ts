import { expect, it, vi } from "vitest";
import { subscribeAnalysisExport } from "./analysisExportEvents";

it("opens with the supplied snapshot, does not write, and unsubscribes", () => {
  const target = new EventTarget();
  const open = vi.fn();
  const snapshot = { source: "raw-channel-cache", channels: [], trajectories: [] };
  const unsubscribe = subscribeAnalysisExport(open, target);
  expect(open).not.toHaveBeenCalled();
  target.dispatchEvent(new CustomEvent("vs-analysis-export", { detail: snapshot }));
  expect(open).toHaveBeenCalledExactlyOnceWith(snapshot);
  unsubscribe();
  target.dispatchEvent(new CustomEvent("vs-analysis-export", { detail: snapshot }));
  expect(open).toHaveBeenCalledTimes(1);
});
