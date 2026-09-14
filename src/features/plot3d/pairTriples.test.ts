/**
 * P75 B2：三轴配对纯函数测试。
 * 核心回归：同帧三轴（相同时间戳）→ 每锚点恰 1 点（阶梯根因）；
 * 以及插值/最近邻/容差/前向填充/水位边界。
 */
import { describe, expect, it } from "vitest";
import {
  autoTolMs,
  buildPairedTriples,
  ffillAt,
  lowerBoundGt,
  medianInterval,
  sampleAt,
  type Series,
} from "./pairTriples";

const S = (t: number[], v: number[]): Series => ({ t, v });

describe("medianInterval / autoTolMs", () => {
  it("中位数间隔：取末尾窗口；样本不足 → Infinity", () => {
    expect(medianInterval([])).toBe(Infinity);
    expect(medianInterval([5])).toBe(Infinity);
    expect(medianInterval([0, 10, 20, 31])).toBe(10); // [10,10,11] → 中位 10
    expect(medianInterval([0, 10, 20, 45])).toBe(10); // [10,10,25] → 中位 10
  });

  it("autoTol = max(1.5·Ix, 0.75·Iy, 0.75·Iz)；任一序列无法估计 → Infinity", () => {
    const x = S([0, 10, 20, 30], [0, 0, 0, 0]);
    const y = S([0, 20, 40], [0, 0, 0]);
    const z = S([0, 10, 20, 30], [0, 0, 0, 0]);
    expect(autoTolMs(x, y, z)).toBeCloseTo(15); // max(15, 15, 11.25)
    expect(autoTolMs(x, S([1], []), z)).toBe(Infinity);
  });
});

describe("sampleAt / ffillAt", () => {
  const s = S([0, 10, 20], [0, 10, 20]);

  it("头部无数据 → null；尾沿保持末值（不受容差约束）", () => {
    expect(sampleAt(s, -1, "interp", 5)).toBeNull();
    expect(sampleAt(s, 20, "interp", 0.0001)).toBe(20);
    expect(sampleAt(s, 999, "nearest", 0.0001)).toBe(20);
  });

  it("插值：宽间隙中段（两端都超容差）→ null；靠近一端按近端放行并线性插值", () => {
    expect(sampleAt(s, 15, "interp", 3)).toBeNull(); // min(5,5)=5 > 3
    expect(sampleAt(s, 12, "interp", 3)).toBeCloseTo(12); // dL=2 ≤ 3
    expect(sampleAt(s, 18, "interp", 3)).toBeCloseTo(18); // dR=2 ≤ 3
  });

  it("最近邻：平手取左（前向填充口径）", () => {
    expect(sampleAt(s, 5, "nearest", 6)).toBe(0); // dL=5=dR → 左
    expect(sampleAt(s, 6, "nearest", 6)).toBe(10); // dR=4 < dL=6 → 右
  });

  it("重复时间戳：精确命中取该值；span=0 不除零", () => {
    const dup = S([0, 10, 10, 20], [0, 1, 2, 3]);
    expect(sampleAt(dup, 10, "interp", 1)).toBe(2); // 命中最后一个 ≤ 10
    expect(sampleAt(dup, 15, "interp", 5)).toBeCloseTo(2.5); // [10,20] 括弧
  });

  it("ffillAt：严格前向填充；早于首样本 → null", () => {
    expect(ffillAt(s, -1)).toBeNull();
    expect(ffillAt(s, 0)).toBe(0);
    expect(ffillAt(s, 15)).toBe(10);
    expect(ffillAt(s, 999)).toBe(20);
  });

  it("lowerBoundGt：非严格递增也正确", () => {
    expect(lowerBoundGt([1, 2, 2, 3], 0)).toBe(0);
    expect(lowerBoundGt([1, 2, 2, 3], 2)).toBe(3);
    expect(lowerBoundGt([1, 2, 2, 3], 3)).toBe(4);
    expect(lowerBoundGt([], 1)).toBe(0);
  });
});

describe("buildPairedTriples", () => {
  it("回归：同帧三轴（相同时间戳）→ 每锚点恰 1 点、零跳过（阶梯根因）", () => {
    // 6 帧同 ts：旧联合对齐会拆成 18 行阶梯；配对后必须 6 个平滑点
    const r = buildPairedTriples(
      S([0, 10, 20, 30, 40, 50], [1, 2, 3, 4, 5, 6]),
      S([0, 10, 20, 30, 40, 50], [11, 12, 13, 14, 15, 16]),
      S([0, 10, 20, 30, 40, 50], [21, 22, 23, 24, 25, 26]),
      { mode: "interp", tolMs: 0 },
    );
    expect(r.t).toEqual([0, 10, 20, 30, 40, 50]);
    expect(r.x).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.y).toEqual([11, 12, 13, 14, 15, 16]);
    expect(r.z).toEqual([21, 22, 23, 24, 25, 26]);
    expect(r.skipped).toBe(0);
    expect(r.endT).toBe(50);
  });

  it("interp：Y 半频（每 2 锚 1 样本）→ 中间锚点线性插值、尾沿保持", () => {
    const r = buildPairedTriples(
      S([0, 10, 20, 30], [0, 1, 2, 3]),
      S([0, 20], [0, 2]),
      S([0, 10, 20, 30], [0, 1, 2, 3]),
      { mode: "interp", tolMs: 0 }, // auto：max(15, 15, 11.25) = 15
    );
    expect(r.y).toEqual([0, 1, 2, 2]); // t=10 插值 1；t=30 ≥ 末样本 20 → 保持 2
    expect(r.skipped).toBe(0);
  });

  it("容差外跳过：稀疏 Y + 手动小容差 → 中段全部丢弃并计数", () => {
    const r = buildPairedTriples(
      S([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      S([0, 100], [0, 1]),
      S([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      { mode: "nearest", tolMs: 5 },
    );
    expect(r.t).toEqual([0]); // 仅 t=0 精确命中；10..90 两侧距离 ≥10 > 5；无尾沿
    expect(r.skipped).toBe(9);
  });

  it("union：旧版口径——并集 + 前向填充（含 Y 独有行），水位按原始 ts 过滤", () => {
    const y = S([0, 100], [0, 1]);
    const x = S([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const z = S([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = buildPairedTriples(x, y, z, { mode: "union", tolMs: 0, sinceT: -Infinity });
    // 并集 = [0,10..90,100] 共 11 行；Y 前向填充：10..90 拿 Y(0)（旧版阶梯来源），100 拿 Y(1)
    expect(r.t).toHaveLength(11);
    expect(r.y).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(r.skipped).toBe(0);
    expect(r.endT).toBe(100);
    // 水位 sinceT=50：只产出原始 ts > 50 的行（60..90,100）
    const r2 = buildPairedTriples(x, y, z, { mode: "union", tolMs: 0, sinceT: 50 });
    expect(r2.t).toHaveLength(5);
    expect(r2.y).toEqual([0, 0, 0, 0, 1]);
  });

  it("interp：锚点早于 Y 首样本 → 跳过（头部不编造）", () => {
    const r = buildPairedTriples(
      S([0, 10, 20, 30], [0, 1, 2, 3]),
      S([20, 30], [2, 3]),
      S([0, 10, 20, 30], [0, 1, 2, 3]),
      { mode: "interp", tolMs: 0 },
    );
    expect(r.t).toEqual([20, 30]);
    expect(r.y).toEqual([2, 3]);
    expect(r.skipped).toBe(2);
  });

  it("interp：水位续传——sinceT 之后才产出；空段 endT 仍推进（幂等）", () => {
    const x = S([0, 10, 20, 30], [0, 1, 2, 3]);
    const y = S([0, 10, 20, 30], [0, 1, 2, 3]);
    const z = S([0, 10, 20, 30], [0, 1, 2, 3]);
    const r1 = buildPairedTriples(x, y, z, { mode: "interp", tolMs: 0, sinceT: -Infinity });
    expect(r1.t).toEqual([0, 10, 20, 30]);
    const r2 = buildPairedTriples(x, y, z, { mode: "interp", tolMs: 0, sinceT: 30 });
    expect(r2.t).toEqual([]);
    expect(r2.skipped).toBe(0);
    expect(r2.endT).toBe(30); // 幂等：水位不回退
  });

  it("Y/Z 空序列 → 全部锚点跳过；endT 仍为 X 末点", () => {
    const r = buildPairedTriples(
      S([0, 10], [0, 1]),
      S([], []),
      S([], []),
      { mode: "interp", tolMs: 0 },
    );
    expect(r.t).toEqual([]);
    expect(r.skipped).toBe(2);
    expect(r.endT).toBe(10);
  });
});
