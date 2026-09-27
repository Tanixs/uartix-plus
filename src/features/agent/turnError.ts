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
/**
 * 截断类失败下调输出预算的**兜底阶梯**：只在拿不到档案（没配模型）时用。
 * P110-B5 之后正常路径的阶梯来自档案里那台的 `maxOutputTokens`（见 `ladderFrom`），
 * 这三个数不再是"每个模型都先撞一次 16384"的理由。
 */
export const MAX_TOKENS_LADDER = [16384, 8192, 4096];

/** 按真实上限生成阶梯：1.0 → 0.5 → 0.25（宿主侧还会再钳一次，这里只管"别一上来就顶格"） */
export function ladderFrom(ceiling: number): number[] {
  const top = Math.max(256, Math.round(ceiling));
  const half = Math.max(256, Math.round(top / 2));
  const quarter = Math.max(256, Math.round(top / 4));
  return [top, half, quarter];
}

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

/**
 * 截断类失败之后把输出预算往下退一档。
 *
 * P110-B5：给了 `ceiling`（档案里那台的 `maxOutputTokens`）就按 1.0 → 0.5 → 0.25 退，
 * 不再拿三个硬编码数去试——旧写法的后果是：对面那台只能吐 4k 的模型，
 * 也要先撞两次「16384 太大」才知道自己是谁。拿不到档案时才退回 `MAX_TOKENS_LADDER`。
 */
export function nextMaxTokens(current: number, shrink: boolean, ceiling = 0): number | null {
  if (!shrink) return null;
  if (ceiling > 0) {
    const ladder = ladderFrom(ceiling);
    const under = ladder.filter((n) => n < current);
    // 退到"比现在小的最大一档"；已经在一档之下就没得退了
    return under.length ? Math.max(...under) : null;
  }
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
