/**
 * P93-A6 / P92-C：具名授权档位。
 *
 * 内部枚举仍是 `preview | create | custom`（已持久化、已测、MCP 侧也在用），本模块只做一件事：
 * 把「档位 + 授权域集合」呈现为**有名字、有白名单、可比较**的预设，并修掉一处真实的语义误读——
 * 旧 UI 把 custom 排在最后、只写「自定义」，用户自然读成"比常规创造更低一档"；而 enforce 侧
 * 根本不是阶梯：`files/network/shell` 三类工具**只认 custom**，`create` 永远拿不到。
 *
 * 所以这里明说"扩展档比基础档更多"，并让每一档把自己的域白名单显示出来。
 */
import type { RunScope } from "./types";

export const DOMAINS = ["config", "plugins", "device", "files", "network", "shell", "ui", "write"] as const;
export type Domain = (typeof DOMAINS)[number];

/** 授权域 → 中文名（档位说明、勾选行、拒绝文案、设置页四处共用的唯一来源）。
 *  标签写成"动作"而不是"名词"：旧文案「文件」让人以为 Agent 能写文件。 */
export const DOMAIN_ZH: Record<Domain, string> = {
  config: "配置写入",
  plugins: "插件库",
  device: "设备发送",
  files: "文件读取",
  network: "网络访问",
  shell: "命令行",
  ui: "界面深改",
  write: "文件写入",
};

/** 授权域 → 一行边界说明（勾选行悬停与正文提示） */
export const DOMAIN_TIP: Record<Domain, string> = {
  config: "设置与工作区配置的新建/修改（删除/覆盖仍需批准）",
  plugins: "保存新插件并启用纯 UI 插件",
  device: "仿真环境自动发送；实车/未知设备仍逐次批准",
  files: "读取/列出「Agent 文件白名单」内的本地文件（设置 → AI 服务）",
  network: "抓取公网网页与搜索（自动拒绝内网地址）",
  shell: "执行 shell 命令：需设置页总开关 + 每次逐条批准",
  ui: "对具体组件/面板注入受校验的样式与动效（全局选择器、fixed 遮罩、外链资源一律拒）",
  write: "在软件目录/工作区内新建与修改文件；覆盖已有文件与删除仍逐次批准",
};

/** custom 的兜底授权集＝与「放手改界面」同权。**空数组绝不允许落盘**：
 *  旧实现 custom + 空 allowed ⇒ authorized() 恒 false ⇒ "自定义几乎什么都干不了"。 */
export const DEFAULT_DOMAINS: Domain[] = ["config", "plugins"];

/**
 * 档位选择的跨重启恢复（P98-M3，用户裁决 Q3 的折中方案）。
 *
 * 旧行为是**完全不持久化**（P92 当时裁决"授权默认不静默恢复更安全"），代价是用户反映的
 * "重开就回默认、没法形成稳定预期"。但把「全面放手」静默带回开机状态更糟——
 * 用户会以为"我没授权过它怎么什么都能干"。
 *
 * 所以这里记住选择，**但高危档不自动恢复**：`custom`（含「全面放手」与手工勾选）
 * 一律回落到「放手改界面」，并把 `downgraded` 报给 UI 明说，绝不静默改用户上次选的东西。
 * 存的是 `(scope, allowed)` 二元组而不是档位 id —— 与任务台账同一口径，档位改名不会让记录失效。
 */
const TIER_KEY = "vs.agentTier.v1";

export interface TierRestore { scope: RunScope; allowed: Domain[]; downgraded: boolean }

export function rememberTier(scope: RunScope, allowed: readonly Domain[]): void {
  try {
    localStorage.setItem(TIER_KEY, JSON.stringify({ scope, allowed: [...allowed] }));
  } catch {
    // 隐私模式/配额满：记住记不住都不该影响任务本身，静默降级为"不持久化"（旧行为）
  }
}

export function restoreTier(): TierRestore {
  const fallback: TierRestore = { scope: "create", allowed: [...DEFAULT_DOMAINS], downgraded: false };
  let raw: string | null;
  try {
    raw = localStorage.getItem(TIER_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as { scope?: unknown; allowed?: unknown };
    if (p.scope === "preview") return { scope: "preview", allowed: [], downgraded: false };
    if (p.scope === "create") return { scope: "create", allowed: [...DEFAULT_DOMAINS], downgraded: false };
    if (p.scope === "custom" && Array.isArray(p.allowed)) {
      const kept = normalizeAllowed("custom", p.allowed);
      return { scope: "create", allowed: kept, downgraded: true };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function clearRememberedTier(): void {
  try {
    localStorage.removeItem(TIER_KEY);
  } catch {
    /* 同上：清不掉也不该影响功能 */
  }
}

export interface ScopeTier {
  id: string;
  label: string;
  /** 一行说明：能做什么、不能做什么 */
  desc: string;
  scope: RunScope;
  /** scope=custom 时的域预设；create/preview 档忽略（create 的域由 hasDomain 隐含） */
  domains: Domain[];
  /**
   * P98-M3：`true` = 面板第一层的授权档；`false` = 高级区里的**预设**（点了就是把 8 个勾选填成这一组）。
   * 旧实现把 7 个东西一律排成 radio，其中 4 个彼此只差 1~2 个域 —— 用户数出"8 个发送方式"就是这么来的。
   * 真正的两个轴是「用不用 Agent」与「Agent 有多大权」，现在分开表达。
   */
  primary: boolean;
}

/** 全部定义（主档 + 预设）：`resolveTier`/`tierIdOf` 按 id 在这里查，id 一个都没改 ⇒ 台账无需迁移 */
export const TIERS: ScopeTier[] = [
  { id: "read", label: "仅预览", desc: "只读数据与状态；任何写入只给预览，不落一行改动", scope: "preview", domains: [], primary: true },
  { id: "create", label: "放手改界面", desc: "改应用设置、保存主题/控件/面板插件，可逆的自动做；不碰设备与本机", scope: "create", domains: ["config", "plugins"], primary: true },
  { id: "full", label: "全面放手", desc: "软件目录内八个能力域全开（含界面深改、读白名单文件、写目录内文件、网络、命令行）；覆盖已有文件、删除、实车发送与命令行仍逐次批准", scope: "custom", domains: ["config", "plugins", "device", "files", "network", "shell", "ui", "write"], primary: true },
  // ↓ 高级区预设：不是"更低一档"，是"某一组勾选的一键填法"
  { id: "workspace", label: "工作区写入", desc: "放手改界面的全部 + 读取白名单内文件", scope: "custom", domains: ["config", "plugins", "files"], primary: false },
  { id: "device", label: "设备收发", desc: "放手改界面的全部 + 向仿真/虚拟设备发送；实车连接时仍逐次人工批准", scope: "custom", domains: ["config", "plugins", "device"], primary: false },
  { id: "host", label: "本机全能力", desc: "工作区/设备两组的全部 + 网络 + 命令行 + 界面深改（七个域）", scope: "custom", domains: ["config", "plugins", "device", "files", "network", "shell", "ui"], primary: false },
];

/** 面板第一层：三档 */
export const PRIMARY_TIERS: ScopeTier[] = TIERS.filter((t) => t.primary);
/** 高级区预设 chip */
export const DOMAIN_PRESETS: ScopeTier[] = TIERS.filter((t) => !t.primary);
/** 勾选与任何预设都不相等时的落点（不是一条可选预设，是一个状态） */
export const CUSTOM_TIER: ScopeTier = {
  id: "custom", label: "自定义勾选", desc: "自己勾授权域，勾完就地生效", scope: "custom", domains: [], primary: false,
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** 「放手改界面」预设域＝scope=create 的隐含授权集 */
const CREATE_DOMAINS = TIERS.find((t) => t.id === "create")!.domains;

/**
 * 某个授权域是否已授（P92-C 的关键一环）。create 档=config+plugins；custom 档=勾选集；preview 恒 false。
 *
 * 为什么要有这个函数：旧代码在外观/设置工具里到处写 `scope !== "create" ⇒ 拒绝`，于是**扩展档
 * 反而比「界面创造」改不动东西**——用户投诉的"自定义权限比常规创造还低"根子在 enforce 侧，
 * 把 UI 换成具名档位并不会自己修好它。勾选了 config/plugins 的档位必须拿到这两项能力。
 */
export function hasDomain(
  scope: RunScope,
  allowed: readonly string[] | undefined,
  domain: Domain,
): boolean {
  if (scope === "preview") return false;
  const set: readonly string[] = scope === "create" ? CREATE_DOMAINS : allowed ?? [];
  return set.includes(domain);
}

/** 档位/预设 id → 实际下发给 runAgent 的 (scope, allowed) */
export function resolveTier(id: string, handPicked: Domain[]): { scope: RunScope; allowed: Domain[] } {
  // custom 不再是 TIERS 里的一条（它是"勾选不等于任何预设"的落点），所以要先于查表拦下来
  if (id === CUSTOM_TIER.id) {
    return { scope: "custom", allowed: handPicked.length ? [...handPicked] : [...DEFAULT_DOMAINS] };
  }
  const t = TIERS.find((x) => x.id === id) ?? PRIMARY_TIERS.find((x) => x.id === "create")!;
  if (t.scope !== "custom") return { scope: t.scope, allowed: [...t.domains] };
  // 预设档：域集写死在表里；空集兜底成与「放手改界面」同权，
  // 绝不产出"看似已授权其实全禁"的任务（P93-A6）
  return { scope: "custom", allowed: t.domains.length ? [...t.domains] : [...DEFAULT_DOMAINS] };
}

/** 由 (scope, allowed) 反推当前档位/预设 id；勾选与任何预设都不相等就落回 custom */
export function tierIdOf(scope: RunScope, allowed: readonly string[]): string {
  if (scope === "preview") return "read";
  if (scope === "create") return "create";
  const hit = TIERS.find((t) => t.scope === "custom" && sameSet(t.domains, allowed));
  return hit?.id ?? CUSTOM_TIER.id;
}

/** 当前档位的完整定义（主档 / 预设 / 自定义三选一），UI 与徽标都从这里取，不再各存一份标签 */
export function tierOf(scope: RunScope, allowed: readonly string[]): ScopeTier {
  const id = tierIdOf(scope, allowed);
  return TIERS.find((t) => t.id === id) ?? CUSTOM_TIER;
}

/** 顶栏 pill 文案：把"到底授了什么"说在明面上 */
export function tierBadge(scope: RunScope, allowed: readonly string[]): string {
  const t = tierOf(scope, allowed);
  if (t.id === CUSTOM_TIER.id) return `自定义 · ${allowed.length || DEFAULT_DOMAINS.length} 项授权`;
  return t.label.replace(/（.*）/, "");
}

/**
 * 授权域归一化（P93-A6 的硬约束）：custom 永不为空、丢掉未知域，非 custom 一律空集。
 * 旧实现把 `options.allowed ?? []` 直接落盘，一旦空数组进台账，`authorized()` 恒 false，
 * 用户看到的就是"我明明选了自定义并起了任务，却什么都改不动"。
 */
export function normalizeAllowed(scope: RunScope, allowed?: readonly string[] | null): Domain[] {
  if (scope !== "custom") return [];
  const kept = (allowed ?? []).filter((d): d is Domain => (DOMAINS as readonly string[]).includes(d));
  return kept.length ? kept : [...DEFAULT_DOMAINS];
}
