import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "../ai/extRuntime";
import { tx } from "../../i18n/strings";

/**
 * 文件传输（P49）：Rust xfer.rs 为权威状态源，本 store 只镜像进度/结果事件。
 * 传输激活期间 Rust 侧 ingest 头部 tap 截流 RX 控制字节，前端无需参与协议状态机。
 */

export interface XferProgress {
  phase: "waiting" | "sending" | "receiving" | "done" | "error" | "aborted";
  block: number;
  blocks: number;
  bytes: number;
  total: number;
  retries: number;
  bps: number;
  msg: string;
}

export interface XferSnapshot {
  /** 传输进行中（waiting/sending/receiving） */
  active: boolean;
  progress: XferProgress | null;
  /** 最近一次结果（含 ok 标志），打开对话框时显示 */
  lastDone: { ok: boolean; msg: string } | null;
  /** AI xferStart 动作的预填请求（ConsolePanel 消费后打开对话框） */
  aiPrefill: { proto: string; paths: string[]; seq: number } | null;
  /** 多文件顺序传输队列（前端展示用；权威推进逻辑在本 store） */
  queue: { total: number; idx: number } | null;
}

let snap: XferSnapshot = {
  active: false,
  progress: null,
  lastDone: null,
  aiPrefill: null,
  queue: null,
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

/** 多文件顺序传输队列：{ proto, paths, idx }——null = 非队列模式 */
let queue: { proto: string; paths: string[]; idx: number } | null = null;

/** 队列推进：当前文件成功后自动续传下一个；失败/中止/传完即清队 */
async function advanceQueue(ok: boolean) {
  const q = queue;
  if (!q) return;
  if (!ok) {
    queue = null;
    set({ queue: null });
    toast(tx("多文件传输队列已停止（上一个文件失败）", "Multi-file queue stopped (previous file failed)"));
    return;
  }
  if (q.idx + 1 >= q.paths.length) {
    queue = null;
    set({ queue: null });
    return;
  }
  queue = { ...q, idx: q.idx + 1 };
  set({ queue: { total: q.paths.length, idx: queue.idx }, progress: null });
  try {
    await invoke("xfer_start", { proto: q.proto, path: q.paths[queue.idx] });
  } catch (e) {
    queue = null;
    set({ queue: null, active: false });
    toast(tx(`队列续传失败：${String(e)}`, `Queue continuation failed: ${String(e)}`));
  }
}

export async function init() {
  if (inited) return;
  inited = true;
  await listen<XferProgress>("xfer:progress", (e) => {
    const p = e.payload;
    set({
      active: p.phase === "waiting" || p.phase === "sending" || p.phase === "receiving",
      progress: p,
      ...(p.phase === "done" || p.phase === "error" || p.phase === "aborted"
        ? { lastDone: { ok: p.phase === "done", msg: p.msg } }
        : {}),
    });
  });
  await listen<{ ok: boolean; msg: string }>("xfer:done", (e) => {
    set({ active: false, lastDone: e.payload });
    void advanceQueue(e.payload.ok);
  });
}

export async function start(proto: string, path: string): Promise<void> {
  queue = null;
  await invoke("xfer_start", { proto, path });
  set({ progress: null, lastDone: null, queue: null });
}

/** 多文件顺序传输：确认后从第一个开始，xfer:done(ok) 驱动 advanceQueue 续传 */
export async function startQueue(proto: string, paths: string[]): Promise<void> {
  queue = { proto, paths, idx: 0 };
  try {
    await invoke("xfer_start", { proto, path: paths[0] });
    set({ progress: null, lastDone: null, queue: { total: paths.length, idx: 0 } });
  } catch (e) {
    queue = null;
    set({ queue: null });
    throw e;
  }
}

/** 接收（设备 → PC）：path 为保存目标，协议状态机与写盘全在 Rust 侧 */
export async function receiveStart(proto: string, path: string): Promise<void> {
  queue = null;
  await invoke("xfer_receive_start", { proto, path });
  set({ progress: null, lastDone: null, queue: null });
}

/** AI xferStart 动作：预填路径/协议并请求打开传输对话框（用户确认后才开始发送） */
export function requestAiPrefill(paths: string[], proto = "ymodem") {
  set({ aiPrefill: { proto, paths, seq: Date.now() } });
}

/** ConsolePanel 取走预填请求（取走即清空，避免重复触发） */
export function consumeAiPrefill(): { proto: string; paths: string[]; seq: number } | null {
  const p = snap.aiPrefill;
  if (p) set({ aiPrefill: null });
  return p;
}

export async function abort(): Promise<void> {
  queue = null;
  set({ queue: null });
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
  receiving: ["接收中", "Receiving"],
  done: ["完成", "Done"],
  error: ["失败", "Failed"],
  aborted: ["已取消", "Aborted"],
};
