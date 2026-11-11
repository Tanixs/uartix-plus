/**
 * 3D 轨迹视图的实例预算与降级阶梯（配置层）。
 *
 * 与姿态视图共用 `panels/viewQuality.ts` 的状态机，但预算与阈值独立：
 * - 视图同屏 **1** 个；停靠区 `plot3d` 整板另有 1 个 ⇒ 轨迹自身上限 2，**不与姿态相加**；
 * - 每实例最多 3 组 ×（12 万尾窗 + 10 万全景）= 66 万点，比姿态模型重得多，
 *   所以降级阈值放得比姿态更宽（22/18fps，dwell 2500ms）：短暂 GC / 导入抖动
 *   不应把还在 30fps 的画面误降到低清。
 *
 * 阶梯（只降不升；重挂载回到 L0）：
 *   0 全画质：dpr×zf，上限 2，目标 30fps
 *   1 降像素比：上限 1.5，目标 30fps
 *   2 低功耗：上限 1，目标 20fps，并给渲染循环加 20fps 上限（真正削 GPU 的那一步）
 */
import {
  makeLadder,
  type QualityLevel,
  type QualityTiers,
} from "../../panels/viewQuality";

export type { QualityLevel, QualitySample } from "../../panels/viewQuality";

export const TRAJECTORY_VIEW_MAX_INSTANCES = 1;
/** 轨迹自身：停靠 1 + 视图 1（预算分开计，不参与姿态的 2 个） */
export const TRAJECTORY_WEBGL_BUDGET = 2;

const TIERS: QualityTiers = {
  0: { dprCap: 2, targetFps: 30, downFps: 22, dwellMs: 2500 },
  1: { dprCap: 1.5, targetFps: 30, downFps: 18, dwellMs: 2500 },
  2: { dprCap: 1, targetFps: 20, downFps: 0, dwellMs: Infinity },
};

const ladder = makeLadder(TIERS);

export const nextQuality = ladder.nextQuality;
export const dprCapOf = ladder.dprCapOf;
export const targetFpsOf = ladder.targetFpsOf;
export const pixelRatioFor = ladder.pixelRatioFor;

/** 渲染循环的上限帧率：0 = 不限（L0/L1 只靠 needsRender 脏标记，不额外节流） */
export function renderFpsCapOf(level: QualityLevel): number {
  return level >= 2 ? 20 : 0;
}
