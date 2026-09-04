/**
 * 自定义布局槽位：用户可将当前 dockview 布局另存为命名布局，
 * 随时切回；内置预设切换前自动把当前布局快照到「自动备份」槽。
 */
import { useSyncExternalStore } from "react";

export interface LayoutSlot {
  id: string;
  name: string;
  /** dockview api.toJSON() 序列化结果 */
  layout: unknown;
  ts: number;
  /** true = 切内置预设时的自动备份（最多保留 1 个，被新备份覆盖） */
  auto?: boolean;
}

interface LayoutsSnapshot {
  slots: LayoutSlot[];
}

const KEY = "vs.layouts";

function load(): LayoutsSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { slots?: LayoutSlot[] };
      if (Array.isArray(parsed.slots)) {
        return {
          slots: parsed.slots.filter(
            (s) => s && s.id && typeof s.name === "string" && s.layout,
          ),
        };
      }
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { slots: [] };
}

let snapshot: LayoutsSnapshot = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  }, 250);
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snapshot;
}

export function useLayouts() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getLayout(id: string): LayoutSlot | null {
  return snapshot.slots.find((s) => s.id === id) ?? null;
}

/** 另存为命名布局（最多 12 个） */
export function saveLayout(name: string, layout: unknown): string {
  const slot: LayoutSlot = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 24) || `布局 ${snapshot.slots.length + 1}`,
    layout,
    ts: Date.now(),
  };
  let slots = [...snapshot.slots, slot];
  // 超出容量：优先淘汰最旧的自动备份，再淘汰最旧的手动布局
  if (slots.length > 12) {
    const autoIdx = slots.findIndex((s) => s.auto);
    if (autoIdx >= 0) slots.splice(autoIdx, 1);
    else slots = slots.slice(slots.length - 12);
  }
  snapshot = { slots };
  emit();
  return slot.id;
}

/** 切内置预设前调用：当前布局快照到 auto 槽（覆盖旧的） */
export function backupAutoLayout(layout: unknown) {
  snapshot = {
    slots: [...snapshot.slots.filter((s) => !s.auto), {
      id: "auto-backup",
      name: "上次切换前的布局（自动）",
      layout,
      ts: Date.now(),
      auto: true,
    }],
  };
  emit();
}

export function removeLayout(id: string) {
  snapshot = { slots: snapshot.slots.filter((s) => s.id !== id) };
  emit();
}

export function renameLayout(id: string, name: string) {
  snapshot = {
    slots: snapshot.slots.map((s) =>
      s.id === id ? { ...s, name: name.trim().slice(0, 24) || s.name } : s,
    ),
  };
  emit();
}
