import { useSyncExternalStore } from "react";

export type WorkspacePreset = "proto" | "analyze" | "attitude" | "console" | "video";

export type ThemeMode =
  | "light"
  | "dark"
  | "navy"
  | "ocean"
  | "matcha"
  | "amber"
  | "begonia"
  | "glaze"
  | "system";

/** 全部主题（设置页色板网格顺序） */
export const THEME_LIST: ThemeMode[] = [
  "light",
  "dark",
  "system",
  "ocean",
  "navy",
  "matcha",
  "amber",
  "begonia",
  "glaze",
];

export interface Settings {
  theme: ThemeMode;
  locale: "zh" | "en";
  zoom: number;
  decimals: number;
  perfHud: boolean;
  workspace: WorkspacePreset;
  cellSize: number;
  aiPreset: AiPreset;
  aiFormat: AiFormat;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiTemperature: number;
  aiProxy: string;
  aiNoProxy: string;
  aiCreativity: boolean;
  aiWidgetSend: boolean;
}

export type AiPreset = "openai" | "deepseek" | "qwen" | "ollama" | "anthropic";

export type AiFormat = "chat" | "anthropic" | "responses";

export const AI_FORMATS: { key: AiFormat; label: string }[] = [
  { key: "chat", label: "Chat Completions (/chat/completions)" },
  { key: "anthropic", label: "Anthropic Messages (/v1/messages)" },
  { key: "responses", label: "Responses (/responses)" },
];

export const AI_PRESETS: Record<AiPreset, { label: string; baseUrl: string; model: string }> = {
  openai: { label: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  qwen: { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  ollama: { label: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
};

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
    aiPreset: "deepseek",
    aiFormat: "chat",
    aiBaseUrl: AI_PRESETS.deepseek.baseUrl,
    aiApiKey: "",
    aiModel: AI_PRESETS.deepseek.model,
    aiTemperature: 0.3,
    aiProxy: "",
    aiNoProxy: "",
    aiCreativity: false,
    aiWidgetSend: false,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: THEME_LIST.includes(p.theme as ThemeMode)
        ? (p.theme as ThemeMode)
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
      aiPreset: (["openai", "deepseek", "qwen", "ollama", "anthropic"] as const).includes(
        p.aiPreset as AiPreset,
      )
        ? (p.aiPreset as AiPreset)
        : "deepseek",
      aiFormat: (["chat", "anthropic", "responses"] as const).includes(p.aiFormat as AiFormat)
        ? (p.aiFormat as AiFormat)
        : "chat",
      aiBaseUrl: typeof p.aiBaseUrl === "string" ? p.aiBaseUrl : AI_PRESETS.deepseek.baseUrl,
      aiApiKey: typeof p.aiApiKey === "string" ? p.aiApiKey : "",
      aiModel: typeof p.aiModel === "string" && p.aiModel ? p.aiModel : AI_PRESETS.deepseek.model,
      aiTemperature:
        typeof p.aiTemperature === "number" && p.aiTemperature >= 0 && p.aiTemperature <= 2
          ? p.aiTemperature
          : 0.3,
      aiProxy: typeof p.aiProxy === "string" ? p.aiProxy : "",
      aiNoProxy: typeof p.aiNoProxy === "string" ? p.aiNoProxy : "",
      aiCreativity: Boolean(p.aiCreativity),
      aiWidgetSend: Boolean(p.aiWidgetSend),
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
