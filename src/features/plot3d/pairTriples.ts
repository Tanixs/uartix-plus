/**
 * P75 B2：三轴时间戳配对纯函数（无副作用、无全局状态，可单测）。
 *
 * 背景（阶梯根因）：3D 轨迹此前消费 plotStore 的联合对齐时间轴
 * fullAlignedRaw()——多路归并时同帧的 AX/AY/AZ（时间戳相同）被 `t <= last →
 * +0.001ms` 递进拆成 3 行，前向填充使每行只有「一个轴」在新值上移动，
 * 其余两轴是上一帧的陈旧值 → 轨迹呈横平竖直的 L 形阶梯。
 *
 * 方案：绕开联合对齐，直接消费各通道原始序列（getChanData），以 X 轴时间轴
 * 为锚，把 Y/Z 按「带容差的插值 / 最近邻」配对到每个锚点上：
 * - interp（默认）：在 Y/Z 的括弧区间内线性插值，但要求至少一端真实样本落在
 *   容差内（min(dL,dR) ≤ tol）——宽间隙中点不编造数据；
 * - nearest：取更近一侧的真实样本（同样受容差约束）；
 * - union：旧版口径逃生舱——三序列时间轴并集 + 各列前向填充（阶梯会回来，
 *   仅用于对照/兼容）。
 * 容差 tolMs ≤ 0 表示自动：max(1.5·Iₓ, 0.75·Iᵧ, 0.75·I_z)（各序列最近 512 个
 * 间隔的中位数）；任一序列样本不足 2 个 → 不做容差拒绝。
 *
 * 边界约定（三种模式一致）：
 * - 锚点早于 Y/Z 首个样本 → 跳过（头部无数据不编造坐标）；
 * - 锚点晚于 Y/Z 末个样本 → 保持末值（实时流尾沿常态，不做容差拒绝，
 *   否则高频 X + 低频 Y 的尾沿会永久丢点）；
 * - 水位 sinceT：interp/nearest 按 X 原始时间戳过滤锚点；union 按原始时间
 *   （bump 前）过滤行——避免 bump 链导致的重复/漏行。
 */

export interface Series {
  /** 原始时间戳（毫秒，非严格递增；同帧字段可能重复） */
  t: number[];
  /** 工程值（与 t 等长） */
  v: number[];
}

export type PairMode = "interp" | "nearest" | "union";

export interface PairOptions {
  mode: PairMode;
  /** 配对容差（毫秒）；≤0 = 自动（按三序列间隔节奏推算） */
  tolMs: number;
  /** 水位：只产出原始时间戳 > sinceT 的锚点/并集行（首次传 -Infinity） */
  sinceT?: number;
}

export interface PairResult {
  /** 产出点（t 为原始毫秒：interp/nearest = 锚点 ts；union = bump 后并集 ts） */
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  /** 因容差外/头部无数据而丢弃的锚点（union：任一列前向填充仍为 null 的行） */
  skipped: number;
  /** 实际生效容差（自动解析后；union 恒 0） */
  tolMs: number;
  /** 已消费到的源末点（interp/nearest = X 末锚点；union = 三序列原始末点最大值）；空源 = -Infinity */
  endT: number;
}

/** 第一个 > v 的下标（t 非严格递增也可用：跳过所有 ≤ v） */
export function lowerBoundGt(t: number[], v: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 末尾 window 个间隔的中位数；样本 <2 或全为非正间隔 → Infinity（无法估计节奏） */
export function medianInterval(t: number[], window = 512): number {
  const n = t.length;
  if (n < 2) return Infinity;
  const from = Math.max(1, n - window);
  const ds: number[] = [];
  for (let i = from; i < n; i++) {
    const d = t[i] - t[i - 1];
    if (d > 0) ds.push(d); // 忽略倒退/重复（防御异常源）
  }
  if (ds.length === 0) return Infinity;
  ds.sort((a, b) => a - b);
  return ds[ds.length >> 1];
}

/** 自动容差：锚点节奏从宽（1.5×），目标轴从宽 accommodated（0.75×各自间隔） */
export function autoTolMs(xs: Series, ys: Series, zs: Series): number {
  const ix = medianInterval(xs.t);
  const iy = medianInterval(ys.t);
  const iz = medianInterval(zs.t);
  if (!isFinite(ix) || !isFinite(iy) || !isFinite(iz)) return Infinity;
  return Math.max(ix * 1.5, iy * 0.75, iz * 0.75);
}

/**
 * 单序列采样：t 时刻的值（interp 线性 / nearest 阶跃），带容差支持判定。
 * 返回 null = 该时刻不可信（头部无数据 / 容差外）。
 */
export function sampleAt(
  s: Series,
  t: number,
  mode: "interp" | "nearest",
  tol: number,
): number | null {
  const n = s.t.length;
  if (n === 0) return null;
  if (t < s.t[0]) return null; // 头部无数据：不编造
  if (t >= s.t[n - 1]) return s.v[n - 1]; // 尾沿：保持末值（实时流常态）
  // 括弧：j = 最后一个 t[j] ≤ t 的下标（j+1 < n 恒成立）
  let l = 0;
  let r = n - 1;
  while (l < r) {
    const m = (l + r + 1) >> 1;
    if (s.t[m] <= t) l = m;
    else r = m - 1;
  }
  const j = l;
  const dL = t - s.t[j];
  const dR = s.t[j + 1] - t;
  if (Math.min(dL, dR) > tol) return null; // 宽间隙中段：两侧样本都太远 → 不采信
  if (mode === "nearest") return dL <= dR ? s.v[j] : s.v[j + 1]; // 平手取左（= 前向填充口径）
  const span = dL + dR;
  if (span <= 0) return s.v[j]; // 重复时间戳：精确命中
  return s.v[j] + ((s.v[j + 1] - s.v[j]) * dL) / span;
}

/** 严格前向填充：t 时刻取「最后一个 ≤ t 的样本值」；早于首样本 → null（union/着色列用） */
export function ffillAt(s: Series, t: number): number | null {
  const n = s.t.length;
  if (n === 0 || t < s.t[0]) return null;
  let l = 0;
  let r = n - 1;
  while (l < r) {
    const m = (l + r + 1) >> 1;
    if (s.t[m] <= t) l = m;
    else r = m - 1;
  }
  return s.v[l];
}

/** 三轴配对主入口：见文件头注释 */
export function buildPairedTriples(
  xs: Series,
  ys: Series,
  zs: Series,
  opts: PairOptions,
): PairResult {
  const sinceT = opts.sinceT ?? -Infinity;
  const out: PairResult = { t: [], x: [], y: [], z: [], skipped: 0, tolMs: 0, endT: -Infinity };
  const xEnd = xs.t.length > 0 ? xs.t[xs.t.length - 1] : -Infinity;

  if (opts.mode === "union") {
    // 旧版口径：三序列时间轴并集（重复 ts 以 +0.001ms 递进）+ 各列前向填充。
    // 仅合并三条绑定轴（旧联合轴还混入未绑定通道的行，产出大量零位移重复点，此处不再复刻）。
    // 水位按「原始时间戳 > sinceT」过滤（bump 值仅用于输出显示，不影响水位语义）。
    let last = sinceT;
    let i = 0;
    let j = 0;
    let k = 0;
    let vx: number | null = null;
    let vy: number | null = null;
    let vz: number | null = null;
    const nx = xs.t.length;
    const ny = ys.t.length;
    const nz = zs.t.length;
    for (;;) {
      let bt = Infinity;
      if (i < nx && xs.t[i] < bt) bt = xs.t[i];
      if (j < ny && ys.t[j] < bt) bt = ys.t[j];
      if (k < nz && zs.t[k] < bt) bt = zs.t[k];
      if (!isFinite(bt)) break;
      if (i < nx && xs.t[i] === bt) { vx = xs.v[i]; i++; }
      if (j < ny && ys.t[j] === bt) { vy = ys.v[j]; j++; }
      if (k < nz && zs.t[k] === bt) { vz = zs.v[k]; k++; }
      const rawT = bt;
      last = last < bt ? bt : last + 0.001; // 重复/倒退 → +0.001 递进（旧联合轴同款）
      if (rawT > sinceT) {
        if (vx === null || vy === null || vz === null) out.skipped++;
        else {
          out.t.push(last);
          out.x.push(vx);
          out.y.push(vy);
          out.z.push(vz);
        }
      }
    }
    out.endT = Math.max(xEnd, ys.t.length > 0 ? ys.t[ys.t.length - 1] : -Infinity,
      zs.t.length > 0 ? zs.t[zs.t.length - 1] : -Infinity);
    return out;
  }

  // interp / nearest：X 原始时间轴为锚
  const start = lowerBoundGt(xs.t, sinceT);
  if (start >= xs.t.length) {
    out.endT = xEnd; // 无新锚点也要推进水位到 X 末点（幂等）
    return out;
  }
  const tol = opts.tolMs > 0 ? opts.tolMs : autoTolMs(xs, ys, zs);
  out.tolMs = tol;
  for (let i = start; i < xs.t.length; i++) {
    const t = xs.t[i];
    const yv = sampleAt(ys, t, opts.mode, tol);
    const zv = sampleAt(zs, t, opts.mode, tol);
    if (yv === null || zv === null) {
      out.skipped++;
      continue;
    }
    out.t.push(t);
    out.x.push(xs.v[i]);
    out.y.push(yv);
    out.z.push(zv);
  }
  out.endT = xEnd;
  return out;
}
