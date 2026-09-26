/**
 * P104-B1：缩放坐标内核（项目指针红线，唯一出处）。
 *
 * 为什么必须有这个文件：`App.tsx` 用的是 **CSS `zoom`**（不是 transform: scale），它有两个
 * 反直觉的性质，实测于 1600×950 / zoom=125%：
 *   - `getBoundingClientRect()` 返回**已含缩放因子**的视觉 px（24px 的按钮 rect = 30）；
 *   - `window.innerWidth` **不随 zoom 变**（仍是 1319）。
 * 所以"拿 rect 和 innerWidth 直接比"必然差一个缩放因子；而 dockview 的 `initialWidth`
 * 是写进 `style.width` 的**逻辑 CSS px**，要用 innerWidth 去除以缩放因子才是可比分母。
 *
 * 这个红线原先散在 7 个文件 9 处（AiFloat / WidgetFloats / SentinelPanel / TourOverlay 各一份
 * 同名 helper，Plot2D 另有三处内联写法），靠副本维持=迟早漂移。收敛到这里。
 */

/** 当前缩放因子；未设置或异常时回落 1（宁可不缩放，也不能算出 NaN 把布局搞崩） */
export function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

/**
 * 视口尺寸，单位换算成**逻辑 CSS px**——凡是要与 `initialWidth` / 布局常量 / 面板最小宽
 * 相比的，都用这个，别用裸 `window.innerWidth`。
 */
export function logicalViewport(): { w: number; h: number } {
  const zf = zoomFactor();
  return { w: window.innerWidth / zf, h: window.innerHeight / zf };
}

/**
 * 应用界面缩放。**同时**写两处：
 *  - `style.zoom`：真正生效的缩放；
 *  - `--zoom` 根变量：让 CSS 侧也能读到当前缩放因子。
 * 实测 90% 缩放会把 117 只可交互元素里的 116 只压到 24 视觉 px 以下（B0 度量）。
 * **不要**据此写 `calc(24px / var(--zoom))`：那等于拿 100% 的尺子去纠正用户主动选的密度。
 * 底线定在 100% 下 ≥24，欠着的（20×20 / 13×13 / 80×3）在 B4 抬上来，90% 下变密是特性。
 *
 * 派发 `vs-zoom-change`：zoom 改变 vw/vh 语义但**不触发 resize**，浮窗类必须靠它重钳制。
 */
export function applyUiZoom(pct: number): void {
  const root = document.documentElement;
  const zf = Number.isFinite(pct) && pct > 0 ? pct / 100 : 1;
  root.style.zoom = `${pct}%`;
  root.style.setProperty("--zoom", String(zf));
  window.dispatchEvent(new Event("vs-zoom-change"));
}
