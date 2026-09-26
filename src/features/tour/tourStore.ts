/**
 * 交互式教学引导（P78a）——分步聚光灯导览的状态机。
 *
 * 职责边界：store 只管「第几步 + 激活/退出 + 完成/看过持久化」；
 * DOM（目标定位/遮罩/气泡）全部在 TourOverlay，不进 store。
 * 步骤定义在 tourSteps.ts（纯数据 + 动作回调），store 与具体步骤解耦。
 *
 * 持久化：
 *  - vs.tour.done —— 走完或跳过过引导（用于文案微差，不拦截重看）
 *
 * P104-B7：`vs.tour.seen`（"首启自动弹过没有"）已删。首启现在弹的是欢迎轮播，
 * 引导改从欢迎卡或帮助里进——自动弹没了，这个键就只剩写没有读，留着是假象。
 * 首启标记收敛成一个：`vs.welcome.seen`（见 `shell/welcomeSlides.ts`）。
 */

import type { RailKey } from "../../shell/railState";

export interface TourStep {
  id: string;
  title: { zh: string; en: string };
  body: { zh: string; en: string };
  /** 聚光灯目标（CSS 选择器）；缺省 = 居中卡片（欢迎/完成页） */
  selector?: string;
  /**
   * 目标住在左侧导轨的二级面板里（R1~R5 把控件库/命令库/协议/接入搬进去了）。
   * 导轨收起时锚点根本不在 DOM 里，`selector` 找不到只会静默退化成居中卡片
   * ——那是引导最坏的坏法（教的东西还在，高亮没了，谁也看不出来）。
   * 所以这类步骤必须同时声明 `rail`，TourOverlay 会先把它展开再量。
   */
  rail?: RailKey;
  /** 步骤激活时执行的动作（开面板/启动演示源…）；失败不阻塞引导 */
  do?: () => void | Promise<void>;
  /**
   * 环扩到目标所在的**停靠框外框**（页签条 + 内容）。
   * 面板类目标默认只框内容根 `data-panel`，看着像"高亮跑到内容区里"，外框没反应。
   */
  frame?: boolean;
  /** do() 之后等目标出现/面板渲染的宽限（ms，默认 600） */
  settleMs?: number;
}

export interface TourState {
  active: boolean;
  idx: number;
  steps: TourStep[];
  total: number;
}

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

export function isDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 启动引导（重复调用 = 重新开始）。 */
export function start(steps: TourStep[], at = 0): void {
  if (!steps.length) return;
  // 越界夹回两端：取证入口允许 ?tour=7 直接跳到第 7 步，写错数字不该让引导白屏
  const idx = Math.min(Math.max(0, Math.trunc(at)), steps.length - 1);
  state = { active: true, idx, steps, total: steps.length };
  emit();
  void runStepDo(idx);
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
