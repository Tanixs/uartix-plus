/**
 * 内嵌卡片的视口判定。
 *
 * 抽成纯函数只为一件事：这条判断要能单测。真跑起来时它每 100ms 被 rAF 调一次，
 * 一旦写成"和 DOM 扯在一起"，边界（贴边、零尺寸、完全在外）就只能靠手点验证。
 */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 卡片与视口是否有交集。零尺寸（卡片还没布局 / 页面被隐藏）一律算不可见：
 * 此时 canvas 的 clientWidth 也是 0，绘制没有意义。
 */
export function rectsOverlap(card: RectLike, view: RectLike): boolean {
  if (card.right <= card.left || card.bottom <= card.top) return false;
  if (view.right <= view.left || view.bottom <= view.top) return false;
  return (
    card.right > view.left &&
    card.left < view.right &&
    card.bottom > view.top &&
    card.top < view.bottom
  );
}
