/**
 * 控制卡片的像素盒：拖拽/缩放期间由 DOM 临时接管 width/height，
 * 松手后必须**同时**把两轴写回去。
 *
 * 历史坑（2026-11：控件拖成一条 / 内嵌卡只剩一条阴影）：
 * 旧实现在提交前把 `style.width/height` 清空，指望 React 重渲染补回来。
 * 但 React 只重写「值发生变化」的样式属性——只改一个轴的 resize 结束后，
 * 另一个轴仍被判定为没变而不再写入，于是 `width:auto`/`height:auto` 落在
 * `container-type: size` 的卡片上（尺寸包含 → 没有内容内在尺寸）→ 塌成一条。
 *
 * 所以这里的唯一口径是：**只写、不清**，且两轴永远一起写。
 * 非有限值/0 格一律回落到 1 格，绝不把 `NaNpx` 或 `0px` 写进 DOM。
 */
export interface BoxStyleTarget {
  style: { width: string; height: string };
}

export function boxPx(cells: number, step: number, gap: number): number {
  const n = Number.isFinite(cells) && cells >= 1 ? Math.round(cells) : 1;
  return n * step - gap;
}

/** 原子地写两轴：任何调用方都不需要（也不允许）单独清某一轴。 */
export function applyCardBox(
  el: BoxStyleTarget,
  w: number,
  h: number,
  step: number,
  gap: number,
): void {
  el.style.width = `${boxPx(w, step, gap)}px`;
  el.style.height = `${boxPx(h, step, gap)}px`;
}
