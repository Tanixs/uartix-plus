/**
 * P152 前置件：填色百分比的算法。
 * 之所以单独钉：这枚变量是"滑杆已走那段"的唯一事实，算错了不报错、只是颜色不对——
 * 那种错在截图里长得像"主题没生效"，会被追到主题层去查（P146 就是这么绕了一圈的）。
 */
import { describe, expect, it } from "vitest";
import { RANGE_FILL_VAR, rangePct, rangeStyle } from "./rangeFill";

describe("rangePct", () => {
  it("常规档：0/50/100 落在 0/50/100", () => {
    expect(rangePct(0, 0, 100)).toBe(0);
    expect(rangePct(50, 0, 100)).toBe(50);
    expect(rangePct(100, 0, 100)).toBe(100);
  });

  it("非零下限与负区间（本仓真有这种滑杆：偏移 -1 ~ 1、缩放 0.5 ~ 4）", () => {
    expect(rangePct(0, -1, 1)).toBe(50);
    expect(rangePct(2, 0.5, 4)).toBeCloseTo(42.857, 2);
    expect(rangePct(20, 10, 30)).toBe(50);
  });

  it("越界钳住、算不出来给 0，不猜一个中间值", () => {
    expect(rangePct(999, 0, 100)).toBe(100);
    expect(rangePct(-5, 0, 100)).toBe(0);
    expect(rangePct(Number.NaN, 0, 100)).toBe(0);
    expect(rangePct(5, 7, 7)).toBe(0);
  });

  it("rangeStyle 用的是那枚变量名，且值是字符串（CSS 变量不接数字字面量）", () => {
    const st = rangeStyle(30, 0, 100);
    expect(st[RANGE_FILL_VAR as keyof typeof st]).toBe("30");
    expect(Object.keys(rangeStyle(1, 0, 2))).toEqual([RANGE_FILL_VAR]);
  });
});
