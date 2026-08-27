import { listen } from "@tauri-apps/api/event";
import type { FrameRow, FramesEventPayload } from "../../ipc/types";

const ARCHIVE_BYTES_LIMIT = 4 * 1024 * 1024;
const EMIT_MS = 100;

let inited = false;
const list: FrameRow[] = [];
const prefix: number[] = [];
let totalBytes = 0;
let dropped = 0;
const perTpl = new Map<string, number>();
const subs = new Set<() => void>();
let snap: { frames: number; bytes: number; dropped: number; rev: number } = {
  frames: 0,
  bytes: 0,
  dropped: 0,
  rev: 0,
};
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function doEmit() {
  snap = { frames: list.length, bytes: totalBytes, dropped, rev: snap.rev + 1 };
  subs.forEach((f) => f());
}

function scheduleEmit() {
  dirty = true;
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    if (!dirty) return;
    dirty = false;
    doEmit();
  }, EMIT_MS);
}

export function init() {
  if (inited) return;
  inited = true;
  listen<FramesEventPayload>("parser:frames", (e) => {
    const p = e.payload;
    if (p.dropped !== undefined && p.dropped !== dropped) {
      dropped = p.dropped;
    }
    for (const r of p.rows) {
      const bytes = r.bytes;
      if (!r.valid || !bytes || bytes.length === 0) continue;
      while (
        list.length > 0 &&
        totalBytes + bytes.length > ARCHIVE_BYTES_LIMIT
      ) {
        const old = list.shift()!;
        prefix.shift();
        totalBytes -= old.len;
        perTpl.set(old.tplId, Math.max(0, (perTpl.get(old.tplId) ?? 0) - 1));
      }
      prefix.push(totalBytes);
      totalBytes += bytes.length;
      list.push(r);
      perTpl.set(r.tplId, (perTpl.get(r.tplId) ?? 0) + 1);
    }
    scheduleEmit();
  }).catch(() => {});
}

export function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getMeta() {
  return snap;
}

export interface Archive {
  list: readonly FrameRow[];
  prefix: readonly number[];
  totalBytes: number;
}

export function archiveRef(): Archive {
  return { list, prefix, totalBytes };
}

export function tplCounts(): ReadonlyMap<string, number> {
  return perTpl;
}

export function clearArchive() {
  list.length = 0;
  prefix.length = 0;
  totalBytes = 0;
  dropped = 0;
  perTpl.clear();
  doEmit();
}
