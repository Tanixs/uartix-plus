import type { FrameRow } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";

const ARCHIVE_BYTES_LIMIT = 4 * 1024 * 1024;
const ARCHIVE_BYTES_LOW = 3 * 1024 * 1024;
const ARCHIVE_COUNT_LIMIT = 200_000;
const ARCHIVE_COUNT_LOW = 150_000;
const EMIT_MS = 100;

/** 归档行：bytes 解码为 Uint8Array 存放（IPC 传输用 base64） */
export type ArchivedRow = Omit<FrameRow, "bytes"> & { bytes: Uint8Array };

let inited = false;
const list: ArchivedRow[] = [];
/** prefix[i] = 第 i 帧之前的累计字节数（绝对值，剪枝时不减基址，见 prefixBase） */
const prefix: number[] = [];
let prefixBase = 0;
/** 绝对累计字节数（剪枝不回退，prefix 存绝对值） */
let absTotal = 0;
let totalBytes = 0;
let dropped = 0;
const perTpl = new Map<string, number>();
const lastRow = new Map<string, ArchivedRow>();
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

/** 第 i 帧之前的累计字节数（相对当前归档起点） */
function bytesBefore(cut: number): number {
  return cut === 0 ? 0 : prefix[cut - 1] + list[cut - 1].len - prefixBase;
}

function pruneArchive() {
  if (totalBytes <= ARCHIVE_BYTES_LIMIT && list.length <= ARCHIVE_COUNT_LIMIT) {
    return;
  }
  // 二分定位 cut：剩余字节/帧数同时回到低水位线之后的第一个位置。
  // 旧实现逐帧 cut++ 扫描 + 全量 prefix 重算，是 O(n) 热点（违反分块回收约束）
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const remainBytes = totalBytes - bytesBefore(mid);
    const remainCount = list.length - mid;
    if (remainBytes <= ARCHIVE_BYTES_LOW && remainCount <= ARCHIVE_COUNT_LOW) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const cut = lo;
  if (cut === 0) return;
  for (let i = 0; i < cut; i++) {
    const r = list[i];
    perTpl.set(r.tplId, Math.max(0, (perTpl.get(r.tplId) ?? 0) - 1));
  }
  totalBytes -= bytesBefore(cut);
  list.splice(0, cut);
  prefix.splice(0, cut);
  // prefix 存绝对累计值，剪枝后仅推进基址，避免逐项重算
  prefixBase = prefix.length ? prefix[0] : 0;
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
  onFrames((p) => {
    // 面板关闭 → 归档完全停止（每帧 base64 解码+入库+剪枝是持续开销，
    // 用户红线：关闭了的面板绝不允许后台运行）。重开后归档从当前帧起。
    if (!panelActivity.isOpen("framecanvas")) return;
    if (p.dropped !== undefined && p.dropped !== dropped) {
      dropped = p.dropped;
    }
    for (const r of p.rows) {
      if (!r.valid || !r.bytes || r.bytes.length === 0) continue;
      // bytes 已是二进制总线直出的 Uint8Array（批量缓冲的子视图，
      // 归档持有的内存总量等于帧字节本身，无需再拷贝）
      const bytes = r.bytes;
      if (bytes.length === 0) continue;
      prefix.push(absTotal);
      absTotal += bytes.length;
      totalBytes += bytes.length;
      const row: ArchivedRow = { ...r, bytes };
      list.push(row);
      lastIdx.set(r.tplId, list.length - 1);
      lastRow.set(r.tplId, row);
      perTpl.set(r.tplId, (perTpl.get(r.tplId) ?? 0) + 1);
    }
    pruneArchive();
    scheduleEmit();
  });
}

export function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getMeta() {
  return snap;
}

export interface Archive {
  list: readonly ArchivedRow[];
  prefix: readonly number[];
  totalBytes: number;
}

export function archiveRef(): Archive {
  return { list, prefix, totalBytes };
}

export function tplCounts(): ReadonlyMap<string, number> {
  return perTpl;
}

export function lastOf(tplId: string): ArchivedRow | null {
  return lastRow.get(tplId) ?? null;
}

export function lastIndexOf(tplId: string): number {
  return lastIdx.get(tplId) ?? -1;
}

export function clearArchive() {
  list.length = 0;
  prefix.length = 0;
  prefixBase = 0;
  absTotal = 0;
  totalBytes = 0;
  dropped = 0;
  perTpl.clear();
  lastRow.clear();
  lastIdx.clear();
  doEmit();
}
