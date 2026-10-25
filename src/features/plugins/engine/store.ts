/**
 * P174-A4：插件仓库账本（index / trust）的读写与容错。
 *
 * 这一层只做三件事：调 `plugin_store_*`、把盘上的数据归一成可信形状、把坏数据**说出来**。
 *
 * 为什么要有 `normalize*`：账本是磁盘上的普通 JSON，用户可能手改、可能被别的程序截断。
 * 直接 `JSON.parse` 之后当可信数据用，症状是"某个插件在列表里显示 undefined"——
 * 那种 bug 没人能从现象反推到"账本坏了"。所以这里一律：**坏了就退回空账本 + 返回 issues**，
 * 让 UI 能说一句"账本格式不对，已按空账本启动"。
 */

import { invoke } from "@tauri-apps/api/core";
import { emptyIndex, emptyTrust, type PluginIndex, type TrustBook } from "./repo";
import { ROOT_KEY_RE } from "./manifest";
import { normalizeJournal, type JournalBook } from "./journal";
import { emptyProfilesBook, normalizeProfiles, type ProfilesBook } from "./profiles";

/**
 * 账本名白名单。**必须与 Rust 侧 `plugin_fs.rs` 的 `STORE_NAMES` 一致**——
 * 两边不一致的症状是"写得进读不出"或"读得出写不进"，而且两边各自都"没报错"。
 * 这条契约由 `scripts/pluginContract.test.mjs` 直接读 Rust 源码比对，不靠人记。
 */
export const PLUGIN_STORE_NAMES = ["index", "trust", "settings", "journal", "profiles"] as const;
export type PluginStoreName = (typeof PLUGIN_STORE_NAMES)[number];

export interface StoreIssues {
  issues: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 索引归一：只保留形状对的条目，坏条目记进 issues（不静默丢）。 */
export function normalizeIndex(raw: unknown): { index: PluginIndex; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw) || !isObj(raw.items)) {
    if (raw !== null && raw !== undefined) issues.push("索引不是预期形状，已按空索引启动");
    return { index: emptyIndex(), issues };
  }
  const out = emptyIndex();
  for (const [id, item] of Object.entries(raw.items)) {
    if (!isObj(item) || typeof item.dir !== "string" || typeof item.version !== "string") {
      issues.push(`索引条目「${id}」形状不对，已跳过`);
      continue;
    }
    out.items[id] = {
      dir: item.dir,
      version: item.version,
      digest: typeof item.digest === "string" ? item.digest : "",
      installedAt: typeof item.installedAt === "number" ? item.installedAt : 0,
      source:
        item.source === "market" || item.source === "local" || item.source === "ai" || item.source === "import"
          ? item.source
          : "import",
      // **只有明确的 `false` 才算停用**。缺字段（这个字段出现之前就装着的）、
      // 以及被手改成 `"false"` / `0` 这种既不是 true 也不是 false 的值，一律按启用算——
      // 静默藏掉一批在用的面板，用户只会得到"我插件呢"这一种反馈，没有任何线索。
      enabled: item.enabled !== false,
      ...(typeof item.origin === "string" && item.origin ? { origin: item.origin } : {}),
    };
  }
  return { index: out, issues };
}

/** 信任账归一。摘要缺失的条目视为无效——它无法参与判定，留着只会让人以为"这个插件批过了"。 */
export function normalizeTrust(raw: unknown): { trust: TrustBook; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw) || !isObj(raw.items)) {
    if (raw !== null && raw !== undefined) issues.push("信任账不是预期形状，已按空账启动");
    return { trust: emptyTrust(), issues };
  }
  const out = emptyTrust();
  for (const [id, item] of Object.entries(raw.items)) {
    if (!isObj(item) || typeof item.digest !== "string" || !item.digest) {
      issues.push(`信任条目「${id}」缺少摘要，已跳过（它无法参与判定）`);
      continue;
    }
    out.items[id] = {
      id,
      version: typeof item.version === "string" ? item.version : "",
      digest: item.digest,
      grantedAt: typeof item.grantedAt === "number" ? item.grantedAt : 0,
      grantedSummary: Array.isArray(item.grantedSummary)
        ? item.grantedSummary.filter((s): s is string => typeof s === "string")
        : [],
    };
  }
  return { trust: out, issues };
}

async function readStore(name: PluginStoreName, roots: string[]): Promise<unknown> {
  const r = await invoke<{ exists: boolean; data: unknown }>("plugin_store_read", { name, roots });
  return r.exists ? r.data : null;
}

export async function loadIndex(roots: string[]): Promise<{ index: PluginIndex; issues: string[] }> {
  try {
    return normalizeIndex(await readStore("index", roots));
  } catch (e) {
    return { index: emptyIndex(), issues: [`读取索引失败：${String((e as Error)?.message ?? e)}`] };
  }
}

export async function loadTrust(roots: string[]): Promise<{ trust: TrustBook; issues: string[] }> {
  try {
    return normalizeTrust(await readStore("trust", roots));
  } catch (e) {
    return { trust: emptyTrust(), issues: [`读取信任账失败：${String((e as Error)?.message ?? e)}`] };
  }
}

/* ============================ 插件子系统自己的设置 ============================ */

/**
 * 插件子系统的偏好。目前只有一条：**工作区根**（`$WS`）。
 *
 * 为什么它不放进全局设置：那里已经有一个 `workspace`（预设布局），
 * 同名不同义的两个键放在一张表里，agent 工具与帮助文档都会指着它说错话。
 */
export interface PluginEngineSettings {
  /** 工作区根目录。空串 = 没登记（声明了 `$WS` 的插件会被拒启动，这是有意为之）。 */
  workspaceRoot: string;
  /**
   * 当前在画的插件主题（`plg:<pluginId>:<themeId>`）。空串 = 用内置主题。
   *
   * 为什么它不在全局设置里：`settings.theme` 是**内置主题的枚举**（light/dark/system…），
   * 把第三方的 id 塞进去会一路撞类型与校验器。插件主题有它自己的"谁在画"这件事。
   */
  activeTheme: string;
  /**
   * 外部目录登记表（`$EXT:<key>` → 绝对路径）。
   *
   * 为什么它是**一张表**而不是又一个 `xxxRoot` 字段：插件要碰的工作区外目录是开放的
   * （部署工具、素材库、模型仓……），每来一个就加一个 `if` 是不可持续的。表里的键由清单声明，
   * 用户绑一次，宿主展开进 `--allow-fs-write` 并经 `hello.roots` 递进去。
   */
  roots: Record<string, string>;
  /**
   * 每个插件的 `contributes.settings` **覆盖值**（只存与默认值不同的键）。
   * 读的时候与清单默认值合并；写的时候按键级 patch 合并且过类型校验（见 `pluginConfig.ts`）。
   */
  pluginConfig: Record<string, Record<string, unknown>>;
}

export function emptyPluginEngineSettings(): PluginEngineSettings {
  return { workspaceRoot: "", activeTheme: "", roots: {}, pluginConfig: {} };
}

/** 单个插件覆盖值的体积上限（与 `pluginConfig.ts` 同一判据）。 */
const MAX_PLUGIN_CONFIG_BYTES = 64 * 1024;

/** 配置覆盖表归一：只收形状对的键/基本值；坏数据说出来，不静默保留半截。 */
function normalizePluginConfigBook(raw: unknown, issues: string[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    issues.push("插件配置表不是预期形状，已按空处理");
    return out;
  }
  for (const [id, values] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      issues.push(`插件配置「${id}」的插件 id 不合规，已忽略`);
      continue;
    }
    if (!isObj(values)) {
      issues.push(`插件配置「${id}」不是对象，已忽略`);
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") clean[k] = v;
    }
    if (JSON.stringify(clean).length > MAX_PLUGIN_CONFIG_BYTES) {
      issues.push(`插件配置「${id}」超过 64KB，已忽略`);
      continue;
    }
    out[id] = clean;
  }
  return out;
}

/** 归一：只要形状不对就退回默认并说一句，不静默保留半截数据。 */
export function normalizePluginEngineSettings(raw: unknown): { settings: PluginEngineSettings; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw)) {
    if (raw !== null && raw !== undefined) issues.push("插件设置不是预期形状，已按默认值启动");
    return { settings: emptyPluginEngineSettings(), issues };
  }
  const root = raw.workspaceRoot;
  if (root !== undefined && typeof root !== "string") {
    issues.push("工作区根不是字符串，已按未设置处理");
    return { settings: emptyPluginEngineSettings(), issues };
  }
  return {
    settings: {
      workspaceRoot: typeof root === "string" ? root : "",
      activeTheme: typeof raw.activeTheme === "string" ? raw.activeTheme : "",
      roots: normalizeRoots(raw.roots, issues),
      pluginConfig: normalizePluginConfigBook(raw.pluginConfig, issues),
    },
    issues,
  };
}

/**
 * 外部目录表的归一。丢掉三类东西：键名不合规的（清单里根本写不出来，留着只会永远绑不上）、
 * 值不是非空字符串的、以及**与 `$EXT:<key>` 语法不一致的键**。
 * 丢的时候说一句，且**指名道姓**——静默丢一个用户刚绑的目录，是最难查的那类"怎么不生效"。
 */
function normalizeRoots(raw: unknown, issues: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    issues.push("外部目录表不是预期形状，已按空处理");
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!ROOT_KEY_RE.test(k)) {
      issues.push(`外部目录「${k}」的键名不合规（只许小写字母开头、小写字母/数字/连字符，最长 24），已忽略`);
      continue;
    }
    if (typeof v !== "string" || !v.trim()) {
      issues.push(`外部目录「${k}」没有路径，已忽略`);
      continue;
    }
    out[k] = v.trim();
  }
  return out;
}

export async function loadPluginEngineSettings(roots: string[]): Promise<{ settings: PluginEngineSettings; issues: string[] }> {
  try {
    return normalizePluginEngineSettings(await readStore("settings", roots));
  } catch (e) {
    return { settings: emptyPluginEngineSettings(), issues: [`读取插件设置失败：${String((e as Error)?.message ?? e)}`] };
  }
}

export async function savePluginEngineSettings(settings: PluginEngineSettings, roots: string[]): Promise<void> {
  await invoke("plugin_store_write", { name: "settings", data: settings, roots });
}

export async function loadJournal(roots: string[]): Promise<{ journal: JournalBook | null; issues: string[] }> {
  try {
    return normalizeJournal(await readStore("journal", roots));
  } catch (e) {
    return { journal: null, issues: [`读取变更日志失败：${String((e as Error)?.message ?? e)}`] };
  }
}

export async function saveJournal(journal: JournalBook, roots: string[]): Promise<void> {
  await invoke("plugin_store_write", { name: "journal", data: journal, roots });
}

export async function loadProfiles(roots: string[]): Promise<{ book: ProfilesBook; issues: string[] }> {
  try {
    return normalizeProfiles(await readStore("profiles", roots));
  } catch (e) {
    return { book: emptyProfilesBook(), issues: [`读取场景账本失败：${String((e as Error)?.message ?? e)}`] };
  }
}

export async function saveProfiles(book: ProfilesBook, roots: string[]): Promise<void> {
  await invoke("plugin_store_write", { name: "profiles", data: book, roots });
}

export async function saveIndex(index: PluginIndex, roots: string[]): Promise<void> {
  await invoke("plugin_store_write", { name: "index", data: index, roots });
}

export async function saveTrust(trust: TrustBook, roots: string[]): Promise<void> {
  await invoke("plugin_store_write", { name: "trust", data: trust, roots });
}
