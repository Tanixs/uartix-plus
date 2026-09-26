import { useSyncExternalStore } from "react";
// P99b-N6：示例货架的地址只有一处定义（市场契约叶子，不拉 store、不碰 Tauri）——
// 默认值、读不到时的回落、设置页那句回显都引它，省掉"设置页说的默认值 ≠ 实际取的那条"。
import { MARKET_BUNDLED_INDEX_URL } from "../market/marketIndex";

/** 九套内置工作区预设：运行时唯一事实源（normalize、appActions 白名单、layout_apply 工具同引这一份） */
export const WORKSPACE_PRESETS = [
  "proto",
  "analyze",
  "attitude",
  "console",
  "video",
  "calib",
  "auto",
  "modbus",
  "vdev",
] as const;

export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];

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
  /** 帧画布字节格边长（px，20~96；P86b，与控制画布 cellSize 无关） */
  fcCellSize: number;
  // P110-B1：`aiPreset` / `aiFormat` / `aiBaseUrl` / `aiApiKey` / `aiModel` 五键已删除。
  // 它们搬进了 `features/ai/aiProfileStore.ts` 的两张表（供应商 / 模型档案）。
  // 留在这里的只有"与哪台机器无关的全局偏好"：温度、代理、超时、发送总闸。
  aiTemperature: number;
  aiProxy: string;
  aiNoProxy: string;
  /** P98-M2：aiCreativity / aiScript 已删（死码与假装生效的安全控件） */
  aiWidgetSend: boolean;
  /** P88e B2：Agent 通用工具——文件白名单（分号/换行分隔的绝对路径；空=fs_read/fs_list 关闭） */
  agentFsRoots: string;
  /** P88e B2：Agent 通用工具——命令执行总开关（默认关；开启后 shell_exec 仍需逐次审批） */
  agentShellEnabled: boolean;
  /**
   * P109-D：重启后要不要**保留**「全权执行 / 手工勾选」这一档。默认 false = 保持原行为
   * （回落「界面创造」并如实标 downgraded）。这是 2026-09-26 用户点名的放松（§8-44 要求单独点头）；
   * 开了它，高危授权就跨重启存活 —— 所以开关本身必须是 protected：模型不许自己开。
   */
  agentRestoreTier: boolean;
  showThinking: boolean;
  /** P96-K4：是否让模型进入"先想后答"模式（与 showThinking 的界面显示解耦）。
   *  思考模式会显著拉长首字节前的静默，是网关按空闲掐断的主要来源，所以单独成项。 */
  deepThink: boolean;
  /** P96-K4：流式相邻两 chunk 之间的读空闲上限（秒）；只约束我们这一侧，管不到上游网关 */
  streamIdleSecs: number;
  /* P109-A：Agent 预算，**0 = 不限制**，默认全部不限（2026-09-26 用户裁决，对标 DSH
     "No built-in turn budget"）。它们以前是 `loop.ts` 里两处 `Math.min` 焊死的天花板，
     而"允许收紧不允许放宽"那句从来不是用户裁决。
     ⚠ 三项在 settingsSchema 里必须是 `protected`：Agent 不能写自己的上限，
     否则"成本责任回到用户侧"就是一句空话（有测试钉）。 */
  agentMaxRounds: number;
  agentMaxCalls: number;
  /** 单位：分钟（界面按分钟说话，落盘也是分钟；换算成 ms 只发生在交给 loop 的那一处） */
  agentTimeoutMins: number;
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
  /** 插件市场（P99b-N1）：索引地址。默认是应用自带的示例货架（同源，不联网） */
  marketIndexUrl: string;
  /** 国内可达性兜底：直连失败后才试的 https 前缀，域同样要过市场白名单（空＝不用） */
  marketMirrorPrefix: string;
}

/** 设置页「插件管理」那一栏的键——标题栏那颗、页签表、渲染分支都引它，别各处再写一遍 "ext" */
export const SETTINGS_TAB_PLUGINS = "ext";

export type AiPreset =
  | "openai"
  | "deepseek"
  | "zhipu"
  | "qwen"
  | "ollama"
  | "anthropic"
  | "openrouter";

export type AiFormat = "chat" | "anthropic" | "responses";

export const AI_FORMATS: { key: AiFormat; label: string }[] = [
  { key: "chat", label: "Chat Completions (/chat/completions)" },
  { key: "anthropic", label: "Anthropic Messages (/v1/messages)" },
  { key: "responses", label: "Responses (/responses)" },
];

/** AI 服务预设（2026-09 按各家官方文档刷新：默认模型名以官方 API ID 为准）
 *  `keyHint` 只在真实前缀不是通用的 `sk-…` 时才给（P108）：输入框里那句提示是用户唯一
 *  能对照"我贴的这串长得对不对"的地方，缺前缀这类事故就发生在这里。 */
export const AI_PRESETS: Record<
  AiPreset,
  { label: string; baseUrl: string; model: string; keyHint?: string }
> = {
  openai: { label: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-sol" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3" },
  qwen: { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-flash" },
  ollama: { label: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "gemma4:12b" },
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
  // P108：网关不是厂商，模型名由用户挑 —— 默认给一条**实测存在**的 `:free` 路由
  // （2026-09-26 从公开 /api/v1/models 的 458 条里核对），不替用户默认一个要花钱的档位。
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.8-27b:free",
    keyHint: "sk-or-v1-…",
  },
};

/** P110-B1：旧模型名迁移表随 `aiModel` 一起删除（零兼容裁决：未发布、无存量用户）。
 *  模型名的真相现在是 `aiProfileStore` 里那条 `AiModelProfile.model`，用户自己改。 */

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

/** P109-A：预算项的恢复口径。**0 是合法值且就是默认（不限制）**，所以非法值也落回 0，
 *  而不是偷偷给用户开一个他以为关着的上限。`max` 只防手滑输入天文数字。 */
function clampBudgetNum(v: unknown, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function load(): Settings {
  const fallback: Settings = {
    /* P104-B2：默认主题 海棠 → light。
       不是因为海棠不好看，而是 P104 的层级规则要求「accent 面积 ≤3%、层级由明度档承担」——
       海棠的 accent 就是它的主色，任何 accent 化都等于给整屏上色，那条预算在它身上执行不干净。
       light (#f5f6f8/#ffffff/#eceef1/#eef0f4) 实测壳/面板 1.141、画布/面板 1.081，本就是中性档。
       海棠仍在 THEME_LIST 里可选，只是不再当默认；老用户已存的 vs.settings 不受影响。 */
    theme: localStorage.getItem("vs.theme") === "dark" ? "dark" : "light",
    locale: "zh",
    zoom: 100,
    decimals: clampDecimals(localStorage.getItem("vs.decimals") ?? "2", 2),
    perfHud: false,
    workspace: "proto",
    cellSize: 60,
    fcCellSize: 42,
    aiTemperature: 0.3,
    aiProxy: "",
    aiNoProxy: "",
    aiWidgetSend: false,
    agentFsRoots: "",
    agentShellEnabled: false,
    agentRestoreTier: false,
    showThinking: true,
    deepThink: true,
    streamIdleSecs: 120,
    agentMaxRounds: 0,
    agentMaxCalls: 0,
    agentTimeoutMins: 0,
    chartPalette: "standard",
    conWrap: true,
    reduceMotion: false,
    autoReconnect: false,
    mcpEnabled: false,
    mcpPort: 7731,
    mcpAllowSend: false,
    mcpHighPriv: false,
    mcpToken: newToken(),
    marketIndexUrl: MARKET_BUNDLED_INDEX_URL,
    marketMirrorPrefix: "",
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
      workspace: (WORKSPACE_PRESETS as readonly string[]).includes(p.workspace as string)
        ? (p.workspace as WorkspacePreset)
        : "proto",
      cellSize: [48, 60, 72, 90, 110].includes(p.cellSize ?? 60)
        ? (p.cellSize as number)
        : 60,
      fcCellSize: Number.isFinite(p.fcCellSize)
        ? Math.max(20, Math.min(96, Math.round(p.fcCellSize as number)))
        : 42,
      // P110-B1：这五条（aiPreset / aiFormat / aiBaseUrl / aiApiKey / aiModel）连同下面的
      // `LEGACY_MODEL_IDS` 一起删掉了 —— 供应商与模型现在住在 `features/ai/aiProfileStore.ts`，
      // 那张表自己 normalize，坏一行整表退回 seed。
      // P108 那条教训跟着搬过去，别丢：**名单必须从 AI_PRESETS 派生**，手抄一份的后果不是编译错，
      // 是"选了新档、重启软件，预设被静默退回 deepseek、baseUrl 跟着被覆盖"。
      aiTemperature:
        typeof p.aiTemperature === "number" && p.aiTemperature >= 0 && p.aiTemperature <= 2
          ? p.aiTemperature
          : 0.3,
      aiProxy: typeof p.aiProxy === "string" ? p.aiProxy : "",
      aiNoProxy: typeof p.aiNoProxy === "string" ? p.aiNoProxy : "",
      aiWidgetSend: Boolean(p.aiWidgetSend),
      agentFsRoots: typeof p.agentFsRoots === "string" ? p.agentFsRoots.slice(0, 4096) : "",
      agentShellEnabled: Boolean(p.agentShellEnabled),
      agentRestoreTier: Boolean(p.agentRestoreTier),
      showThinking: p.showThinking === undefined ? true : Boolean(p.showThinking),
      deepThink: p.deepThink === undefined ? true : Boolean(p.deepThink),
      streamIdleSecs: (() => {
        const n = Math.round(Number(p.streamIdleSecs));
        return Number.isFinite(n) && n >= 30 && n <= 600 ? n : 120;
      })(),
      // P109-A：0 = 不限制，所以"洗掉非法值"的落点也是 0（默认就是不限）；上限只是防手滑输入
      // 一个天文数字把界面计数撑坏，不是安全边界。
      agentMaxRounds: clampBudgetNum(p.agentMaxRounds, 100000),
      agentMaxCalls: clampBudgetNum(p.agentMaxCalls, 100000),
      agentTimeoutMins: clampBudgetNum(p.agentTimeoutMins, 1440),
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
      marketIndexUrl:
        typeof p.marketIndexUrl === "string" && p.marketIndexUrl.trim()
          ? p.marketIndexUrl.trim().slice(0, 300)
          : MARKET_BUNDLED_INDEX_URL,
      marketMirrorPrefix: typeof p.marketMirrorPrefix === "string" ? p.marketMirrorPrefix.trim().slice(0, 300) : "",
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
