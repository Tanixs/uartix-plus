/**
 * P123-C · 「属性页现在在编谁」这一位的唯一出处。
 *
 * 为什么要有它：接收侧的选中住在 `templateStore.selection`，发送侧的选中住在
 * `SendBuildPanel` 的组件本地 state。两块各自长出一套属性编辑面，于是同一个动作
 * （点一个字段）在两边是两条代码、两套措辞、两份 CSS。要收成"一个属性页 + 两套 section"，
 * 缺的不是组件，是**"哪一侧现在归它显示"这一位** —— 没有它，属性页就得自己猜。
 *
 * 三条判据：
 *  1. 各侧的真值仍在自己 store 里（`templateStore.selection` / `sendStore` 的谱与块），
 *     这里只记"谁被最后点了一下 + 指向哪个 id"。**不搬数据，只搬注意力**；
 *  2. 同值不 emit —— 联动高亮与滚动都挂在这条总线上，重复通知会闪；
 *  3. 零依赖（连 store 都不 import），否则它就成了依赖图上的又一个枢纽。
 */
import { useSyncExternalStore } from "react";

export type InspectorFocus =
  /** rx = 解析协议（帧画布 / 协议面板）；tx = 发送谱（TX组帧台） */
  { side: "rx" | "tx"; id: string; fieldId: string };

let current: InspectorFocus | null = null;
const subs = new Set<() => void>();

export function getInspectorFocus(): InspectorFocus | null {
  return current;
}

export function setInspectorFocus(next: InspectorFocus | null): void {
  const same =
    (next === null && current === null) ||
    (!!next && !!current && next.side === current.side && next.id === current.id && next.fieldId === current.fieldId);
  if (same) return;
  current = next;
  subs.forEach((cb) => cb());
}

export function subscribeInspector(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/**
 * Esc 的语义：从"某一块"退回"整张谱"。返回是否真的退了（调用方据此决定要不要吃掉这次按键）。
 *
 * 只管 tx：rx 那一侧有自己的退法（`FrameCanvas` 的 Esc 会写回 `templateStore.selection`，
 * 那才是它的真值），在这里替它退就会让 selection 与焦点各说一套。
 */
export function txeBackToSpec(): boolean {
  const f = current;
  if (!f || f.side !== "tx" || !f.fieldId) return false;
  setInspectorFocus({ side: "tx", id: f.id, fieldId: "" });
  return true;
}

export function useInspectorFocus(): InspectorFocus | null {
  return useSyncExternalStore(subscribeInspector, getInspectorFocus, getInspectorFocus);
}
