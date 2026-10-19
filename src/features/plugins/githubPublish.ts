/**
 * P157-E3：插件一键发布到 GitHub 话题（TS 侧）。
 *
 * 这一层只做"把包摊成文件 + 归一化话题 + 调命令"；真正出网的是 Rust `github_publish`
 * （固定 api.github.com、不跟重定向、token 不进错误）。两边各自校验一遍不是重复：
 * 前端挡住"用户填错"，Rust 挡住"前端被绕过"。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import type { PluginManifest } from "./pluginManifest";
import type { PluginRecord } from "./pluginStore";

/** GitHub 话题页的固定目录（发布时始终并入，用户再填的话题排在后面） */
export const FORCED_TOPIC = "uartix-plugin";
export const MAX_TOPICS = 20;

/** 与 Rust `normalize_topic` 同规则：小写、空格/下划线→连字符、只留字母数字与连字符。 */
export function normalizeTopic(raw: string): string {
  let s = "";
  for (const ch of raw.trim()) {
    const c = ch === " " || ch === "_" ? "-" : ch;
    if (/[a-z0-9]/i.test(c)) s += c.toLowerCase();
    else if (c === "-") s += "-";
  }
  const t = s.replace(/^-+|-+$/g, "");
  return t.length <= 50 && /^[a-z0-9]/.test(t) ? t : "";
}

export function mergeTopics(input: string[], forced = FORCED_TOPIC): string[] {
  const out: string[] = [];
  for (const raw of [forced, ...input]) {
    const t = normalizeTopic(raw);
    if (t && out.length < MAX_TOPICS && !out.includes(t)) out.push(t);
  }
  return out;
}

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export interface PublishFile {
  path: string;
  content: string;
}

export function buildReadme(pkg: PluginManifest, topic = FORCED_TOPIC): string {
  const caps = pkg.capabilities.map((c) => `\`${c}\``).join("、") || "—";
  return [
    `# ${pkg.name}`,
    "",
    pkg.desc || "Uartix+ 插件 / A Uartix+ plugin.",
    "",
    `- 版本 / Version: \`${pkg.version}\``,
    `- 作者 / Author: ${pkg.author || "—"}`,
    `- 标识 / ID: \`${pkg.id}\``,
    `- 宿主 API / Host API: \`${pkg.hostApi}\``,
    `- 能力 / Capabilities: ${caps}`,
    ...(pkg.homepage ? [`- 主页 / Homepage: ${pkg.homepage}`] : []),
    "",
    "## 安装 / Install",
    "",
    "在 Uartix+ 打开「设置 → 插件管理」→ 导入 `plugin.uartix.json`，或把包拖进应用窗口。",
    "Import `plugin.uartix.json` in Uartix+ → Settings → Plugins, or drag the package into the app.",
    "",
    "## 话题 / Topic",
    "",
    `本仓库属于 GitHub 话题 [\`${topic}\`](https://github.com/topics/${topic})。`,
    "",
  ].join("\n");
}

/** 包 → 三个发布文件：manifest（UTF-8→b64）、封面（原样 b64）、README（UTF-8→b64）。 */
export function buildPublishFiles(rec: PluginRecord): PublishFile[] {
  const files: PublishFile[] = [
    { path: "plugin.uartix.json", content: b64utf8(JSON.stringify(rec.pkg, null, 2) + "\n") },
  ];
  const cover = rec.pkg.cover;
  if (cover) {
    const m = /^data:image\/(png|jpeg|webp);base64,/.exec(cover);
    if (m) {
      files.push({ path: `cover.${m[1] === "jpeg" ? "jpg" : m[1]}`, content: cover.slice(m[0].length) });
    }
  }
  files.push({ path: "README.md", content: b64utf8(buildReadme(rec.pkg)) });
  return files;
}

export interface PublishOptions {
  repo: string;
  description?: string;
  isPrivate: boolean;
  /** 逗号/空白分隔的话题串或数组 */
  topics: string | string[];
}

export type PublishResult =
  | { ok: true; repoUrl: string; topicUrl: string; topics: string[]; created: boolean; files: string[]; warning: string }
  | { ok: false; msg: string };

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** 调 Rust 发布命令；token 来自设置（secret 键，界面只以密码框出现）。 */
export async function publishPlugin(rec: PluginRecord, opts: PublishOptions): Promise<PublishResult> {
  const settings = getSettings();
  const token = settings.ghToken.trim();
  if (!token) return { ok: false, msg: "先在「设置 → 集成」填入 GitHub Token" };
  const repo = opts.repo.trim();
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    return { ok: false, msg: "仓库名不合法（允许字母/数字/._-，1~100 字）" };
  }
  const rawTopics = Array.isArray(opts.topics) ? opts.topics : opts.topics.split(/[,，]+/);
  const files = buildPublishFiles(rec);
  try {
    const r = await invoke<{
      login: string;
      owner: string;
      repo: string;
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
      description: (opts.description ?? "").trim().slice(0, 350),
      isPrivate: opts.isPrivate,
      files,
      topics: mergeTopics(rawTopics),
      proxy: settings.aiProxy || null,
      noProxy: settings.aiNoProxy || null,
    });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}
