/** Manual, bounded consumer of raw channel caches. Never aligns or consumes dirty. */
import * as plotStore from "../plot/plotStore";
import * as plot3dStore from "../plot3d/plot3dStore";
import { makeTransform } from "../plot3d/smoothing";
import {
  computeStatistics, computeTrajectory, compareTrajectories, METRICS_VERSION,
  type MetricRange, type MetricSeries, type StatisticsResult,
  type TrajectorySeries, type TrajectoryResult, type ComparisonResult,
} from "./metrics";

export const ANALYSIS_MAX_CHANNELS = 32;
export const ANALYSIS_MAX_POINTS = 30000;
export const ANALYSIS_TOTAL_POINTS = 120000;
export type AnalysisRange = { mode: "cache" } | { mode: "recent"; seconds: number } |
  { mode: "custom"; startMs: number; endMs: number };
export interface BuildAnalysisOptions {
  channelIds?: string[];
  groupIds?: string[];
  range?: AnalysisRange;
  /** Explicit time matching tolerance, independent of display pairing settings. */
  toleranceMs?: number;
  distanceTolerance?: number;
  compare?: { a: string; b: string };
  unit?: string;
  maxPointsPerChannel?: number;
}
export interface AnalysisRequest {
  schema: "vs-analysis-request/v1";
  channelIds: string[];
  /** Includes groups needed by the directional comparison. */
  groupIds: string[];
  range: AnalysisRange;
  toleranceMs: number;
  distanceTolerance: number;
  compare: { a: string; b: string } | null;
  unit: string;
  maxPointsPerChannel: number;
}
export interface AnalysisGroupParameters {
  id: string;
  bindings: { x: string; y: string; z: string | null };
  transform: { scale: number; rotX: number; rotY: number; rotZ: number; offX: number; offY: number; offZ: number };
  /** Actual analysis pairing, not the independent display pairing configuration. */
  pairing: { mode: "nearest"; toleranceMs: number; anchor: "x"; windowAppliedBeforePairing: true };
}
export interface AnalysisSnapshot {
  /** Absent on legacy snapshots; never infer unrecorded parameters. */
  request?: AnalysisRequest;
  groups?: AnalysisGroupParameters[];
  limits?: { maxChannels: number; maxPointsPerChannel: number; totalPoints: number; effectivePointsPerChannel: number };
  algorithmVersion: typeof METRICS_VERSION;
  generatedAt: number;
  selection: AnalysisRange;
  range: MetricRange | null;
  source: "raw-channel-cache";
  /** Results never contain serial data, model paths, notes, or credentials. */
  channels: { id: string; stats: StatisticsResult }[];
  trajectories: { id: string; stats: TrajectoryResult; pairing: "nearest"; toleranceMs: number }[];
  comparison: ({ a: string; b: string; stats: ComparisonResult }) | null;
  coverage: { channels: { id: string; cached: number; retained: number; truncated: boolean }[]; truncated: boolean };
}

const safeNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const safeText = (v: unknown) => typeof v === "string" ? v : null;
const safeRange = (r: MetricRange | null) => r ? { startMs: safeNumber(r.startMs), endMs: safeNumber(r.endMs) } : null;
const safeSelection = (r: AnalysisRange) => r.mode === "custom"
  ? { mode: "custom", startMs: safeNumber(r.startMs), endMs: safeNumber(r.endMs) }
  : r.mode === "recent" ? { mode: "recent", seconds: safeNumber(r.seconds) } : r.mode === "cache" ? { mode: "cache" } : null;
const numbers = (value: object, keys: readonly string[]) => Object.fromEntries(keys.map(key =>
  [key, safeNumber((value as Record<string, unknown>)[key])]));
const safeCoverage = (c: TrajectoryResult["coverage"]) => numbers(c, ["total", "validFraction", "firstMs", "lastMs"]);

/** Explicit recursive whitelist: no store objects, extensions or toJSON hooks cross the boundary. */
export function safeAnalysisSnapshot(s: AnalysisSnapshot) {
  const r = s.request;
  return {
    schema: "vs-analysis-snapshot/v1", algorithmVersion: safeText(s.algorithmVersion), generatedAt: safeNumber(s.generatedAt),
    source: "raw-channel-cache", selection: safeSelection(s.selection), range: safeRange(s.range),
    provenance: r ? "recorded" : "unrecorded",
    request: r ? { schema: r.schema === "vs-analysis-request/v1" ? r.schema : null,
      channelIds: r.channelIds.map(safeText), groupIds: r.groupIds.map(safeText), range: safeSelection(r.range),
      toleranceMs: safeNumber(r.toleranceMs), distanceTolerance: safeNumber(r.distanceTolerance),
      compare: r.compare ? { a: safeText(r.compare.a), b: safeText(r.compare.b) } : null,
      unit: safeText(r.unit), maxPointsPerChannel: safeNumber(r.maxPointsPerChannel) } : null,
    groups: s.groups ? s.groups.map(g => ({ id: safeText(g.id),
      bindings: { x: safeText(g.bindings.x), y: safeText(g.bindings.y), z: safeText(g.bindings.z) },
      transform: numbers(g.transform, ["scale", "rotX", "rotY", "rotZ", "offX", "offY", "offZ"]),
      pairing: { mode: g.pairing.mode === "nearest" ? "nearest" : null, toleranceMs: safeNumber(g.pairing.toleranceMs),
        anchor: g.pairing.anchor === "x" ? "x" : null, windowAppliedBeforePairing: g.pairing.windowAppliedBeforePairing === true } })) : null,
    limits: s.limits ? numbers(s.limits, ["maxChannels", "maxPointsPerChannel", "totalPoints", "effectivePointsPerChannel"]) : null,
    channels: s.channels.map(({ id, stats: v }) => ({ id: safeText(id), stats: {
      algorithmVersion: safeText(v.algorithmVersion), range: safeRange(v.range),
      units: { value: safeText(v.units.value), slope: safeText(v.units.slope), timeGap: "ms", count: "samples" },
      ...numbers(v, ["n", "invalid", "min", "max", "mean", "rms", "std", "slope"]),
      coverage: numbers(v.coverage, ["total", "validFraction", "firstMs", "lastMs", "unlocated"]),
      timeGap: numbers(v.timeGap, ["n", "minMs", "maxMs", "meanMs", "duplicateTimes"]) } })),
    trajectories: s.trajectories.map(({ id, stats: v, pairing, toleranceMs }) => ({ id: safeText(id),
      pairing: pairing === "nearest" ? "nearest" : null, toleranceMs: safeNumber(toleranceMs), stats: {
        algorithmVersion: safeText(v.algorithmVersion), range: safeRange(v.range), unit: safeText(v.unit),
        ...numbers(v, ["n", "invalid", "length", "displacement", "segments"]), coverage: safeCoverage(v.coverage) } })),
    comparison: s.comparison ? { a: safeText(s.comparison.a), b: safeText(s.comparison.b), stats: {
      algorithmVersion: safeText(s.comparison.stats.algorithmVersion), range: safeRange(s.comparison.stats.range),
      unit: safeText(s.comparison.stats.unit), pairing: "nearest-within-time-overlap",
      ...numbers(s.comparison.stats, ["toleranceMs", "distanceTolerance", "n", "unmatched", "meanDev", "rmsDev", "maxDev", "inToleranceFraction"]),
      coverage: numbers(s.comparison.stats.coverage, ["total", "matchedFraction", "firstMs", "lastMs"]) } } : null,
    coverage: { truncated: s.coverage.truncated === true, channels: s.coverage.channels.map(c => ({
      id: safeText(c.id), cached: safeNumber(c.cached), retained: safeNumber(c.retained), truncated: c.truncated === true })) },
  };
}

/** Validates ALL IDs before calling getChanData (which creates missing buffers). */
export function buildAnalysisSnapshot(options: BuildAnalysisOptions = {}): AnalysisSnapshot {
  const selected = [...new Set(options.channelIds ?? [])];
  const gids = [...new Set([...(options.groupIds ?? []), ...(options.compare ? [options.compare.a, options.compare.b] : [])])];
  const groups = plot3dStore.getSnapshot().settings.groups;
  const picked = gids.map((id) => {
    const g = groups.find((g) => g.id === id);
    if (!g) throw new RangeError(`Unknown trajectory group: ${id}`);
    if (!g.chX || !g.chY) throw new RangeError(`Unbound trajectory group: ${id}`);
    return g;
  });
  const ids = [...new Set([...selected, ...picked.flatMap((g) => [g.chX, g.chY, ...(g.chZ ? [g.chZ] : [])])])];
  if (ids.length > ANALYSIS_MAX_CHANNELS) throw new RangeError("Too many analysis channels");
  const known = new Set(plotStore.getSnapshot().channels.map((c) => c.id));
  for (const id of ids) if (!known.has(id)) throw new RangeError(`Unknown channel: ${id}`);
  const toleranceMs = options.toleranceMs ?? 100;
  const distanceTolerance = options.distanceTolerance ?? 0;
  if (![toleranceMs, distanceTolerance].every((v) => Number.isFinite(v) && v >= 0)) throw new RangeError("Invalid tolerance");
  const cap = options.maxPointsPerChannel ?? ANALYSIS_MAX_POINTS;
  if (!Number.isInteger(cap) || cap < 1 || cap > ANALYSIS_MAX_POINTS) throw new RangeError("Invalid snapshot cap");
  const perChannel = Math.min(cap, Math.floor(ANALYSIS_TOTAL_POINTS / Math.max(1, ids.length)));
  const selection = options.range ?? { mode: "cache" };
  if (selection.mode === "custom") computeStatistics({ t: [], v: [] }, selection);
  if (selection.mode === "recent" && (!Number.isFinite(selection.seconds) || selection.seconds <= 0)) throw new RangeError("Invalid recent window");
  // Raw references are used only synchronously; copy a bounded tail before calculation.
  const sources = ids.map((id) => ({ id, data: plotStore.getChanData(id) }));
  let first = Infinity;
  let last = -Infinity;
  for (const { data } of sources) {
    for (let i = 0; i < data.t.length; i++) {
      if (Number.isFinite(data.t[i])) { first = Math.min(first, data.t[i]); last = Math.max(last, data.t[i]); }
    }
  }
  const range: MetricRange | null = selection.mode === "custom" ? { startMs: selection.startMs, endMs: selection.endMs } :
    last === -Infinity ? null : { startMs: selection.mode === "recent" ? last - selection.seconds * 1000 : first, endMs: last };
  const raw = new Map<string, MetricSeries>();
  const coverage: AnalysisSnapshot["coverage"] = { channels: [], truncated: false };
  for (const { id, data } of sources) {
    const t: number[] = [], v: number[] = [];
    const scanStart = 0;
    let eligible = 0;
    // Keep newest in-range raw samples without resampling; report truncation explicitly.
    for (let i = data.t.length - 1; i >= scanStart; i--) {
      if (range && Number.isFinite(data.t[i]) && (data.t[i] < range.startMs || data.t[i] > range.endMs)) continue;
      eligible++;
      if (t.length < perChannel) { t.push(data.t[i]); v.push(data.v[i]); }
    }
    t.reverse(); v.reverse();
    raw.set(id, { t, v });
    const truncated = eligible > perChannel;
    coverage.channels.push({ id, cached: data.t.length, retained: t.length, truncated });
    coverage.truncated ||= truncated;
  }
  const unit = options.unit ?? "raw";
  const requestedRange: AnalysisRange = selection.mode === "custom"
    ? { mode: "custom", startMs: selection.startMs, endMs: selection.endMs }
    : selection.mode === "recent" ? { mode: "recent", seconds: selection.seconds } : { mode: "cache" };
  const parameters: AnalysisGroupParameters[] = picked.map(g => ({ id: g.id,
    bindings: { x: g.chX, y: g.chY, z: g.chZ || null },
    transform: { scale: g.transform.scale, rotX: g.transform.rotX, rotY: g.transform.rotY,
      rotZ: g.transform.rotZ, offX: g.transform.offX, offY: g.transform.offY, offZ: g.transform.offZ },
    pairing: { mode: "nearest", toleranceMs, anchor: "x", windowAppliedBeforePairing: true } }));
  const result: AnalysisSnapshot = { algorithmVersion: METRICS_VERSION, generatedAt: Date.now(),
    request: { schema: "vs-analysis-request/v1", channelIds: [...selected], groupIds: [...gids],
      range: requestedRange, toleranceMs, distanceTolerance,
      compare: options.compare ? { a: options.compare.a, b: options.compare.b } : null, unit, maxPointsPerChannel: cap },
    groups: parameters,
    limits: { maxChannels: ANALYSIS_MAX_CHANNELS, maxPointsPerChannel: ANALYSIS_MAX_POINTS,
      totalPoints: ANALYSIS_TOTAL_POINTS, effectivePointsPerChannel: perChannel },
    selection: { ...requestedRange }, range, source: "raw-channel-cache", channels: [], trajectories: [], comparison: null, coverage };
  if (!range) return result;
  result.channels = selected.map((id) => ({ id, stats: computeStatistics(raw.get(id)!, range, unit) }));
  const trajectories = new Map<string, TrajectorySeries>();
  for (const g of picked) {
    const xs = raw.get(g.chX)!;
    const ys = raw.get(g.chY)!;
    const zs = g.chZ ? raw.get(g.chZ)! : null;
    // Sorting copies handles imported, non-monotonic raw series without mutating cache.
    const sorted = (s: MetricSeries) => s.t.map((t, i) => ({ t, v: s.v[i] })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    const x = sorted(xs), y = sorted(ys), z = zs ? sorted(zs) : null;
    const at = (s: { t: number; v: number }[], t: number): number => {
      if (!s.length || t < s[0].t || t > s[s.length - 1].t) return NaN;
      let lo = 0, hi = s.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (s[mid].t < t) lo = mid + 1; else hi = mid; }
      let i = Math.min(lo, s.length - 1);
      if (i > 0 && Math.abs(s[i - 1].t - t) <= Math.abs(s[i].t - t)) i--;
      return Math.abs(s[i].t - t) <= toleranceMs ? s[i].v : NaN;
    };
    const trajectory = { t: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
    const xf = makeTransform(g.transform);
    const p: [number, number, number] = [0, 0, 0];
    for (const anchor of x) {
      xf(anchor.v, at(y, anchor.t), z ? at(z, anchor.t) : 0, p);
      trajectory.t.push(anchor.t); trajectory.x.push(p[0]); trajectory.y.push(p[1]); trajectory.z.push(p[2]);
    }
    trajectories.set(g.id, trajectory);
    result.trajectories.push({ id: g.id, stats: computeTrajectory(trajectory, range, unit), pairing: "nearest", toleranceMs });
  }
  if (options.compare) {
    const { a, b } = options.compare;
    result.comparison = { a, b, stats: compareTrajectories(trajectories.get(a)!, trajectories.get(b)!, range, toleranceMs, distanceTolerance, unit) };
  }
  return result;
}
