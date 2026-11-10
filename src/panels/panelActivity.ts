/**
 * 面板活动注册表：记录面板的「打开」与「可见」状态。
 *
 * - 「打开」（open）= 面板存在**任一形态**：停靠在布局里，或作为控制画布的内嵌卡片。
 *   两种形态互斥（同一 panelId 只能有一处挂载），所以这里仍按 id 记账，不需要实例维度。
 *   都不存在 → 对应 store 完全停止处理数据（用户红线：面板没开绝不允许后台运行）。
 * - 「可见」（visible）= 停靠时处于所在标签组前台页签；内嵌时要求宿主控制画布可见
 *   **且卡片没有滚出画布视口**。不可见但仍打开 → 数据进有界缓冲，跳过渲染。
 *
 * 停靠状态由 App.tsx 在 dockview 事件中 syncPanels() 全量同步；内嵌状态由内嵌宿主
 * 调 setEmbeddedPanels() 同步。两者在这里取并集，业务侧 7 处 isOpen() 判断不用改。
 */

const dockedPanels = new Set<string>();
const dockedVisiblePanels = new Set<string>();
/** 内嵌卡片的面板 id；同一 id 由放置互斥保证至多一张卡。 */
const embeddedPanels = new Set<string>();
/**
 * 已内嵌但滚出画布视口的面板。与 embeddedPanels 分开记：
 * "卡片还在"（open）与"眼睛看得见"（visible）是两件事，前者决定数据泵要不要跑。
 */
const hiddenEmbedded = new Set<string>();
/** 内嵌卡片所在的宿主面板 id（当前只有控制画布），宿主不可见时内嵌也不算可见。 */
let embeddedGateId = "controls";

const openPanels = new Set<string>();
const visiblePanels = new Set<string>();
const listeners = new Set<() => void>();

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** 停靠集合与内嵌集合合并后发布；不变则不发，避免 dockview 高频事件里打空转。 */
function recompute() {
  const nextOpen = new Set(dockedPanels);
  for (const id of embeddedPanels) nextOpen.add(id);
  const nextVisible = new Set(dockedVisiblePanels);
  if (dockedVisiblePanels.has(embeddedGateId)) {
    for (const id of embeddedPanels) {
      if (!hiddenEmbedded.has(id)) nextVisible.add(id);
    }
  }
  if (sameSet(nextOpen, openPanels) && sameSet(nextVisible, visiblePanels)) {
    return;
  }
  openPanels.clear();
  for (const id of nextOpen) openPanels.add(id);
  visiblePanels.clear();
  for (const id of nextVisible) visiblePanels.add(id);
  listeners.forEach((l) => l());
}

export function syncPanels(list: { id: string; visible: boolean }[]) {
  dockedPanels.clear();
  for (const x of list) dockedPanels.add(x.id);
  dockedVisiblePanels.clear();
  for (const x of list) if (x.visible) dockedVisiblePanels.add(x.id);
  recompute();
}

/**
 * 同步内嵌卡片。`ids` 是当前**真正渲染出来**的内嵌面板 id（不是画布上所有卡片 id）：
 * 面板页签切到后台时宿主仍在，是否可见由 gate 面板的 dock 可见性决定。
 */
export function setEmbeddedPanels(ids: string[], gatePanelId = "controls") {
  const next = new Set(ids.filter(Boolean));
  if (sameSet(next, embeddedPanels) && gatePanelId === embeddedGateId) return;
  embeddedPanels.clear();
  for (const id of next) embeddedPanels.add(id);
  // 换页 / 删卡后不留旧标记：下一次挂载应当是"可见"的。
  for (const id of [...hiddenEmbedded]) {
    if (!next.has(id)) hiddenEmbedded.delete(id);
  }
  embeddedGateId = gatePanelId;
  recompute();
}

/**
 * 内嵌卡片是否滚出画布视口。由宿主用 rAF 比较卡片 rect 与 `.ctl-grid` 视口后写入；
 * 只在布尔值变化时调，registry 内部再判一次变化，调用点不用自己防抖。
 */
export function setEmbeddedCardVisible(id: string, visible: boolean): void {
  const changed = visible ? hiddenEmbedded.delete(id) : !hiddenEmbedded.has(id);
  if (!visible && changed) hiddenEmbedded.add(id);
  if (changed) recompute();
}

/** 卡片卸载时清掉隐藏标记，避免下次挂载前误判成"不可见"。 */
export function clearEmbeddedCardVisibility(id: string): void {
  if (hiddenEmbedded.delete(id)) recompute();
}

export function isOpen(id: string): boolean {
  return openPanels.has(id);
}

export function isVisible(id: string): boolean {
  return visiblePanels.has(id);
}

/** 仅停靠形态存在。放置互斥用：dock 里已经开着的面板不能再内嵌一张。 */
export function isDocked(id: string): boolean {
  return dockedPanels.has(id);
}

/** 仅内嵌形态存在。 */
export function isEmbedded(id: string): boolean {
  return embeddedPanels.has(id);
}

/** 面板可见性恢复时需要补一次 emit 的 store 订阅此事件 */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * `useSyncExternalStore` 的快照函数。**必须返回不可变比较得出的稳定值**，
 * 所以这里返回排序后的 id 串，而不是 Set 本身（Set 每次比较都不相等 ⇒ 无限重渲染）。
 *
 * 放这里而不是各消费方自己拼：RailPanel 原先有一份本地 `activityVersion()`，
 * B9 的命令面板也要读同一件事——再抄一份就是"哪些面板开着"的第二个真值。
 */
let cachedKeys = "";
let cachedSnapshot = "";
export function getSnapshot(): string {
  const keys = [...openPanels].sort().join(",");
  if (keys !== cachedKeys) {
    cachedKeys = keys;
    cachedSnapshot = keys + "|" + [...visiblePanels].sort().join(",");
  }
  return cachedSnapshot;
}
