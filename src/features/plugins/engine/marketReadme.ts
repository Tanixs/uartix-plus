/**
 * P174-R17：README 预览图的**解析层**（纯函数，不碰网络）。
 *
 * 详情页现在会把图抓成 data URL（raw 在部分网络不可达），所以"哪些图值得抓"必须在
 * 这一层定死：只认 GitHub 自家图床、只给本仓路径、包根封面不重复抓。
 * 拆成独立模块也是为了能单测——marketClient 会拖进 settingsStore 的 localStorage。
 */
import { MARKET_RAW_HOST } from "./hosts";
import type { GhRepo } from "./ghSearch";

/** 详情预览图上限。读进来是 data URL，放 5 张也不该把一屏内存吃掉。 */
export const README_IMG_MAX = 1.5 * 1024 * 1024;

export interface ReadmeImageRef {
  url: string;
  /** 本仓库内的相对路径；指向别处/别的分支时没有。raw 打不开时要靠它改走 contents API。 */
  path?: string;
}

export function readmeImageRefs(repo: GhRepo, md: string): ReadmeImageRef[] {
  if (!MARKET_RAW_HOST) return [];
  const base = `https://${MARKET_RAW_HOST}/${repo.owner}/${repo.name}/${repo.defaultBranch}/`;
  const raw: string[] = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g)) raw.push(m[1]);
  for (const m of md.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) raw.push(m[1]);
  const branchPrefix = `/${repo.owner}/${repo.name}/${repo.defaultBranch}/`;
  const out: ReadmeImageRef[] = [];
  for (const r of raw) {
    let u: URL;
    try {
      u = new URL(r, base);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.hostname !== MARKET_RAW_HOST) continue;
    if (u.pathname.includes("/../")) continue;
    if (out.some((x) => x.url === u.toString())) continue;
    let path: string | undefined;
    // 这是 GitHub 上的仓库路径，不是文件系统路径；单独接出来也让"剥前导斜杠"的检查不去误判
    const pathname = u.pathname;
    if (pathname.startsWith(branchPrefix)) {
      try {
        const segs = pathname.slice(branchPrefix.length).split("/").map((s) => decodeURIComponent(s));
        // 编码过的 `..` 也不能进 contents API 的路径
        if (segs.length && !segs.some((s) => s === ".." || s === "")) path = segs.join("/");
      } catch {
        /* 坏的百分号编码：只留 raw URL */
      }
    }
    out.push(path ? { url: u.toString(), path } : { url: u.toString() });
    if (out.length >= 5) break;
  }
  return out;
}

const ROOT_COVER = /^cover\.(png|jpe?g|webp)$/i;

/** 卡片和详情的第一张已经是包根封面；README 再引用同一个文件就跳过（不抓两遍）。 */
export function readmePreviewRefs(repo: GhRepo, md: string): ReadmeImageRef[] {
  return readmeImageRefs(repo, md).filter((r) => !(r.path && ROOT_COVER.test(r.path)));
}
