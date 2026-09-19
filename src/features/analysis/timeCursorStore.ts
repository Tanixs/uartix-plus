export type CursorSource = "plot2d" | "plot3d" | "annotation" | "alert" | "session";
/** Ordered inclusive bounds in source milliseconds, independent of the playhead. */
export type TimeRangeMs = readonly [number, number];
export type TimeCursorState = {
  tsMs: number | null;
  rangeMs: TimeRangeMs | null;
  source: CursorSource;
  revision: number;
  linked: boolean;
};

let state: TimeCursorState = { tsMs: null, rangeMs: null, source: "plot2d", revision: 0, linked: true };
const listeners = new Set<() => void>();

export function getSnapshot(): TimeCursorState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit() {
  for (const listener of listeners) listener();
}

/** Source timestamps retain their original time domain; they are not necessarily Unix time. */
export function locate(tsMs: number | null, source: CursorSource): boolean {
  if (tsMs !== null && !Number.isFinite(tsMs)) return false;
  if (state.tsMs === tsMs && state.source === source) return true;
  state = { ...state, tsMs, source, revision: state.revision + 1 };
  emit();
  return true;
}

/**
 * Publish the 2D A/B cursor span in source milliseconds (or clear with null).
 * Independent of the playhead: consumers read it on demand instead of polling
 * the plot. Invalid or inverted bounds are rejected without notifying.
 */
export function setRange(rangeMs: TimeRangeMs | null): boolean {
  if (rangeMs !== null) {
    const [lo, hi] = rangeMs;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return false;
  }
  const next: TimeRangeMs | null = rangeMs === null ? null : [rangeMs[0], rangeMs[1]];
  const prev = state.rangeMs;
  if (prev === next || (prev !== null && next !== null && prev[0] === next[0] && prev[1] === next[1])) return true;
  state = { ...state, rangeMs: next, revision: state.revision + 1 };
  emit();
  return true;
}

export function publishDisplayRange(a: number | null, b: number | null, originMs: number, enabled: boolean): boolean {
  if (!enabled || a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(originMs)) {
    return setRange(null);
  }
  return setRange([fromDisplaySeconds(Math.min(a, b), originMs), fromDisplaySeconds(Math.max(a, b), originMs)]);
}

export function setLinked(linked: boolean) {
  if (state.linked === linked) return;
  state = { ...state, linked, revision: state.revision + 1 };
  emit();
}

export function toDisplaySeconds(tsMs: number, originMs: number): number {
  return (tsMs - originMs) / 1000;
}

export function fromDisplaySeconds(seconds: number, originMs: number): number {
  return originMs + seconds * 1000;
}
