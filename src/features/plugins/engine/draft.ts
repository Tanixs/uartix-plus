/**
 * P174-B1：插件**草稿态**（对应 dsh 的 Creative 模式）。
 *
 * 为什么要单独一层：现在"装"只有一个动作——写进 `plugins/`。于是任何一次"我想试试"都必须
 * 走完整安装（复制、批准、账本、出现在「+面板」），试错成本高到没人愿意试，AI 更不敢试。
 * dsh 的 Creative 做法是"在内存里装、退出即清"；我们没有内存插件树，但**临时目录 + 不写账本**
 * 是等价物，而且天然有磁盘边界（看得见、能删、不会被误当成已安装）。
 *
 * 三条边界：
 * 1. 草稿**不进账本、不进信任库、不进「+面板」**——它只在"草稿"分区里存在；
 * 2. 草稿**不许启动**（没有批准过的东西不跑代码，这是底线，不因为"放宽权限"而破）；
 * 3. 转正只有一条路：`planFolder(草稿目录)` → 批准卡 → `commitInstall`。**草稿不提供"免批准转正"**。
 *
 * 放宽的部分：草稿的**数量、体积、来源**都不设人为门槛（不像 `PLUGIN_LIMITS` 那样卡条数）——
 * 试错本来就是散的，卡它只会让人绕过这套机制。
 */
import { invoke } from "@tauri-apps/api/core";
import { validateExtension, type PluginManifest } from "./manifest";
import { flattenPermissions } from "./repo";

/** 草稿根：`<appDir>/.drafts`。放 appDir 下是因为 `plugin_fs_write` 只认登记的根。 */
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
  /** 校验过了但值得提一句的地方（例如没写 activation）。 */
  warnings: string[];
  /** 批准卡上会列出的那几行权限（只在清单合法时非空）。 */
  permissions: string[];
  /** 清单合法时的规范形态；不合法时为 undefined。转正计划也由它算出来。 */
  manifest?: PluginManifest;
  /** 与"已装的同 id 插件"的版本关系，给"要不要转正"做参考。 */
  installedVersion?: string;
}

/**
 * 从一份草稿目录读清单并归一成条目。**清单坏了不抛**：坏草稿出现在列表里比消失更有用
 * （"我明明拷进去了"是常见困惑）。
 *
 * B1 收尾起这里**真的跑一遍校验器**，不再只看 id/name/version：草稿分区要能在转正之前
 * 就说清"这份包根本装不上"，而不是让用户点了转正才吃一句 `planFolder` 抛出来的错。
 */
export function toDraftEntry(name: string, dir: string, raw: unknown, installedVersion?: string): DraftEntry {
  const base = {
    name,
    dir,
    id: "",
    title: name,
    version: "",
    issue: "",
    warnings: [] as string[],
    permissions: [] as string[],
    installedVersion,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base, issue: "plugin.json 不是对象" };
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const title = typeof o.name === "string" && o.name ? o.name : id || name;
  const version = typeof o.version === "string" ? o.version : "";
  const v = validateExtension(raw);
  if (!v.ok || !v.manifest) {
    return {
      ...base,
      id,
      title,
      version,
      issue: v.legacy ? "旧版插件格式（schemaVersion 1/2），不能转正" : v.errors[0] ?? "清单校验失败",
      warnings: v.warnings,
    };
  }
  return {
    ...base,
    id: v.manifest.id,
    title: v.manifest.name,
    version: v.manifest.version,
    warnings: v.warnings,
    permissions: flattenPermissions(v.manifest),
    manifest: v.manifest,
  };
}

/**
 * 读草稿里的一个文件（预览用）。**只读、且只读这份草稿自己的目录**：
 * 路径按 `draftRelPath` 归一，越界一律拒——预览不该成为"从草稿里读任意文件"的通道。
 */
export async function readDraftFile(appDir: string, name: string, rel: string): Promise<string> {
  const safe = draftRelPath(rel);
  if (!safe) throw new Error(`草稿内的路径不合法：${rel}`);
  const r = await invoke<{ exists: boolean; text: string; truncated: boolean }>("plugin_fs_read", {
    path: `${draftDirOf(appDir, name)}/${safe}`,
    roots: [appDir],
  });
  if (!r.exists) throw new Error(`草稿里没有这个文件：${safe}`);
  return r.text;
}


/** 草稿里"能预览的那一件"（面板优先，其次小部件，最后主题）。纯函数：预览面与门共用同一判据。 */
export type DraftPreviewTarget =
  | { kind: "panel"; id: string; title: string; entry: string }
  | { kind: "widget"; id: string; title: string; entry: string }
  | { kind: "theme"; id: string; title: string; entry: string };

export function draftPreviewTarget(entry: Pick<DraftEntry, "manifest">): DraftPreviewTarget | null {
  const c = entry.manifest?.contributes;
  if (!c) return null;
  const p = c.panels?.[0];
  if (p) return { kind: "panel", id: p.id, title: p.title, entry: p.entry };
  const w = c.widgets?.[0];
  if (w) return { kind: "widget", id: w.id, title: w.title, entry: w.entry };
  const t = c.themes?.[0];
  if (t) return { kind: "theme", id: t.id, title: t.title, entry: t.entry };
  return null;
}

/** 草稿条数上限——**故意给得很大**：这不是权限，是"别一次拷进来一万个"的地板。 */
export const DRAFT_LIMIT = 200;

/**
 * 一次 `plugin_draft_save` 最多写多少文件/多大。
 *
 * 同样是地板不是权限：草稿**可以**很大（`DRAFT_LIMIT` 数量、这里单次体积），
 * 但一次工具调用把 2000 个文件塞进 JSON 里，先炸的是模型上下文与 IPC。
 * 要更大的包就分几次写（同一份草稿按 tag 续写）。
 */
export const DRAFT_WRITE_LIMITS = {
  files: 200,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
} as const;

const norm = (p: string) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * 草稿内相对路径判据。草稿是"别人写的东西"，文件路径也是别人给的——
 * 绝对路径、盘符、`..`、空段一律拒，否则一次写入就能落到草稿根之外。
 *
 * 反斜杠**归一成正斜杠**而不是拒：Windows 上用户/AI 很可能写 `sub\file.txt`，
 * 归一之后它仍然被逐段检查，安全性不变。
 */
export function draftRelPath(rel: string): string | null {
  const s = String(rel).trim().replace(/\\/g, "/");
  if (!s || s.length > 300) return null;
  if (s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:/.test(s)) return null;
  if (s.includes("\0")) return null;
  const segs = s.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  return segs.join("/");
}


/**
 * 草稿目录里的文件清单（递归，封顶）。**只用来做"清单里点的名，包里真的有吗"**。
 *
 * 为什么必须查：`entry` 指向的文件不存在时，清单本身是**合法**的——
 * 转正会成功、装完是一个没有 CSS 的主题 / 打不开的面板。真机用真模型跑出来过这一形态
 * （它写了 `"entry": "theme.css"`，但整份草稿里只有 plugin.json 与 main.mjs）。
 * 那种"装上了、什么也没发生"最难查，所以在这一层就把它拦成 issue。
 */
async function listDraftFiles(appDir: string, dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 4 || out.size > 400) return;
    try {
      const r = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("plugin_fs_list", {
        dir: rel ? `${dir}/${rel}` : dir,
        roots: [appDir],
      });
      if (!r.exists) return;
      for (const it of r.items) {
        const next = rel ? `${rel}/${it.name}` : it.name;
        if (it.dir) await walk(next, depth + 1);
        else out.add(next);
      }
    } catch {
      /* 列目录失败不该把草稿判死：这条只是加分项，读不到就当没有清单外的事实 */
    }
  };
  await walk("", 0);
  return out;
}

/** 清单里点名的入口文件，一个都不能缺。返回缺失项的人话（空数组 = 齐了）。 */
export function missingDeclaredFiles(m: PluginManifest, files: ReadonlySet<string>): string[] {
  const miss: string[] = [];
  const c = m.contributes;
  const check = (where: string, entry: string): void => {
    if (!files.has(entry)) miss.push(`${where} 的 entry「${entry}」不在包里`);
  };
  for (const p of c.panels ?? []) check(`面板「${p.title}」`, p.entry);
  for (const t of c.themes ?? []) check(`主题「${t.title}」`, t.entry);
  for (const w of c.widgets ?? []) check(`小部件「${w.title}」`, w.entry);
  for (const p of c.presets ?? []) check(`工作区预设「${p.title}」`, p.entry);
  for (const t of c.tasks ?? []) check(`任务模板「${t.title}」`, t.entry);
  if (m.main && !files.has(m.main)) miss.push(`清单声明了 main「${m.main}」，但包里没有这个文件`);
  return miss;
}

/** 读一份草稿目录里的清单并归一（不抛：坏草稿也要能出现在列表里）。 */
async function readDraftAt(appDir: string, name: string, dir: string, installedVersion?: string): Promise<DraftEntry> {
  let raw: unknown = null;
  let issue = "";
  try {
    const f = await invoke<{ exists: boolean; text: string; truncated: boolean }>("plugin_fs_read", {
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
  const e0 = toDraftEntry(name, dir, raw, installedVersion);
  // 清单合法还不够：它点名的入口文件得真的在包里（缺了就是"装上了但什么也没有"）
  let entryIssue = "";
  if (!issue && !e0.issue && e0.manifest) {
    const miss = missingDeclaredFiles(e0.manifest, await listDraftFiles(appDir, dir));
    if (miss.length) entryIssue = `清单点名的文件不在包里：${miss.join("；")}`;
  }
  return { ...e0, issue: issue || e0.issue || entryIssue };
}

/**
 * 列草稿（读盘失败就当没有：草稿不是关键路径，不该让面板打不开）。
 * `installed` 是「已装插件 id → 版本」，只用于在草稿详情里提示版本关系。
 */
export async function listDrafts(appDir: string, installed: Record<string, string> = {}): Promise<DraftEntry[]> {
  const root = draftRoot(appDir);
  const out: DraftEntry[] = [];
  let names: string[];
  try {
    const r = await invoke<{ items: { name: string; dir: boolean }[] }>("plugin_fs_list", { dir: root, roots: [appDir] });
    names = r.items.filter((i) => i.dir).map((i) => i.name);
  } catch {
    return out; // 目录还不存在
  }
  for (const name of names.slice(0, DRAFT_LIMIT)) {
    const dir = `${root}/${name}`;
    const got = await readDraftAt(appDir, name, dir);
    const id = got.id;
    out.push(id && installed[id] ? { ...got, installedVersion: installed[id] } : got);
  }
  return out;
}

/** 单份草稿的归一结果。转正请求在前端先拿它做一次可读校验。 */
export async function getDraft(appDir: string, name: string, installedVersion?: string): Promise<DraftEntry> {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  return readDraftAt(appDir, name, dir, installedVersion);
}

/**
 * 把一组文件写进一份草稿目录（`plugin_draft_save` 的 IO 半边）。
 *
 * 只写不删：同名文件覆盖，未提及的旧文件留在原处——"改一版留一版"靠的是 tag，
 * 而不是每次写入把旧文件清空（那样一次写漏就变成"少文件"）。
 * 写入之后再读一遍清单：返回的是**磁盘事实**，不是"我以为写成了什么"。
 */
export async function writeDraftFiles(
  appDir: string,
  name: string,
  files: Record<string, string>,
): Promise<{ entry: DraftEntry; written: number; bytes: number }> {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  const rels = Object.keys(files);
  if (!rels.length) throw new Error("没有要写的文件");
  if (rels.length > DRAFT_WRITE_LIMITS.files) {
    throw new Error(`一次最多写 ${DRAFT_WRITE_LIMITS.files} 个文件（收到 ${rels.length} 个），请分几次写`);
  }
  let bytes = 0;
  const out: { rel: string; content: string }[] = [];
  for (const rel0 of rels) {
    const rel = draftRelPath(rel0);
    if (!rel) throw new Error(`草稿内路径非法：${rel0}`);
    const content = files[rel0];
    if (typeof content !== "string") throw new Error(`文件内容必须是字符串：${rel0}`);
    const size = new TextEncoder().encode(content).length;
    if (size > DRAFT_WRITE_LIMITS.fileBytes) throw new Error(`文件 ${rel} 超过 8 MiB`);
    bytes += size;
    if (bytes > DRAFT_WRITE_LIMITS.totalBytes) throw new Error("这次要写的总字节超过 32 MiB，请分几次写");
    out.push({ rel, content });
  }
  for (const f of out) {
    await invoke("plugin_fs_write", { path: `${dir}/${f.rel}`, content: f.content, roots: [appDir] });
  }
  const entry = await readDraftAt(appDir, name, dir);
  return { entry, written: out.length, bytes };
}

/** 丢掉一份草稿。路径先过 `draftPathOf`——草稿目录也是"别人写的东西"，一样不许越界。 */
export async function discardDraft(appDir: string, name: string): Promise<void> {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  await invoke("plugin_remove_tree", { path: dir, roots: [appDir] });
}

/** 草稿目录的绝对路径（转正时交给 `planFolder`）。 */
export function draftDirOf(appDir: string, name: string): string {
  const dir = draftPathOf(appDir, name);
  if (!dir) throw new Error(`草稿目录名非法：${name}`);
  return norm(dir);
}
