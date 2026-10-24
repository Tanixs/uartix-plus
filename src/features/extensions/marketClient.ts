/**
 * P174-A13/A14：市场通道的 IO 层——搜 GitHub 话题、下归档、解包、落到临时目录。
 *
 * 三条边界写死在文件头，改之前先读一遍：
 * 1. **网络只走 `market_fetch`**：那条是白名单域 + https + 拒重定向 + 硬字节上限。
 *    这里不许出现裸 `fetch()`——裸 fetch 等于把上面四项全绕过去。
 * 2. **装包必须走批准卡**：本文件只负责把包"解到一个临时目录"，然后把目录交给
 *    `planFolder()`。它不写 `extensions/`、不碰账本。跳过批准卡的安装通道一条都不要有。
 * 3. **临时目录用完就删**：解包失败、校验失败、用户取消，三条路都要清。留一堆
 *    `.incoming/*` 在用户 AppData 里，是那种"没人会想到去看"的垃圾。
 */
import { invoke } from "@tauri-apps/api/core";
import { parseSearchResponse, searchUrl, tarballUrl, type GhRepo, type SearchQuery, type SearchResult } from "./ghSearch";
import { unpackTarGz, type PackFile } from "./packUnpack";
import { planFolder, commitInstall, type InstallWarn } from "./extStore";
import type { InstallPlan } from "./install";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { MARKET_ALLOW_HOSTS } from "./hosts";

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
 * 为什么落在 appDir 而不是系统临时目录：`ext_fs_write` 只在登记的根里写（这是牢笼），
 * 而 `planFolder()` 之后要从这个目录读清单。放 appDir 下两件事都满足，也不用给临时目录开新根。
 */
export async function unpackToIncoming(
  archive: Uint8Array,
  tag: string,
): Promise<{ dir: string; info: PackInfo; manifestHint: string }> {
  const r = await unpackTarGz(archive);
  if (!r.ok) throw new Error(r.msg);

  const paths = await invoke<{ appDir: string }>("ext_paths");
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
    await invoke("ext_fs_write_b64", { path: `${dir}/${f.name}`, b64: bytesToB64(f.bytes), roots: [root] });
  }
}

/** 清掉一个临时目录（不存在的就算了，清理失败也不该让安装失败）。 */
export async function cleanIncoming(dir: string): Promise<void> {
  try {
    const paths = await invoke<{ appDir: string }>("ext_paths");
    await invoke("ext_remove_tree", { path: dir, roots: [paths.appDir] });
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
 * 从一枚 GitHub 仓库准备安装：下载 → 解包 → 出**安装计划**（不动 `extensions/`）。
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
