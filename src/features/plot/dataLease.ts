/**
 * P88b-2 §6.1 数据订阅租约（用户裁决 H2 的批准稿）。
 *
 * 问题：plotStore 为省资源只在 2D/频谱/3D 至少一个面板打开时从帧总线采样进通道缓存；
 * 全部曲线面板关闭时 Agent 的读取工具将无新数据可取。
 *
 * 方案：Agent run 首次调用曲线/通道读取工具时申请租约，等效一个虚拟面板——
 * - 只维持 plotStore 采样与缓存：不启动 2D/3D 渲染、不占 GPU、不新建第二条帧通道；
 * - 上限 DATA_LEASE_CAP=4，超出 FIFO 排队；排队 10s 超时返回 false（调用方回
 *   lease_busy 回执，不阻塞 loop）；等待可被 AbortSignal 取消；
 * - 幂等：同 owner 重复 acquire 直接成功、重复 release 无副作用；
 * - 内存态：应用重启不恢复租约（§6.1 明示），run 终止由运行宿主负责 release。
 */

export const DATA_LEASE_CAP = 4;
const QUEUE_TIMEOUT_MS = 10_000;

interface Waiter {
  owner: string;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
}

const holders = new Set<string>();
const waiters: Waiter[] = [];

export function leaseCount(): number {
  return holders.size;
}

export function hasDataLease(owner: string): boolean {
  return holders.has(owner);
}

/** 有空位且无人排队时立即授予；否则 FIFO 排队（不插队，保证公平）。 */
export function acquireDataLease(owner: string, signal?: AbortSignal): Promise<boolean> {
  if (holders.has(owner)) return Promise.resolve(true);
  if (holders.size < DATA_LEASE_CAP && waiters.length === 0) {
    holders.add(owner);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const w: Waiter = {
      owner,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        if (w.signal) w.signal.removeEventListener("abort", w.onAbort);
        resolve(false);
      }, QUEUE_TIMEOUT_MS),
      signal,
      onAbort: () => {
        clearTimeout(w.timer);
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(false);
      },
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(w.timer);
        resolve(false);
        return;
      }
      signal.addEventListener("abort", w.onAbort, { once: true });
    }
    waiters.push(w);
  });
}

/** 幂等释放；释放后按 FIFO 唤醒排队者。 */
export function releaseDataLease(owner: string): void {
  if (!holders.delete(owner)) return;
  while (holders.size < DATA_LEASE_CAP && waiters.length > 0) {
    const w = waiters.shift()!;
    clearTimeout(w.timer);
    if (w.signal) w.signal.removeEventListener("abort", w.onAbort);
    holders.add(w.owner);
    w.resolve(true);
  }
}
