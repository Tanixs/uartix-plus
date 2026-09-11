/**
 * 频谱/直方图分析引擎（P65a）——纯函数、零依赖，全部可单测。
 *
 * 用途：频谱分析面板（SpectrumPanel）的数学层。
 *  - resampleUniform：帧时间戳 → 等间隔采样（帧间隔抖动根治，FFT 的前提）
 *  - fftRadix2：迭代式 radix-2 就地 FFT（n 必须为 2 的幂，调用方保证）
 *  - amplitudeSpectrum：单边幅度谱（Hann/矩形窗 + 幅值恢复 + 去均值）
 *  - histogram：等宽 bin 统计 + mean/std 摘要
 *  - topPeaks：主峰提取（局部极大 + 最小频率间隔）
 *
 * 设计红线：全部纯函数无状态；Float64Array 走数值缓冲，避免 GC 压力。
 */

/** 等间隔重采样：把 (t,v) 序列线性插值到 n 个等间隔点，覆盖 [t[0], t[n-1]]。
 *  返回 fs（Hz）与重采样值；t 需单调不减（plotStore 保证），重复时间戳取段末值。
 *  数据不足（<2 点）或时间跨度为 0 时返回 null。 */
export function resampleUniform(
  t: number[],
  v: number[],
  n: number,
): { fs: number; ys: number[] } | null {
  const m = Math.min(t.length, v.length);
  if (m < 2 || n < 2) return null;
  const t0 = t[0];
  const t1 = t[m - 1];
  const spanMs = t1 - t0;
  if (!(spanMs > 0)) return null;
  const ys = new Array<number>(n);
  let seg = 0; // 当前段索引：目标时间单调递增，指针只前进
  for (let i = 0; i < n; i++) {
    const target = t0 + (spanMs * i) / (n - 1);
    while (seg < m - 2 && t[seg + 1] < target) seg++;
    if (target <= t[0]) {
      ys[i] = v[0];
      continue;
    }
    if (target >= t1) {
      ys[i] = v[m - 1];
      continue;
    }
    const ta = t[seg];
    const tb = t[seg + 1];
    const dt = tb - ta;
    ys[i] = dt > 0 ? v[seg] + ((v[seg + 1] - v[seg]) * (target - ta)) / dt : v[seg + 1];
  }
  return { fs: ((n - 1) / spanMs) * 1000, ys };
}

/** Hann 窗（周期定义 periodic Hann：w[i]=0.5(1-cos(2πi/n))——FFT 分析惯例，
 *  峰值 1.0 落在 i=n/2，相干增益恰为 0.5） */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

/** 迭代式 radix-2 就地 FFT（Cooley-Tukey，位反转 + 蝶形）。
 *  n 必须为 2 的幂；正变换，无归一化。 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error("fftRadix2: n 必须为 2 的幂");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const brRaw = re[i + j + half];
        const biRaw = im[i + j + half];
        const br = brRaw * cr - biRaw * ci;
        const bi = brRaw * ci + biRaw * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + half] = ar - br;
        im[i + j + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface SpectrumResult {
  /** 频率轴（Hz），长度 n/2+1 */
  freqs: Float64Array;
  /** 单边幅度谱（原信号单位；窗幅值已恢复） */
  mags: Float64Array;
  /** 频率分辨率（Hz/bin） */
  binHz: number;
  /** 重采样采样率（Hz） */
  fs: number;
  /** 参与变换的点数 */
  n: number;
}

export interface SpectrumOpts {
  /** FFT 点数（2 的幂） */
  points: number;
  window: "hann" | "rect";
}

/** 单边幅度谱：按原始数据的局部平均采样率截取「n 点 @ fs」时长 → 等间隔重采样
 *  → 去均值 → 加窗 → FFT。
 *  关键：重采样率必须与原始率一致（跨度=(n-1)/fs，而非「末尾 n 个点的跨度」）——
 *  后者在 n 小于原始点数时会把 fs 压低到原始率以下，造成频谱混叠。
 *  去均值让直流偏置不主导幅度轴（DC bin 仍输出，≈0）；Hann 幅值按相干增益恢复。 */
export function amplitudeSpectrum(
  t: number[],
  v: number[],
  opts: SpectrumOpts,
): SpectrumResult | null {
  const n = opts.points;
  if (n < 4 || (n & (n - 1)) !== 0) return null;
  const m = Math.min(t.length, v.length);
  if (m < 2) return null;
  // 局部平均率：末尾 min(m, n) 个原始点的跨度（突发数据下全跨度平均会失真）
  const take = Math.min(m, n);
  const localSpan = t[m - 1] - t[m - take];
  if (!(localSpan > 0)) return null;
  const fs = ((take - 1) / localSpan) * 1000;
  // 目标分析时长 = (n-1)/fs；从末尾往回截（二分定位）。容差半个局部 dt：
  // startMs 的浮点误差（如 511.87500000000006-511.875=1e-13）会把 t[0] 排除在
  // 外，使跨度少一个采样点、fs 偏高 ~0.02%，主峰偏离 bin 中心产生伪泄漏
  const startMs = t[m - 1] - ((n - 1) / fs) * 1000;
  const dtHalf = localSpan / (take - 1) / 2;
  let lo = 0;
  let hi = m - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < startMs - dtHalf) lo = mid + 1;
    else hi = mid;
  }
  const ts = t.slice(lo);
  const vs = v.slice(lo);
  const rs = resampleUniform(ts, vs, n);
  if (!rs) return null;
  // 去均值
  let mean = 0;
  for (let i = 0; i < n; i++) mean += rs.ys[i];
  mean /= n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // 窗 + 幅值恢复因子（矩形=1；Hann 相干增益 = mean(w) ≈ 0.5）
  let gain = 1;
  if (opts.window === "hann") {
    const w = hannWindow(n);
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      wsum += w[i];
      re[i] = (rs.ys[i] - mean) * w[i];
    }
    gain = wsum / n;
  } else {
    for (let i = 0; i < n; i++) re[i] = rs.ys[i] - mean;
  }
  if (gain <= 0) gain = 1;
  fftRadix2(re, im);
  const half = n >> 1;
  const freqs = new Float64Array(half + 1);
  const mags = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    let mag = Math.hypot(re[k], im[k]) / n / gain;
    if (k !== 0 && k !== half) mag *= 2; // 单边谱：共轭对称能量折半回收
    freqs[k] = (k * rs.fs) / n;
    mags[k] = mag;
  }
  return { freqs, mags, binHz: rs.fs / n, fs: rs.fs, n };
}

export interface HistogramResult {
  /** bin 边界（长度 bins+1，单调递增） */
  edges: number[];
  /** 各 bin 计数（长度 bins；左闭右开，末 bin 闭） */
  counts: number[];
  min: number;
  max: number;
  mean: number;
  std: number;
  n: number;
}

/** 等宽直方图：值落入 [edge_i, edge_{i+1})，末 bin 闭（含 max）。
 *  常数序列（min==max）退化为单 bin。数据为空返回 null。std 为样本标准差。 */
export function histogram(v: number[], bins: number): HistogramResult | null {
  const n = v.length;
  if (n === 0 || bins < 1) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = v[i] - mean;
    ss += d * d;
  }
  const std = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const nb = min === max ? 1 : bins;
  const width = (max - min) / nb;
  const edges = new Array<number>(nb + 1);
  for (let i = 0; i <= nb; i++) edges[i] = min + width * i;
  edges[nb] = max; // 末边界精确等于 max（浮点累加误差兜底）
  const counts = new Array<number>(nb).fill(0);
  for (let i = 0; i < n; i++) {
    let k = min === max ? 0 : Math.floor((v[i] - min) / width);
    if (k >= nb) k = nb - 1; // v==max 落末 bin
    counts[k]++;
  }
  return { edges, counts, min, max, mean, std, n };
}

export interface Peak {
  freq: number;
  mag: number;
}

/** 主峰提取：局部极大（跳过 DC bin）→ 按幅值降序 → 频率间隔 ≥ minSepHz 去重 → 前 k 个 */
export function topPeaks(
  freqs: Float64Array,
  mags: Float64Array,
  k: number,
  minSepHz: number,
): Peak[] {
  const n = mags.length;
  const cand: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) {
      cand.push({ freq: freqs[i], mag: mags[i] });
    }
  }
  cand.sort((a, b) => b.mag - a.mag);
  const out: Peak[] = [];
  for (const p of cand) {
    if (out.length >= k) break;
    if (out.every((q) => Math.abs(q.freq - p.freq) >= minSepHz)) out.push(p);
  }
  return out;
}

/** 最近似且 ≥ n 的 2 的幂（上限 cap） */
export function nextPow2(n: number, cap: number): number {
  let p = 4;
  while (p < n && p < cap) p <<= 1;
  return p;
}
