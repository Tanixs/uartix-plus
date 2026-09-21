/**
 * P91 A2/A3：Agent 单轮错误的解析与重试策略（纯函数，独立成模块）。
 * loop.ts 需要它来决定"退避重试 / 降预算重试 / 定因失败"，而 provider.ts 静态引着
 * @tauri-apps/api —— 解析逻辑放那边的话，loop 的测试环境就会拖进 Tauri 依赖。
 */
import type { TurnError } from "./types";

/** 单轮可重试错误的退避上限与节奏（P91 A3） */
export const TURN_RETRY_LIMIT = 2;
export const TURN_RETRY_BACKOFF_MS = [1500, 4000];
/** 输出预算阶梯：截断类失败逐级下调重试（16384 起步，最低 4096） */
export const MAX_TOKENS_LADDER = [16384, 8192, 4096];

/**
 * 宿主错误 → 结构化 TurnError。
 * ai_agent_turn 以 JSON 字符串回传 `{agentError:1,code,msg,retryable,shrink}`；
 * 解不动（IPC 层自身异常、非本通道的错误）时整串当文案并按关键词兜底判定，
 * 绝不把内部码或 Rust Debug 串直接甩给用户。
 */
export function parseTurnError(err: unknown): TurnError {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.startsWith("{")) {
    try {
      const v = JSON.parse(raw) as Partial<TurnError>;
      if (v && v.agentError === 1) {
        return {
          agentError: 1,
          code: String(v.code ?? "unknown"),
          msg: String(v.msg ?? raw),
          retryable: v.retryable === true,
          shrink: v.shrink === true,
          // P95-H1：输入侧超限走"收缩上下文"，与 shrink（降输出预算）分道
          shrinkInput: v.shrinkInput === true || v.code === "context_overflow",
        };
      }
    } catch {
      /* 非 JSON：落到下面的整串文案 */
    }
  }
  const retryable = /超时|中断|连接|频繁|限流|HTTP 5|429|502|503|temporar/i.test(raw);
  return { agentError: 1, code: "legacy", msg: raw, retryable, shrink: false };
}

/**
 * P99a-C1：**发送前**发现任务已取消。
 *
 * 为什么单独一支：`AbortSignal` 不回放过去事件——signal 已经 aborted 时再挂监听器，
 * 那个监听永远不会触发。provider 于是拿到一个"永远不会有结果"的请求，用户点了停止，
 * 任务却以 running 卡到天荒地老（真机上"臂模块/建 Worker 那几百毫秒里点停止"就是这个洞）。
 * loop 在每次真正发起请求之前先问一次 aborted，用这个错误把 run 收成 cancelled。
 */
export function cancelledBeforeSend(): Error {
  const e: TurnError = { agentError: 1, code: "cancelled", msg: "任务已取消：本轮请求未发送", retryable: false, shrink: false };
  return new Error(JSON.stringify(e));
}

/** 截断/400 之后该用哪一档输出预算；已在最低档返回 null（不再降） */
export function nextMaxTokens(current: number, shrink: boolean): number | null {
  if (!shrink) return null;
  const i = MAX_TOKENS_LADDER.indexOf(current);
  const next = i === -1 ? MAX_TOKENS_LADDER[MAX_TOKENS_LADDER.length - 1] : MAX_TOKENS_LADDER[Math.min(i + 1, MAX_TOKENS_LADDER.length - 1)];
  return next < current ? next : null;
}

/** 退避等待（可被 abort 提前叫醒；返回是否被中断） */
export async function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return await new Promise<boolean>((resolve) => {
    const done = (aborted: boolean) => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = () => done(true);
    const t = setTimeout(() => done(false), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
