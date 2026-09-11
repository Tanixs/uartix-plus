/**
 * 面板 → AI 动作的单点共享（P63d）。
 *
 * 面板每次「采样分析 / 重选帧长 / 簇分析」后发布冻结快照与簇结果；
 * AI 动作（xrayEvidence/xrayCrack/xrayReport）从这里取数。
 * 生命周期红线不受影响：不新增帧流订阅、不在面板关闭后继续累积——
 * 发布的只是静态分析快照（有 256KB 上限），面板关闭后仍可供 AI 查询。
 */
import type { Analysis, FrameType } from "./xrayEngine";

let last: { analysis: Analysis; cluster: FrameType[] } | null = null;

export function publishXray(a: Analysis, cluster: FrameType[]): void {
  last = { analysis: a, cluster };
}

export function lastXray(): { analysis: Analysis; cluster: FrameType[] } | null {
  return last;
}
