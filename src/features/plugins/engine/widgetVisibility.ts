/** 小部件的"本次会话隐藏"表：关掉不改变 enabled，插件详情里能再显示回来。 */
import { useSyncExternalStore } from "react";

const hidden = new Set<string>();
let snapshot: readonly string[] = Object.freeze([]);
const subs = new Set<() => void>();

function emit(): void {
  snapshot = Object.freeze([...hidden].sort());
  for (const f of subs) f();
}

export function widgetKey(pluginId: string, widgetId: string): string {
  return `${pluginId}:${widgetId}`;
}

export function hideWidget(key: string): void {
  if (hidden.has(key)) return;
  hidden.add(key);
  emit();
}

export function showWidget(key: string): void {
  if (!hidden.delete(key)) return;
  emit();
}

export function isWidgetHidden(key: string): boolean {
  return hidden.has(key);
}

export function getHiddenWidgets(): readonly string[] {
  return snapshot;
}

export function subscribeWidgetVisibility(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useHiddenWidgets(): readonly string[] {
  return useSyncExternalStore(subscribeWidgetVisibility, getHiddenWidgets, getHiddenWidgets);
}
