import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { saveAnalysisPackage } from "./packageWriter";

describe("analysis package writer", () => {
  it("passes directory and immutable file content to the non-overwriting command", async () => {
    const receipt = { directory: "D:/exports/analysis-new", status: "complete", fileCount: 1, totalBytes: 2 };
    invoke.mockResolvedValueOnce(receipt);
    const files = [{ name: "meta.json", content: "{}" }];
    expect(await saveAnalysisPackage("D:/exports", files)).toEqual(receipt);
    expect(invoke).toHaveBeenLastCalledWith("save_analysis_package", { directory: "D:/exports", files });
    expect(files).toEqual([{ name: "meta.json", content: "{}" }]);
  });
  it("never converts a failed write to success or retries it", async () => {
    invoke.mockClear(); invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(saveAnalysisPackage("D:/exports", [{ name: "meta.json", content: "{}" }])).rejects.toThrow("disk full");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
