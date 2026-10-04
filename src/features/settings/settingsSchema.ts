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
import { THEME_LIST, type Settings, type ThemeMode, type WorkspacePreset, type AiPreset, type AiFormat } from "./settingsStore";
import { LOCALE_LIST } from "../../i18n/strings";
import { MARKET_BUNDLED_INDEX_URL } from "../market/marketIndex";

export type Sensitivity = "safe" | "protected" | "secret";

export type SettingEntry =
  | { key: keyof Settings; type: "enum"; values: readonly (string | number)[]; def: string | number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "int"; min: number; max: number; def: number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "number"; min: number; max: number; def: number; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "boolean"; def: boolean; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean }
  | { key: keyof Settings; type: "string"; maxLen: number; def: string; group: string; label: string; sensitivity: Sensitivity; reversible: boolean; requiresRestart?: boolean };

/** 全量声明：每个 Settings 键恰好一条。 */
export const SETTINGS_SCHEMA: readonly SettingEntry[] = [
  { key: "theme", type: "enum", values: THEME_LIST, def: "light", group: "appearance", label: "主题", sensitivity: "safe", reversible: true },
  { key: "locale", type: "enum", values: LOCALE_LIST, def: "zh", group: "appearance", label: "语言", sensitivity: "safe", reversible: true },
  { key: "zoom", type: "enum", values: [90, 100, 110, 125], def: 100, group: "appearance", label: "界面缩放", sensitivity: "safe", reversible: true },
  { key: "decimals", type: "int", min: 0, max: 6, def: 2, group: "appearance", label: "显示精度", sensitivity: "safe", reversible: true },
  { key: "perfHud", type: "boolean", def: false, group: "appearance", label: "性能浮窗", sensitivity: "safe", reversible: true },
  { key: "workspace", type: "enum", values: ["proto", "analyze", "attitude", "console", "video", "calib", "auto", "modbus", "vdev"], def: "proto", group: "layout", label: "预设布局", sensitivity: "safe", reversible: true },
  { key: "cellSize", type: "enum", values: [48, 60, 72, 90, 110], def: 60, group: "appearance", label: "控制画布格尺寸", sensitivity: "safe", reversible: true },
  { key: "fcCellSize", type: "int", min: 20, max: 96, def: 42, group: "appearance", label: "帧画布格尺寸", sensitivity: "safe", reversible: true },
  { key: "sbCellSize", type: "int", min: 20, max: 96, def: 22, group: "appearance", label: "TX组帧台格尺寸", sensitivity: "safe", reversible: true },
  { key: "showThinking", type: "boolean", def: true, group: "appearance", label: "显示思考过程", sensitivity: "safe", reversible: true },
  // P96-K4：以前"显示思考过程"一个开关同时管着"界面上看不看得到思维链"和"要不要让模型先想后说"。
  // 后者会显著拉长静默时间，正是网关按空闲掐断的直接来源 ⇒ 拆开，显示归显示、模型行为归模型行为。
  { key: "deepThink", type: "boolean", def: true, group: "ai", label: "深度思考（先想后答）", sensitivity: "safe", reversible: true },
  { key: "streamIdleSecs", type: "int", min: 30, max: 600, def: 120, group: "ai", label: "流式读空闲超时（秒）", sensitivity: "safe", reversible: true },
  { key: "chartPalette", type: "enum", values: ["standard", "cbSafe"], def: "standard", group: "appearance", label: "图表配色", sensitivity: "safe", reversible: true },
  { key: "conWrap", type: "boolean", def: true, group: "appearance", label: "控制台自动换行", sensitivity: "safe", reversible: true },
  { key: "reduceMotion", type: "boolean", def: false, group: "appearance", label: "减弱动效", sensitivity: "safe", reversible: true },
  // P110-B1：`aiPreset` / `aiFormat` / `aiBaseUrl` / `aiApiKey` / `aiModel` 五条已随
  // `Settings` 里的字段一起删除。供应商与模型是**表**，不是标量设置项：
  // `SettingEntry` 只有 enum/int/number/boolean/string 五个分支，一张含密钥的表塞进来
  // 就会被下面那条 `readSettings()` 的"按 schema 逐键吐值"原样序列化给模型（§8-38）。
  // 表的读口径在 `features/ai/aiProfileStore.redactedProjection()`。
  { key: "aiTemperature", type: "number", min: 0, max: 2, def: 0.3, group: "ai", label: "AI 温度", sensitivity: "protected", reversible: true },
  // P110-B2：自动压缩阈值。**protected 而不是 safe**：这是模型自己的上下文预算，
  // 让它能改就等于让它给自己放宽“什么时候该把历史折掉”（同 P109-A 那三条预算的口径）。
  { key: "aiCompactRatio", type: "number", min: 0.4, max: 0.9, def: 0.6, group: "ai", label: "上下文压缩阈值（占窗口比例）", sensitivity: "protected", reversible: true },
  // P110-B2：手动压缩的持久化落点。0 = 跟随窗口自动算。故意也标 protected（同上）。
  { key: "aiHistoryOverride", type: "int", min: 0, max: 200_000, def: 0, group: "ai", label: "手动历史预算（0=自动）", sensitivity: "protected", reversible: true },
  // P110-B5：思考强度档位。**档位名与它的参数都在档案里**，这里只存"选了哪一档"。
  { key: "aiThinkingLevel", type: "string", maxLen: 40, def: "", group: "ai", label: "思考强度档位", sensitivity: "protected", reversible: true },
  { key: "aiProxy", type: "string", maxLen: 512, def: "", group: "ai", label: "AI 代理", sensitivity: "protected", reversible: true },
  { key: "aiNoProxy", type: "string", maxLen: 512, def: "", group: "ai", label: "AI 免代理", sensitivity: "protected", reversible: true },
  // P98-M2：aiCreativity / aiScript 已删（前者 prompts 从不读；后者是"假装生效"的安全控件）。
  // aiWidgetSend 留：它是全机发送总闸，改名并搬到「权限与安全」组
  { key: "aiWidgetSend", type: "boolean", def: false, group: "ai", label: "允许向设备发送", sensitivity: "protected", reversible: false },
  { key: "agentFsRoots", type: "string", maxLen: 4096, def: "", group: "ai", label: "Agent 文件白名单", sensitivity: "protected", reversible: false },
  { key: "agentShellEnabled", type: "boolean", def: false, group: "ai", label: "Agent 允许执行命令", sensitivity: "protected", reversible: false },
  // P133-A：跑本仓校验的**独立**开关。故意与 agentShellEnabled 分开：那条的半径是"任意命令"，
  // 这条只能跑命令表里那五档且无 shell。想让用户"能自证改动没弄坏"却不必开那道闸，就得有两个口子。
  // 同样 protected —— 模型不许给自己开校验面（与预算三键、agentRestoreTier 同一条测试钉着）。
  { key: "agentRepoCheck", type: "boolean", def: false, group: "ai", label: "Agent 允许跑本仓校验", sensitivity: "protected", reversible: false },
  // P135-B：只读子代理的**独立**开关。默认关的理由与上面那条同源——它不是免费的：一次派发＝若干轮
  // 真实模型请求（用户的钱包）。它不需要「允许执行命令」那条：派一只只读代理不必交出 shell。
  // 同样 protected：模型不许给自己开这扇门（与预算三键、agentRestoreTier 同一条测试钉着）。
  { key: "agentSubagent", type: "boolean", def: false, group: "ai", label: "Agent 只读子代理", sensitivity: "protected", reversible: false },
  // P109-D：高危档跨重启。**默认关**＝保持"重启回落界面创造并标 downgraded"的原行为；
  // 开它是用户点名的放松（§8-44），所以它本身必须是 protected —— 模型不许给自己开这扇门。
  { key: "agentRestoreTier", type: "boolean", def: false, group: "ai", label: "重启后保留全权执行档", sensitivity: "protected", reversible: true },
  // P109-A：Agent 预算，**0 = 不限制**（默认）。三条一律 `protected` —— 模型不许写自己的上限，
  // 否则"无限预算的成本责任在用户侧"这句话就是空的（settingsTools 只放行 safe 键，
  // 这条由 settingsSchema.test.ts 里与 marketIndexUrl 同一形状的测试钉住）。
  { key: "agentMaxRounds", type: "int", min: 0, max: 100000, def: 0, group: "ai", label: "Agent 轮数上限（0=不限）", sensitivity: "protected", reversible: true },
  { key: "agentMaxCalls", type: "int", min: 0, max: 100000, def: 0, group: "ai", label: "Agent 工具调用上限（0=不限）", sensitivity: "protected", reversible: true },
  { key: "agentTimeoutMins", type: "int", min: 0, max: 1440, def: 0, group: "ai", label: "Agent 单次任务时限（分钟，0=不限）", sensitivity: "protected", reversible: true },
  { key: "autoReconnect", type: "boolean", def: false, group: "behavior", label: "断线自动重连", sensitivity: "protected", reversible: true },
  { key: "mcpEnabled", type: "boolean", def: false, group: "mcp", label: "MCP 桥开关", sensitivity: "protected", reversible: false, requiresRestart: true },
  { key: "mcpPort", type: "int", min: 1024, max: 65535, def: 7731, group: "mcp", label: "MCP 端口", sensitivity: "protected", reversible: true, requiresRestart: true },
  { key: "mcpAllowSend", type: "boolean", def: false, group: "mcp", label: "MCP 允许远程发送", sensitivity: "protected", reversible: false },
  { key: "mcpHighPriv", type: "boolean", def: false, group: "mcp", label: "MCP 允许高权限动作", sensitivity: "protected", reversible: false },
  { key: "mcpToken", type: "string", maxLen: 128, def: "", group: "mcp", label: "MCP 握手 token", sensitivity: "secret", reversible: true },
  // P99b-N6：这两键从 N1 起就存在于 store，但一直没进 schema、也没进界面——
  // 那句「全量声明：每个 Settings 键恰好一条」因此是假的（双向守卫现在钉着它）。
  // **为什么是 protected 而不是 safe**：`marketIndexUrl` 决定"从哪台机器取包的元数据"。
  // 让模型能改它，等于给它一条换货架的通道——即便仍有域白名单与 sha256 兜底，这是**信任面**
  // 而不是技术面（详设 §3-R2）。本批既不新增也不放松任何审批，只是把两个此前只有人能改的键
  // 放进了 UI，同时声明模型不可改。
  { key: "marketIndexUrl", type: "string", maxLen: 300, def: MARKET_BUNDLED_INDEX_URL, group: "market", label: "插件市场索引地址", sensitivity: "protected", reversible: true },
  { key: "marketMirrorPrefix", type: "string", maxLen: 300, def: "", group: "market", label: "插件市场镜像前缀", sensitivity: "protected", reversible: true },
] as const satisfies readonly SettingEntry[];

const byKey = new Map(SETTINGS_SCHEMA.map((e) => [e.key as string, e]));

export function schemaEntry(key: string): SettingEntry | undefined {
  return byKey.get(key);
}

/** Agent 可直接应用的键：safe 且可撤销 */
export function agentWritableKeys(): (keyof Settings)[] {
  return SETTINGS_SCHEMA.filter((e) => e.sensitivity === "safe" && e.reversible).map((e) => e.key);
}

/**
 * 「恢复外观默认」的范围（P98-M1）。
 * 取 appearance 组里**真正属于视觉样式**的键，刻意排除两个同名不同类的：
 * - `locale`：语言不是外观偏好，且误触代价高（整界面换语言），不该被"恢复外观"顺带带走；
 * - `showThinking`：那是 AI 助手的显示偏好，归 AI 页管（P96-K4 还专门为它拆过开关）。
 * 名单只在这里声明一次——恢复动作、确认文案、测试都从它派生，不再各抄一份（§8-36）。
 */
export const APPEARANCE_RESET_KEYS: readonly (keyof Settings)[] = [
  "theme", "zoom", "decimals", "perfHud", "cellSize", "fcCellSize", "sbCellSize", "chartPalette", "conWrap", "reduceMotion",
];

/** 这些键的默认值（从 schema 的 `def` 取，不另立第二份数字） */
export function appearanceDefaults(): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of APPEARANCE_RESET_KEYS) {
    const e = SETTINGS_SCHEMA.find((x) => x.key === k);
    if (e) out[k] = e.def;
  }
  return out as Partial<Settings>;
}

/**
 * 这些键的中文名 —— 只给**不看语言的消费方**（Agent 工具描述里点名要改哪几项）。
 * 界面上一律别用它：设置项的名字住在中心键 `set.*`（`SettingsModal` 就从那里取），
 * 这里再出一份就是第二处名字真值，两边迟早对不上。
 */
export function appearanceDefaultLabels(): string[] {
  return APPEARANCE_RESET_KEYS
    .map((k) => SETTINGS_SCHEMA.find((x) => x.key === k)?.label)
    .filter((x): x is string => !!x);
}

/**
 * Agent 可写键的紧凑清单（工具描述用），**从 schema 派生**。
 * 旧实现把这份清单手抄在 `settingsTools` 的描述字符串里——P96-K4 新增 deepThink/streamIdleSecs
 * 时它就悄悄漂了一次，而描述与实现分叉会让模型反复试错（P92-C 的同款教训）。
 */
export function agentWritableHint(): string {
  return SETTINGS_SCHEMA
    .filter((e) => e.sensitivity === "safe" && e.reversible)
    .map((e) => {
      if (e.type === "enum") return `${e.key}=${e.values.join("|")}`;
      if (e.type === "int" || e.type === "number") return `${e.key}[${e.min}..${e.max}]`;
      return String(e.key);
    })
    .join(", ");
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
