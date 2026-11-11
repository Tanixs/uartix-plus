import { describe, expect, it } from "vitest";
import {
  ATTITUDE_VIEW_MAX_INSTANCES,
  ATTITUDE_WEBGL_BUDGET,
  TRAJECTORY_WEBGL_BUDGET,
  dprCapOf,
  nextQuality,
  pixelRatioFor,
  targetFpsOf,
} from "./attitudeViewQuality";

describe("attitude view budget", () => {
  it("keeps the canvas view at one instance and the app-wide attitude budget at two", () => {
    expect(ATTITUDE_VIEW_MAX_INSTANCES).toBe(1);
    expect(ATTITUDE_WEBGL_BUDGET).toBe(2);
    // 3D 轨迹单独记账，不许和姿态预算相加后再判断
    expect(TRAJECTORY_WEBGL_BUDGET).toBe(1);
  });
});

describe("attitude view quality ladder", () => {
  it("stays at full quality while the frame rate holds", () => {
    expect(nextQuality(0, { fps: 29, msInLevel: 10_000 })).toBe(0);
    expect(nextQuality(0, { fps: 0, msInLevel: 10_000 })).toBe(0); // 还没出样本
  });

  it("drops a tier only after the dwell time at each threshold", () => {
    expect(nextQuality(0, { fps: 20, msInLevel: 1_999 })).toBe(0);
    expect(nextQuality(0, { fps: 20, msInLevel: 2_000 })).toBe(1);
    expect(nextQuality(1, { fps: 18, msInLevel: 1_999 })).toBe(1);
    expect(nextQuality(1, { fps: 18, msInLevel: 2_000 })).toBe(2);
  });

  it("never upgrades on its own and pins the lowest tier", () => {
    expect(nextQuality(0, { fps: 120, msInLevel: 60_000 })).toBe(0);
    expect(nextQuality(2, { fps: 5, msInLevel: 60_000 })).toBe(2);
    expect(nextQuality(2, { fps: 120, msInLevel: 60_000 })).toBe(2);
  });

  it("exposes the caps and targets for each tier", () => {
    expect([dprCapOf(0), dprCapOf(1), dprCapOf(2)]).toEqual([2, 1.5, 1]);
    expect([targetFpsOf(0), targetFpsOf(1), targetFpsOf(2)]).toEqual([30, 30, 20]);
  });
});

describe("attitude view pixel ratio", () => {
  it("multiplies dpr by the UI zoom and clamps at 2", () => {
    expect(pixelRatioFor(1, 1, 0)).toBe(1);
    expect(pixelRatioFor(1.5, 1.25, 0)).toBe(1.875);
    expect(pixelRatioFor(2, 1.5, 0)).toBe(2);
  });

  it("follows the degradation caps", () => {
    expect(pixelRatioFor(2, 1, 1)).toBe(1.5);
    expect(pixelRatioFor(2, 1, 2)).toBe(1);
    expect(pixelRatioFor(0.0001, 0.5, 0)).toBe(1);
  });
});
