import { describe, expect, it } from "vitest";
import { resolvePlot3dGroup, plot3dRemovalReceipt } from "./plot3dActionPolicy";

describe("plot3d action group policy", () => {
  const gid = "12345678-1234-4234-8234-123456789abc";
  const groups = [{ id: "g1" }, { id: gid }];
  it("preserves explicit UUID identity and legacy default", () => {
    expect(resolvePlot3dGroup({ gid }, groups)).toBe(gid);
    expect(resolvePlot3dGroup({}, groups)).toBe("g1");
  });
  it("rejects missing, invalid and deleted identities without fallback", () => {
    for (const value of [null, 0, "", "g2"]) {
      expect(() => resolvePlot3dGroup({ gid: value }, groups)).toThrow();
    }
    expect(() => resolvePlot3dGroup({}, [{ id: gid }])).toThrow();
    expect(() => resolvePlot3dGroup({}, groups, true)).toThrow();
  });
  it("external removal always returns a non-executing manual-confirmation receipt", () => {
    expect(plot3dRemovalReceipt(gid)).toMatchObject({
      ok: false, status: "needs_manual_confirmation", gid,
    });
  });
});
