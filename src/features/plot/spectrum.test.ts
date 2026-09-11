import { describe, expect, it } from "vitest";
import {
  amplitudeSpectrum,
  fftRadix2,
  histogram,
  hannWindow,
  nextPow2,
  resampleUniform,
  topPeaks,
} from "./spectrum";

/** 参考实现：O(n²) DFT（小规模对照用） */
function dftMag(x: number[]): number[] {
  const n = x.length;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ang = (-2 * Math.PI * k * i) / n;
      re += x[i] * Math.cos(ang);
      im += x[i] * Math.sin(ang);
    }
    out.push(Math.hypot(re, im));
  }
  return out;
}

describe("fftRadix2", () => {
  it("与 O(n²) DFT 对照一致（n=64 随机信号）", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < n; i++) re[i] = rnd();
    const ref = dftMag(Array.from(re));
    fftRadix2(re, im);
    for (let k = 0; k < n; k++) {
      expect(Math.hypot(re[k], im[k])).toBeCloseTo(ref[k], 8);
    }
  });

  it("非 2 的幂抛错", () => {
    const re = new Float64Array(3);
    const im = new Float64Array(3);
    expect(() => fftRadix2(re, im)).toThrow();
  });
});

describe("resampleUniform", () => {
  it("输出等间隔且端点保持、fs 正确", () => {
    // 100Hz 等间隔 200 点（10ms 步长）
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < 200; i++) {
      t.push(i * 10);
      v.push(Math.sin((2 * Math.PI * 5 * i) / 100));
    }
    const rs = resampleUniform(t, v, 128);
    expect(rs).not.toBeNull();
    // fs 语义 = n 点覆盖输入跨度：(n-1)/span（amplitudeSpectrum 负责按原始率定跨度）
    expect(rs!.fs).toBeCloseTo((127 / 1990) * 1000, 6);
    expect(rs!.ys.length).toBe(128);
    expect(rs!.ys[0]).toBeCloseTo(v[0], 12);
    expect(rs!.ys[127]).toBeCloseTo(v[199], 12);
    // 等间隔：中点目标时间 1002.8ms → 原始 100/100.28 点线性插值（手工算期望值）
    const midT = (1990 * 64) / 127;
    const idx = midT / 10;
    const i0 = Math.floor(idx);
    const expectMid = v[i0] + (v[i0 + 1] - v[i0]) * (idx - i0);
    expect(rs!.ys[64]).toBeCloseTo(expectMid, 9);
  });

  it("抖动时间戳被吸收（±3ms 抖动下 fs 稳定）", () => {
    const t: number[] = [];
    const v: number[] = [];
    let jitter = 1;
    for (let i = 0; i < 500; i++) {
      jitter = (jitter * 48271) % 2147483647;
      t.push(i * 5 + ((jitter % 7) - 3)); // 200Hz ±3ms
      v.push(i);
    }
    const rs = resampleUniform(t, v, 256);
    expect(rs).not.toBeNull();
    // 抖动被插值吸收：fs≈(255/2495)*1000（理想 200 点跨度语义下 102.2）
    expect(rs!.fs).toBeCloseTo((255 / 2495) * 1000, 0);
    // 输出值单调（输入 v=i 单调递增，插值不得产生回退）
    for (let i = 1; i < rs!.ys.length; i++) {
      expect(rs!.ys[i]).toBeGreaterThanOrEqual(rs!.ys[i - 1]);
    }
  });

  it("重复时间戳段不产生 NaN", () => {
    const rs = resampleUniform([0, 10, 10, 10, 30], [1, 2, 3, 4, 5], 16);
    expect(rs).not.toBeNull();
    for (const y of rs!.ys) expect(Number.isFinite(y)).toBe(true);
  });

  it("数据不足/零跨度返回 null", () => {
    expect(resampleUniform([1], [1], 8)).toBeNull();
    expect(resampleUniform([5, 5, 5], [1, 2, 3], 8)).toBeNull();
    expect(resampleUniform([0, 10], [1, 2], 1)).toBeNull();
  });
});

describe("amplitudeSpectrum", () => {
  it("矩形窗：1kHz 正弦 @8kHz 采样 4096 点 → bin 512 精确命中，幅值≈1", () => {
    const fs = 8000;
    const n = 4096;
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push((i / fs) * 1000);
      v.push(Math.sin((2 * Math.PI * 1000 * i) / fs));
    }
    const sp = amplitudeSpectrum(t, v, { points: n, window: "rect" });
    expect(sp).not.toBeNull();
    expect(sp!.fs).toBeCloseTo(fs, 6);
    expect(sp!.binHz).toBeCloseTo(fs / n, 6);
    let best = 0;
    for (let k = 1; k < sp!.mags.length; k++) {
      if (sp!.mags[k] > sp!.mags[best]) best = k;
    }
    expect(best).toBe(512); // 1000Hz / (8000/4096) = 512（bin 中心，无泄漏）
    expect(sp!.mags[512]).toBeCloseTo(1, 2);
    expect(sp!.freqs[512]).toBeCloseTo(1000, 6);
  });

  it("Hann 窗幅值恢复：幅值 2.0 的正弦主峰≈2.0（泄漏 bin 下降）", () => {
    const fs = 8000;
    const n = 4096;
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push((i / fs) * 1000);
      v.push(2 * Math.sin((2 * Math.PI * 1000 * i) / fs));
    }
    const sp = amplitudeSpectrum(t, v, { points: n, window: "hann" });
    expect(sp).not.toBeNull();
    expect(sp!.mags[512]).toBeCloseTo(2, 1);
    // Hann 峰更瘦：主峰 bin 的能量占比高于矩形窗
    const totalHann = sp!.mags.reduce((a, b) => a + b, 0);
    expect(sp!.mags[512] / totalHann).toBeGreaterThan(0.28);
  });

  it("去均值：直流偏置不进入谱峰", () => {
    const fs = 8000;
    const n = 1024;
    const t: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push((i / fs) * 1000);
      v.push(100 + Math.sin((2 * Math.PI * 500 * i) / fs)); // DC=100
    }
    const sp = amplitudeSpectrum(t, v, { points: n, window: "rect" });
    expect(sp).not.toBeNull();
    expect(sp!.mags[0]).toBeLessThan(1e-6); // DC 被去均值消除
    let best = 1;
    for (let k = 2; k < sp!.mags.length; k++) {
      if (sp!.mags[k] > sp!.mags[best]) best = k;
    }
    expect(best).toBe(64); // 500Hz @ binHz=7.8125 → bin 64
  });

  it("点数非法返回 null", () => {
    expect(amplitudeSpectrum([0, 1], [0, 1], { points: 1000, window: "rect" })).toBeNull();
    expect(amplitudeSpectrum([0, 1], [0, 1], { points: 2, window: "rect" })).toBeNull();
  });
});

describe("histogram", () => {
  it("计数守恒 + bin 边界正确", () => {
    const v = [0, 0.9, 1, 1.1, 2, 2.9, 3];
    const h = histogram(v, 3);
    expect(h).not.toBeNull();
    expect(h!.counts.reduce((a, b) => a + b, 0)).toBe(v.length);
    expect(h!.edges[0]).toBe(0);
    expect(h!.edges[3]).toBe(3);
    expect(h!.counts[0]).toBe(2); // [0,1): 0, 0.9
    expect(h!.counts[1]).toBe(2); // [1,2): 1, 1.1
    expect(h!.counts[2]).toBe(3); // [2,3]: 2, 2.9, 3（末 bin 闭）
  });

  it("mean/std 与已知值一致", () => {
    const h = histogram([1, 2, 3, 4], 4);
    expect(h!.mean).toBe(2.5);
    expect(h!.std).toBeCloseTo(Math.sqrt(5 / 3), 12); // 样本 std
  });

  it("常数序列退化为单 bin", () => {
    const h = histogram([7, 7, 7], 40);
    expect(h).not.toBeNull();
    expect(h!.counts).toEqual([3]);
    expect(h!.min).toBe(7);
    expect(h!.max).toBe(7);
    expect(h!.std).toBe(0);
  });

  it("空数据返回 null", () => {
    expect(histogram([], 10)).toBeNull();
  });
});

describe("topPeaks", () => {
  it("两峰分离 + minSep 过滤近邻", () => {
    // 双峰 @ 100/500Hz（各为局部极大），100Hz 旁的 101Hz 是肩峰（非极大）
    const freqs = new Float64Array([0, 100, 101, 500, 900]);
    const mags = new Float64Array([0.01, 1.0, 0.2, 0.5, 0.02]);
    const peaks = topPeaks(freqs, mags, 3, 10);
    expect(peaks.length).toBe(2);
    expect(peaks[0].freq).toBe(100);
    expect(peaks[1].freq).toBe(500);
  });

  it("k 限制返回数量", () => {
    const freqs = new Float64Array([0, 10, 20, 30]);
    const mags = new Float64Array([0, 0.3, 0.9, 0.6]);
    expect(topPeaks(freqs, mags, 1, 1).length).toBe(1);
    expect(topPeaks(freqs, mags, 1, 1)[0].freq).toBe(20);
  });
});

describe("hannWindow / nextPow2", () => {
  it("Hann 窗端点趋 0、中点为 1（periodic 定义）", () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
  });
  it("nextPow2 向上取整且封顶", () => {
    expect(nextPow2(1000, 32768)).toBe(1024);
    expect(nextPow2(1024, 32768)).toBe(1024);
    expect(nextPow2(50000, 32768)).toBe(32768);
  });
});
