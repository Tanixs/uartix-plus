import { useSyncExternalStore } from "react";

export type WorkspacePreset = "proto" | "analyze" | "attitude" | "console" | "video";

export type ThemeMode = "light" | "dark" | "system";

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

function clampDecimals(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 6 ? n : fallback;
}

function load(): Settings {
  const fallback: Settings = {
    theme: localStorage.getItem("vs.theme") === "dark" ? "dark" : "light",
    locale: "zh",
    zoom: 100,
    decimals: clampDecimals(localStorage.getItem("vs.decimals") ?? "2", 2),
    perfHud: false,
    workspace: "proto",
    cellSize: 60,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      theme:
        p.theme === "light" || p.theme === "dark" || p.theme === "system"
          ? p.theme
          : fallback.theme,
      locale: p.locale === "en" ? "en" : "zh",
      zoom: [90, 100, 110, 125].includes(p.zoom ?? 100) ? (p.zoom as number) : 100,
      decimals: clampDecimals(p.decimals ?? 2, 2),
      perfHud: Boolean(p.perfHud),
      workspace: (["proto", "analyze", "attitude", "console", "video"] as const).includes(
        p.workspace as WorkspacePreset,
      )
        ? (p.workspace as WorkspacePreset)
        : "proto",
      cellSize: [48, 60, 72, 90, 110].includes(p.cellSize ?? 60)
        ? (p.cellSize as number)
        : 60,
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
