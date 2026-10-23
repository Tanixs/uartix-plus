/**
 * P174-A5：插件运行时的**纯逻辑**（状态机 + 日志环形缓冲）。
 *
 * 与 IO 分开的原因很实际：状态迁移和环形缓冲是"错了会静默"的那类代码——
 * 日志缓冲区少写一行，用户看到的是"最后一条日志没了"，而不是一个报错。
 * 所以它必须能被单测咬住，而 `extStore.ts` 里那些 `invoke` 没法在 vitest 里跑。
 */

export type ExtPhase = "idle" | "starting" | "running" | "stopped" | "failed";

export type ExtLogLevel = "debug" | "info" | "warn" | "error" | "raw";

export interface ExtLogLine {
  at: number;
  level: ExtLogLevel;
  text: string;
  stream?: "stdout" | "stderr";
}

/** 日志保留行数。超过就丢最旧的——**不是"暂停写入"**，暂停会让面板看着像卡死。 */
export const LOG_MAX = 500;

/**
 * 追加一行。环形语义：超过 `max` 丢最旧。
 *
 * 实现上刻意**每次新建数组**（不做 in-place shift）：store 用 `useSyncExternalStore`，
 * 引用不变就不会重渲染——in-place 改数组是这个组合下最经典的"数据变了界面不动"。
 */
export function appendLog(logs: readonly ExtLogLine[], line: ExtLogLine, max = LOG_MAX): ExtLogLine[] {
  const next = logs.length >= max ? logs.slice(logs.length - max + 1) : logs.slice();
  next.push(line);
  return next;
}

export type ExtEvent =
  | { type: "starting" }
  | { type: "ready" }
  | { type: "exit" }
  | { type: "idle" }
  | { type: "stopped" }
  | { type: "failed"; error: string };

/**
 * 状态迁移表。任何未列出的组合都**保持原状态**（不做"兜底改成 idle"——
 * 那会把 failed 悄悄抹成 idle，用户就再也看不见上次为什么挂了）。
 */
const TRANSITIONS: Record<ExtPhase, Partial<Record<ExtEvent["type"], ExtPhase>>> = {
  idle: { starting: "starting" },
  starting: { ready: "running", failed: "failed", exit: "failed", stopped: "stopped" },
  running: { exit: "stopped", idle: "stopped", stopped: "stopped", failed: "failed" },
  stopped: { starting: "starting" },
  failed: { starting: "starting" },
};

export function nextPhase(cur: ExtPhase, ev: ExtEvent): ExtPhase {
  return TRANSITIONS[cur][ev.type] ?? cur;
}

/** 只有"没在跑"的状态才允许启动。`starting` 期间再点一次不该起第二个进程。 */
export function canStart(p: ExtPhase): boolean {
  return p === "idle" || p === "stopped" || p === "failed";
}

/** 只有 running 才允许停（stopped/failed 下按停止只会得到一个"没有在运行"的错误）。 */
export function canStop(p: ExtPhase): boolean {
  return p === "running" || p === "starting";
}

/** 状态给人看的一句话（面板顶栏与按钮文案共用，避免两处各写一份）。 */
export function phaseLabel(p: ExtPhase): { zh: string; en: string } {
  switch (p) {
    case "idle":
      return { zh: "未启动", en: "Idle" };
    case "starting":
      return { zh: "正在启动", en: "Starting" };
    case "running":
      return { zh: "运行中", en: "Running" };
    case "stopped":
      return { zh: "已停止", en: "Stopped" };
    case "failed":
      return { zh: "启动失败", en: "Failed" };
  }
}
