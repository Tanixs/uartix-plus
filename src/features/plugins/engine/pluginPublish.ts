/**
 * P174-R2：把**代码插件**发布到 GitHub 话题。
 *
 * 旧发布器只认旧的 `PluginRecord`；新引擎的包是目录，所以这里把包内文本文件读出来，
 * 原样作为 GitHub 仓库文件（`plugin.json` 在根，市场能直接认），再补 README 与封面。
 *
 * 边界与旧发布器相同：token 只从设置读、只进 `github_publish`、不落日志；目标域固定
 * `api.github.com`；文件数与体积由 Rust 再挡一次。二进制资源暂不发布（文本插件如 YOLO
 * 不受影响），遇到二进制会跳过并在回执里点名。
 */

import { invoke } from "@tauri-apps/api/core";
import { listInExt, readInExt, type InstalledPlugin } from "./pluginEngine";
import type { PluginMeta } from "./pluginMeta";

const TEXT_EXT = /\.(json|mjs|js|cjs|html|htm|css|md|txt|yaml|yml|svg)$/i;
const MAX_FILES = 10; // 留两个位置给 README + 封面；Rust 侧硬顶 12
const MAX_DEPTH = 4;
const MAX_TEXT_BYTES = 512 * 1024;

export interface PublishFile {
  path: string;
  /** base64（GitHub contents API 的 content） */
  content: string;
}

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function buildReadmeV3(p: InstalledPlugin, meta?: PluginMeta): string {
  const m = p.manifest;
  const bits = [
    `# ${meta?.name || m.name}`,
    "",
    meta?.description || m.description || "Uartix+ 插件 / A Uartix+ plugin.",
    "",
    `- 版本 / Version: \`${p.version}\``,
    `- 作者 / Author: ${meta?.author || m.author || "—"}`,
    `- 标识 / ID: \`${p.id}\``,
    ...(m.license ? [`- 许可证 / License: ${m.license}`] : []),
    ...(meta?.homepage || m.homepage ? [`- 主页 / Homepage: ${meta?.homepage || m.homepage}`] : []),
  ];
  if (m.contributes.panels?.length) bits.push("", `## 面板 / Panels`, "", m.contributes.panels.map((x) => `- ${x.title} (\`${x.id}\`)`).join("\n"));
  if (m.contributes.themes?.length) bits.push("", `## 主题 / Themes`, "", m.contributes.themes.map((x) => `- ${x.title} (\`${x.id}\`)`).join("\n"));
  if (m.contributes.commands?.length) bits.push("", `## 命令 / Commands`, "", m.contributes.commands.map((x) => `- ${x.title} (\`${x.id}\`)`).join("\n"));
  bits.push(
    "",
    "## 安装 / Install",
    "",
    "在 Uartix+ 的插件管理里安装这个仓库（GitHub 话题 `uartix-plugin`）。安装前会列出权限并要求批准。",
    "Install this repo from the Uartix+ plugin manager (GitHub topic `uartix-plugin`). Permissions are shown and must be approved.",
    "",
    "## 话题 / Topic",
    "",
    "本仓库属于 GitHub 话题 [`uartix-plugin`](https://github.com/topics/uartix-plugin)。",
    "",
  );
  return bits.join("\n");
}

/** 递归读包内文本文件；二进制/超大/过深的条目跳过并点名。 */
export async function readPackageTextFiles(extId: string): Promise<{ files: PublishFile[]; skipped: string[] }> {
  const files: PublishFile[] = [];
  const skipped: string[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      skipped.push(`${rel}/（层级过深）`);
      return;
    }
    const items = await listInExt(extId, rel);
    for (const it of items) {
      if (files.length >= MAX_FILES) {
        skipped.push(`${rel}/${it.name}（超过 ${MAX_FILES} 个文件）`);
        continue;
      }
      const child = rel ? `${rel}/${it.name}` : it.name;
      if (it.dir) {
        await walk(child, depth + 1);
        continue;
      }
      if (!TEXT_EXT.test(it.name)) {
        skipped.push(`${child}（非文本，已跳过）`);
        continue;
      }
      try {
        const text = await readInExt(extId, child);
        if (new Blob([text]).size > MAX_TEXT_BYTES) {
          skipped.push(`${child}（超过 ${Math.round(MAX_TEXT_BYTES / 1024)}KB，已跳过）`);
          continue;
        }
        files.push({ path: child, content: b64utf8(text) });
      } catch (e) {
        skipped.push(`${child}（读不出来：${String((e as Error)?.message ?? e)}）`);
      }
    }
  }
  await walk("", 0);
  return { files, skipped };
}

export interface PublishOptionsV3 {
  repo: string;
  description?: string;
  isPrivate: boolean;
  topics: string | string[];
}

export type PublishResultV3 =
  | { ok: true; repoUrl: string; topicUrl: string; topics: string[]; created: boolean; files: string[]; warning: string; skipped: string[] }
  | { ok: false; msg: string };

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** 与旧发布器同一套话题归一（保留强制话题；不加新域）。 */
function normalizeTopic(raw: string): string {
  let s = "";
  for (const ch of raw.trim()) {
    const c = ch === " " || ch === "_" ? "-" : ch;
    if (/[a-z0-9]/i.test(c)) s += c.toLowerCase();
    else if (c === "-") s += "-";
  }
  const t = s.replace(/^-+|-+$/g, "");
  return t.length <= 50 && /^[a-z0-9]/.test(t) ? t : "";
}

function mergeTopics(input: string[], forced = "uartix-plugin"): string[] {
  const out: string[] = [];
  for (const raw of [forced, ...input]) {
    const t = normalizeTopic(raw);
    if (t && out.length < 20 && !out.includes(t)) out.push(t);
  }
  return out;
}

export async function publishPluginV3(p: InstalledPlugin, meta: PluginMeta | undefined, opts: PublishOptionsV3): Promise<PublishResultV3> {
  const { getSnapshot: getSettings } = await import("../../settings/settingsStore");
  const settings = getSettings();
  const token = settings.ghToken.trim();
  if (!token) return { ok: false, msg: "先在「设置 → 集成」填入 GitHub Token" };
  const repo = opts.repo.trim();
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") return { ok: false, msg: "仓库名不合法（允许字母/数字/._-，1~100 字）" };

  let pack: { files: PublishFile[]; skipped: string[] };
  try {
    pack = await readPackageTextFiles(p.id);
  } catch (e) {
    return { ok: false, msg: `读取包内文件失败：${String((e as Error)?.message ?? e)}` };
  }
  if (!pack.files.length) return { ok: false, msg: "包里没有可发布的文本文件" };

  const files = [...pack.files];
  if (!files.some((f) => f.path === "README.md")) {
    files.push({ path: "README.md", content: b64utf8(buildReadmeV3(p, meta)) });
  }
  const cover = meta?.cover;
  const cm = cover ? /^data:image\/(png|jpeg|webp);base64,/.exec(cover) : null;
  if (cover && cm) files.push({ path: `cover.${cm[1] === "jpeg" ? "jpg" : cm[1]}`, content: cover.slice(cm[0].length) });
  if (files.length > 12) return { ok: false, msg: "包内文件太多（发布上限 12 个，请先精简）" };

  const rawTopics = Array.isArray(opts.topics) ? opts.topics : opts.topics.split(/[,，]+/);
  try {
    const r = await invoke<{
      repoUrl: string;
      topicUrl: string;
      topics: string[];
      created: boolean;
      files: string[];
      warning: string;
    }>("github_publish", {
      token,
      owner: settings.ghOwner.trim() || null,
      repo,
      description: (opts.description || meta?.description || p.manifest.description || "").trim().slice(0, 350),
      isPrivate: opts.isPrivate,
      files,
      topics: mergeTopics(rawTopics),
      proxy: settings.aiProxy || null,
      noProxy: settings.aiNoProxy || null,
    });
    return { ok: true, ...r, skipped: pack.skipped };
  } catch (e) {
    return { ok: false, msg: String((e as Error)?.message ?? e) };
  }
}
