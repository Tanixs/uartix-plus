/**
 * 控制画布内嵌控件的滚轮归属（唯一判定，所有面板共用）。
 *
 * 规则只有一条：
 *   指针在卡内容区（[data-wheel-scope="control"]）且未锁定 → 控件消费；
 *   锁定，或指针在卡外（标题条 / 卡片间隙 / 空白）        → 画布滚动。
 *
 * 各控件"消费"的具体动作由控件自己决定（不再在画布侧逐个 if-else）：
 *   2D 曲线   uPlot 缩放/框选        Hex      滚缓冲区
 *   数据表格  滚行                   频谱     留在图内（无缩放语义，至少不误滚画布）
 *   X-Ray    滚内容                  序列器   滚内容
 *   哨兵      滚内容                 帧画布   滚内容
 *   3D 轨迹   相机缩放               组帧台   滚表单
 *   插件面板  iframe 内滚内容（跨文档，父页本就收不到）
 *
 * 为什么放在 capture 阶段：画布接管时必须先于控件拿到事件并 stopPropagation，
 * 否则会出现"图表缩放了一格、画布又滚了一段"的双重动作（历史现象）；控件接管时
 * 画布完全不动作。
 */
export const WHEEL_SCOPE_SELECTOR = '[data-wheel-scope="control"]';
export const WHEEL_LOCKED_SELECTOR = '[data-wheel-locked="1"]';

export type WheelOwner = "control" | "canvas";

export function resolveWheelOwner(
  target: EventTarget | null,
  pageLocked: boolean,
): WheelOwner {
  if (pageLocked) return "canvas";
  if (!(target instanceof Element)) return "canvas";
  const scope = target.closest(WHEEL_SCOPE_SELECTOR);
  if (!scope) return "canvas";
  return scope.closest(WHEEL_LOCKED_SELECTOR) ? "canvas" : "control";
}
