/**
 * 视图型内嵌的公共渲染预算件。
 *
 * 为什么要把这两件事抽出来：姿态视图与 3D 轨迹视图各自是独立的 WebGL 上下文，
 * 但"掉帧时先舍什么"和"卡片内滚轮不滚画布"是同一套机制。此前姿态视图里写了一份，
 * 再给轨迹抄一份就会出现两个真值——改阈值只改一半是这类降级最常见的事故。
 *
 * 预算仍是各视图自己的数（`attitudeViewQuality` / `trajectoryViewQuality`），
 * 这里只提供状态机：给定 tiers，输出 nextQuality / dprCapOf / targetFpsOf / pixelRatioFor。
 */

export type QualityLevel = 0 | 1 | 2;

export interface QualitySample {
  /** 最近窗口内的平均帧率 */
  fps: number;
  /** 已经在当前级别停留了多久（ms） */
  msInLevel: number;
}

export interface QualityTier {
  dprCap: number;
  targetFps: number;
  /** 掉到该帧率以下并持续 dwellMs 才降级；0 = 终点不再降 */
  downFps: number;
  dwellMs: number;
}

export type QualityTiers = Record<QualityLevel, QualityTier>;

export interface QualityLadder {
  nextQuality(level: QualityLevel, s: QualitySample): QualityLevel;
  dprCapOf(level: QualityLevel): number;
  targetFpsOf(level: QualityLevel): number;
  /** 设备像素比 = dpr × 界面缩放，再被当前档位与硬上限 2 夹住 */
  pixelRatioFor(dpr: number, zf: number, level: QualityLevel): number;
}

export function makeLadder(tiers: QualityTiers): QualityLadder {
  const dprCapOf = (level: QualityLevel): number => tiers[level].dprCap;
  return {
    nextQuality(level, s) {
      const t = tiers[level];
      if (level >= 2) return 2;
      if (s.fps > 0 && s.fps < t.downFps && s.msInLevel >= t.dwellMs) {
        return (level + 1) as QualityLevel;
      }
      return level;
    },
    dprCapOf,
    targetFpsOf: (level) => tiers[level].targetFps,
    pixelRatioFor(dpr, zf, level) {
      const base =
        Math.max(1, Number.isFinite(dpr) ? dpr : 1) *
        (Number.isFinite(zf) ? zf : 1);
      return Math.max(1, Math.min(base, dprCapOf(level), 2));
    },
  };
}

/**
 * 卡片内滚轮分流：未锁定截停冒泡与默认行为（只让 OrbitControls 缩放模型），
 * 锁定时不拦（滚轮交还控制画布）。必须非被动：被动监听里 preventDefault 会被忽略。
 * 缩放量取 deltaY，不依赖 clientX/Y，所以全局 CSS zoom 不影响滚轮手感。
 */
export function attachViewWheelGuard(
  host: HTMLElement,
  isLocked: () => boolean,
): () => void {
  const onWheel = (e: WheelEvent) => {
    if (isLocked()) return;
    e.stopPropagation();
    e.preventDefault();
  };
  host.addEventListener("wheel", onWheel, { passive: false });
  return () => host.removeEventListener("wheel", onWheel);
}
