/**
 * 教学引导宿主（App 挂载）：不活跃时零渲染；首启（无 vs.tour.seen）自动弹欢迎卡，
 * 之后从 帮助 → 快速入门 的「交互式教学」按钮重进。
 */
import { useEffect, useSyncExternalStore } from "react";
import * as tourStore from "./tourStore";
import { TOUR_STEPS } from "./tourSteps";
import { TourOverlay } from "./TourOverlay";

export function TourHost() {
  const s = useSyncExternalStore(tourStore.subscribe, tourStore.getSnapshot);
  useEffect(() => {
    if (!tourStore.hasSeen()) tourStore.start(TOUR_STEPS);
  }, []);
  if (!s.active) return null;
  return <TourOverlay />;
}
