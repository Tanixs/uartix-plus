import { describe, expect, it } from "vitest";
import {
  TRAJECTORY_VIEW_MAX_INSTANCES,
  TRAJECTORY_WEBGL_BUDGET,
  dprCapOf,
  nextQuality,
  pixelRatioFor,
  renderFpsCapOf,
  targetFpsOf,
} from "./trajectoryViewQuality";
import { ATTITUDE_WEBGL_BUDGET } from "../attitude/attitudeViewQuality";

describe("trajectoryViewQuality · 预算与阶梯", () => {
  it("视图上限 1；轨迹自身 2 个上下文，与姿态分开记账", () => {
    expect(TRAJECTORY_VIEW_MAX_INSTANCES).toBe(1);
    expect(TRAJECTORY_WEBGL_BUDGET).toBe(2);
    expect(ATTITUDE_WEBGL_BUDGET).toBe(2);
    // 分开计：轨迹的 2 不在姿态的 2 里面，也不是相加后的 4
    expect(TRAJECTORY_WEBGL_BUDGET).not.toBe(ATTITUDE_WEBGL_BUDGET + 2);
  });

  it("L0→L1 阈值 22fps、dwell 2500ms", () => {
    expect(nextQuality(0, { fps: 21, msInLevel: 2499 })).toBe(0);
    expect(nextQuality(0, { fps: 21, msInLevel: 2500 })).toBe(1);
    expect(nextQuality(0, { fps: 22, msInLevel: 9999 })).toBe(0);
  });

  it("L1→L2 阈值 18fps，L2 不再降", () => {
    expect(nextQuality(1, { fps: 18, msInLevel: 9999 })).toBe(1);
    expect(nextQuality(1, { fps: 17, msInLevel: 2500 })).toBe(2);
    expect(nextQuality(2, { fps: 1, msInLevel: 99999 })).toBe(2);
    // 还没采到样本（0fps）不算卡死
    expect(nextQuality(0, { fps: 0, msInLevel: 9999 })).toBe(0);
  });

  it("档位：dpr 2 / 1.5 / 1，目标 30/30/20，仅 L2 加 20fps 渲染上限", () => {
    expect([dprCapOf(0), dprCapOf(1), dprCapOf(2)]).toEqual([2, 1.5, 1]);
    expect([targetFpsOf(0), targetFpsOf(1), targetFpsOf(2)]).toEqual([30, 30, 20]);
    expect([renderFpsCapOf(0), renderFpsCapOf(1), renderFpsCapOf(2)]).toEqual([0, 0, 20]);
  });

  it("像素比 = dpr × zf，硬上限 2", () => {
    expect(pixelRatioFor(2, 1, 0)).toBe(2);
    expect(pixelRatioFor(2, 1, 1)).toBe(1.5);
    expect(pixelRatioFor(2, 1, 2)).toBe(1);
    expect(pixelRatioFor(4, 1, 0)).toBe(2);
    expect(pixelRatioFor(1.5, 0.8, 0)).toBeCloseTo(1.2);
    expect(pixelRatioFor(1, 0.6, 0)).toBe(1);
  });
});
