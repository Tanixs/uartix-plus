/**
 * 交互式教学引导（P78a）——分步聚光灯导览的状态机。
 *
 * 职责边界：store 只管「第几步 + 激活/退出 + 完成/看过持久化」；
 * DOM（目标定位/遮罩/气泡）全部在 TourOverlay，不进 store。
 * 步骤定义在 tourSteps.ts（纯数据 + 动作回调），store 与具体步骤解耦。
 *
 * 持久化：
 *  - vs.tour.seen —— 首启欢迎卡只自动弹一次的标记（start() 即置位）
 *  - vs.tour.done —— 走完或跳过过引导（用于文案微差，不拦截重看）
 */

export interface TourStep {
  id: string;
  title: { zh: string; en: string };
  body: { zh: string; en: string };
  /** 聚光灯目标（CSS 选择器）；缺省 = 居中卡片（欢迎/完成页） */
  selector?: string;
  /** 步骤激活时执行的动作（开面板/启动演示源…）；失败不阻塞引导 */
  do?: () => void | Promise<void>;
  /** do() 之后等目标出现/面板渲染的宽限（ms，默认 600） */
  settleMs?: number;
}

export interface TourState {
  active: boolean;
  idx: number;
  steps: TourStep[];
  total: number;
}

const SEEN_KEY = "vs.tour.seen";
const DONE_KEY = "vs.tour.done";

let state: TourState = { active: false, idx: 0, steps: [], total: 0 };
const listeners = new Set<() => void>();

function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): TourState {
  return state;
}

export function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function isDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 启动引导（重复调用 = 重新开始）。首次调用落 seen 标记。 */
export function start(steps: TourStep[]): void {
  if (!steps.length) return;
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* 无痕模式：仅内存生效 */
  }
  state = { active: true, idx: 0, steps, total: steps.length };
  emit();
  void runStepDo(0);
}

export function next(): void {
  if (!state.active) return;
  if (state.idx >= state.steps.length - 1) {
    finish();
    return;
  }
  state.idx += 1;
  emit();
  void runStepDo(state.idx);
}

export function prev(): void {
  if (!state.active || state.idx === 0) return;
  state.idx -= 1;
  emit();
  void runStepDo(state.idx);
}

/** 中途退出（×/Esc）：不写 done（用户可能还想看，帮助里可重进） */
export function stop(): void {
  if (!state.active) return;
  state = { active: false, idx: 0, steps: [], total: 0 };
  emit();
}

function finish(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* 仅内存 */
  }
  stop();
}

async function runStepDo(idx: number): Promise<void> {
  const step = state.steps[idx];
  if (!step?.do) return;
  try {
    await step.do();
  } catch (e) {
    // 不阻塞引导（如非 Tauri 环境启动演示源失败），但不能静默：
    // 这一步到底有没有真的把界面动起来，出问题时只有这一条线索（§8-32 同一口径）。
    console.warn(`[tour] 步骤「${step.id}」的 do() 失败，引导继续但界面未随之变化`, e);
  }
}
