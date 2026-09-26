/**
 * 教学引导宿主（App 挂载）：不活跃时零渲染。
 *
 * P104-B7：**首启不再自动弹**。首启现在弹的是欢迎轮播（`shell/Welcome.tsx`），
 * 引导是它上面的一颗「跟着走一遍」；重看走 帮助 → 交互式教学。
 * 原来这里是 `if (!tourStore.hasSeen()) tourStore.start()`——一进来就全屏遮罩，
 * 用户根本没看见过自己打开的界面，先被按住上了一堂课。
 */
import { useEffect, useSyncExternalStore } from "react";
import * as tourStore from "./tourStore";
import { TOUR_STEPS } from "./tourSteps";
import { devTourAt } from "../../dev/bootOverrides";
import { TourOverlay } from "./TourOverlay";

export function TourHost() {
  const s = useSyncExternalStore(tourStore.subscribe, tourStore.getSnapshot);
  useEffect(() => {
    // devTourAt() 只在 dev 且有 ?tour=N 时有值；生产恒 undefined ⇒ 行为与改前逐字一致
    const at = devTourAt();
    if (at !== undefined) tourStore.start(TOUR_STEPS, at);
  }, []);
  if (!s.active) return null;
  return <TourOverlay />;
}
