import { listen } from "@tauri-apps/api/event";
import type { FrameRow, FramesEventPayload } from "../../ipc/types";

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
  await listen<FramesEventPayload>("parser:frames", (e) => {
    if (e.payload.rows.length === 0) return;
    rows = rows.concat(e.payload.rows);
    if (rows.length > maxRows) {
      rows = rows.slice(rows.length - maxRows);
      capped = true;
    }
    emit();
  });
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
