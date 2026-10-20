import { describe, expect, it } from "vitest";
import { hexSliceCovers } from "./hexCoverage";

const sl = (start: number, total: number, len: number) => ({
  start,
  total,
  bytes: { length: len },
});

describe("hexSliceCovers", () => {
  it("持续收流时旧切片仍覆盖可视区（total 增长不作废）", () => {
    expect(hexSliceCovers(sl(1000, 5000, 3000), 2000, 3500, 6000)).toBe(true);
  });

  it("切片尾部不够时重取", () => {
    expect(hexSliceCovers(sl(1000, 5000, 3000), 2000, 4500, 6000)).toBe(false);
  });

  it("请求起点早于切片起点时重取", () => {
    expect(hexSliceCovers(sl(2000, 5000, 3000), 1500, 2500, 6000)).toBe(false);
  });

  it("total 回退（清空/复位）时重取", () => {
    expect(hexSliceCovers(sl(1000, 5000, 3000), 0, 500, 0)).toBe(false);
  });

  it("无切片时重取", () => {
    expect(hexSliceCovers(null, 0, 500, 1000)).toBe(false);
  });
});
