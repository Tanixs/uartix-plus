/**
 * P174-B1：插件**草稿态**（对应 dsh 的 Creative 模式）。
 *
 * 为什么要单独一层：现在"装"只有一个动作——写进 `extensions/`。于是任何一次"我想试试"都必须
 * 走完整安装（复制、批准、账本、出现在「+面板」），试错成本高到没人愿意试，AI 更不敢试。
 * dsh 的 Creative 做法是"在内存里装、退出即清"；我们没有内存插件树，但**临时目录 + 不写账本**
 * 是等价物，而且天然有磁盘边界（看得见、能删、不会被误当成已安装）。
 *
 * 三条边界：
 * 1. 草稿**不进账本、不进信任库、不进「+面板」**——它只在"草稿"分区里存在；
 * 2. 草稿**不许启动**（没有批准过的东西不跑代码，这是底线，不因为"放宽权限"而破）；
 * 3. 转正只有一条路：`planFolder(草稿目录)` → 批准卡 → `commitInstall`。**草稿不提供"免批准转正"**。
 *
 * 放宽的部分：草稿的**数量、体积、来源**都不设人为门槛（不像 `EXT_LIMITS` 那样卡条数）——
 * 试错本来就是散的，卡它只会让人绕过这套机制。
 */
import { invoke } from "@tauri-apps/api/core";

/** 草稿根：`<appDir>/.drafts`。放 appDir 下是因为 `ext_fs_write` 只认登记的根。 */
export function draftRoot(appDir: string): string {
  return `${String(appDir).replace(/\\/g, "/").replace(/\/+$/, "")}/.drafts`;
}

/**
 * 草稿目录名：`<manifest id>-<tag>`。
 *
 * 带 tag 是为了**同一个插件可以有多份草稿**（改一版、留一版对比）。tag 只允许
 * `[a-z0-9]`，因为它要进路径——非法字符会变成"草稿建在别人的目录里"。
 */
export function draftDirName(pluginId: string, tag: string): string {
  const id = String(pluginId).trim();
  const t = String(tag).trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "draft";
  return `${id}-${t}`;
}

/** 草稿目录是否落在草稿根**里面**（防 `../` 与绝对路径：草稿也是别人写的东西）。 */
export function draftPathOf(appDir: string, name: string): string | null {
  const root = draftRoot(appDir);
  const n = String(name).trim();
  if (!n || n.includes("/") || n.includes("\\") || n.includes("..") || n.startsWith(".")) return null;
  return `${root}/${n}`;
}

export interface DraftEntry {
  /** 目录名（`<id>-<tag>`），草稿在这一层的唯一键。 */
  name: string;
  dir: string;
  /** 清单里的 id / 名称 / 版本；清单坏了也照样列出来（坏草稿更该被看见）。 */
  id: string;
  title: string;
  version: string;
  /** 清单校验失败的原因；空串＝这份草稿是合法的，可以转正。 */
  issue: string;
  /** 与"已装的同 id 插件"的版本关系，给"要不要转正"做参考。 */
  installedVersion?: string;
}

/**
 * 从一份草稿目录读清单并归一成条目。**清单坏了不抛**：坏草稿出现在列表里比消失更有用
 * （"我明明拷进去了"是常见困惑）。
 */
export function toDraftEntry(name: string, dir: string, raw: unknown, installedVersion?: string): DraftEntry {
  const base = { name, dir, id: "", title: name, version: "", issue: "", installedVersion };
  if (!raw || typeof raw !== "object") return { ...base, issue: "plugin.json 不是对象" };
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const title = typeof o.name === "string" && o.name ? o.name : id || name;
  const version = typeof o.version === "string" ? o.version : "";
  return { ...base, id, title, version };
}

/** 草稿条数上限——**故意给得很大**：这不是权限，是"别一次拷进来一万个"的地板。 */
export const DRAFT_LIMIT = 200;

const norm = (p: string) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

/** 列草稿（读盘失败就当没有：草稿不是关键路径，不该让面板打不开）。 */
export async function listDrafts(appDir: string): Promise<DraftEntry[]> {
  const root = draftRoot(appDir);
  const out: DraftEntry[] = [];
  let names: string[];
  try {
    const r = await invoke<{ items: { name: string; dir: boolean }[] }>("ext_fs_list", { dir: root, roots: [appDir] });
    names = r.items.filter((i) => i.dir).map((i) => i.name);
  } catch {
    return out; // 目录还不存在
  }
  for (const name of names.slice(0, DRAFT_LIMIT)) {
    const dir = `${root}/${name}`;
    let raw: unknown = null;
    let issue = "";
    try {
      const f = await invoke<{ exists: boolean; text: string; truncated: boolean }>("ext_fs_read", {
        path: `${dir}/plugin.json`,
        roots: [appDir],
      });
      if (!f.exists) issue = "缺 plugin.json";
      else if (f.truncated) issue = "plugin.json 超过 256 KiB";
      else {
        try {
          raw = JSON.parse(f.text);
        } catch {
          issue = "plugin.json 不是合法 JSON";
        }
      }
    } catch (e) {
      issue = String((e as Error)?.message ?? e);
    }
    const e0 = toDraftEntry(name, dir, raw);
    out.push({ ...e0, issue: issue || e0.issue });
  }
  return out;
}

/** 丢掉一份草稿。路径先过 `draftPathOf`——草稿目录也是"别人写的东西"，一样不许越界。 */
export async function discardDraft(appDir: string, name: string): Promise<void> {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  await invoke("ext_remove_tree", { path: dir, roots: [appDir] });
}

/** 草稿目录的绝对路径（转正时交给 `planFolder`）。 */
export function draftDirOf(appDir: string, name: string): string {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  return norm(dir);
}
