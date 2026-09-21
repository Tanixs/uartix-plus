/**
 * P88b-3 §9.2：uartix-plugin 包格式（schemaVersion 2，对齐 extensionStore 分享包版本起点）。
 * 首版包以 JSON 形态存储于本地插件库（localStorage）；
 * 压缩包/文件系统的 staging 落盘随后续批次，本批先做内存 staging + 原子切换入库。
 *
 * 限额（详设 §11 建议初值）：文件（条目）数 ≤200、单配置 JSON ≤1MiB；
 * 包总体积上限按 localStorage 配额适配为 4MiB（详设 10MiB 为压缩文件包上限，
 * 文件包形态落地时以文件系统为准，此处为 JSON 库形态的保守值）。
 */
import {
  validateArtifact,
  type ArtifactKind,
} from "./artifact";
import { MAX_MODULES_PER_PKG } from "./pluginLimits";

export const PLUGIN_FORMAT = "uartix-plugin";
export const PLUGIN_SCHEMA_VERSION = 2;
/** 宿主 API 版本：本批固定 ^1.0，不匹配的包拒绝安装。 */
export const HOST_API = "^1.0";

/** 包总体积上限（JSON 库形态，见文件头注释）。 */
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
/** 包内条目（产物文件）数上限。 */
export const MAX_PACKAGE_FILES = 200;
/** 单包用户配置字段上限。 */
export const MAX_SETTINGS_FIELDS = 16;

/** 能力白名单：manifest 之外的能力声明一律拒绝（§9.2/§11）。 */
export const PLUGIN_CAPS = [
  "theme.tokens",
  "ui.panel",
  "ui.widget",
  "ui.action",
  /** 窗口控制危险子集：置顶 / 点击穿透 / 弹出系统窗口（详设 §13.2） */
  "win.control",
  /** 本包的 JS 允许被放进专用 Worker 执行（P99a-B1）。刻意**不**与 `agent.tool` 合并：
   * "能跑代码"和"能往 Agent 工具面里加东西"是两件事，混成一支就再也拆不开裁决。 */
  "logic.run",
  /** 本包可向 Agent 注册工具（P99a-B2）。与 `logic.run` 分列：能跑代码 ≠ 能扩工具面 */
  "agent.tool",
  "motion.preset",
  "workspace.preset",
  "workflow.compose",
  "report.view",
  "telemetry.read",
  "serial.send",
  "ai.ask",
] as const;
export type PluginCap = (typeof PLUGIN_CAPS)[number];

/**
 * 纯 UI 能力集：仅含这些能力的插件启用可自动应用（§9.3）。
 *
 * `win.control` **刻意不在这里** —— 自动启用侧放进来就等于"Agent 生成一个置顶且点击穿透
 * 的挂件并自己启用它"，那正是点击劫持的形态。含它的包只能人工启用一次。
 * `logic.run` 同理：会跑 JS 的包不得被自动启用（详设 §11"不给 module 自动启用"）。
 * `agent.tool` 也是同一条规矩：**特权不进自动放行集** —— 否则 Agent 存一个带工具的包、
 * 自己启用、下一步就多了一支自己能调的工具，那是自扩展顺手变成自提权。
 */
export const PURE_UI_CAPS: readonly PluginCap[] = [
  "theme.tokens",
  "ui.panel",
  "ui.widget",
  "ui.action",
  "motion.preset",
  "workspace.preset",
  "workflow.compose",
  "report.view",
  "telemetry.read",
];

/** 产物类型 → 需要的能力（安装时双向校验：声明了贡献却缺能力即拒绝）。 */
export const KIND_REQUIRED_CAP: Record<ArtifactKind, PluginCap> = {
  theme: "theme.tokens",
  motionPreset: "motion.preset",
  widget: "ui.widget",
  panel: "ui.panel",
  workspacePreset: "workspace.preset",
  workflow: "workflow.compose",
  reportView: "report.view",
  module: "logic.run",
};

/** 产物类型 → contributions 里的列表键。 */
export const KIND_CONTRIB_KEY: Record<ArtifactKind, string> = {
  theme: "themes",
  motionPreset: "motionPresets",
  widget: "widgets",
  panel: "panels",
  workspacePreset: "workspacePresets",
  workflow: "workflows",
  reportView: "reportViews",
  module: "modules",
};

export interface ContribEntry {
  id: string;
  entry: string;
  name?: string;
}

export interface PluginConfigField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "enum";
  default: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
}

export interface PluginManifest {
  format: typeof PLUGIN_FORMAT;
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  desc?: string;
  hostApi: string;
  capabilities: PluginCap[];
  contributions: Partial<Record<string, ContribEntry[]>>;
  /** entry 路径 → 产物（{ kind, …内容 }） */
  artifacts: Record<string, Record<string, unknown>>;
  settingsSchema?: PluginConfigField[];
  /** `legacy` 已随 P99a-B1a 零兼容裁决移除（没有任何活代码写入它，它能做的只是免检用桥） */
  provenance: { createdBy: "agent" | "user" | "import"; reviewed: boolean; sourceExtId?: string };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: PluginManifest;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const CONTRIBUT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * 包内条目路径规范化：拒绝绝对路径、盘符、反斜杠、路径穿越、空段（§11）。
 * JSON 库形态不存在符号链接，路径约束即为防穿越的完整边界；文件包形态落地时
 * 由文件系统层再加 realpath 越界检查（在包校验测试中作为约束固定）。
 */
export function normalizeEntryPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s || s.length > 200) return null;
  if (s.includes("\\") || s.includes("\0")) return null; // Windows 路径分隔/空字节
  if (s.startsWith("/") || s.startsWith("~")) return null; // 绝对路径
  if (/^[A-Za-z]:/.test(s)) return null; // 盘符
  const segs = s.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return null; // 空段/当前目录/穿越
  }
  return segs.join("/");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验并规范化 manifest。通过时返回 manifest（规范形态），否则 errors 非空。 */
export function validateManifest(raw: unknown): ManifestValidation {
  const out: ManifestValidation = { ok: false, errors: [], warnings: [] };
  if (!isPlainObject(raw)) {
    out.errors.push("包必须是 JSON 对象");
    return out;
  }
  const bytes = JSON.stringify(raw).length;
  if (bytes > MAX_PACKAGE_BYTES) {
    out.errors.push(`包体积超过上限（${bytes} > ${MAX_PACKAGE_BYTES} 字节）`);
    return out;
  }
  if (raw.format !== PLUGIN_FORMAT) {
    out.errors.push(`format 必须是 "${PLUGIN_FORMAT}"`);
  }
  if (raw.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    out.errors.push(`schemaVersion 必须是 ${PLUGIN_SCHEMA_VERSION}`);
  }
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    out.errors.push('id 必须是小写点分标识（如 "user.workspace.inspection"）');
  }
  if (typeof raw.version !== "string" || !VER_RE.test(raw.version)) {
    out.errors.push("version 必须是 semver（如 1.0.0）");
  }
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 60) {
    out.errors.push("name 必须是 1..60 字符");
  }
  if (raw.hostApi !== HOST_API) {
    out.errors.push(`hostApi 必须是 "${HOST_API}"`);
  }
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) {
    out.errors.push("capabilities 不能为空");
  } else {
    for (const c of raw.capabilities) {
      if (!(PLUGIN_CAPS as readonly string[]).includes(c as string)) {
        out.errors.push(`未知能力：${String(c)}`);
      }
    }
    if (new Set(raw.capabilities).size !== raw.capabilities.length) {
      out.warnings.push("capabilities 存在重复声明");
    }
  }
  if (out.errors.length) return out;

  const caps = raw.capabilities as PluginCap[];

  /* —— contributions 与 artifacts：条目路径规范化 + 类型/能力对应 —— */
  const contributions: Partial<Record<string, ContribEntry[]>> = {};
  const contribRaw = raw.contributions;
  if (contribRaw !== undefined && !isPlainObject(contribRaw)) {
    out.errors.push("contributions 必须是对象");
    return out;
  }
  const artifactsRaw = raw.artifacts;
  if (artifactsRaw !== undefined && !isPlainObject(artifactsRaw)) {
    out.errors.push("artifacts 必须是对象");
    return out;
  }
  const artifacts: Record<string, Record<string, unknown>> = {};
  let moduleCount = 0;
  const entries = Object.entries(artifactsRaw ?? {});
  if (entries.length > MAX_PACKAGE_FILES) {
    out.errors.push(`包内文件数超过上限（${entries.length} > ${MAX_PACKAGE_FILES}）`);
    return out;
  }
  for (const [path, payload] of entries) {
    const norm = normalizeEntryPath(path);
    if (!norm) {
      out.errors.push(`非法产物路径（拒绝穿越/绝对路径/反斜杠/空段）：${String(path)}`);
      continue;
    }
    if (artifacts[norm]) {
      out.errors.push(`产物路径重复：${norm}`);
      continue;
    }
    const v = validateArtifact(payload);
    if (!v.ok) {
      out.errors.push(`产物 ${norm} 校验失败：${v.errors.join("；")}`);
      continue;
    }
    if (v.warnings.length) out.warnings.push(`产物 ${norm}：${v.warnings.join("；")}`);
    const rec = payload as Record<string, unknown>;
    const kind = rec.kind as ArtifactKind;
    if (kind === "module") {
      moduleCount += 1;
      // 首版按包键控 worker：多模块要各自的键控与生命周期，别"收下了但只跑第一个"（§8-37）
      if (moduleCount > MAX_MODULES_PER_PKG) {
        out.errors.push(`一个包最多 ${MAX_MODULES_PER_PKG} 个逻辑模块（多余的请另存为一个包）：${norm}`);
        continue;
      }
    }
    const need = KIND_REQUIRED_CAP[kind];
    if (!caps.includes(need)) {
      out.errors.push(`产物 ${norm} 类型 ${kind} 需要能力 ${need}，manifest 未声明`);
      continue;
    }
    artifacts[norm] = rec;
  }

  /* —— contributions：键名必须匹配产物类型，entry 必须指向存在的产物 —— */
  const usedEntries = new Set<string>();
  if (contribRaw) {
    for (const [key, list] of Object.entries(contribRaw)) {
      const kind = (Object.keys(KIND_CONTRIB_KEY) as ArtifactKind[]).find((k) => KIND_CONTRIB_KEY[k] === key);
      if (!kind) {
        out.errors.push(`未知 contributions 键：${key}`);
        continue;
      }
      if (!Array.isArray(list) || list.length === 0 || list.length > 64) {
        out.errors.push(`contributions.${key} 必须是 1..64 个的数组`);
        continue;
      }
      const norm: ContribEntry[] = [];
      for (const it of list) {
        if (!isPlainObject(it) || typeof it.id !== "string" || !CONTRIBUT_ID_RE.test(it.id)) {
          out.errors.push(`contributions.${key} 条目 id 非法`);
          continue;
        }
        const entry = normalizeEntryPath(it.entry);
        if (!entry || !artifacts[entry]) {
          out.errors.push(`contributions.${key}[${it.id}] entry 不存在或非法：${String(it.entry)}`);
          continue;
        }
        const entryKind = artifacts[entry].kind as string;
        if (entryKind !== kind) {
          out.errors.push(`contributions.${key}[${it.id}] 指向的产物类型是 ${entryKind}，应为 ${kind}`);
          continue;
        }
        if (usedEntries.has(entry)) {
          out.errors.push(`产物 ${entry} 被多个贡献条目引用`);
          continue;
        }
        usedEntries.add(entry);
        norm.push({ id: it.id, entry, ...(typeof it.name === "string" ? { name: it.name.slice(0, 60) } : {}) });
      }
      if (norm.length) contributions[key] = norm;
    }
  }
  if (Object.keys(contributions).length === 0) {
    out.warnings.push("包没有可用的贡献条目（仅保存产物）");
  }
  // 产物没有对应贡献条目：允许（作为库内资产），仅提示
  for (const p of Object.keys(artifacts)) {
    if (!usedEntries.has(p)) out.warnings.push(`产物 ${p} 未被 contributions 引用`);
  }

  /* —— settingsSchema：声明式用户配置 —— */
  let settingsSchema: PluginConfigField[] | undefined;
  if (raw.settingsSchema !== undefined) {
    if (!Array.isArray(raw.settingsSchema) || raw.settingsSchema.length > MAX_SETTINGS_FIELDS) {
      out.errors.push(`settingsSchema 必须是 ≤${MAX_SETTINGS_FIELDS} 个的数组`);
    } else {
      const fields: PluginConfigField[] = [];
      const seen = new Set<string>();
      for (const f of raw.settingsSchema) {
        if (!isPlainObject(f) || typeof f.key !== "string" || !CONTRIBUT_ID_RE.test(f.key) || seen.has(f.key)) {
          out.errors.push("settingsSchema 字段 key 非法或重复");
          continue;
        }
        seen.add(f.key);
        const type = f.type;
        if (type !== "number" && type !== "string" && type !== "boolean" && type !== "enum") {
          out.errors.push(`settingsSchema.${f.key} type 非法`);
          continue;
        }
        if (typeof f.label !== "string" || !f.label.trim()) {
          out.errors.push(`settingsSchema.${f.key} 缺少 label`);
          continue;
        }
        const def = f.default;
        if (type === "number" && (typeof def !== "number" || !Number.isFinite(def))) {
          out.errors.push(`settingsSchema.${f.key} default 必须是数字`);
          continue;
        }
        if (type === "boolean" && typeof def !== "boolean") {
          out.errors.push(`settingsSchema.${f.key} default 必须是布尔`);
          continue;
        }
        if ((type === "string" || type === "enum") && typeof def !== "string") {
          out.errors.push(`settingsSchema.${f.key} default 必须是字符串`);
          continue;
        }
        if (type === "enum" && (!Array.isArray(f.options) || !f.options.includes(def as string))) {
          out.errors.push(`settingsSchema.${f.key} enum 必须提供 options 且含 default`);
          continue;
        }
        fields.push({
          key: f.key,
          label: f.label.slice(0, 60),
          type,
          default: def as number | string | boolean,
          ...(typeof f.min === "number" ? { min: f.min } : {}),
          ...(typeof f.max === "number" ? { max: f.max } : {}),
          ...(type === "enum" ? { options: (f.options as string[]).slice(0, 32) } : {}),
        });
      }
      if (fields.length) settingsSchema = fields;
    }
  }

  /* —— provenance：作者自报 reviewed 不构成信任，导入侧一律重置（§9.3） —— */
  const provRaw = isPlainObject(raw.provenance) ? raw.provenance : {};
  const createdBy = provRaw.createdBy;
  const provenance = {
    createdBy: (["agent", "user", "import"].includes(createdBy as string) ? createdBy : "import") as PluginManifest["provenance"]["createdBy"],
    reviewed: false,
    ...(typeof provRaw.sourceExtId === "string" ? { sourceExtId: provRaw.sourceExtId } : {}),
  };

  if (out.errors.length) return out;
  out.ok = true;
  out.manifest = {
    format: PLUGIN_FORMAT,
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: raw.id as string,
    version: raw.version as string,
    name: (raw.name as string).trim(),
    ...(typeof raw.desc === "string" && raw.desc.trim() ? { desc: raw.desc.trim().slice(0, 300) } : {}),
    hostApi: HOST_API,
    capabilities: caps,
    contributions,
    artifacts,
    ...(settingsSchema ? { settingsSchema } : {}),
    provenance,
  };
  return out;
}

/** 导出白名单：包含疑似秘密字段即拒绝导出（§8/详设 §13 导出插件行）。 */
const SECRET_KEY_RE = /(apikey|api_?key|token|secret|password|passwd|credential|私钥|密钥)/i;

export function containsSecretLike(value: unknown, path = ""): string | null {
  if (typeof value === "string") return null; // 字符串内容不做内容扫描（插件代码可能含 "token" 字样）
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = containsSecretLike(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) return `${path}.${k}`;
      const hit = containsSecretLike(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
