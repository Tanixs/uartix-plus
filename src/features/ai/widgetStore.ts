import { useSyncExternalStore } from "react";

export interface AiWidget {
  id: string;
  name: string;
  html: string;
  createdAt: number;
}

export interface WidgetSnapshot {
  widgets: AiWidget[];
  openIds: string[];
}

const KEY = "vs.aiWidgets";

function load(): WidgetSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<WidgetSnapshot>;
      return {
        widgets: Array.isArray(p.widgets) ? p.widgets : [],
        openIds: Array.isArray(p.openIds) ? p.openIds : [],
      };
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { widgets: [], openIds: [] };
}

let snapshot: WidgetSnapshot = load();
const listeners = new Set<() => void>();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(snapshot));
}

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
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

export function useWidgets() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function addWidget(name: string, html: string): string {
  const id = crypto.randomUUID();
  snapshot = {
    widgets: [...snapshot.widgets, { id, name, html, createdAt: Date.now() }],
    openIds: [...snapshot.openIds, id],
  };
  persist();
  emit();
  return id;
}

export function removeWidget(id: string) {
  snapshot = {
    widgets: snapshot.widgets.filter((w) => w.id !== id),
    openIds: snapshot.openIds.filter((x) => x !== id),
  };
  persist();
  emit();
}

export function setOpen(id: string, open: boolean) {
  const has = snapshot.openIds.includes(id);
  if (open === has) return;
  snapshot = {
    ...snapshot,
    openIds: open ? [...snapshot.openIds, id] : snapshot.openIds.filter((x) => x !== id),
  };
  persist();
  emit();
}

export function isOpen(id: string): boolean {
  return snapshot.openIds.includes(id);
}

export function clearAll() {
  snapshot = { widgets: [], openIds: [] };
  persist();
  emit();
}
