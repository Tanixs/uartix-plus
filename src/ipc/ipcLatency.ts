/**
 * IPC 投递延迟统计：Rust 端 emit 事件时带 emitTs（Date.now 基准），
 * 前端收到时 now - emitTs 即投递延迟。主线程被长任务阻塞时事件在
 * WebView 队列里排队，该值会显著增大——用于区分“后端慢”与“前端卡”。
 */

let sum = 0;
let cnt = 0;
let max = 0;

export function recordIpcLatency(emitTs: number | undefined) {
  if (!emitTs) return;
  const lag = Date.now() - emitTs;
  if (lag < 0 || lag > 60000) return;
  sum += lag;
  cnt += 1;
  if (lag > max) max = lag;
}

/** 取走并清零窗口统计 */
export function takeIpcLatency(): { avg: number; max: number; n: number } {
  const out = { avg: cnt ? sum / cnt : 0, max, n: cnt };
  sum = 0;
  cnt = 0;
  max = 0;
  return out;
}
