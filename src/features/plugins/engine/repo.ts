/**
 * P174-A2：插件仓库的**布局与信任判定**。
 *
 * 这里一行磁盘 IO 都没有，全是纯函数。理由：这两件事是"判据"，而判据要能被单测钉住；
 * 真正读写的部分在 Rust（`plugin_*` 命令），它只负责"把我说好的路径读出来/写进去"。
 * 把判据和 IO 混在一起的结果，历来是"测不到、只能手点"。
 *
 * 三件必须在这里定死的事：
 * 1. **目录布局**：`plugins/<id>/`、`plugins/staging/`、`index.json`、`trust.json`。
 * 2. **路径穿越**：包内任何相对路径都必须落在它自己的目录里（`../` 一律 null）。
 * 3. **信任三态**：`trusted` / `needs-approval` / `changed`——判据是「权限相关字段的摘要」，
 *    而不是整个 manifest 的哈希。改一句描述不该让人重新批准，加一个写目录才该。
 */

import type { PluginManifest } from "./manifest";

export const REPO_VERSION = 1;
export const INDEX_FILE = "index.json";
export const TRUST_FILE = "trust.json";
export const STAGING_DIR = "staging";

/** 插件根目录。`appDir` 由 Rust 给（`%APPDATA%` 下那一层）。 */
export function pluginsRoot(appDir: string): string {
  return `${trimSlash(appDir)}/plugins`;
}

export function pluginDir(appDir: string, id: string): string {
  return `${pluginsRoot(appDir)}/${id}`;
}

export function stagingDir(appDir: string, draftId: string): string {
  return `${pluginsRoot(appDir)}/${STAGING_DIR}/${draftId}`;
}

export function indexPath(appDir: string): string {
  return `${pluginsRoot(appDir)}/${INDEX_FILE}`;
}

export function trustPath(appDir: string): string {
  return `${pluginsRoot(appDir)}/${TRUST_FILE}`;
}

export function logsDir(appDir: string, id: string): string {
  return `${pluginDir(appDir, id)}/logs`;
}

function trimSlash(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/**
 * 把包内相对路径解析成绝对路径；非法（穿越/绝对/空段）返回 null。
 *
 * 与旧格式的 `normalizeEntryPath` 同一套判据，但这里多一步"拼完还要复查前缀"——
 * 因为 `a/../../b` 这种形态在逐段判 `..` 时会被拦，而 `a%2F..%2F..` 之类的编码变体
 * 只能靠拼完再看前缀兜住。两层都做，成本是一个 `startsWith`。
 */
export function resolveInExtDir(dir: string, rel: string): string | null {
  const s = rel.trim();
  if (!s || s.length > 300) return null;
  if (s.includes("\\") || s.includes("\0")) return null;
  if (s.startsWith("/") || s.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  const segs = s.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  const base = trimSlash(dir);
  const full = `${base}/${segs.join("/")}`;
  // 复查：拼完必须仍在 dir 之下（防编码变体与大小写陷阱）
  if (!full.startsWith(base + "/")) return null;
  return full;
}

/* ============================ 索引 ============================ */

export interface PluginIndexItem {
  /** 安装目录（相对 `plugins/`，即 `<id>`；用相对值是为了整个 AppData 能搬走）。 */
  dir: string;
  version: string;
  /** 权限摘要（见 `trustDigestInput`），不是整包哈希。 */
  digest: string;
  installedAt: number;
  source: "market" | "local" | "ai" | "import";
  /**
   * 用户是否启用它。**装完默认不启用**（产品流程是"安装 → 启用 → 才出现面板"），
   * 只有用户点了启用，它的面板才进「+面板」，才允许起进程。
   *
   * 迁移口径：老账本里没有这个字段 ⇒ 按 `true` 处理（那些插件本来就装着在用，
   * 静默把它们藏起来比多问一次更糟）。判据在 `normalizeIndex`，不在读盘那一侧各写一份。
   */
  enabled: boolean;
  /**
   * 从哪来（`github:owner/name`、`url:https://…`、空 = 本地目录）。**只用于显示与对账**：
   * "这个插件是从哪个仓库装的"是市场那栏把卡片标成「已安装」的唯一依据。
   * 它不参与信任判定（信任只看权限面摘要）。
   */
  origin?: string;
}

export interface PluginIndex {
  version: number;
  items: Record<string, PluginIndexItem>;
}

export function emptyIndex(): PluginIndex {
  return { version: REPO_VERSION, items: {} };
}

/**
 * 合并一次安装/更新。**同一 id 覆盖，不保留历史**——旧版本要不要留着是"回滚"功能的事，
 * 而本批的回滚策略是"重装上一个包"，不是"仓库里存 N 份"。
 */
export function upsertIndex(index: PluginIndex, id: string, item: PluginIndexItem): PluginIndex {
  return { ...index, version: REPO_VERSION, items: { ...index.items, [id]: item } };
}

export function removeFromIndex(index: PluginIndex, id: string): PluginIndex {
  const items = { ...index.items };
  delete items[id];
  return { ...index, version: REPO_VERSION, items };
}

/** 索引里指向不存在目录的条目（磁盘被手工删过）——启动时要报出来，不静默丢。 */
export function danglingIndexIds(index: PluginIndex, existing: readonly string[]): string[] {
  const set = new Set(existing);
  return Object.keys(index.items).filter((id) => !set.has(id));
}

/* ============================ 信任 ============================ */

export interface TrustRecord {
  id: string;
  version: string;
  digest: string;
  grantedAt: number;
  /** 批准时用户看到的那份权限快照（给人看的，不参与判定；判定只看 digest）。 */
  grantedSummary: string[];
}

export interface TrustBook {
  version: number;
  items: Record<string, TrustRecord>;
}

export function emptyTrust(): TrustBook {
  return { version: REPO_VERSION, items: {} };
}

/**
 * 稳定序列化：键排序 + 数组保序。
 *
 * 为什么必须稳定：这份字符串会被拿去算摘要，而摘要一变就要用户重新批准。
 * `JSON.stringify` 按插入顺序输出，同一个 manifest 从不同路径构造出来键序不同，
 * 就会算出两个摘要——用户明明没改任何东西，却被要求重批。那是本仓最讨厌的假变更。
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 计算"信任摘要"的输入串。
 *
 * **只取会改变风险面的字段**：`permissions`（要什么）、`inject`（改宿主哪里）、
 * `main`（有没有代码）、`activation`（什么时候跑）。刻意**不含** `name` / `description` /
 * `author` / `homepage` / `license`——改这些不改变它能干什么，让用户为此重批是骚扰。
 *
 * 含 `id` 与 `version`：id 变了是另一个插件；version 变了便于在信任库里说清"你批的是哪一版"。
 */
/**
 * 权限面里的**字符串清单**都是集合，不是序列。
 *
 * `["$WS/a","$WS/b"]` 与反过来是同一份风险，所以摘要必须对书写顺序不敏感——
 * 否则用户只是把清单调了一下顺序，就被要求重新批准一次。A2 当时只对 `activation`
 * 排了序，其余照抄；A6 补上（并留了 `...p` 这类展开，好在以后 `PluginFsPermission`
 * 加字段时**不会静默从摘要里漏掉**——漏掉等于"加了权限却不重批"，那是这套模型最坏的失败）。
 */
function sortedCopy(xs: readonly string[] | undefined): string[] | undefined {
  return xs ? [...xs].sort() : undefined;
}

export function trustDigestInput(m: PluginManifest): string {
  const perm = m.permissions;
  return stableStringify({
    id: m.id,
    version: m.version,
    main: m.main ?? "",
    activation: [...m.activation].sort(),
    permissions: {
      ...perm,
      fs: perm.fs ? { ...perm.fs, read: sortedCopy(perm.fs.read), write: sortedCopy(perm.fs.write) } : undefined,
      process: perm.process ? { ...perm.process, spawn: sortedCopy(perm.process.spawn) } : undefined,
      net: perm.net ? { ...perm.net, connect: sortedCopy(perm.net.connect) } : undefined,
      secrets: sortedCopy(perm.secrets),
    },
    inject: m.inject,
    panels: (m.contributes.panels ?? []).map((p) => ({ id: p.id, entry: p.entry })),
    commands: (m.contributes.commands ?? []).map((c) => c.id),
    widgets: (m.contributes.widgets ?? []).map((w) => ({ id: w.id, entry: w.entry })),
    presets: (m.contributes.presets ?? []).map((p) => ({ id: p.id, entry: p.entry })),
    tasks: (m.contributes.tasks ?? []).map((t) => ({ id: t.id, entry: t.entry })),
  });
}

export type TrustVerdict = "trusted" | "needs-approval" | "changed";

/**
 * 三态判定。这是批准流的唯一判据，别处不许再写一份。
 *
 * - 没有记录 ⇒ `needs-approval`（第一次装）
 * - 有记录但摘要不同 ⇒ `changed`（权限面变了，必须重批；摘要相同则**不重批**）
 * - 有记录且摘要相同 ⇒ `trusted`
 */
export function trustVerdict(stored: TrustRecord | undefined, digest: string): TrustVerdict {
  if (!stored) return "needs-approval";
  if (stored.digest !== digest) return "changed";
  return "trusted";
}

/** 权限面的可读差异，批准卡上要列"新增了哪些"，不许拿"版本更新"一笔带过。 */
export interface PermissionDelta {
  added: string[];
  removed: string[];
}

/** 把权限面摊平成可比较的行（每行一句中文），用于批准卡的"新增/移除"。 */
export function flattenPermissions(m: PluginManifest): string[] {
  const out: string[] = [];
  const w = m.permissions.fs?.write ?? [];
  const r = m.permissions.fs?.read ?? [];
  /**
   * `$EXT:<key>` 在批准卡上要说人话：用户看到的是"它要碰「deploy」那个目录"，
   * 而不是 `读 $EXT:deploy`（那是清单语法，不是给人看的）。键名保留——它正是用户绑定时看到的那个词。
   */
  const human = (p: string) => {
    const hit = p.match(/^\$EXT:([a-z][a-z0-9-]{0,23})/);
    return hit ? `外部目录「${hit[1]}」` : p;
  };
  for (const p of r) out.push(`读 ${human(p)}`);
  for (const p of w) out.push(`写 ${human(p)}`);
  for (const p of m.permissions.process?.spawn ?? []) out.push(`运行 ${p}`);
  for (const p of m.permissions.net?.connect ?? []) out.push(`联网 ${p}`);
  if (m.permissions.ui?.panel) out.push("在界面里加面板");
  if (m.permissions.ui?.widget) out.push("在主窗口里加小部件");
  if (m.permissions.ui?.notify) out.push("发系统通知");
  // 预设会整屏换掉用户当前的面板排布——批准卡上要单列，别让它藏在"版本更新"里
  if ((m.contributes.presets ?? []).length) out.push("提供工作区预设（可一键换整屏布局，换前会备份当前布局）");
  if ((m.contributes.tasks ?? []).length) out.push("提供任务模板（只把话填进 AI 输入框，不替你发送）");
  // 主题改的是**整张界面的长相**，批准卡上必须单列：装完发现配色自己变了，是最说不清的那种惊吓
  for (const th of m.contributes.themes ?? []) out.push(`改界面主题（${th.title}）`);
  if (m.permissions.ui?.clipboard) out.push("读写剪贴板");
  if (m.permissions.ai?.registerTools) out.push("向 AI 注册工具");
  if (m.permissions.ai?.ask) out.push("向 AI 提问");
  for (const s of m.permissions.secrets ?? []) out.push(`读密钥 ${s}`);
  for (const sec of m.inject.sections ?? []) out.push(`往 ${sec.slot} 加区块`);
  for (const mu of m.inject.mutations ?? []) out.push(`${mu.op === "hide" ? "隐藏" : mu.op === "retitle" ? "改标题" : "移动"}面板 ${mu.target}`);
  return out;
}

/**
 * 这个插件的面板该不该出现在「+面板」：**启用了**，并且**批过**。
 *
 * 两条缺一不可。只判 `enabled` 的话，一个权限刚被改过的插件（`changed`）会带着一份
 * 没人看过的权限声明直接出现在菜单里——批准卡就没意义了。
 * 只判 `verdict` 的话，"启用"这个动作变成装饰（装完就有）。
 *
 * 放在这里（而不是 `pluginEngine`）是因为它是**纯判据**：`pluginEngine` 一 import 就拉起 tauri，
 * 那里面写判据等于不可测。
 */
export function panelEnabled(e: { enabled: boolean; verdict: TrustVerdict }): boolean {
  return e.enabled && e.verdict === "trusted";
}

export function permissionDelta(prev: readonly string[], next: readonly string[]): PermissionDelta {
  const a = new Set(prev);
  const b = new Set(next);
  return {
    added: next.filter((x) => !a.has(x)),
    removed: prev.filter((x) => !b.has(x)),
  };
}
