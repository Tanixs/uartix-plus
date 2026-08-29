import { listen } from "@tauri-apps/api/event";
import type { FrameRow, FramesEventPayload } from "../../ipc/types";

const ARCHIVE_BYTES_LIMIT = 4 * 1024 * 1024;
const ARCHIVE_BYTES_LOW = 3 * 1024 * 1024;
const ARCHIVE_COUNT_LIMIT = 200_000;
const ARCHIVE_COUNT_LOW = 150_000;
const EMIT_MS = 100;

let inited = false;
const list: FrameRow[] = [];
const prefix: number[] = [];
let totalBytes = 0;
let dropped = 0;
const perTpl = new Map<string, number>();
const lastRow = new Map<string, FrameRow>();
const lastIdx = new Map<string, number>();
const subs = new Set<() => void>();
let snap: { frames: number; bytes: number; dropped: number; rev: number } = {
  frames: 0,
  bytes: 0,
  dropped: 0,
  rev: 0,
};
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function bytesBefore(cut: number): number {
  return cut === 0 ? 0 : prefix[cut - 1] + list[cut - 1].len;
}

function pruneArchive() {
  if (totalBytes <= ARCHIVE_BYTES_LIMIT && list.length <= ARCHIVE_COUNT_LIMIT) {
    return;
  }
  let cut = 0;
  while (cut < list.length) {
    const remainBytes = totalBytes - bytesBefore(cut);
    const remainCount = list.length - cut;
    if (remainBytes <= ARCHIVE_BYTES_LOW && remainCount <= ARCHIVE_COUNT_LOW) {
      break;
    }
    cut++;
  }
  if (cut === 0) return;
  const removed = list.splice(0, cut);
  let cutBytes = 0;
  for (const r of removed) {
    cutBytes += r.len;
    perTpl.set(r.tplId, Math.max(0, (perTpl.get(r.tplId) ?? 0) - 1));
  }
  totalBytes -= cutBytes;
  prefix.splice(0, cut);
  for (let i = 0; i < prefix.length; i++) prefix[i] -= cutBytes;
  lastIdx.forEach((v, k) => {
    const nv = v - cut;
    if (nv >= 0) lastIdx.set(k, nv);
    else {
      lastIdx.set(k, -1);
      lastRow.delete(k);
    }
  });
}

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
      prefix.push(totalBytes);
      totalBytes += bytes.length;
      list.push(r);
      lastIdx.set(r.tplId, list.length - 1);
      lastRow.set(r.tplId, r);
      perTpl.set(r.tplId, (perTpl.get(r.tplId) ?? 0) + 1);
    }
    pruneArchive();
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

export function lastOf(tplId: string): FrameRow | null {
  return lastRow.get(tplId) ?? null;
}

export function lastIndexOf(tplId: string): number {
  return lastIdx.get(tplId) ?? -1;
}

export function clearArchive() {
  list.length = 0;
  prefix.length = 0;
  totalBytes = 0;
  dropped = 0;
  perTpl.clear();
  lastRow.clear();
  lastIdx.clear();
  doEmit();
}
