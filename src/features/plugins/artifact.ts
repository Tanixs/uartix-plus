/**
 * P88b-3 §9.1：统一 Artifact 类型与校验器。
 * 产物优先声明式 schema；高级 HTML 以隔离插件形式渲染（§11），不生成主进程 React 源码。
 * 校验只做结构与限额判定，跨 store 的语义校验（通道存在性、工具注册表）在安装时进行。
 * CSS 文本一律过 `styles/styleSanitize` 那个无依赖叶子净化器（P99a-A6 起与 AI 工具同一条门）。
 */
import { guardStyleText } from "../styles/styleSanitize";

export type ArtifactKind =
  | "theme"
  | "motionPreset"
  | "widget"
  | "panel"
  | "workspacePreset"
  | "workflow"
  | "reportView"
  | "module";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "theme",
  "motionPreset",
  "widget",
  "panel",
  "workspacePreset",
  "workflow",
  "reportView",
  "module",
];

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  theme: "主题",
  motionPreset: "动效预设",
  widget: "小部件",
  panel: "面板",
  workspacePreset: "工作区预设",
  workflow: "工作流",
  reportView: "报告视图",
  module: "逻辑模块",
};

/**
 * 按字符串取产物中文名（模型给的 kind 可能不在枚举里，原样回显而不是编一个）。
 * 单点来源（§8-36①）：插件库标签、`save_plugin` 参数摘要都走这里，
 * 此前 toolDisplay 里还手抄过两份同名表，改一处漂两处。
 */
export function artifactKindLabel(kind: string): string {
  return (ARTIFACT_KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

/** 单个产物 JSON 字节上限（详设 §11 建议初值：单配置 JSON 1MiB）。 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
/**
 * 主题 `css` 的上限。这个名字就是它的**唯一**说法：`validateTheme` 的长度判定与净化器
 * 都读它，`style_commit` 判定"能不能固化成主题"也读它（原来同文件里写了两个 `64*1024` 字面量）。
 */
export const THEME_CSS_MAX_BYTES = 64 * 1024;

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

/**
 * `module` = 一段跑在专用 Worker 里的 JS（P99a-B1，详设 §5.2）。
 * 结构校验**故意不做任何"看起来危险就拒"的正则**：字符串匹配挡不住逃逸，
 * 只会给人"已经防住了"的错觉（§8-37）。真正的门是 realm 封网 + 桥裁决 + 启用前自证。
 */
export interface ModuleArtifact {
  format: "js";
  code: string;
}

/** 模块源码上限（比单产物 1MiB 更严：它要整个塞进 blob 并在每次启用时求值）。 */
export const MAX_MODULE_BYTES = 256 * 1024;

function validateModule(a: Record<string, unknown>, out: ValidationIssue) {
  if (a.format !== "js") out.errors.push('module.format 目前只支持 "js"');
  const code = a.code;
  if (typeof code !== "string" || !code.trim()) {
    out.errors.push("module.code 必须是非空字符串");
    return;
  }
  if (code.length > MAX_MODULE_BYTES) {
    out.errors.push(`module.code 超过 ${MAX_MODULE_BYTES} 字节上限（实际 ${code.length}）`);
  }
  // NUL 会截断一些文本处理链路（导出/预览/编辑器）；结构性语法这里不判，交给 worker 求值回报
  if (code.includes("\0")) out.errors.push("module.code 含空字节");
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
    if (typeof a.css !== "string" || a.css.length > THEME_CSS_MAX_BYTES) {
      out.errors.push(`theme.css 必须是 ≤${THEME_CSS_MAX_BYTES} 字节字符串`);
    } else {
      /**
       * P99a-A6：走与 AI `style_patch` / `save_theme_extension` **同一个净化器**。
       * 旧写法在这里只正则挡 `@import` 与 `url(http`，`position:fixed` 只给警告——
       * 于是同一个"第三方 CSS 能不能进宿主"的问题有两条门：松的这条恰好是插件/市场要用的，
       * 一条 `body{display:none}` 或一层 fixed 就能盖掉批准弹层与停止入口（§8-37 的"共享槽位/
       * 同一能力两个门"）。净化器是无依赖叶子模块，两边共用不成环。
       */
      const g = guardStyleText(a.css, THEME_CSS_MAX_BYTES, []);
      if (!g.ok) out.errors.push(...g.problems.slice(0, 8).map((p) => `theme.css 未通过净化：${p}`));
      else if (g.problems.length) out.warnings.push(...g.problems.slice(0, 8));
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
    case "module":
      validateModule(payload, out);
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
