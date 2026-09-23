/**
 * P88b-3 §9.1：统一 Artifact 类型与校验器。
 * 产物优先声明式 schema；高级 HTML 以隔离插件形式渲染（§11），不生成主进程 React 源码。
 * 校验只做结构与限额判定，跨 store 的语义校验（通道存在性、工具注册表）在安装时进行。
 * CSS 文本一律过 `styles/styleSanitize` 那个无依赖叶子净化器（P99a-A6 起与 AI 工具同一条门）。
 *
 * **P99a-D1a：一张元表就是产物种类的唯一真相**（`KIND_TABLE`，在文件末尾）。
 * 此前"种类"这件事散在五处：union 字面量、一份平行的 `ARTIFACT_KINDS` 数组（两者无任何互相校验，
 * 加一支忘了改另一处就静默少一种）、中文名表、`KIND_REQUIRED_CAP`、`KIND_CONTRIB_KEY`、`KIND_CAPS`，
 * 外加 `validateArtifactPayload` 那个**没有 default 的 switch**——它才是最坏的一处：
 * 新增 kind 忘了配校验，运行时是"直接通过"，不红不响（§8-36①）。现在种类由元表的键派生，
 * 校验器、能力、contributions 键、中文名都挂在同一条目上：漏一项就编译不过，不存在"通过但没人看过"。
 */
import { guardStyleText } from "../styles/styleSanitize";
// P99b-N5：主题产物的键白名单与"相近真名"建议，住在零 import 的 `styles/themeCore`（详设 R5）
import { APPEARANCE_TOKENS, checkThemeVars } from "../../styles/themeCore";
// 只 import 类型：产物元表要说清"这类产物要什么能力"，而 PluginCap 的权威定义在 manifest 那边
import type { PluginCap } from "./pluginManifest";

/** 产物种类 = 元表的键（元表在文件末尾）。不存在第二份"合法种类"清单可漂。 */
export type ArtifactKind = keyof typeof KIND_TABLE_DEF;

/**
 * 产物种类元表的一项。**加一个 kind 就必须把这一行填满**——中文名列键、能力、contributions 键、
 * 载荷校验器缺一样都编译不过，也不会在运行时"静默通过校验"。
 */
export interface ArtifactKindMeta {
  /** 中文名：插件库标签、`save_plugin` 参数摘要、帮助文本共用这一份 */
  label: string;
  /** manifest.contributions 里这类产物占的键 */
  contribKey: string;
  /** 声明了这类产物就必须有的最低能力（`validateManifest` 用它判"有产物没能力"） */
  requiredCap: PluginCap;
  /**
   * `save_plugin` 建包时给的能力集。**这张表是它唯一的来源，且永不含 `serial.send`**（详设 §9.3）：
   * Agent 自己造的包碰不到设备发送，提权只能走"用户装新包"那条路。
   */
  caps: readonly PluginCap[];
  /** 载荷校验：errors 非空即拒 */
  validate(payload: Record<string, unknown>, out: ValidationIssue): void;
}

/**
 * 按字符串取产物中文名（模型给的 kind 可能不在枚举里，原样回显而不是编一个）。
 * 读的就是 `KIND_TABLE` 那一行：插件库标签、`save_plugin` 参数摘要、帮助文本同一份（§8-36①）。
 */
export function artifactKindLabel(kind: string): string {
  return kind in KIND_TABLE_DEF ? KIND_TABLE_DEF[kind as ArtifactKind].label : kind;
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
/** widget/panel 内容判别器用 format（外层 kind 是产物类型，见 validateArtifact）。 */
export type WidgetArtifact =
  | { format: "html"; html: string; chrome?: "none" }
  | { format: "declarative"; blocks: DeclarativeBlock[]; chrome?: "none" };
export type PanelArtifact =
  | { format: "html"; html: string }
  | { format: "declarative"; blocks: DeclarativeBlock[] };
export interface WorkspacePresetArtifact {
  /** dockview 布局 JSON（App 的 applyLayoutJson 消费；安装时不自动应用，要用户在插件库里点一次） */
  layout: Record<string, unknown>;
  note?: string;
}
/**
 * 任务模板（P99a-D1b）。**它不是宏执行器**：载入后是"目标 + 建议步骤"的一段话，
 * 交给 Agent 按正常门禁/档位/批准去跑，一步都不会替用户执行（详设 §7.1）。
 * 所以这里只校结构（有 goal、tool 名形如注册表式样）；**"这支工具到底存不存在"由
 * `save_plugin` 与插件库分别再查一次**——`artifact.ts` 是叶子模块，不能反过来 import 注册表（§8-33）。
 */
export interface WorkflowArtifact {
  goal: string;
  steps: Array<{ tool: string; args?: Record<string, unknown>; note?: string }>;
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

/**
 * 主题产物校验。
 *
 * P99b-N5（详设 R5）：键必须落在白名单里，**并且报错时给相近的真名**。旧写法只查"以 `--` 开头"，
 * 于是两份市场示例写着应用里根本不存在的 `--panel` / `--accent-contrast`——那份"秋海棠主题"
 * 实际只落地 4 项，而没有任何一处说出来（详设 §1-4）。键名写错不是小事，是静默失效。
 */
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
  /**
   * 白名单之外的键**拒收**。允许差量（只改几项是合法写法，详设 Q2 已裁），
   * 但"差量"不等于"可以写错名字"：未登记的键既不报错也不生效，那正是要消灭的静默。
   */
  const g = checkThemeVars(vars as Record<string, string>, APPEARANCE_TOKENS);
  out.errors.push(...g.errors);
  /** 明暗归属是**可选**声明：不给就由 `--bg` 亮度算（详设 S4）；给了就必须是 dark/light */
  if (a.scheme !== undefined && a.scheme !== "dark" && a.scheme !== "light") {
    out.errors.push(`theme.scheme 只认 dark / light，实际「${String(a.scheme)}」`);
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

/** 任务模板里的工具名式样：与注册表 `TOOL_NAME_RE` 同形（结构性检查，存在性另查）。 */
const STEP_TOOL_RE = /^[a-z][a-z0-9_]{2,39}$/;
/** goal 与 step 数上限：模板是"给 Agent 的一段任务说明"，不是脚本，长到读不动就该拆成几个模板。 */
const TEMPLATE_GOAL_MAX = 600;
const TEMPLATE_STEPS_MAX = 24;

function validateWorkflow(a: Record<string, unknown>, out: ValidationIssue) {
  if (typeof a.goal !== "string" || !a.goal.trim()) {
    out.errors.push("workflow.goal 必须是非空字符串（这套步骤要达成什么）");
  } else if (a.goal.length > TEMPLATE_GOAL_MAX) {
    out.errors.push(`workflow.goal 最长 ${TEMPLATE_GOAL_MAX} 字符（实际 ${a.goal.length}）`);
  }
  const steps = a.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > TEMPLATE_STEPS_MAX) {
    out.errors.push(`workflow.steps 必须是 1..${TEMPLATE_STEPS_MAX} 个的数组`);
    return;
  }
  steps.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.tool !== "string" || !s.tool.trim()) {
      out.errors.push(`workflow.steps[${i}] 缺少 tool 名称`);
      return;
    }
    // 只校式样；"这支工具在不在注册表里"由 save_plugin 与插件库各查一次（叶子模块不能反查注册表，§8-33）
    if (!STEP_TOOL_RE.test(s.tool)) out.errors.push(`workflow.steps[${i}].tool 不是合法工具名：${s.tool}`);
    if (s.args !== undefined && !isPlainObject(s.args)) out.errors.push(`workflow.steps[${i}].args 必须是对象`);
    if (s.note !== undefined && (typeof s.note !== "string" || s.note.length > 200)) {
      out.errors.push(`workflow.steps[${i}].note 必须是 ≤200 字符字符串`);
    }
  });
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
  // 校验器来自元表本身：没有 switch、也没有"忘了配就走默认通过"这条路
  KIND_TABLE_DEF[kind].validate(payload, out);
  out.ok = out.errors.length === 0;
  return out;
}

/* ============================ 产物种类元表（唯一一份） ============================ */

/**
 * 每一种产物的一行：中文名 / contributions 键 / 最低能力 / Agent 建包能力 / 校验器。
 *
 * `ArtifactKind` 就是这张表的键，所以：
 * - 加一行 → `pluginManifest`、`localEntries`、插件库标签里所有 `Record<ArtifactKind,…>`
 *   与穷举分支立刻编译不过（它们从此是**派生视图**，不是并列的第二份真相）；
 * - 删一行 → 该种类的入口、能力、标签一起消失，不会留下"schema 里还能选、选了就说不支持"。
 *
 * `caps` 一律不含 `serial.send`（详设 §9.3）：Agent 造不出能碰设备的包；`widget`/`panel` 带
 * `telemetry.read` 是因为挂件桥只读订阅遥测，写仍然只有 `run_app_action` 那几条既有路。
 */
const KIND_TABLE_DEF = {
  theme: {
    label: "主题",
    contribKey: "themes",
    requiredCap: "theme.tokens",
    caps: ["theme.tokens"],
    validate: validateTheme,
  },
  widget: {
    label: "小部件",
    contribKey: "widgets",
    requiredCap: "ui.widget",
    caps: ["ui.widget", "telemetry.read"],
    validate: (a, out) => validateUiArtifact(a, out, true),
  },
  panel: {
    label: "面板",
    contribKey: "panels",
    requiredCap: "ui.panel",
    caps: ["ui.panel", "telemetry.read"],
    validate: (a, out) => validateUiArtifact(a, out, false),
  },
  workspacePreset: {
    label: "工作区预设",
    contribKey: "workspacePresets",
    requiredCap: "workspace.preset",
    caps: ["workspace.preset"],
    validate: validateWorkspace,
  },
  workflow: {
    label: "任务模板",
    contribKey: "workflows",
    requiredCap: "workflow.compose",
    caps: ["workflow.compose"],
    validate: validateWorkflow,
  },
  module: {
    label: "逻辑模块",
    contribKey: "modules",
    requiredCap: "logic.run",
    caps: ["logic.run"],
    validate: validateModule,
  },
} as const satisfies Record<string, ArtifactKindMeta>;

/**
 * **P99a-D1b 下架记录**（详设 §7.1 的裁决："要么有投影，要么从创造面消失"）：
 *
 * - `reportView` → 并入 `panel`。它的 `blocks` 与 panel 的 declarative 分支**同一个类型、同一个校验器**，
 *   两个 kind 一份语义就是第二真相；面板产物已能表达同样的东西。
 * - `motionPreset` → 并入主题（token 覆盖层）。原建议在 §7.1 是"接通到 fx 层"，实地核查后不成立：
 *   P97-I3 之后动效的旋钮就是 `--fx-speed`/`--fx-color` 这些 CSS 变量，而变量的**唯一写入者**
 *   已经是主题层（`rootVars` + 按优先级重算，§8-37①）。再造一层"动效预设"往同一槽位写，
 *   就是我们在 M0 刚清退过的那种复发。它的 `trigger` 字段也没有任何消费方。
 *
 * 零兼容（§13.1）：**不迁移、不降级**，但也不静默——库里留着这两种产物的包会在产物行上明说
 * "该形态已废弃"（见 `PluginLibraryDialog` 与 `pluginStore.buildProjections` 的出声分支）。
 */

/** 取某一类产物的元信息（能力、contributions 键、中文名、校验器）。 */
export function artifactKindMeta(kind: ArtifactKind): ArtifactKindMeta {
  return KIND_TABLE_DEF[kind];
}

/** 全部合法种类（顺序即 UI 与 schema 里的顺序）。 */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = Object.keys(KIND_TABLE_DEF) as ArtifactKind[];

/** contributions 键 → 种类（`validateManifest` 拿它判"这个键是不是有人认领"）。 */
export function kindOfContribKey(key: string): ArtifactKind | undefined {
  return ARTIFACT_KINDS.find((k) => KIND_TABLE_DEF[k].contribKey === key);
}

/** contributions 键 → 中文名（插件库产物行用；没人认领的键原样回显，不猜一个） */
export function contribKeyLabel(key: string): string {
  const k = kindOfContribKey(key);
  return k ? KIND_TABLE_DEF[k].label : key;
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
