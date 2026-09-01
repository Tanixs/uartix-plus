import type { FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";

export interface LatestValue {
  value: number;
  text: string | null;
  ts: number;
  seq: number;
  valid: boolean;
}

export interface TelemetrySnapshot {
  stats: { total: number; errors: number };
  tplStats: Record<string, { ok: number; err: number }>;
  latest: Record<string, LatestValue>;
}

let snapshot: TelemetrySnapshot = {
  stats: { total: 0, errors: 0 },
  tplStats: {},
  latest: {},
};

const listeners = new Set<() => void>();
let initialized = false;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let pending = false;

function set(patch: Partial<TelemetrySnapshot>) {
  snapshot = { ...snapshot, ...patch };
}

function scheduleNotify() {
  if (notifyTimer) {
    pending = true;
    return;
  }
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (pending) {
      pending = false;
      scheduleNotify();
    }
    listeners.forEach((l) => l());
  }, 200);
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snapshot;
}

export async function init() {
  if (initialized) return;
  initialized = true;
  onFrames((p: FramesEventPayload) => {
    const tplStats = { ...snapshot.tplStats };
    const latest = { ...snapshot.latest };
    let touched = false;
    for (const row of p.rows) {
      const cur = tplStats[row.tplId] ?? { ok: 0, err: 0 };
      tplStats[row.tplId] = row.valid
        ? { ...cur, ok: cur.ok + 1 }
        : { ...cur, err: cur.err + 1 };
      if (row.valid) {
        for (const f of row.fields) {
          latest[f.id] = {
            value: f.value,
            text: f.text,
            ts: row.tsMs,
            seq: row.seq,
            valid: row.valid,
          };
        }
      }
      touched = true;
    }
    if (!touched) return;
    set({
      stats: { total: p.total, errors: p.errors },
      tplStats,
      latest,
    });
    scheduleNotify();
  });
}
