import { useSyncExternalStore } from "react";
import type { ThemeMode } from "../../ipc/types";

export type WorkspacePreset = "proto" | "analyze" | "attitude" | "console";

export interface Settings {
  theme: ThemeMode;
  locale: "zh" | "en";
  zoom: number;
  decimals: number;
  perfHud: boolean;
  workspace: WorkspacePreset;
  cellSize: number;
}

const KEY = "vs.settings";

function load(): Settings {
  const fallback: Settings = {
    theme: localStorage.getItem("vs.theme") === "light" ? "light" : "dark",
    locale: "zh",
    zoom: 100,
    decimals: parseInt(localStorage.getItem("vs.decimals") ?? "2", 10) || 2,
    perfHud: false,
    workspace: "proto",
    cellSize: 90,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: p.theme === "light" ? "light" : p.theme === "dark" ? "dark" : fallback.theme,
      locale: p.locale === "en" ? "en" : "zh",
      zoom: [90, 100, 110, 125].includes(p.zoom ?? 100) ? (p.zoom as number) : 100,
      decimals: [0, 2, 4, 6].includes(p.decimals ?? 2) ? (p.decimals as number) : 2,
      perfHud: Boolean(p.perfHud),
      workspace: (["proto", "analyze", "attitude", "console"] as const).includes(
        p.workspace as WorkspacePreset,
      )
        ? (p.workspace as WorkspacePreset)
        : "proto",
      cellSize: [60, 72, 90, 110].includes(p.cellSize ?? 90) ? (p.cellSize as number) : 90,
    };
  } catch {
    return fallback;
  }
}

let snapshot: Settings = load();
const listeners = new Set<() => void>();

function emit() {
  snapshot = { ...snapshot };
  localStorage.setItem(KEY, JSON.stringify(snapshot));
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

export function useSettings() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function patch(p: Partial<Settings>) {
  snapshot = { ...snapshot, ...p };
  emit();
}
