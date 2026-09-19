/** Raw-sample statistics. Times and inclusive ranges are absolute milliseconds.
 * No alignment, interpolation, resampling, store access or background work.
 */
export const METRICS_VERSION = "p87c-stats-v1";

export interface MetricRange { startMs: number; endMs: number }
export interface MetricSeries { t: readonly number[]; v: readonly number[] }
export interface TrajectorySeries {
  t: readonly number[];
  x: readonly number[];
  y: readonly number[];
  z: readonly number[];
}
export interface TrajectoryResult {
  algorithmVersion: typeof METRICS_VERSION;
  range: MetricRange;
  unit: string;
  n: number;
  invalid: number;
  length: number | null;
  displacement: number | null;
  segments: number;
  coverage: { total: number; validFraction: number | null; firstMs: number | null; lastMs: number | null };
}
export interface ComparisonResult {
  algorithmVersion: typeof METRICS_VERSION;
  range: MetricRange;
  unit: string;
  pairing: "nearest-within-time-overlap";
  toleranceMs: number;
  distanceTolerance: number;
  n: number;
  unmatched: number;
  meanDev: number | null;
  rmsDev: number | null;
  maxDev: number | null;
  inToleranceFraction: number | null;
  coverage: { total: number; matchedFraction: number | null; firstMs: number | null; lastMs: number | null };
}
export interface StatisticsResult {
  algorithmVersion: typeof METRICS_VERSION;
  range: MetricRange;
  units: {
    value: string;
    slope: string;
    timeGap: "ms";
    count: "samples";
  };
  coverage: {
    /** Finite timestamps in the requested range, including invalid values. */
    total: number;
    validFraction: number | null;
    firstMs: number | null;
    lastMs: number | null;
    /** Invalid timestamps cannot be assigned to a range. */
    unlocated: number;
  };
  n: number;
  invalid: number;
  min: number | null;
  max: number | null;
  /** Static-interval bias estimate only when the caller selects a static interval. */
  mean: number | null;
  rms: number | null;
  /** Sample standard deviation (n-1), null for n < 2. */
  std: number | null;
  /** Ordinary least squares value/second; not an automatic sensor drift diagnosis. */
  slope: number | null;
  timeGap: {
    /** Positive gaps between consecutive finite, valid samples, sorted by time. */
    n: number;
    minMs: number | null;
    maxMs: number | null;
    meanMs: number | null;
    duplicateTimes: number;
  };
}

/** Finite-value, sample-weighted stats; invalid values are never coerced to zero.
 * Duplicate timestamps contribute to value stats but not positive time gaps.
 * No boundary values are synthesized and nothing is extrapolated outside range.
 */
export function computeStatistics(
  series: MetricSeries,
  range: MetricRange,
  unit = "raw",
): StatisticsResult {
  if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.startMs > range.endMs)
    throw new RangeError("Invalid metric range");
  if (series.t.length !== series.v.length) throw new RangeError("Mismatched series lengths");
  const points: { t: number; v: number }[] = [];
  let invalid = 0;
  let unlocated = 0;
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i];
    if (!Number.isFinite(t)) { unlocated++; continue; }
    if (t < range.startMs || t > range.endMs) continue;
    const v = series.v[i];
    if (!Number.isFinite(v)) { invalid++; continue; }
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  const n = points.length;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  let scale = 0;
  let sumSquares = 0;
  let meanT = 0;
  let tt = 0;
  let tv = 0;
  let gapN = 0;
  let gapMin = Infinity;
  let gapMax = 0;
  let gapMean = 0;
  let duplicateTimes = 0;
  const origin = points[0]?.t ?? 0;
  for (let i = 0; i < n; i++) {
    const { t, v } = points[i];
    const count = i + 1;
    const dt = (t - origin) / 1000 - meanT;
    const dv = v - mean;
    meanT += dt / count;
    mean += dv / count;
    m2 += dv * (v - mean);
    tt += dt * ((t - origin) / 1000 - meanT);
    tv += dt * (v - mean);
    min = Math.min(min, v);
    max = Math.max(max, v);
    // Scaled sum of squares avoids overflow from squaring moderate large values.
    const a = Math.abs(v);
    if (a > scale) {
      sumSquares = 1 + sumSquares * (scale / a) ** 2;
      scale = a;
    } else if (scale > 0) sumSquares += (a / scale) ** 2;
    if (i > 0) {
      const gap = t - points[i - 1].t;
      if (gap === 0) duplicateTimes++;
      else {
        gapN++;
        gapMin = Math.min(gapMin, gap);
        gapMax = Math.max(gapMax, gap);
        gapMean += (gap - gapMean) / gapN;
      }
    }
  }
  // Overflow is unavailable, never non-JSON Infinity/NaN.
  const finite = (v: number): number | null => Number.isFinite(v) ? v : null;
  return {
    algorithmVersion: METRICS_VERSION,
    range: { ...range },
    units: { value: unit, slope: `${unit}/s`, timeGap: "ms", count: "samples" },
    coverage: {
      total: n + invalid, validFraction: n + invalid ? n / (n + invalid) : null,
      firstMs: points[0]?.t ?? null, lastMs: points[n - 1]?.t ?? null, unlocated,
    },
    n, invalid,
    min: n ? min : null, max: n ? max : null, mean: n ? finite(mean) : null,
    rms: n ? finite(scale * Math.sqrt(sumSquares / n)) : null,
    std: n > 1 ? finite(Math.sqrt(Math.max(0, m2 / (n - 1)))) : null,
    slope: n > 1 && tt > 0 ? finite(tv / tt) : null,
    timeGap: {
      n: gapN, minMs: gapN ? gapMin : null, maxMs: gapN ? gapMax : null,
      meanMs: gapN ? gapMean : null, duplicateTimes,
    },
  };
}

function trajectoryPoints(s: TrajectorySeries, range: MetricRange) {
  computeStatistics({ t: [], v: [] }, range); // shared range validation
  if ([s.x, s.y, s.z].some((a) => a.length !== s.t.length)) throw new RangeError("Mismatched trajectory lengths");
  return s.t.map((t, i) => ({ t, x: s.x[i], y: s.y[i], z: s.z[i] }))
    .filter((p) => Number.isFinite(p.t) && p.t >= range.startMs && p.t <= range.endMs)
    .sort((a, b) => a.t - b.t);
}
const validPoint = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z].every(Number.isFinite);
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finiteResult = (v: number) => Number.isFinite(v) ? v : null;

/** Polyline length; invalid points break segments rather than silently bridging holes. */
export function computeTrajectory(s: TrajectorySeries, range: MetricRange, unit = "raw"): TrajectoryResult {
  const points = trajectoryPoints(s, range);
  const valid = points.filter(validPoint);
  let length = 0;
  let segments = 0;
  for (let i = 1; i < points.length; i++) {
    if (!validPoint(points[i - 1]) || !validPoint(points[i])) continue;
    length += distance(points[i - 1], points[i]);
    segments++;
  }
  return {
    algorithmVersion: METRICS_VERSION, range: { ...range }, unit,
    n: valid.length, invalid: points.length - valid.length,
    length: segments ? finiteResult(length) : null,
    displacement: valid.length > 1 ? finiteResult(distance(valid[0], valid[valid.length - 1])) : null,
    segments,
    coverage: { total: points.length, validFraction: points.length ? valid.length / points.length : null,
      firstMs: valid[0]?.t ?? null, lastMs: valid[valid.length - 1]?.t ?? null },
  };
}

/** Directional A→B nearest match. A timestamp must lie inside B's actual support.
 * No extrapolation/interpolation. B samples may be reused; ties choose earlier B.
 * Invalid nearest B is a missing match, not permission to bridge it.
 */
export function compareTrajectories(a: TrajectorySeries, b: TrajectorySeries, range: MetricRange,
  toleranceMs: number, distanceTolerance = 0, unit = "raw"): ComparisonResult {
  if (![toleranceMs, distanceTolerance].every((v) => Number.isFinite(v) && v >= 0)) throw new RangeError("Invalid tolerance");
  const ap = trajectoryPoints(a, range);
  const bp = trajectoryPoints(b, range);
  const times: number[] = [];
  const deviations: number[] = [];
  let within = 0;
  let j = 0;
  for (const p of ap) {
    if (!validPoint(p) || !bp.length || p.t < bp[0].t || p.t > bp[bp.length - 1].t) continue;
    while (j + 1 < bp.length && bp[j + 1].t <= p.t) j++;
    const next = bp[j + 1];
    const q = next && Math.abs(next.t - p.t) < Math.abs(bp[j].t - p.t) ? next : bp[j];
    if (!validPoint(q) || Math.abs(q.t - p.t) > toleranceMs) continue;
    const d = distance(p, q);
    if (!Number.isFinite(d)) continue;
    times.push(p.t); deviations.push(d);
    if (d <= distanceTolerance) within++;
  }
  const stats = computeStatistics({ t: times, v: deviations }, range, unit);
  return { algorithmVersion: METRICS_VERSION, range: { ...range }, unit,
    pairing: "nearest-within-time-overlap", toleranceMs, distanceTolerance,
    n: stats.n, unmatched: ap.length - stats.n, meanDev: stats.mean, rmsDev: stats.rms, maxDev: stats.max,
    inToleranceFraction: stats.n ? within / stats.n : null,
    coverage: { total: ap.length, matchedFraction: ap.length ? stats.n / ap.length : null,
      firstMs: times[0] ?? null, lastMs: times[times.length - 1] ?? null },
  };
}
