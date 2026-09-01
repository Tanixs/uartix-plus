/**
 * 面板活动注册表：记录 dockview 面板的「打开」与「可见」状态。
 *
 * - 「打开」（open）= 面板存在于布局中（未被用户点 × 关闭）。
 *   关闭的面板 → 对应 store 完全停止处理数据（用户红线：关闭了的面板
 *   绝不允许在后台运行）。
 * - 「可见」（visible）= 面板打开且处于所在标签组的前台页签。
 *   堆叠在后台的面板 → 数据仍进有界缓冲（切回前台不丢数据），
 *   但跳过 React emit / canvas 重绘 / DOM 写入等渲染开销。
 *
 * 状态由 App.tsx 在 dockview 事件（add/remove/active/layout change）中
 * 调用 syncPanels() 全量同步；本模块不做 DOM 探测，避免 CSS zoom 误判。
 */

const openPanels = new Set<string>();
const visiblePanels = new Set<string>();
const listeners = new Set<() => void>();

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function syncPanels(list: { id: string; visible: boolean }[]) {
  const nextOpen = new Set(list.map((x) => x.id));
  const nextVisible = new Set(
    list.filter((x) => x.visible).map((x) => x.id),
  );
  if (sameSet(nextOpen, openPanels) && sameSet(nextVisible, visiblePanels)) {
    return;
  }
  openPanels.clear();
  for (const id of nextOpen) openPanels.add(id);
  visiblePanels.clear();
  for (const id of nextVisible) visiblePanels.add(id);
  listeners.forEach((l) => l());
}

export function isOpen(id: string): boolean {
  return openPanels.has(id);
}

export function isVisible(id: string): boolean {
  return visiblePanels.has(id);
}

/** 面板可见性恢复时需要补一次 emit 的 store 订阅此事件 */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
