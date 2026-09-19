/**
 * P88b-3 §9.1：统一 Artifact 类型与校验器。
 * 产物优先声明式 schema；高级 HTML 以隔离插件形式渲染（§11），不生成主进程 React 源码。
 * 校验只做结构与限额判定，跨 store 的语义校验（通道存在性、工具注册表）在安装时进行。
 */

export type ArtifactKind =
  | "theme"
  | "motionPreset"
  | "widget"
  | "panel"
  | "workspacePreset"
  | "workflow"
  | "reportView";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "theme",
  "motionPreset",
  "widget",
  "panel",
  "workspacePreset",
  "workflow",
  "reportView",
];

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  theme: "主题",
  motionPreset: "动效预设",
  widget: "小部件",
  panel: "面板",
  workspacePreset: "工作区预设",
  workflow: "工作流",
  reportView: "报告视图",
};

/** 单个产物 JSON 字节上限（详设 §11 建议初值：单配置 JSON 1MiB）。 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** 声明式块：指标卡 / 迷你图 / 富文本 / 自定义 HTML（受限）。 */
export type DeclarativeBlock =
  | { type: "metric"; title: string; channel?: string; unit?: string; precision?: number }
  | { type: "spark"; title: string; channel: string; seconds?: number }
  | { type: "text"; title?: string; text: string }
  | { type: "html"; html: string };

export interface ThemeArtifact {
  vars: Record<string, string>;
  css?: string;
}
export interface MotionPresetArtifact {
  presets: Array<{
    name: string;
    durationMs: number;
    easing: string;
    trigger: "stateChange" | "alert" | "open" | "hover";
  }>;
}
/** widget/panel 内容判别器用 format（外层 kind 是产物类型，见 validateArtifact）。 */
export type WidgetArtifact =
  | { format: "html"; html: string; chrome?: "none" }
  | { format: "declarative"; blocks: DeclarativeBlock[]; chrome?: "none" };
export type PanelArtifact =
  | { format: "html"; html: string }
  | { format: "declarative"; blocks: DeclarativeBlock[] };
export interface WorkspacePresetArtifact {
  /** dockview 布局 JSON（applyLayoutSlot 消费的数据形状，安装时不自动应用） */
  layout: Record<string, unknown>;
  note?: string;
}
export interface WorkflowArtifact {
  /** 声明式组合宿主已注册工具（§11：工具插件首版只允许声明式组合） */
  steps: Array<{ tool: string; args?: Record<string, unknown>; note?: string }>;
}
export interface ReportViewArtifact {
  blocks: DeclarativeBlock[];
}

export type PluginArtifact =
  | ({ kind: ArtifactKind } & Record<string, unknown>);

export interface ValidationIssue {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 主题变量键：必须是 CSS 自定义属性（--xxx），值限长防注入巨型字符串。 */
function validateTheme(a: Record<string, unknown>, out: ValidationIssue) {
  const vars = a.vars;
  if (!isPlainObject(vars)) {
    out.errors.push("theme.vars 必须是对象");
    return;
  }
  const keys = Object.keys(vars);
  // 纯样式层迁移件允许无变量（仅有 css）
  if (keys.length === 0 && typeof a.css !== "string") out.errors.push("theme.vars 不能为空");
  if (keys.length > 128) out.errors.push("theme.vars 数量超过 128");
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith("--")) out.errors.push(`主题变量键必须以 -- 开头：${k}`);
    if (typeof v !== "string" || v.length > 200) out.errors.push(`主题变量值必须是 ≤200 字符字符串：${k}`);
  }
  if (a.css !== undefined) {
    if (typeof a.css !== "string" || a.css.length > 64 * 1024) {
      out.errors.push("theme.css 必须是 ≤64KiB 字符串");
    } else if (/@import|url\(\s*['"]?https?:/i.test(a.css)) {
      // §11：默认禁外部资源；http(s) 引用一律拒绝，data: 由 CSP 兜底
      out.errors.push("theme.css 不允许 @import 或外部 url() 引用");
    } else if (/position\s*:\s*fixed/i.test(a.css)) {
      // §10：主题不得遮挡批准组件/安全提示，fixed 覆盖层给出警告（由预览人工确认）
      out.warnings.push("theme.css 含 position:fixed 覆盖层，请确认不遮挡安全提示与停止入口");
    }
  }
}

function validateMotion(a: Record<string, unknown>, out: ValidationIssue) {
  const presets = a.presets;
  if (!Array.isArray(presets) || presets.length === 0 || presets.length > 32) {
    out.errors.push("motionPreset.presets 必须是 1..32 个的数组");
    return;
  }
  const easings = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"];
  const triggers = ["stateChange", "alert", "open", "hover"];
  for (const p of presets) {
    const e = p as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim()) out.errors.push("动效缺少 name");
    const d = Number(e.durationMs);
    if (!Number.isFinite(d) || d < 50 || d > 5000) out.errors.push(`动效「${String(e.name)}」durationMs 必须在 50..5000`);
    const es = typeof e.easing === "string" ? e.easing : "";
    if (!easings.some((x) => es === x || es.startsWith("cubic-bezier("))) {
      out.errors.push(`动效「${String(e.name)}」easing 不受支持`);
    }
    if (!triggers.includes(String(e.trigger))) out.errors.push(`动效「${String(e.name)}」trigger 非法`);
  }
}

const MAX_HTML = 512 * 1024;

/** widget/panel 共用：format 判别 html 或 declarative（缺省时按 html 字段推断）。 */
function validateUiArtifact(a: Record<string, unknown>, out: ValidationIssue, allowChrome: boolean) {
  const format = a.format ?? (typeof a.html === "string" ? "html" : undefined);
  if (format === "html") {
    if (typeof a.html !== "string" || !a.html.trim()) out.errors.push("html 内容为空");
    else if (a.html.length > MAX_HTML) out.errors.push("html 超过 512KiB 上限");
    else {
      // 外链资源在 iframe CSP 已被禁；这里提前给出可读错误
      const m = a.html.match(/(?:src|href)\s*=\s*["']https?:\/\//i);
      if (m) out.warnings.push("html 引用外链资源，新插件 iframe 将按 CSP 拦截（建议改用内联或 data:）");
      if (/<script[^>]+src=/i.test(a.html)) out.warnings.push("html 含外部 script，新插件 iframe 将按 CSP 拦截");
    }
    if (a.chrome !== undefined && allowChrome && a.chrome !== "none") out.errors.push('chrome 仅支持 "none"');
  } else if (format === "declarative") {
    validateBlocks(a.blocks, out);
  } else {
    out.errors.push('widget/panel 内容必须是 { format: "html" | "declarative", … }');
  }
}

export function validateBlocks(blocks: unknown, out: ValidationIssue) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 64) {
    out.errors.push("blocks 必须是 1..64 个的数组");
    return;
  }
  for (const b of blocks) {
    if (!isPlainObject(b)) {
      out.errors.push("块必须是对象");
      continue;
    }
    switch (b.type) {
      case "metric": {
        if (typeof b.title !== "string" || !b.title.trim()) out.errors.push("metric 缺少 title");
        if (b.channel !== undefined && typeof b.channel !== "string") out.errors.push("metric.channel 必须是字符串");
        if (b.precision !== undefined && (!Number.isInteger(b.precision) || (b.precision as number) < 0 || (b.precision as number) > 8)) {
          out.errors.push("metric.precision 必须是 0..8 整数");
        }
        break;
      }
      case "spark": {
        if (typeof b.channel !== "string" || !b.channel.trim()) out.errors.push("spark 缺少 channel");
        if (b.seconds !== undefined && (!Number.isFinite(b.seconds) || (b.seconds as number) < 1 || (b.seconds as number) > 3600)) {
          out.errors.push("spark.seconds 必须在 1..3600");
        }
        break;
      }
      case "text": {
        if (typeof b.text !== "string" || b.text.length > 8192) out.errors.push("text 内容必须是 ≤8KiB 字符串");
        break;
      }
      case "html": {
        if (typeof b.html !== "string" || b.html.length > 64 * 1024) out.errors.push("html 块内容必须 ≤64KiB");
        break;
      }
      default:
        out.errors.push(`未知块类型：${String(b.type)}`);
    }
  }
}

function validateWorkspace(a: Record<string, unknown>, out: ValidationIssue) {
  if (!isPlainObject(a.layout)) out.errors.push("workspacePreset.layout 必须是对象");
  if (a.note !== undefined && (typeof a.note !== "string" || a.note.length > 2000)) out.errors.push("note 必须是 ≤2000 字符串");
}

function validateWorkflow(a: Record<string, unknown>, out: ValidationIssue) {
  const steps = a.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 64) {
    out.errors.push("workflow.steps 必须是 1..64 个的数组");
    return;
  }
  for (const s of steps) {
    if (!isPlainObject(s) || typeof s.tool !== "string" || !s.tool.trim()) {
      out.errors.push("workflow.step 缺少 tool 名称");
    } else if (s.args !== undefined && !isPlainObject(s.args)) {
      out.errors.push("workflow.step.args 必须是对象");
    }
  }
}

function validateReportView(a: Record<string, unknown>, out: ValidationIssue) {
  validateBlocks(a.blocks, out);
}

/**
 * 校验产物内容。errors 非空即拒绝；warnings 不阻塞（预览时提示）。
 * kind 与内容的匹配由调用方选择校验分支（artifactPayload 携带自身 kind）。
 */
export function validateArtifactPayload(kind: ArtifactKind, payload: unknown): ValidationIssue {
  const out: ValidationIssue = { ok: true, errors: [], warnings: [] };
  if (!isPlainObject(payload)) {
    return { ok: false, errors: ["产物内容必须是对象"], warnings: [] };
  }
  const bytes = JSON.stringify(payload).length;
  if (bytes > MAX_ARTIFACT_BYTES) {
    return { ok: false, errors: [`产物超过单 JSON 1MiB 上限（${bytes} 字节）`], warnings: [] };
  }
  switch (kind) {
    case "theme":
      validateTheme(payload, out);
      break;
    case "motionPreset":
      validateMotion(payload, out);
      break;
    case "widget":
      validateUiArtifact(payload, out, true);
      break;
    case "panel":
      validateUiArtifact(payload, out, false);
      break;
    case "workspacePreset":
      validateWorkspace(payload, out);
      break;
    case "workflow":
      validateWorkflow(payload, out);
      break;
    case "reportView":
      validateReportView(payload, out);
      break;
  }
  out.ok = out.errors.length === 0;
  return out;
}

/** 校验一个 { kind, payload } 形态的产物条目。 */
export function validateArtifact(entry: unknown): ValidationIssue & { kind?: ArtifactKind } {
  if (!isPlainObject(entry) || typeof entry.kind !== "string") {
    return { ok: false, errors: ["产物必须是 { kind, …内容 } 对象"], warnings: [] };
  }
  if (!(ARTIFACT_KINDS as readonly string[]).includes(entry.kind)) {
    return { ok: false, errors: [`未知产物类型：${entry.kind}`], warnings: [] };
  }
  const kind = entry.kind as ArtifactKind;
  const r = validateArtifactPayload(kind, entry);
  return { ...r, kind };
}
