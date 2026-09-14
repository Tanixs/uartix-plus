/**
 * P71 椭球拟合测试。
 * 核心：合成椭球 + 高斯噪声 → 参数恢复（功能性判据：校正后半径 CV/均值）；
 * 大数值条件（ADC 量级 1e4）；退化拒绝（共面/半球/点数不足）；八象限覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  correctedRadius,
  fitAccelSix,
  fitEllipsoid,
  grade,
  octantCoverage,
  type Accel6Face,
  type CalibPts,
} from "./ellipsoidFit";

/** mulberry32 确定性伪随机（测试可复现） */
function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 高斯 */
function gaussOf(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** 均匀球面方向（Gauss 三元组归一化） */
function sphereDirs(n: number, seed: number): [number, number, number][] {
  const rand = rng32(seed);
  const g = gaussOf(rand);
  const out: [number, number, number][] = [];
  while (out.length < n) {
    const x = g();
    const y = g();
    const z = g();
    const l = Math.hypot(x, y, z);
    if (l > 1e-6) out.push([x / l, y / l, z / l]);
  }
  return out;
}

/** Rodrigues 旋转矩阵（绕单位轴 axis 转 ang 弧度） */
function rotAxis(axis: [number, number, number], ang: number): number[][] {
  const [x, y, z] = axis;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

/** 合成采样点：p = offset + R·diag(axes)·u + σ·ā·噪声 */
function synth(
  offset: [number, number, number],
  axes: [number, number, number],
  R: number[][],
  noiseSigma: number,
  n: number,
  seed = 42,
): CalibPts {
  const dirs = sphereDirs(n, seed);
  const rand = rng32(seed + 1);
  const g = gaussOf(rand);
  const aMean = (axes[0] + axes[1] + axes[2]) / 3;
  const pts: CalibPts = { x: [], y: [], z: [] };
  for (const u of dirs) {
    // R·diag(axes)·u
    const e = [
      R[0][0] * axes[0] * u[0] + R[0][1] * axes[1] * u[1] + R[0][2] * axes[2] * u[2],
      R[1][0] * axes[0] * u[0] + R[1][1] * axes[1] * u[1] + R[1][2] * axes[2] * u[2],
      R[2][0] * axes[0] * u[0] + R[2][1] * axes[1] * u[1] + R[2][2] * axes[2] * u[2],
    ];
    pts.x.push(offset[0] + e[0] + g() * noiseSigma * aMean);
    pts.y.push(offset[1] + e[1] + g() * noiseSigma * aMean);
    pts.z.push(offset[2] + e[2] + g() * noiseSigma * aMean);
  }
  return pts;
}

/** 功能性判据：校正后半径均值≈ā 且 CV 达标 */
function correctedStats(pts: CalibPts, W: number[][], offset: [number, number, number]) {
  let s1 = 0;
  let s2 = 0;
  const n = Math.min(pts.x.length, pts.y.length, pts.z.length);
  for (let i = 0; i < n; i++) {
    const dx = pts.x[i] - offset[0];
    const dy = pts.y[i] - offset[1];
    const dz = pts.z[i] - offset[2];
    const r = Math.hypot(
      W[0][0] * dx + W[0][1] * dy + W[0][2] * dz,
      W[1][0] * dx + W[1][1] * dy + W[1][2] * dz,
      W[2][0] * dx + W[2][1] * dy + W[2][2] * dz,
    );
    s1 += r;
    s2 += r * r;
  }
  const mean = s1 / n;
  const cv = Math.sqrt(Math.max(0, s2 / n - mean * mean)) / mean;
  return { mean, cv };
}

describe("octantCoverage", () => {
  it("空=0；单卦限=1；4 卦限=4；全向=8", () => {
    expect(octantCoverage({ x: [], y: [], z: [] })).toBe(0);
    // 全部点重合 → 全部 tie 归同一卦限
    const one: CalibPts = { x: [5, 5, 5], y: [7, 7, 7], z: [9, 9, 9] };
    expect(octantCoverage(one)).toBe(1);
    // +x/+y 与 -x/+y 平面内 → 4 卦限
    const four: CalibPts = {
      x: [1, -1, 2, -2],
      y: [1, 1, 2, 2],
      z: [0, 0, 1, -1],
    };
    expect(octantCoverage(four)).toBe(4);
    const full = synth([0, 0, 0], [100, 100, 100], rotAxis([0, 0, 1], 0), 0, 2000);
    expect(octantCoverage(full)).toBe(8);
  });
});

describe("fitEllipsoid 参数恢复", () => {
  it("球面：offset 回收 <1% ā，gains≈1，校正后 CV<3%", () => {
    const offset: [number, number, number] = [50, -30, 20];
    const pts = synth(offset, [100, 100, 100], rotAxis([0, 0, 1], 0), 0.005, 2000);
    const r = fitEllipsoid(pts);
    if (!r.ok) throw new Error(`拟合失败: ${r.reason}`);
    expect(r.n).toBe(2000);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.offset[i] - offset[i])).toBeLessThan(3); // 3% ā 容差（含噪声 0.5% 应远小于此）
      expect(Math.abs(r.gains[i] - 1)).toBeLessThan(0.03);
    }
    const st = correctedStats(pts, r.matrix, r.offset);
    expect(st.cv).toBeLessThan(0.03);
    expect(r.cv).toBeLessThan(0.03);
    expect(grade(r.cv)).toBe("优");
  });

  it("三轴畸变椭球：gains 回收 ā/aᵢ（±3%），轴长回收", () => {
    const axes: [number, number, number] = [80, 100, 130];
    const pts = synth([0, 0, 0], axes, rotAxis([0, 0, 1], 0), 0.005, 2000);
    const r = fitEllipsoid(pts);
    if (!r.ok) throw new Error(`拟合失败: ${r.reason}`);
    const aMean = (axes[0] + axes[1] + axes[2]) / 3;
    // 拟合轴长升序（λ 升序 → 轴降序），与合成轴降序对应
    const axesSorted = [...axes].sort((a, b) => b - a);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.axes[i] - axesSorted[i])).toBeLessThan(aMean * 0.03);
      const g = aMean / axesSorted[i];
      expect(Math.abs(r.gains[i] - g)).toBeLessThan(0.04);
    }
    const st = correctedStats(pts, r.matrix, r.offset);
    expect(st.cv).toBeLessThan(0.03);
  });

  it("旋转椭球（绕 (1,1,1) 轴 30°）：功能性 CV<3%（矩阵非对角项显著）", () => {
    const R = rotAxis([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], Math.PI / 6);
    const pts = synth([12, -8, 30], [90, 110, 125], R, 0.005, 2500, 7);
    const r = fitEllipsoid(pts);
    if (!r.ok) throw new Error(`拟合失败: ${r.reason}`);
    // 旋转椭球 → 对称矩阵非对角项不可忽略
    const offDiag =
      Math.abs(r.matrix[0][1]) + Math.abs(r.matrix[0][2]) + Math.abs(r.matrix[1][2]);
    expect(offDiag).toBeGreaterThan(0.01);
    const st = correctedStats(pts, r.matrix, r.offset);
    expect(st.cv).toBeLessThan(0.03);
    // 正交性
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = r.rot[i][0] * r.rot[j][0] + r.rot[i][1] * r.rot[j][1] + r.rot[i][2] * r.rot[j][2];
        expect(Math.abs(dot - (i === j ? 1 : 0))).toBeLessThan(1e-6);
      }
    }
  });

  it("大数值条件（ADC 1e4 量级，含大偏置）：仍收敛且 offset 回收", () => {
    const offset: [number, number, number] = [10000, -8000, 500];
    const pts = synth(offset, [1500, 1500, 1500], rotAxis([0, 0, 1], 0), 0.005, 2000, 11);
    const r = fitEllipsoid(pts);
    if (!r.ok) throw new Error(`拟合失败: ${r.reason}`);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.offset[i] - offset[i])).toBeLessThan(1500 * 0.03);
    }
    const st = correctedStats(pts, r.matrix, r.offset);
    expect(st.cv).toBeLessThan(0.03);
  });
});

describe("fitEllipsoid 退化拒绝", () => {
  it("点数不足 → 拒绝", () => {
    const r = fitEllipsoid({ x: [1, 2], y: [1, 2], z: [1, 2] });
    expect(r.ok).toBe(false);
  });

  it("共面点（z 恒定）→ 拒绝", () => {
    const dirs = sphereDirs(1500, 3);
    const pts: CalibPts = { x: [], y: [], z: [] };
    for (const u of dirs) {
      pts.x.push(1000 * u[0]);
      pts.y.push(1000 * u[1]);
      pts.z.push(500); // 恒定 → 共面
    }
    const r = fitEllipsoid(pts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("覆盖不足");
  });

  it("半球采样 → 主轴单侧门拒绝（半球相对自身质心占满 8 卦限，象限门不触发，由单侧门兜底）", () => {
    const dirs = sphereDirs(2000, 5).filter((u) => u[2] > 0.02); // 仅上半球
    const pts: CalibPts = { x: [], y: [], z: [] };
    for (const u of dirs) {
      pts.x.push(100 * u[0] + 30);
      pts.y.push(100 * u[1] - 20);
      pts.z.push(100 * u[2] + 10);
    }
    const r = fitEllipsoid(pts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("覆盖不足");
  });

  it("meanR 输出：≈合成均值半径（预览/参考球基准）", () => {
    const pts = synth([0, 0, 0], [100, 100, 100], rotAxis([0, 0, 1], 0), 0.005, 2000);
    const r = fitEllipsoid(pts);
    if (!r.ok) throw new Error(`拟合失败: ${r.reason}`);
    expect(Math.abs(r.meanR - 100) / 100).toBeLessThan(0.01);
    // correctedRadius 与 correctedStats 均值一致
    let s = 0;
    for (let i = 0; i < pts.x.length; i++) s += correctedRadius(pts.x[i], pts.y[i], pts.z[i], r);
    expect(Math.abs(s / pts.x.length - r.meanR)).toBeLessThan(1e-6);
  });
});

describe("fitAccelSix 六面法（P73）", () => {
  /** 合成六面：真值 offset/scale（原始单位/g），gRef=1；面序 +X,−X,+Y,−Y,+Z,−Z 朝上 */
  function synthFaces(
    offset: [number, number, number],
    scale: [number, number, number],
    noise = 0.05,
    seed = 42,
  ): Accel6Face[] {
    const rand = rng32(seed);
    const g = gaussOf(rand);
    const face = (dom: 0 | 1 | 2, sign: 1 | -1): Accel6Face => {
      const m: [number, number, number] = [offset[0], offset[1], offset[2]];
      m[dom] = offset[dom] + sign * scale[dom];
      return {
        mean: [m[0] + g() * noise, m[1] + g() * noise, m[2] + g() * noise],
        std: [noise, noise, noise],
        n: 240,
      };
    };
    return [face(0, 1), face(0, -1), face(1, 1), face(1, -1), face(2, 1), face(2, -1)];
  }

  it("参数恢复：offset/gain/scale 误差远小于噪声量级，CV_s 与 faceDev 达标", () => {
    const offset: [number, number, number] = [50, -30, 20];
    const scale: [number, number, number] = [100, 102, 98];
    const r = fitAccelSix(synthFaces(offset, scale));
    if (!r.ok) throw new Error(`解算失败: ${r.reason}`);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.offset[i] - offset[i])).toBeLessThan(0.5); // 噪声 0.05 → 远小于 0.5
      expect(Math.abs(r.scales[i] - scale[i])).toBeLessThan(0.5);
      expect(Math.abs(r.gains[i] - 1 / scale[i])).toBeLessThan(1e-4);
    }
    expect(r.cvScale).toBeLessThan(0.03);
    expect(r.faceDev).toBeLessThan(0.02);
    expect(r.grade).toBe("优");
  });

  it("单位换算：gRef=9.80665 时 scale 回收为原始单位/g", () => {
    const G = 9.80665;
    const offset: [number, number, number] = [0, 0, 0];
    const scale: [number, number, number] = [512, 512, 512]; // 原始单位/g
    const faces = synthFaces(offset, scale).map((f) => ({
      mean: [f.mean[0] * G, f.mean[1] * G, f.mean[2] * G] as [number, number, number],
      std: [f.std[0] * G, f.std[1] * G, f.std[2] * G] as [number, number, number],
      n: f.n,
    }));
    const r = fitAccelSix(faces, G);
    if (!r.ok) throw new Error(`解算失败: ${r.reason}`);
    for (let i = 0; i < 3; i++) expect(Math.abs(r.scales[i] - scale[i])).toBeLessThan(0.5);
  });

  it("拒绝：样本不足 / 未静止（σ 超标）/ 顺序错（两面均值差≈0）", () => {
    const base = synthFaces([0, 0, 0], [100, 100, 100]);
    // 样本不足
    const few = base.map((f, i) => (i === 3 ? { ...f, n: 10 } : f));
    const r1 = fitAccelSix(few);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain("样本不足");
    // 未静止：σ 抬到尺度均值 5% 以上
    const shaky = base.map((f, i) => (i === 2 ? { ...f, std: [10, 10, 10] as [number, number, number] } : f));
    const r2 = fitAccelSix(shaky);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("抖动过大");
    // 顺序错：+Y 面采成 -Y（两面均值差≈0）
    const swapped = base.map((f, i) => {
      if (i === 2) return { ...base[3] }; // +Y 面用了 −Y 的数据
      if (i === 3) return { ...base[2] };
      return f;
    });
    const r3 = fitAccelSix(swapped);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toContain("均值差异常");
    // 面数不对
    expect(fitAccelSix(base.slice(0, 5)).ok).toBe(false);
  });
});
