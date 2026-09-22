/**
 * P99b-N1：市场索引（`uartix-market/index@1`）的**契约与解析**。
 *
 * 参照物是 dsh-market + awesome-dsh-plugin：列表来自一份人工 PR、CI 生成的索引，
 * 市场每次打开**实时拉取**，并且**故意不内置快照兜底**（对每天增长的清单，过期答案不是降级而是错误）。
 * 那条判断决定了本文件的三条形状：
 *  1. 信封坏了就是坏了——不"尽力解析"出一份残缺清单（残缺清单会被用户当事实）；
 *  2. **单条坏了只丢那一条**，并留下可显示的原因（一支别人的坏投稿不该让整个货架空掉）；
 *  3. 字段缺失/读不懂 ≠ 不兼容：`compat()` 只回"确认不兼容"或"不知道"，**绝不猜**。
 *
 * 本文件是纯函数叶子：不 import store、不 import Tauri（市场状态在 `marketStore.ts`）。
 */
import { PLUGIN_CAPS } from "../plugins/pluginManifest";

export const MARKET_SCHEMA_VERSION = 1;

/**
 * 远程取回的域白名单（索引里出现的每个 URL 与镜像前缀的域都要过它）。
 * 放在契约文件而不是 store 里：它是**契约的一部分**（解析与校验都要用），
 * 而 store 会拉起 settings/plugins，测试与生成器都不该为了拿这张表去背那些副作用。
 */
export const MARKET_ALLOW_HOSTS = ["raw.githubusercontent.com", "github.com"];

/** 与既有校验器同量级：包 4 MiB、单条截图 4 MiB、索引本身 2 MiB。超限不是"太大"，是"这不是货架该给的东西"。 */
export const MARKET_PKG_MAX_BYTES = 4 * 1024 * 1024;
export const MARKET_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const MARKET_INDEX_MAX_BYTES = 2 * 1024 * 1024;
/** 单条最多带几张图：没有上限就会被一张长图拖死首屏。 */
export const MARKET_SCREENSHOTS_MAX = 8;

export interface MarketDescription {
  zh: string;
  en?: string;
}

export interface MarketEntry {
  id: string;
  name: string;
  author: string;
  category: string;
  description: MarketDescription;
  version: string;
  packageUrl: string;
  /** 索引声明的包哈希；下载后**必比**，不符就拒（§6-2） */
  sha256: string;
  bytes: number;
  /** 索引声明的能力，用于"提权在货架上就露出来"；与包内实际能力比对，多出来即拒装 */
  capabilities: string[];
  screenshots: string[];
  homepage?: string;
  discussion?: string;
  changelogUrl?: string;
  verified?: boolean;
  minAppVersion: string;
  updated: string;
}

export interface MarketIndex {
  schemaVersion: number;
  name: string;
  generatedAt: string;
  source: string;
  docsUrl?: string;
  categories: Record<string, string>;
  entries: MarketEntry[];
  /** 被丢掉的条目与原因：UI 要能数给用户看，不能静默少几支 */
  dropped: { id: string; reason: string }[];
}

export type ParseResult = { ok: true; index: MarketIndex } | { ok: false; errors: string[] };

function fail(...errors: string[]): ParseResult {
  return { ok: false, errors };
}

const CAP_SET = new Set<string>(PLUGIN_CAPS);
const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+){1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** `1.2.3` / `0.4.1`；带 pre-release 后缀的我们不猜 */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isHttpUrl(u: string): boolean {
  return /^https:\/\//i.test(u);
}

/**
 * 包地址与截图允许两种形态：https（要过域白名单）或**同源相对路径**（`/market/...`，
 * 应用自带的示例货架就是这种——它根本不出网，用"必须 https"去卡它只会逼白名单放宽）。
 * `//host/x` 两种都不算：那是协议相对地址，会跟着外网走。
 */
export function isBundledPath(u: string): boolean {
  return u.startsWith("/") && !u.startsWith("//");
}

/** 校验一个地址能不能出现在索引里；返回错误原因，合法回空串。 */
function urlProblem(u: string, allow: readonly string[], kind: string, allowBundled: boolean): string {
  if (!u) return `${kind} 缺失`;
  if (isBundledPath(u)) return allowBundled ? "" : `${kind} 不能用相对地址（外链只收 https）`;
  if (!isHttpUrl(u)) return `${kind} 必须是 https 地址`;
  if (hostAllowed(urlHost(u), allow)) return "";
  return `${kind} 的域不在白名单（${urlHost(u)}）`;
}

/** 取 host（小写、去端口）。解析不了回空串，调用方按"不知道"处理。 */
export function urlHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 域白名单：**精确匹配或子域**，且子域必须以 `.` 边界接上——
 * 拿后缀直接 `endsWith` 会把 `evilgithub.com` 放进 `github.com` 的名单里（与 `..` 越界同族）。
 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  if (!h) return false;
  return allow.some((a) => {
    const base = a.toLowerCase().replace(/^\./, "");
    return h === base || h.endsWith(`.${base}`);
  });
}

/** 语义化版本比较：a>b 回 1，相等 0，小于 -1；任一不可解析回 null（=不知道）。 */
export function compareVersions(a: string, b: string): number | null {
  const pa = SEMVER_RE.test(a) ? a.split(".").map(Number) : null;
  const pb = SEMVER_RE.test(b) ? b.split(".").map(Number) : null;
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** 只有"确认装不上"才是 no；字段缺/格式怪一律 unknown（照参照物的诚实口径） */
export function compat(entry: Pick<MarketEntry, "minAppVersion">, appVersion: string): "yes" | "no" | "unknown" {
  const c = compareVersions(entry.minAppVersion, appVersion);
  if (c === null) return "unknown";
  return c > 0 ? "no" : "yes";
}

/** 攒到的原因拼成一句；**没有原因就必须回 undefined**（这里写成"回退话术"会让一条好条目被判坏，实测过一次）。 */
function bad(reasons: string[]): string | undefined {
  const r = reasons.filter(Boolean);
  return r.length ? r.join("；") : undefined;
}

/** 单条解析：错误只关这一条的生死，不上升到信封。 */
export function parseEntry(raw: unknown, allowHosts: readonly string[]): { entry?: MarketEntry; error?: string } {
  const reasons: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "条目不是对象" };
  const o = raw as Record<string, unknown>;

  const id = str(o.id);
  if (!ID_RE.test(id)) reasons.push("id 非法（小写点分标识）");
  const name = str(o.name);
  if (!name || name.length > 60) reasons.push("name 需为 1..60 字符");
  const author = str(o.author);
  if (!author || author.length > 60) reasons.push("author 需为 1..60 字符");

  const descRaw = o.description;
  const zh = typeof descRaw === "object" && descRaw ? str((descRaw as Record<string, unknown>).zh) : "";
  const en = typeof descRaw === "object" && descRaw ? str((descRaw as Record<string, unknown>).en) : "";
  if (!zh || zh.length > 1000) reasons.push("description.zh 需为 1..1000 字符");
  if (en.length > 1000) reasons.push("description.en 不得超过 1000 字符");

  const category = str(o.category);
  // 分类不在表里**不是丢弃理由**：标签回落到原始 id，让人看得见（不静默少几支）
  if (!category || category.length > 40) reasons.push("category 缺失或过长");

  const version = str(o.version);
  if (!SEMVER_RE.test(version)) reasons.push("version 需为 x.y.z");
  const minAppVersion = str(o.minAppVersion);
  if (!SEMVER_RE.test(minAppVersion)) reasons.push("minAppVersion 需为 x.y.z");
  const updated = str(o.updated);
  if (!DATE_RE.test(updated)) reasons.push("updated 需为 YYYY-MM-DD");

  const packageUrl = str(o.packageUrl);
  const packageProblem = urlProblem(packageUrl, allowHosts, "packageUrl", true);
  if (packageProblem) reasons.push(packageProblem);

  const sha256 = str(o.sha256).toLowerCase();
  if (!SHA_RE.test(sha256)) reasons.push("sha256 需为 64 位十六进制");
  const bytes = o.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) reasons.push("bytes 需为正整数");
  else if (bytes > MARKET_PKG_MAX_BYTES) reasons.push(`bytes 超过上限 ${MARKET_PKG_MAX_BYTES}`);

  const capsRaw = o.capabilities;
  const caps = Array.isArray(capsRaw) ? capsRaw.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
  if (!Array.isArray(capsRaw)) reasons.push("capabilities 必须是数组");
  const unknownCaps = caps.filter((c) => !CAP_SET.has(c));
  if (unknownCaps.length) reasons.push(`capabilities 含未知项（${unknownCaps.join("、")}）`);

  const shotsRaw = Array.isArray(o.screenshots) ? o.screenshots : [];
  if ("screenshots" in o && !Array.isArray(o.screenshots)) reasons.push("截图清单必须是数组");
  const shots: string[] = [];
  for (const s of shotsRaw.slice(0, MARKET_SCREENSHOTS_MAX)) {
    const u = str(s);
    const problem = urlProblem(u, allowHosts, "截图", true);
    if (problem) {
      reasons.push(problem);
      continue;
    }
    shots.push(u);
  }
  if (shotsRaw.length > MARKET_SCREENSHOTS_MAX) reasons.push(`截图超过 ${MARKET_SCREENSHOTS_MAX} 张上限（宁可拒了让人改，也不静默少几图）`);

  for (const [key, val] of [["homepage", o.homepage], ["discussion", o.discussion], ["changelogUrl", o.changelogUrl]] as const) {
    const u = str(val);
    if (!u) continue;
    // 外链一律 https + 白名单：点了就出网的地址不给相对路径，也不给"看着像"的域
    const problem = urlProblem(u, allowHosts, key, false);
    if (problem) reasons.push(problem);
  }

  const error = bad(reasons);
  if (error) return { error };
  const entry: MarketEntry = {
    id,
    name,
    author,
    category,
    description: en ? { zh, en } : { zh },
    version,
    packageUrl,
    sha256,
    bytes: bytes as number,
    capabilities: caps,
    screenshots: shots,
    minAppVersion,
    updated,
  };
  if (typeof o.verified === "boolean") entry.verified = o.verified;
  const hp = str(o.homepage);
  if (hp) entry.homepage = hp;
  const ds = str(o.discussion);
  if (ds) entry.discussion = ds;
  const cl = str(o.changelogUrl);
  if (cl) entry.changelogUrl = cl;
  return { entry };
}

/**
 * 解析索引。
 * @param raw 已 JSON.parse 的内容
 * @param allowHosts 域白名单（索引里出现的每个 URL 都要过它）
 */
export function parseMarketIndex(raw: unknown, allowHosts: readonly string[]): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("索引不是对象");
  const o = raw as Record<string, unknown>;
  const want = Number(o.schemaVersion);
  if (!Number.isInteger(want)) return fail("索引缺少 schemaVersion");
  if (want > MARKET_SCHEMA_VERSION) {
    return fail(`索引版本比应用新（schemaVersion ${want} > ${MARKET_SCHEMA_VERSION}）：请升级 Uartix+ 后再浏览市场`);
  }
  if (want < MARKET_SCHEMA_VERSION) {
    return fail(`索引版本过旧（schemaVersion ${want} < ${MARKET_SCHEMA_VERSION}）：这份清单没有可对照的字段定义，不猜`);
  }
  const catsRaw = o.categories;
  if (!catsRaw || typeof catsRaw !== "object" || Array.isArray(catsRaw)) return fail("categories 必须是 {id: 标签} 对象");
  const categories: Record<string, string> = {};
  for (const [k, v] of Object.entries(catsRaw as Record<string, unknown>)) {
    const label = str(v);
    if (!label) return fail(`分类 ${k} 没有标签`);
    categories[k] = label;
  }
  const pluginsRaw = Array.isArray(o.entries) ? o.entries : null;
  if (!pluginsRaw) return fail("缺少 entries 数组（不猜字段名，索引形状不对就是不对）");

  const entries: MarketEntry[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  pluginsRaw.forEach((item, i) => {
    const candidateId = str((item as Record<string, unknown> | null)?.id) || `第 ${i + 1} 条`;
    const r = parseEntry(item, allowHosts);
    if (r.error) {
      dropped.push({ id: candidateId, reason: r.error });
      return;
    }
    const e = r.entry!;
    if (seen.has(e.id)) {
      dropped.push({ id: e.id, reason: "同一索引里 id 重复" });
      return;
    }
    seen.add(e.id);
    entries.push(e);
  });

  const name = str(o.name) || "社区插件库";
  return {
    ok: true,
    index: {
      schemaVersion: want,
      name,
      generatedAt: str(o.generatedAt),
      source: str(o.source),
      docsUrl: str(o.docsUrl) || undefined,
      categories,
      entries,
      dropped,
    },
  };
}

/** 分类标签：未登记的分类照实显示 id，不塞进别的桶（也不隐藏条目）。 */
export function categoryLabel(index: Pick<MarketIndex, "categories">, id: string): string {
  return index.categories[id] ?? id;
}

/**
 * 与本机插件库的对照结果（界面徽章与装链**共用这一个映射**：
 * 两处各写一遍的话，徽章说"已装同名版本"而装链却去 stage 就是会发生的分裂）。
 *
 * 本机版本由调用方给（界面从 `usePlugins()` 拿）：契约层不去读 store，市场这条链就少一条边。
 * 版本比较用上面的 `compareVersions`——两侧都是各自校验器钉过的 x.y.z（索引 `SEMVER_RE` /
 * manifest `VER_RE`），所以"不可解析"这条分支不存在，不需要为它编一个假状态。
 */
export type InstallState = "absent" | "same" | "update" | "newer-than-shelf";

export function compareInstall(entry: Pick<MarketEntry, "id" | "version">, localVersion: string | undefined): InstallState {
  if (!localVersion) return "absent";
  if (localVersion === entry.version) return "same";
  return (compareVersions(localVersion, entry.version) ?? 0) < 0 ? "update" : "newer-than-shelf";
}
