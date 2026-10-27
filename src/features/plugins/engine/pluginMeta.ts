/**
 * P174-R2：代码插件的**展示信息**（名称/描述/作者/主页/封面/截图）。
 *
 * 为什么不写回 `plugin.json`：那会让一份"展示字段"的修改改变安装包，下一次校验/更新就
 * 对不上；更糟的是别人会以为权限也变了。展示信息只存在本机元信息账本里，**不参与信任指纹**。
 *
 * 版本号不在可编辑字段里：它只能来自安装包（否则"回滚到 1.2.0"会变成一句谎话）。
 */

import { useSyncExternalStore } from "react";

export const META_KEY = "vs.pluginMeta.v1";
const MAX_COVER_BYTES = 256 * 1024;
const MAX_SHOT_BYTES = 256 * 1024;
const MAX_SHOTS = 4;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,/;

export interface PluginMeta {
  name?: string;
  description?: string;
  author?: string;
  homepage?: string;
  cover?: string;
  screenshots?: string[];
  /**
   * 这台机器上次把它发布到了哪个仓库（`owner/name`）。
   *
   * 放这里而不是账本里：它是"用户在这台机器上的一个选择"，不是包的内容，也不参与信任指纹。
   * 存在的理由是那条「仓库名」输入框——以前每次打开都从插件 id 现推一遍，
   * 于是"我明明发到 uartix.yolo 了，再点发布又变回 yolo"。
   */
  publishedRepo?: string;
  updatedAt: number;
}

export interface PluginMetaBook {
  version: 1;
  items: Record<string, PluginMeta>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dataUrlBytes(url: string): number {
  const i = url.indexOf(",");
  if (i < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(((url.length - i - 1) * 3) / 4);
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function cleanImage(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || !IMAGE_DATA_URL.test(v)) return undefined;
  return dataUrlBytes(v) <= max ? v : undefined;
}

/** `owner/name`：只认 GitHub 允许的那串字符，别的形状（URL、带空格）一律当没记过。 */
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function normalizeMeta(raw: unknown): PluginMeta | null {
  if (!isObj(raw)) return null;
  const cover = cleanImage(raw.cover, MAX_COVER_BYTES);
  const shotsRaw = Array.isArray(raw.screenshots) ? raw.screenshots : [];
  const screenshots: string[] = [];
  for (const s of shotsRaw) {
    const img = cleanImage(s, MAX_SHOT_BYTES);
    if (img && screenshots.length < MAX_SHOTS) screenshots.push(img);
  }
  const meta: PluginMeta = {
    ...(cleanText(raw.name, 60) ? { name: cleanText(raw.name, 60)! } : {}),
    ...(cleanText(raw.description, 300) ? { description: cleanText(raw.description, 300)! } : {}),
    ...(cleanText(raw.author, 40) ? { author: cleanText(raw.author, 40)! } : {}),
    ...(typeof raw.homepage === "string" && /^https:\/\/\S+$/i.test(raw.homepage.trim())
      ? { homepage: raw.homepage.trim().slice(0, 500) }
      : {}),
    ...(cover ? { cover } : {}),
    ...(screenshots.length ? { screenshots } : {}),
    ...(typeof raw.publishedRepo === "string" && OWNER_REPO_RE.test(raw.publishedRepo.trim())
      ? { publishedRepo: raw.publishedRepo.trim().slice(0, 120) }
      : {}),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
  return Object.keys(meta).length > 1 ? meta : null;
}

function load(): PluginMetaBook {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) ?? "null");
    if (!isObj(raw) || raw.version !== 1 || !isObj(raw.items)) return { version: 1, items: {} };
    const items: Record<string, PluginMeta> = {};
    let total = 0;
    for (const [id, m] of Object.entries(raw.items)) {
      if (!ID_RE.test(id)) continue;
      const norm = normalizeMeta(m);
      if (!norm) continue;
      const bytes = (norm.cover ? dataUrlBytes(norm.cover) : 0) + (norm.screenshots ?? []).reduce((n, s) => n + dataUrlBytes(s), 0);
      if (total + bytes > MAX_TOTAL_BYTES) continue;
      total += bytes;
      items[id] = norm;
    }
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
}

let book: PluginMetaBook = load();
const subs = new Set<() => void>();

function emit(): void {
  book = { ...book, items: { ...book.items } };
  for (const f of subs) f();
}

function persist(): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(book));
  } catch {
    /* 配额满：内存里仍生效，下一次 reload 回落；不要因此阻断编辑 */
  }
}

export function subscribePluginMeta(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getPluginMetaBook(): PluginMetaBook {
  return book;
}

export function usePluginMetaBook(): PluginMetaBook {
  return useSyncExternalStore(subscribePluginMeta, getPluginMetaBook, getPluginMetaBook);
}

export function getPluginMeta(id: string): PluginMeta | undefined {
  return book.items[id];
}

/** 键级 patch；`undefined` 删除该字段。封面/截图只接受预算内的图片 data URL。 */
export function setPluginMeta(id: string, patch: Partial<Omit<PluginMeta, "updatedAt">>): PluginMeta {
  if (!ID_RE.test(id)) throw new Error(`插件 id 不合规：${id}`);
  const cur = book.items[id] ?? { updatedAt: 0 };
  const next: PluginMeta = { ...cur, ...patch, updatedAt: Date.now() };
  for (const key of ["name", "description", "author", "homepage", "cover", "publishedRepo"] as const) {
    if (next[key] === undefined) delete next[key];
  }
  if (next.screenshots) {
    next.screenshots = next.screenshots.slice(0, MAX_SHOTS).filter((s) => cleanImage(s, MAX_SHOT_BYTES));
    if (!next.screenshots.length) delete next.screenshots;
  }
  const norm = normalizeMeta(next);
  if (!norm) {
    delete book.items[id];
  } else {
    book.items[id] = norm;
  }
  persist();
  emit();
  return norm ?? { updatedAt: Date.now() };
}

export function removePluginMeta(id: string): void {
  if (!book.items[id]) return;
  delete book.items[id];
  persist();
  emit();
}

/** 展示名/描述/作者/主页：元信息优先，缺省回落清单。 */
export const metaName = (fallback: string, m?: PluginMeta): string => m?.name || fallback;
export const metaDescription = (fallback: string, m?: PluginMeta): string => m?.description || fallback;
export const metaAuthor = (fallback: string, m?: PluginMeta): string => m?.author || fallback;
export const metaHomepage = (fallback: string, m?: PluginMeta): string => m?.homepage || fallback;
export const metaCover = (m?: PluginMeta): string | undefined => m?.cover;

/** 供文件选择器使用：一张图 → 受预算的 data URL（复用旧封面压缩器，R3 会把它搬进新层）。 */
export async function readMetaImage(file: File, label: string): Promise<{ ok: true; dataUrl: string } | { ok: false; msg: string }> {
  const { readPicture } = await import("./coverImage");
  return readPicture(file, label);
}
