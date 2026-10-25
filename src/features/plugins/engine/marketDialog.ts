import { useSyncExternalStore } from "react";

/** 市场弹窗的开关放在一个叶子里：旧插件管理工具栏、新引擎列表、AI 动作都只发同一个信号。 */
let open = false;
const subs = new Set<() => void>();

function emit(): void {
  for (const f of subs) f();
}

export function openMarketDialog(): void {
  open = true;
  emit();
}

export function closeMarketDialog(): void {
  open = false;
  emit();
}

export function isMarketDialogOpen(): boolean {
  return open;
}

export function subscribeMarketDialog(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useMarketDialogOpen(): boolean {
  return useSyncExternalStore(subscribeMarketDialog, isMarketDialogOpen, isMarketDialogOpen);
}
