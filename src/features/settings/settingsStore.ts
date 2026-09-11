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
  aiScript: boolean;
  showThinking: boolean;
  chartPalette: "standard" | "cbSafe";
  conWrap: boolean;
  /** 减弱动效：强制关闭呼吸/过渡动画（独立于系统 prefers-reduced-motion） */
  reduceMotion: boolean;
  /** 串口/网络意外断开后自动重连（用户主动断开不触发） */
  autoReconnect: boolean;
  /** MCP 桥（P64）：对外暴露给 AI IDE 的本地控制平面 */
  mcpEnabled: boolean;
  mcpPort: number;
  /** 远程发送/跑序列门控（send / run_sequence 工具） */
  mcpAllowSend: boolean;
  /** 高权限动作门控（openPort/closePort 等 HIGH_ONLY 动作） */
  mcpHighPriv: boolean;
  /** 桥握手 token（首启自动生成，32 hex） */
  mcpToken: string;
}

export type AiPreset = "openai" | "deepseek" | "zhipu" | "qwen" | "ollama" | "anthropic";

export type AiFormat = "chat" | "anthropic" | "responses";

export const AI_FORMATS: { key: AiFormat; label: string }[] = [
  { key: "chat", label: "Chat Completions (/chat/completions)" },
  { key: "anthropic", label: "Anthropic Messages (/v1/messages)" },
  { key: "responses", label: "Responses (/responses)" },
];

/** AI 服务预设（2026-09 按各家官方文档刷新：默认模型名以官方 API ID 为准） */
export const AI_PRESETS: Record<AiPreset, { label: string; baseUrl: string; model: string }> = {
  openai: { label: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3" },
  qwen: { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-flash" },
  ollama: { label: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "gemma4:12b" },
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
};

/** 旧预设模型名 → 现行官方 ID 的存量迁移表（如 deepseek-chat 已于 2026-07-24 停服） */
const LEGACY_MODEL_IDS: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "gpt-4o-mini": "gpt-5.6-sol",
  "gpt-4o": "gpt-5.6-sol",
  "qwen-plus": "qwen3.8-flash",
  "claude-sonnet-4-5": "claude-sonnet-5",
};

const KEY = "vs.settings";

/** MCP 桥握手 token：32 hex（crypto.randomUUID 去连字符 ×2 拼接太长，单个 32 位足够） */
function newToken(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    // 无 crypto 环境（理论上不会）：时间+随机退化
    return `${Date.now().toString(16)}${Math.floor(Math.random() * 2 ** 32).toString(16)}`.padEnd(16, "0");
  }
}

function clampDecimals(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 6 ? n : fallback;
}

function load(): Settings {
  const fallback: Settings = {
    theme: localStorage.getItem("vs.theme") === "dark" ? "dark" : "begonia",
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
    aiScript: false,
    showThinking: true,
    chartPalette: "standard",
    conWrap: true,
    reduceMotion: false,
    autoReconnect: false,
    mcpEnabled: false,
    mcpPort: 7731,
    mcpAllowSend: false,
    mcpHighPriv: false,
    mcpToken: newToken(),
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
      aiPreset: (["openai", "deepseek", "zhipu", "qwen", "ollama", "anthropic"] as const).includes(
        p.aiPreset as AiPreset,
      )
        ? (p.aiPreset as AiPreset)
        : "deepseek",
      aiFormat: (["chat", "anthropic", "responses"] as const).includes(p.aiFormat as AiFormat)
        ? (p.aiFormat as AiFormat)
        : "chat",
      aiBaseUrl: typeof p.aiBaseUrl === "string" ? p.aiBaseUrl : AI_PRESETS.deepseek.baseUrl,
      aiApiKey: typeof p.aiApiKey === "string" ? p.aiApiKey : "",
      aiModel: (() => {
        const m = typeof p.aiModel === "string" && p.aiModel ? p.aiModel : AI_PRESETS.deepseek.model;
        return LEGACY_MODEL_IDS[m] ?? m;
      })(),
      aiTemperature:
        typeof p.aiTemperature === "number" && p.aiTemperature >= 0 && p.aiTemperature <= 2
          ? p.aiTemperature
          : 0.3,
      aiProxy: typeof p.aiProxy === "string" ? p.aiProxy : "",
      aiNoProxy: typeof p.aiNoProxy === "string" ? p.aiNoProxy : "",
      aiCreativity: Boolean(p.aiCreativity),
      aiWidgetSend: Boolean(p.aiWidgetSend),
      aiScript: Boolean(p.aiScript),
      showThinking: p.showThinking === undefined ? true : Boolean(p.showThinking),
      chartPalette: p.chartPalette === "cbSafe" ? "cbSafe" : "standard",
      conWrap: p.conWrap === undefined ? true : Boolean(p.conWrap),
      reduceMotion: Boolean(p.reduceMotion),
      autoReconnect: Boolean(p.autoReconnect),
      mcpEnabled: Boolean(p.mcpEnabled),
      mcpPort: (() => {
        const n = Math.round(Number(p.mcpPort));
        return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : 7731;
      })(),
      mcpAllowSend: Boolean(p.mcpAllowSend),
      mcpHighPriv: Boolean(p.mcpHighPriv),
      mcpToken:
        typeof p.mcpToken === "string" && p.mcpToken.length >= 16 ? p.mcpToken : newToken(),
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
