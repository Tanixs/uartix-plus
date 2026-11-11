/**
 * 姿态视图的实例预算与降级阶梯。
 *
 * 为什么单独一份：姿态视图每个实例都是一个真 WebGL 上下文，和 3D 轨迹抢的是同一块显卡。
 * 把"能开几个"和"跑不动时先舍什么"写成纯函数，既能在没有 GPU 的单测里钉住，
 * 也避免以后改阈值时只改了一半（渲染循环和设备预算各写一套是这类降级最常见的坏味道）。
 *
 * 预算（与 3D 轨迹分开记账）：
 * - 画布内姿态视图：**1** 个（沿用单实例互斥，再拖一次只会提示"已内嵌"）；
 * - 停靠区 3D 姿态：1 个 ⇒ 应用内姿态 WebGL 上下文上限 2；
 * - 3D 轨迹：自己一份预算 1，不与姿态视图相加判断。
 *
 * 阶梯（只降不升；重挂载回到 0 级，避免在临界 fps 上反复横跳）：
 *   0 全画质：dpr×zf，上限 2，目标 30fps
 *   1 降像素比：同一目标帧率，像素比上限 1.5
 *   2 低功耗：像素比上限 1，目标 20fps
 */
export const ATTITUDE_VIEW_MAX_INSTANCES = 1;
export const ATTITUDE_WEBGL_BUDGET = 2;
export const TRAJECTORY_WEBGL_BUDGET = 1;

export type QualityLevel = 0 | 1 | 2;

export interface QualitySample {
  /** 最近窗口内的平均帧率 */
  fps: number;
  /** 已经在当前级别停留了多久（ms） */
  msInLevel: number;
}

interface Tier {
  dprCap: number;
  targetFps: number;
  /** 掉到该帧率以下并持续 dwellMs 才降级 */
  downFps: number;
  dwellMs: number;
}

const TIERS: Record<QualityLevel, Tier> = {
  0: { dprCap: 2, targetFps: 30, downFps: 24, dwellMs: 2000 },
  1: { dprCap: 1.5, targetFps: 30, downFps: 20, dwellMs: 2000 },
  2: { dprCap: 1, targetFps: 20, downFps: 0, dwellMs: Infinity },
};

export function nextQuality(level: QualityLevel, s: QualitySample): QualityLevel {
  const t = TIERS[level];
  if (level >= 2) return 2;
  if (s.fps > 0 && s.fps < t.downFps && s.msInLevel >= t.dwellMs) {
    return (level + 1) as QualityLevel;
  }
  return level;
}

export function dprCapOf(level: QualityLevel): number {
  return TIERS[level].dprCap;
}

export function targetFpsOf(level: QualityLevel): number {
  return TIERS[level].targetFps;
}

/**
 * 设备像素比 = dpr × 界面缩放，再被当前档位与硬上限 2 夹住。
 * 乘 zf 的理由：全局缩放只改 CSS 尺寸，画布的物理像素由这里决定，不乘会在大缩放下发糊。
 */
export function pixelRatioFor(dpr: number, zf: number, level: QualityLevel): number {
  const base = Math.max(1, Number.isFinite(dpr) ? dpr : 1) * (Number.isFinite(zf) ? zf : 1);
  return Math.max(1, Math.min(base, dprCapOf(level), 2));
}
