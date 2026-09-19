/**
 * P88b-1 §8：SettingsSchema 单一来源。
 * 设置项的类型、范围、默认、分组、敏感性、可撤销性、是否需重启集中声明；
 * Agent 工具（describe/read/previewPatch/applyPatch）与校验器都从这里派生，
 * 不再各自维护白名单 Map。
 *
 * 敏感性分级（详设 §8）：
 * - safe：常规外观/显示偏好，Agent 可在授权范围内直接应用；
 * - protected：设备行为/权限/模型端点等，Agent 只能读取（脱敏）与定位到设置页，不能代改；
 * - secret：API key、桥 token，任何工具输出只返回“是否已配置”，值永不回显。
 */
import { THEME_LIST, AI_PRESETS, type Settings, type ThemeMode, type WorkspacePreset, type AiPreset, type AiFormat } from "./settingsStore";

export type Sensitivity = "safe" | "protected" | "secret";

export type SettingEntry =
  | { key: keyof Settings; type: "enum"; values: readonly (string | number)[]; def: string | number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "int"; min: number; max: number; def: number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "number"; min: number; max: number; def: number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "boolean"; def: boolean; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "string"; maxLen: number; def: string; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean };

const PRESET_KEYS = Object.keys(AI_PRESETS) as AiPreset[];

/** 全量声明：每个 Settings 键恰好一条。 */
export const SETTINGS_SCHEMA: readonly SettingEntry[] = [
  { key: "theme", type: "enum", values: THEME_LIST, def: "begonia", group: "appearance", label: "主题", sensitivity: "safe", reversible: true },
  { key: "locale", type: "enum", values: ["zh", "en"], def: "zh", group: "appearance", label: "语言", sensitivity: "safe", reversible: true },
  { key: "zoom", type: "enum", values: [90, 100, 110, 125], def: 100, group: "appearance", label: "界面缩放", sensitivity: "safe", reversible: true },
  { key: "decimals", type: "int", min: 0, max: 6, def: 2, group: "appearance", label: "显示精度", sensitivity: "safe", reversible: true },
  { key: "perfHud", type: "boolean", def: false, group: "appearance", label: "性能浮窗", sensitivity: "safe", reversible: true },
  { key: "workspace", type: "enum", values: ["proto", "analyze", "attitude", "console", "video", "calib", "auto", "modbus", "vdev"], def: "proto", group: "layout", label: "预设布局", sensitivity: "safe", reversible: true },
  { key: "cellSize", type: "enum", values: [48, 60, 72, 90, 110], def: 60, group: "appearance", label: "控制画布格尺寸", sensitivity: "safe", reversible: true },
  { key: "fcCellSize", type: "int", min: 20, max: 96, def: 42, group: "appearance", label: "帧画布格尺寸", sensitivity: "safe", reversible: true },
  { key: "showThinking", type: "boolean", def: true, group: "appearance", label: "显示思考过程", sensitivity: "safe", reversible: true },
  { key: "chartPalette", type: "enum", values: ["standard", "cbSafe"], def: "standard", group: "appearance", label: "图表配色", sensitivity: "safe", reversible: true },
  { key: "conWrap", type: "boolean", def: true, group: "appearance", label: "控制台自动换行", sensitivity: "safe", reversible: true },
  { key: "reduceMotion", type: "boolean", def: false, group: "appearance", label: "减弱动效", sensitivity: "safe", reversible: true },
  { key: "aiPreset", type: "enum", values: PRESET_KEYS, def: "deepseek", group: "ai", label: "AI 服务预设", sensitivity: "protected", reversible: true },
  { key: "aiFormat", type: "enum", values: ["chat", "anthropic", "responses"], def: "chat", group: "ai", label: "AI 协议格式", sensitivity: "protected", reversible: true },
  { key: "aiBaseUrl", type: "string", maxLen: 512, def: "", group: "ai", label: "AI 服务地址", sensitivity: "protected", reversible: true },
  { key: "aiApiKey", type: "string", maxLen: 512, def: "", group: "ai", label: "AI API 密钥", sensitivity: "secret", reversible: true },
  { key: "aiModel", type: "string", maxLen: 128, def: "", group: "ai", label: "AI 模型名", sensitivity: "protected", reversible: true },
  { key: "aiTemperature", type: "number", min: 0, max: 2, def: 0.3, group: "ai", label: "AI 温度", sensitivity: "protected", reversible: true },
  { key: "aiProxy", type: "string", maxLen: 512, def: "", group: "ai", label: "AI 代理", sensitivity: "protected", reversible: true },
  { key: "aiNoProxy", type: "string", maxLen: 512, def: "", group: "ai", label: "AI 免代理", sensitivity: "protected", reversible: true },
  { key: "aiCreativity", type: "boolean", def: false, group: "ai", label: "AI 创造模式", sensitivity: "protected", reversible: true },
  { key: "aiWidgetSend", type: "boolean", def: false, group: "ai", label: "小部件可发送", sensitivity: "protected", reversible: false },
  { key: "aiScript", type: "boolean", def: false, group: "ai", label: "脚本高权限", sensitivity: "protected", reversible: false },
  { key: "agentFsRoots", type: "string", maxLen: 4096, def: "", group: "ai", label: "Agent 文件白名单", sensitivity: "protected", reversible: false },
  { key: "agentShellEnabled", type: "boolean", def: false, group: "ai", label: "Agent 允许执行命令", sensitivity: "protected", reversible: false },
  { key: "autoReconnect", type: "boolean", def: false, group: "behavior", label: "断线自动重连", sensitivity: "protected", reversible: true },
  { key: "mcpEnabled", type: "boolean", def: false, group: "mcp", label: "MCP 桥开关", sensitivity: "protected", reversible: false, requiresRestart: true },
  { key: "mcpPort", type: "int", min: 1024, max: 65535, def: 7731, group: "mcp", label: "MCP 端口", sensitivity: "protected", reversible: true, requiresRestart: true },
  { key: "mcpAllowSend", type: "boolean", def: false, group: "mcp", label: "MCP 允许远程发送", sensitivity: "protected", reversible: false },
  { key: "mcpHighPriv", type: "boolean", def: false, group: "mcp", label: "MCP 允许高权限动作", sensitivity: "protected", reversible: false },
  { key: "mcpToken", type: "string", maxLen: 128, def: "", group: "mcp", label: "MCP 握手 token", sensitivity: "secret", reversible: true },
] as const satisfies readonly SettingEntry[];

const byKey = new Map(SETTINGS_SCHEMA.map((e) => [e.key as string, e]));

export function schemaEntry(key: string): SettingEntry | undefined {
  return byKey.get(key);
}

/** Agent 可直接应用的键：safe 且可撤销 */
export function agentWritableKeys(): (keyof Settings)[] {
  return SETTINGS_SCHEMA.filter((e) => e.sensitivity === "safe" && e.reversible).map((e) => e.key);
}

/** 逐值校验（与 settingsStore.load 的钳制语义一致，但作为拒绝而非静默修正） */
export function validateValue(entry: SettingEntry, value: unknown): boolean {
  switch (entry.type) {
    case "enum":
      return entry.values.includes(String(value)) || entry.values.includes(value as never);
    case "int":
      return typeof value === "number" && Number.isInteger(value) && value >= entry.min && value <= entry.max;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= entry.min && value <= entry.max;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && value.length <= entry.maxLen;
  }
}

/** describe 输出：仅结构与策略，不含当前值、不含秘密 */
export function describeEntries() {
  return SETTINGS_SCHEMA.map((e) => ({
    key: e.key, type: e.type, group: e.group, label: e.label,
    sensitivity: e.sensitivity, reversible: e.reversible, requiresRestart: e.requiresRestart ?? false,
    ...(e.type === "enum" ? { values: e.values } : {}),
    ...(e.type === "int" || e.type === "number" ? { min: e.min, max: e.max } : {}),
    ...(e.type === "string" ? { maxLen: e.maxLen } : {}),
    def: e.def,
  }));
}

export type { Settings, ThemeMode, WorkspacePreset, AiPreset, AiFormat };
