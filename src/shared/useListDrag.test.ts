import { describe, expect, it } from "vitest";
import { pickRow, type RowBand } from "./useListDrag";

const band = (top: number, bottom: number): RowBand => ({ top, bottom });

describe("pickRow（拖拽 Y 带命中，P75 B3）", () => {
  it("空列表 / 空隙过大返回 null", () => {
    expect(pickRow([], 100)).toBeNull();
    // 两行之间 40px 空隙（组卡之间），超容差
    expect(pickRow([band(0, 50), band(90, 140)], 70)).toBeNull();
    // 悬在所有行之外（上方/下方远处）
    expect(pickRow([band(100, 150)], 50)).toBeNull();
    expect(pickRow([band(100, 150)], 200)).toBeNull();
  });

  it("行内命中：ratio 按比例取值", () => {
    const bands = [band(100, 200)];
    expect(pickRow(bands, 100)).toEqual({ index: 0, ratio: 0 });
    expect(pickRow(bands, 200)).toEqual({ index: 0, ratio: 1 });
    expect(pickRow(bands, 125)).toEqual({ index: 0, ratio: 0.25 });
    expect(pickRow(bands, 176)).toEqual({ index: 0, ratio: 0.76 });
  });

  it("多行命中定位到正确行（二分）", () => {
    const bands = [band(0, 30), band(30, 60), band(60, 90), band(90, 120), band(120, 150)];
    expect(pickRow(bands, 45)).toEqual({ index: 1, ratio: 0.5 });
    expect(pickRow(bands, 119)).toEqual({ index: 3, ratio: 29 / 30 });
    expect(pickRow(bands, 0)).toEqual({ index: 0, ratio: 0 });
  });

  it("行间小空隙吸附到最近行（ratio 顶/底）", () => {
    // 8px 空隙：中点两侧分别贴上行底 / 下行顶
    const bands = [band(0, 50), band(58, 108)];
    expect(pickRow(bands, 51)).toEqual({ index: 0, ratio: 1 });
    expect(pickRow(bands, 54)).toEqual({ index: 0, ratio: 1 }); // 中点打平（dPrev <= dNext）归前行
    expect(pickRow(bands, 55)).toEqual({ index: 1, ratio: 0 });
    expect(pickRow(bands, 56)).toEqual({ index: 1, ratio: 0 });
    expect(pickRow(bands, 57)).toEqual({ index: 1, ratio: 0 });
    // 14px 空隙（恰好容差内）两侧均可吸附
    const wide = [band(0, 50), band(64, 108)];
    expect(pickRow(wide, 57)).toEqual({ index: 0, ratio: 1 });
    expect(pickRow(wide, 63)).toEqual({ index: 1, ratio: 0 });
    // 超容差丢弃已由首个用例（40px 组卡间空隙）覆盖
  });

  it("列表首尾外侧的近距吸附", () => {
    const bands = [band(100, 150)];
    expect(pickRow(bands, 90)).toEqual({ index: 0, ratio: 0 });
    expect(pickRow(bands, 160)).toEqual({ index: 0, ratio: 1 });
    expect(pickRow(bands, 80)).toBeNull(); // 20px 超默认容差
  });

  it("高度退化为 0 的行不会除零", () => {
    const bands = [band(50, 50)];
    expect(pickRow(bands, 50)).toEqual({ index: 0, ratio: 0 });
    expect(pickRow(bands, 60)).toEqual({ index: 0, ratio: 1 });
  });
});
