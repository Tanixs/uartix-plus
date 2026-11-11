/**
 * 姿态视图的实例预算与降级阶梯（配置层）。
 *
 * 状态机在 `panels/viewQuality.ts`（与 3D 轨迹视图共用同一份实现），这里只给姿态自己的数：
 * 每实例一个真 WebGL 上下文，和 3D 轨迹抢的是同一块显卡，但预算**分开记账**：
 * - 画布内姿态视图：**1** 个（单实例互斥，再拖一次只会提示"已内嵌"）；
 * - 停靠区 3D 姿态：1 个 ⇒ 应用内姿态 WebGL 上下文上限 2；
 * - 3D 轨迹：自己一份预算（停靠 1 + 轨迹视图 1），不与姿态相加判断。
 *
 * 阶梯（只降不升；重挂载回到 0 级，避免在临界 fps 上反复横跳）：
 *   0 全画质：dpr×zf，上限 2，目标 30fps
 *   1 降像素比：同一目标帧率，像素比上限 1.5
 *   2 低功耗：像素比上限 1，目标 20fps
 */
import { makeLadder, type QualityTiers } from "../../panels/viewQuality";

export type { QualityLevel, QualitySample } from "../../panels/viewQuality";

export const ATTITUDE_VIEW_MAX_INSTANCES = 1;
export const ATTITUDE_WEBGL_BUDGET = 2;

const TIERS: QualityTiers = {
  0: { dprCap: 2, targetFps: 30, downFps: 24, dwellMs: 2000 },
  1: { dprCap: 1.5, targetFps: 30, downFps: 20, dwellMs: 2000 },
  2: { dprCap: 1, targetFps: 20, downFps: 0, dwellMs: Infinity },
};

const ladder = makeLadder(TIERS);

export const nextQuality = ladder.nextQuality;
export const dprCapOf = ladder.dprCapOf;
export const targetFpsOf = ladder.targetFpsOf;
export const pixelRatioFor = ladder.pixelRatioFor;
