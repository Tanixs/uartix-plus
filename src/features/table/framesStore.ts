import type { FrameRow, FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";

export interface FramesSnapshot {
  rows: FrameRow[];
  paused: boolean;
  maxRows: number;
  capped: boolean;
}

function initialMaxRows(): number {
  const v = parseInt(localStorage.getItem("vs.tableMax") ?? "1000", 10);
  return Number.isNaN(v) || v < 100 ? 1000 : v;
}

let rows: FrameRow[] = [];
let paused = false;
let maxRows = initialMaxRows();
let capped = false;

let snapshot: FramesSnapshot = { rows, paused, maxRows, capped };
const listeners = new Set<() => void>();
let initialized = false;
let pending: FrameRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 面板在标签组后台期间发生过入库（切回前台需补一次 emit） */
let dirtyWhileHidden = false;

function emit() {
  snapshot = { rows, paused, maxRows, capped };
  listeners.forEach((l) => l());
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
    if (p.rows.length === 0) return;
    // 面板关闭 → 完全停止（用户红线：关闭了的面板绝不允许后台运行）；
    // 重新打开后从新数据继续，历史行保留（静态）
    if (!panelActivity.isOpen("table")) return;
    pending = pending.concat(p.rows);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 150);
    }
  });
  // 堆叠在后台的表格：数据照常入有界缓冲但不触发 React 渲染；
  // 切回前台（任一 dockview 事件同步可见性）时补一次 emit
  panelActivity.subscribe(() => {
    if (dirtyWhileHidden && panelActivity.isVisible("table")) {
      dirtyWhileHidden = false;
      emit();
    }
  });
}

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const incoming = pending;
  pending = [];
  rows = rows.concat(incoming);
  if (rows.length > maxRows) {
    rows = rows.slice(rows.length - maxRows);
    capped = true;
  }
  // 后台页签跳过 emit（省掉 1000 行级 React 重渲染），仅入库
  if (panelActivity.isVisible("table")) {
    emit();
  } else {
    dirtyWhileHidden = true;
  }
}

export function setPaused(v: boolean) {
  paused = v;
  emit();
}

export function setMaxRows(n: number) {
  maxRows = n;
  localStorage.setItem("vs.tableMax", String(n));
  if (rows.length > n) {
    rows = rows.slice(rows.length - n);
    capped = true;
  }
  emit();
}

export function clearRows() {
  rows = [];
  capped = false;
  emit();
}
