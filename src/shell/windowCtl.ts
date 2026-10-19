/**
 * P157-F · 窗口层共享件（`getWinSafe` 与置顶状态）。
 *
 * 为什么从 `TopBars.tsx` 挪出来：设置页改成"全窗二栏"后，窗口三件（最小化/最大化/关闭）
 * 与**置顶**搬进设置页右栏右上——身份栏整条被盖住（P111-B 的"再盖住身份栏就是事故"
 * 被用户显式改判：职能搬进页里，不是丢了）。两处 UI 同驱一组 API ⇒ 「窗口对象怎么拿」
 * 与「置顶开着没」都必须只有一个出处：各存一份 `useState` 的下场是
 * "在设置页里点了置顶，回工作区一看按钮没亮"。
 */
import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 纯浏览器（npm run dev 直开）没有 Tauri 内核，getCurrentWindow() 构造即抛；降级为 no-op 桩以便浏览器验证 UI。
 * tauri 环境行为不变。
 * 桩里**列全被调到的方法**：少一个就是整页被错误边界接管（`innerSize` 漏掉时就是这样，
 * 于是"纯浏览器验证通道"这条我们自己依赖的路直接废掉——见 §8-46：兜底要兜得住实际调用面）。
 * P157-F 起调用面多了设置页的 `.set-drag`（startDragging / toggleMaximize）与窗键组
 * （minimize / toggleMaximize / close / setAlwaysOnTop / isMaximized / onResized）——
 * 这些方法桩里本来就有，没加新的。
 */
export function getWinSafe(): ReturnType<typeof getCurrentWindow> {
  try {
    return getCurrentWindow();
  } catch {
    const p = <T,>(v: T): Promise<T> => Promise.resolve(v);
    const size = () => p({ width: 0, height: 0 });
    const pos = () => p({ x: 0, y: 0 });
    return {
      onResized: () => p(() => {}),
      onMoved: () => p(() => {}),
      isMaximized: () => p(false),
      isFocused: () => p(true),
      innerSize: size,
      outerSize: size,
      innerPosition: pos,
      outerPosition: pos,
      scaleFactor: () => p(1),
      startDragging: () => p(undefined),
      toggleMaximize: () => p(undefined),
      maximize: () => p(undefined),
      unmaximize: () => p(undefined),
      setAlwaysOnTop: () => p(undefined),
      minimize: () => p(undefined),
      close: () => p(undefined),
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
}

/**
 * 置顶状态：模块级单一出处。**不查系统**——与旧身份栏行为一致（默认关；应用重载后
 * UI 回落 false，不动窗口真实状态的读取时机）。切换时两边 UI 同一拍刷新。
 */
let pinned = false;
const subs = new Set<() => void>();
function emit() {
  for (const f of subs) f();
}
export function subscribePin(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
export function pinnedNow(): boolean {
  return pinned;
}

/** [当前置顶, 切换]——切换同时落到真窗口（setAlwaysOnTop）。身份栏与设置页窗键组共用。 */
export function useWindowPin(): [boolean, () => void] {
  const on = useSyncExternalStore(subscribePin, pinnedNow);
  const toggle = () => {
    pinned = !pinned;
    emit();
    void getWinSafe().setAlwaysOnTop(pinned);
  };
  return [on, toggle];
}
