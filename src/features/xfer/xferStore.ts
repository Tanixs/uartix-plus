import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 文件传输（P49）：Rust xfer.rs 为权威状态源，本 store 只镜像进度/结果事件。
 * 传输激活期间 Rust 侧 ingest 头部 tap 截流 RX 控制字节，前端无需参与协议状态机。
 */

export interface XferProgress {
  phase: "waiting" | "sending" | "done" | "error" | "aborted";
  block: number;
  blocks: number;
  bytes: number;
  total: number;
  retries: number;
  bps: number;
  msg: string;
}

export interface XferSnapshot {
  /** 传输进行中（waiting/sending） */
  active: boolean;
  progress: XferProgress | null;
  /** 最近一次结果（含 ok 标志），打开对话框时显示 */
  lastDone: { ok: boolean; msg: string } | null;
  /** AI xferStart 动作的预填请求（ConsolePanel 消费后打开对话框） */
  aiPrefill: { proto: string; path: string; seq: number } | null;
}

let snap: XferSnapshot = {
  active: false,
  progress: null,
  lastDone: null,
  aiPrefill: null,
};

const listeners = new Set<() => void>();
let inited = false;

function set(patch: Partial<XferSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

export function getSnapshot(): XferSnapshot {
  return snap;
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function init() {
  if (inited) return;
  inited = true;
  await listen<XferProgress>("xfer:progress", (e) => {
    const p = e.payload;
    set({
      active: p.phase === "waiting" || p.phase === "sending",
      progress: p,
      ...(p.phase === "done" || p.phase === "error" || p.phase === "aborted"
        ? { lastDone: { ok: p.phase === "done", msg: p.msg } }
        : {}),
    });
  });
  await listen<{ ok: boolean; msg: string }>("xfer:done", (e) => {
    set({ active: false, lastDone: e.payload });
  });
}

export async function start(proto: string, path: string): Promise<void> {
  await invoke("xfer_start", { proto, path });
  set({ progress: null, lastDone: null });
}

/** AI xferStart 动作：预填路径/协议并请求打开传输对话框（用户确认后才开始发送） */
export function requestAiPrefill(path: string, proto = "ymodem") {
  set({ aiPrefill: { proto, path, seq: Date.now() } });
}

/** ConsolePanel 取走预填请求（取走即清空，避免重复触发） */
export function consumeAiPrefill(): { proto: string; path: string; seq: number } | null {
  const p = snap.aiPrefill;
  if (p) set({ aiPrefill: null });
  return p;
}

export async function abort(): Promise<void> {
  try {
    await invoke("xfer_abort");
  } catch {
    /* 接口已关等场景：状态机自行收尾 */
  }
}

export function fmtBps(bps: number): string {
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

/** [中文, English]——渲染时经 tx() 取当前语言（模块级调 tx 会冻结 locale） */
export const PHASE_LABEL: Record<XferProgress["phase"], [string, string]> = {
  waiting: ["等待设备就绪", "Waiting for receiver"],
  sending: ["传输中", "Transferring"],
  done: ["完成", "Done"],
  error: ["失败", "Failed"],
  aborted: ["已取消", "Aborted"],
};
