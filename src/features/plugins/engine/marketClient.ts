/**
 * P174-A13/A14：市场通道的 IO 层——搜 GitHub 话题、下归档、解包、落到临时目录。
 *
 * 三条边界写死在文件头，改之前先读一遍：
 * 1. **网络只走 `market_fetch`**：那条是白名单域 + https + 拒重定向 + 硬字节上限。
 *    这里不许出现裸 `fetch()`——裸 fetch 等于把上面四项全绕过去。
 * 2. **装包必须走批准卡**：本文件只负责把包"解到一个临时目录"，然后把目录交给
 *    `planFolder()`。它不写 `plugins/`、不碰账本。跳过批准卡的安装通道一条都不要有。
 * 3. **临时目录用完就删**：解包失败、校验失败、用户取消，三条路都要清。留一堆
 *    `.incoming/*` 在用户 AppData 里，是那种"没人会想到去看"的垃圾。
 */
import { invoke } from "@tauri-apps/api/core";
import { parseSearchResponse, searchUrl, tarballUrl, type GhRepo, type SearchQuery, type SearchResult } from "./ghSearch";
import { unpackTarGz, type PackFile } from "./packUnpack";
import { planFolder, commitInstall, type InstallWarn } from "./pluginEngine";
import type { InstallPlan } from "./install";
import { getSnapshot as getSettings } from "../../settings/settingsStore";
import { MARKET_ALLOW_HOSTS, MARKET_API_HOST } from "./hosts";
import { COVER_MAX_FETCH_BYTES, coverCandidates, gitHubFileBytes, imageMime } from "./marketCover";
import { README_IMG_MAX, readmePreviewRefs } from "./marketReadme";

/**
 * 这条通道允许访问的域：**直接复用市场那张唯一的表**（`MARKET_ALLOW_HOSTS`）。
 *
 * 曾经在这里另写一份常量，被 `settingsSchema.test` 那条「放行域只有一份」当场抓住——
 * 它红得对：两份名单一定会漂，而漂的方向永远是"一份放行、另一份没有"，
 * 那时没人能说清"到底哪份在生效"。
 */
const GH_HOSTS = MARKET_ALLOW_HOSTS;

/** 归档字节上限。插件包不该比这更大；Rust 侧还有一道 8 MiB 的硬顶。 */
export const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  // 分块，避免 apply 的参数个数上限（大文件时会炸在"栈溢出"这种看不懂的地方）
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

interface FetchOk {
  data: string;
  sha256: string;
  bytes: number;
}
async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  // `market_fetch` 失败时**抛**（Rust 侧 `Err(String)`），这里统一成一句人话
  try {
    const r = await invoke<FetchOk>("market_fetch", {
      url,
      allowHosts: GH_HOSTS,
      maxBytes,
      // 代理跟 AI 那套设置共用：在"能不能连上 GitHub"这件事上，用户只有一套期望
      proxy: getSettings().aiProxy || null,
      noProxy: getSettings().aiNoProxy || null,
      // 带上用户的 ghToken 抬高 api.github.com 的搜索限流；Rust 侧只把它发给 api.github.com，不给 codeload/raw
      token: getSettings().ghToken || null,
    });
    return b64ToBytes(r.data);
  } catch (e) {
    // 带 cause：上层要能分辨"网络失败"与"包坏了"，只看 message 会把两者压成一句话。
    // 不用 new Error(msg, {cause})：tsconfig 的 lib 还没到 ES2022，这里手工挂。
    const err = new Error(String((e as Error)?.message ?? e)) as Error & { cause?: unknown };
    err.cause = e;
    throw err;
  }
}

/** 检索 GitHub 话题。网络错误 / 限流 / 空结果三种状态都**分开**报（它们的处理方式完全不同）。 */
export async function searchPlugins(q: SearchQuery): Promise<SearchResult> {
  const bytes = await fetchBytes(searchUrl(q), 2 * 1024 * 1024);
  const text = new TextDecoder().decode(bytes);
  const r = parseSearchResponse(text);
  if (!r.ok) throw new Error(r.msg);
  return r.data;
}

/** 解包出来的文件数/字节数，用于"装之前先说清这包有多大"。 */
export interface PackInfo {
  files: number;
  bytes: number;
  skipped: string[];
}

/**
 * 把一枚归档解到 `appDir/.incoming/<tag>/`，返回那个目录。
 *
 * 为什么落在 appDir 而不是系统临时目录：`plugin_fs_write` 只在登记的根里写（这是牢笼），
 * 而 `planFolder()` 之后要从这个目录读清单。放 appDir 下两件事都满足，也不用给临时目录开新根。
 */
export async function unpackToIncoming(
  archive: Uint8Array,
  tag: string,
): Promise<{ dir: string; info: PackInfo; manifestHint: string }> {
  const r = await unpackTarGz(archive);
  if (!r.ok) throw new Error(r.msg);

  const paths = await invoke<{ appDir: string }>("plugin_paths");
  const root = paths.appDir;
  const dir = `${root}/.incoming/${tag}`;

  await writeFiles(dir, r.files, root);
  const bytes = r.files.reduce((n, f) => n + f.bytes.length, 0);
  return {
    dir,
    info: { files: r.files.length, bytes, skipped: r.skipped },
    manifestHint: r.files.some((f) => f.name === "plugin.json") ? "plugin.json" : "（包根目录没有 plugin.json）",
  };
}

async function writeFiles(dir: string, files: PackFile[], root: string): Promise<void> {
  for (const f of files) {
    // 一律走 b64：文本也行，二进制也对。**不按扩展名猜**——猜错的形态是"装完图是黑的"。
    await invoke("plugin_fs_write_b64", { path: `${dir}/${f.name}`, b64: bytesToB64(f.bytes), roots: [root] });
  }
}

/** 清掉一个临时目录（不存在的就算了，清理失败也不该让安装失败）。 */
export async function cleanIncoming(dir: string): Promise<void> {
  try {
    const paths = await invoke<{ appDir: string }>("plugin_paths");
    await invoke("plugin_remove_tree", { path: dir, roots: [paths.appDir] });
  } catch {
    /* 清不掉不影响结论：下次装会换一个 tag */
  }
}

export interface RepoInstallPreview {
  plan: InstallPlan;
  info: PackInfo;
  /** 临时目录，调用方在 `commit` 或 `cancel` 之后必须调 `cleanIncoming`。 */
  incomingDir: string;
}

/**
 * 从一枚 GitHub 仓库准备安装：下载 → 解包 → 出**安装计划**（不动 `plugins/`）。
 *
 * 返回的是计划，不是"装好了"：批准卡要不要弹，由 `needsApproval(plan)` 决定（与本地装同一个判据）。
 */
export async function prepareRepoInstall(repo: GhRepo): Promise<RepoInstallPreview> {
  const tag = `${repo.owner}-${repo.name}-${Date.now().toString(36)}`.replace(/[^\w.-]/g, "_");
  const archive = await fetchBytes(tarballUrl(repo), ARCHIVE_MAX_BYTES);
  let incomingDir = "";
  try {
    const un = await unpackToIncoming(archive, tag);
    incomingDir = un.dir;
    const plan = await planFolder(un.dir, `gh-${tag}`);
    return { plan, info: un.info, incomingDir };
  } catch (e) {
    if (incomingDir) await cleanIncoming(incomingDir);
    throw e;
  }
}

/** 装（批准之后调）。装完由调用方清理临时目录。 */
export async function commitRepoInstall(plan: InstallPlan, repo: GhRepo): Promise<InstallWarn> {
  return commitInstall(plan, { origin: `github:${repo.full}` });
}

/**
 * 仓库里那份 `plugin.json` 的**摘要**：市场要拿它判"有没有更新"，并在装之前就说清权限面。
 *
 * 三条边界：
 * - **这只是预告，不是判据**。真正的闸仍然是下载解包后的 `planFolder()` + 批准卡；
 *   这里读到什么形状都只往界面上写短句，绝不拿它放行任何东西。
 * - **远端 JSON 是不可信输入**：字段逐个验类型、字符串一律截断，解析不出来就返回 null。
 * - **只为"已装的"和"正打开的"取**：一次搜索 30+ 枚仓库，挨个读清单会立刻撞
 *   GitHub 未登录 10 次/分钟；已装集合是用户自己的小数目，额度上算得过账。
 */
export interface RepoPermBrief {
  read: string[];
  write: string[];
  spawn: string[];
  connect: string[];
  ui: string[];
  secrets: string[];
  ai: string[];
}

/** 清单里声明的产物数量（0 的项视图自己就不渲染了）。 */
export interface RepoKindBrief {
  panels: number;
  themes: number;
  widgets: number;
  presets: number;
  tasks: number;
  commands: number;
}

export interface RepoManifestInfo {
  id: string;
  version: string;
  name: string;
  perms: RepoPermBrief;
  kinds: RepoKindBrief;
}

function short(s: unknown, max = 60): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function strList(v: unknown, cap = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => short(x, 48)).filter(Boolean).slice(0, cap);
}

/** 只翻声明了的项；`ui` / `ai` 那种 `{panel:true}` 取键名，值不是 true 的不算声明。 */
function trueKeys(v: unknown, cap = 12): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  return Object.keys(o)
    .filter((k) => o[k] === true)
    .slice(0, cap);
}

function permBrief(perm: Record<string, unknown>): RepoPermBrief {
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const fs = obj(perm.fs);
  const pr = obj(perm.process);
  const net = obj(perm.net);
  return {
    read: strList(fs.read),
    write: strList(fs.write),
    spawn: strList(pr.spawn),
    connect: strList(net.connect),
    ui: trueKeys(perm.ui),
    secrets: strList(perm.secrets),
    ai: trueKeys(perm.ai),
  };
}

const KIND_KEYS = ["panels", "themes", "widgets", "presets", "tasks", "commands"] as const;

function kindBrief(c: Record<string, unknown>): RepoKindBrief {
  const out = { panels: 0, themes: 0, widgets: 0, presets: 0, tasks: 0, commands: 0 } as RepoKindBrief;
  for (const k of KIND_KEYS) out[k] = Array.isArray(c[k]) ? Math.min(c[k].length, 99) : 0;
  return out;
}

const manifestCache = new Map<string, RepoManifestInfo | null>();
const manifestPending = new Map<string, Promise<RepoManifestInfo | null>>();

export function repoManifest(repo: GhRepo): Promise<RepoManifestInfo | null> {
  const key = `${repo.full}@${repo.updated}`;
  const cached = manifestCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = manifestPending.get(key);
  if (running) return running;
  const p = fetchManifest(repo);
  manifestPending.set(key, p);
  void p.then((v) => {
    manifestPending.delete(key);
    manifestCache.set(key, v);
  });
  return p;
}

async function fetchManifest(repo: GhRepo): Promise<RepoManifestInfo | null> {
  if (!MARKET_API_HOST) return null;
  try {
    const url = `https://${MARKET_API_HOST}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/plugin.json?ref=${encodeURIComponent(repo.defaultBranch)}`;
    const bytes = await fetchBytes(url, 512 * 1024);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { content?: unknown; encoding?: unknown };
    if (typeof json.content !== "string" || json.encoding !== "base64") return null;
    const raw = JSON.parse(new TextDecoder().decode(b64ToBytes(json.content.replace(/\s+/g, "")))) as Record<string, unknown>;
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    return {
      id: short(raw.id, 80),
      version: short(raw.version, 32),
      name: short(raw.name, 80),
      perms: isObj(raw.permissions) ? permBrief(raw.permissions) : permBrief({}),
      kinds: isObj(raw.contributes) ? kindBrief(raw.contributes) : kindBrief({}),
    };
  } catch {
    // 没这个文件 / 网络失败 / JSON 坏了：市场照样能装，只是不显示"可更新"
    return null;
  }
}

/**
 * 市场卡片的封面：包根 `cover.<ext>`，只认能直接 img 的三种。
 *
 * 三条取舍：
 * - **和搜索走同一条 API**：raw 在部分网络里直接解析不了（本机实测），而 api 通；
 *   一个没有封面的仓库最多三次 404，有 token 时这点额度可以忽略。
 * - **网络断了就别挨个试**：非 404 的失败（代理没配、超时、限流）会让后面所有仓库都白等，
 *   所以设一个短暂熔断，整批退回文字砖。404 不算事故——大多数仓库本来就没封面。
 * - **按 `full@updated` 缓存**：翻页/重搜不重复下载；仓库更新了才重新取。
 */
const coverCache = new Map<string, string | null>();
const coverPending = new Map<string, Promise<string | null>>();
/** 一次网络故障后安静多久（毫秒）。够用户切一次代理，又不至于整场会话都没有封面。 */
const COVER_SKIP_MS = 90_000;
let coverSkipUntil = 0;

export function repoCover(repo: GhRepo): Promise<string | null> {
  const key = `${repo.full}@${repo.updated}`;
  const cached = coverCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (Date.now() < coverSkipUntil) return Promise.resolve(null);
  const running = coverPending.get(key);
  if (running) return running;
  const p = (async () => {
    for (const url of coverCandidates(repo)) {
      try {
        const body = await fetchBytes(url, COVER_MAX_FETCH_BYTES);
        const bytes = gitHubFileBytes(new TextDecoder().decode(body));
        const mime = bytes ? imageMime(bytes) : null;
        if (bytes && mime) return `data:${mime};base64,${bytesToB64(bytes)}`;
        return null; // 200 但不是图片：别拿一份 HTML 错误页当封面
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/远端返回 404/.test(msg)) continue;
        coverSkipUntil = Date.now() + COVER_SKIP_MS;
        return null;
      }
    }
    return null;
  })();
  coverPending.set(key, p);
  void p.then((v) => {
    coverPending.delete(key);
    coverCache.set(key, v);
  });
  return p;
}

function imageDataUrl(bytes: Uint8Array): string | null {
  const mime = imageMime(bytes);
  return mime ? `data:${mime};base64,${bytesToB64(bytes)}` : null;
}

/**
 * 本仓预览图走 contents API（与封面同一条路）。
 *
 * 不再先试 raw：raw 在部分网络直接解析不了，而 `market_fetch` 一次失败要等满 20s——
 * 一张图先卡 20s 再回退，详情页的"正在读预览…"就会长到用户以为坏了。API 有 token 时
 * 额度足够，直接走可达的那条。非本仓的外链图（徽章、user-images）不抓。
 */
async function readmeImageViaApi(repo: GhRepo, path: string): Promise<string | null> {
  if (!MARKET_API_HOST) return null;
  const enc = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://${MARKET_API_HOST}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${enc}?ref=${encodeURIComponent(repo.defaultBranch)}`;
  try {
    const bytes = await fetchBytes(url, Math.ceil((README_IMG_MAX * 4) / 3) + 128 * 1024);
    const file = gitHubFileBytes(new TextDecoder().decode(bytes), README_IMG_MAX);
    return file ? imageDataUrl(file) : null;
  } catch {
    return null;
  }
}

/**
 * 点开一枚仓库时才取 README 的预览图；不自动、不批量打 GitHub。失败返回空（详情页照常可看）。
 *
 * 返回的是 **data URL** 而不是 raw 地址：raw 在部分网络不可达，直接塞给 `<img>` 会得到
 * 一张空白的"链接"；本仓的图一律经 contents API 取回。包根 `cover.*` 跳过——
 * 卡片与详情的第一张已经是它，别抓两遍。
 */
export async function readmeImagesForRepo(repo: GhRepo): Promise<string[]> {
  if (!MARKET_API_HOST) return [];
  let md: string;
  try {
    const url = `https://${MARKET_API_HOST}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/readme`;
    const bytes = await fetchBytes(url, 2 * 1024 * 1024);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { content?: unknown; encoding?: unknown };
    if (typeof json.content !== "string" || json.encoding !== "base64") return [];
    md = new TextDecoder().decode(b64ToBytes(json.content.replace(/\s+/g, "")));
  } catch {
    return [];
  }
  const refs = readmePreviewRefs(repo, md).filter((r): r is typeof r & { path: string } => Boolean(r.path));
  const urls = await Promise.all(refs.map((r) => readmeImageViaApi(repo, r.path)));
  return urls.filter((x): x is string => typeof x === "string");
}
