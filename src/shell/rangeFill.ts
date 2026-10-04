/**
 * P152 · 滑杆的"已走那段"。
 *
 * 为什么要有这一层：`input[type="range"]` 一直是 `appearance: auto`，也就是**主题画不到它**——
 * Blink 在 auto 下不采纳任何 `::-webkit-slider-*` 作者声明（P146 实测：改 `background` 像素零变化，
 * 改 `appearance: none` 轨道整个消失）。所以流利蓝那三条滑杆规则四批以来一行都没落地。
 *
 * 让它可主题化就得自己画轨道与拇指；而 Chromium **没有** `::-webkit-slider-progress`
 * （Firefox 才有 `::-moz-range-progress`），所以"已走的那段"只能把百分比喂进 CSS 变量。
 * 这一层就是那枚变量的唯一算法。
 *
 * 为什么在渲染期算而不是挂个观察器：React 的受控 `value` 是**属性**不是标签，
 * `MutationObserver` 看不见它；程序化改值（重置、载入预设、跟随字段）也不发 `input` 事件。
 * 观察器只能覆盖"用户拖"那一档，剩下三档会留下错色的滑杆——那比没有填色更难查。
 * 所以每个 range 在渲染时把百分比交出去：一次一处，跟着 state 走，天然同步。
 */
import type { CSSProperties } from "react";

export const RANGE_FILL_VAR = "--range-pct";

/** 百分比（钳在 0~100）。min===max 或值不可算时给 0，不猜。 */
export function rangePct(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * 摊在 `style` 上用的那一小坨。调用点写成 `style={{ ...别的, ...rangeStyle(v, min, max) }}`，
 * 顺序在后可见：谁的显式值赢，不会被这里覆盖掉别的属性。
 */
export function rangeStyle(value: number, min = 0, max = 100): CSSProperties {
  return { [RANGE_FILL_VAR]: String(rangePct(value, min, max)) } as CSSProperties;
}
