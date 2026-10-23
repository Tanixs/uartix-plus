/**
 * P174：**插件清单**（`uartix-plugin` / schemaVersion 3）的定义与校验器。
 *
 * 名字沿用 `uartix-plugin` 而不另起一个：这是**同一个插件系统的第 3 版**，不是并列的第二套东西。
 * v1/v2 一律按"旧版插件"拒绝（`isLegacyPackage`），提示用户让 AI 按 v3 重新生成。
 *
 * 为什么单独一份、而不是在 `pluginManifest.ts` 上改：旧格式（`uartix-plugin` s2）是
 * **声明式配置**，新格式是**代码插件**，两者的必填项、限额、校验判据几乎不重叠
 * （旧的有 `artifacts`/`contributions`，新的有 `main`/`activation`/`permissions`/`inject`）。
 * 硬塞进一个文件的结果是每个字段都带一句 `if (s2) …`，读的人永远不知道当前走哪条路。
 * 旧路径保留原样、只加一个"拒装"入口（见 `rejectLegacy`），新路径从零写。
 *
 * 这一版的三条判据来自 P174 详设，不是随手定的：
 * - **旧包拒装且不静默**：给得出「格式已废弃」这句话，而不是一句「校验失败」（详设 §5.7）。
 * - **写是牢笼、其余是知情**：`fs.write` 参与生成 Node 命令行（真拦），
 *   `fs.read`/`spawn`/`net` 只做结构校验并原样带给批准卡（详设 §10.1）。
 * - **能力面不设限，接入口必须固定**：L2 只能占插槽、L3 只能改布局数据，
 *   不能往宿主 React 树里塞组件（详设 §5.8）。
 */

/** 新格式的标识与版本。名字与旧格式刻意不同，避免"schemaVersion 看懂就以为兼容"。 */
export const EXT_FORMAT = "uartix-plugin";
export const EXT_SCHEMA_VERSION = 3;

/** 清单文件名。v3 起叫 `plugin.json`（旧版的 `extension.json` 不再读）。 */
export const MANIFEST_FILE = "plugin.json";
/** 旧格式标识，仅用于给出「格式已废弃」这句人话。 */
export const LEGACY_PLUGIN_FORMAT = "uartix-plugin";
export const LEGACY_PLUGIN_SCHEMA = 2;

/**
 * 资源上限。集中一处，因为要被校验器、插件库 UI、宿主命令行生成、测试四方读；
 * 抄两份就是一份等着漂的假账。
 */
export const EXT_LIMITS = {
  /** 解压后总字节（对比旧格式 4 MiB）。文件系统存储，不再受 localStorage 配额约束。 */
  packageBytes: 64 * 1024 * 1024,
  /** 单文件字节。`main.mjs` 打包产物体积也落在这条内。 */
  fileBytes: 8 * 1024 * 1024,
  /** 目录里文件数上限（`node_modules` 会很快吃掉它，所以给了 2000）。 */
  files: 2000,
  /**
   * 下面这几条**不是权限**，只是"一个插件声明几百枚面板"这种明显是生成事故的保护线。
   * 数值给得比现实需要宽得多：能力面已经放开，别在这里重新长出限制。
   */
  settingsFields: 256,
  panels: 64,
  themes: 8,
  commands: 256,
  sections: 256,
  mutations: 128,
  secrets: 64,
} as const;

/**
 * **永远不能被插件隐藏的宿主面板**。
 *
 * 这几块不是"普通面板"，是**用户自救的入口**：设置里能停用插件、插件管理能卸载、
 * 批准卡是安全边界本身、运行控制是"停下来"的唯一按钮。允许插件 hide 它们，
 * 等于允许插件把出口焊死——这是本仓 §8-44 那条"不可逆必须可人工干预"的直接推论。
 *
 * 判据在**装包时**执行，不是运行时才发现（运行时发现的代价是插件已经跑起来了）。
 */
export const NEVER_HIDEABLE_PANELS = ["settings", "plugin-manager", "approval", "run-control"] as const;

/** 允许被 L2 注入的插槽名。宿主每个内置面板要在 JSX 里真的渲染它，闭合测试钉住。 */
export const PANEL_SLOTS = [
  "serial.side",
  "serial.toolbar.after",
  "analysis.after-table",
  "hex.side",
  "settings.general.after",
] as const;
export type PanelSlotId = (typeof PANEL_SLOTS)[number];

/** 变量前缀。`$WS` 工作区根、`$EXT:<key>` 用户登记的外部根、`$APP` 应用数据目录。 */
export const PATH_VARS = ["$WS", "$APP"] as const;
const EXT_VAR_RE = /^\$EXT:([a-z][a-z0-9-]{0,23})(\/|$)/;

export interface ExtFsPermission {
  /** 声明要读的路径。**这一项拦不住**（Windows 上 `--allow-fs-read` 精确路径不生效），只用于告知。 */
  read?: string[];
  /** 声明可写的**目录**。这一项是真牢笼：未声明的目录写会 `ERR_ACCESS_DENIED`。 */
  write?: string[];
}

export interface ExtPermissions {
  fs?: ExtFsPermission;
  /** 声明会起的程序。**不参与拦截**，`--allow-child-process` 无条件给；只用于批准卡。 */
  process?: { spawn?: string[] };
  /** 声明会连的地址。**不参与拦截**，`connect-src` 恒为 `*`；只用于批准卡。 */
  net?: { connect?: string[] };
  ui?: { panel?: boolean; notify?: boolean; clipboard?: boolean; /** 贡献主题（改界面长相） */ theme?: boolean };
  ai?: { registerTools?: boolean; ask?: boolean };
  secrets?: string[];
}

/** L2：往宿主已有面板的插槽里加一块（渲染为自己的 iframe，不进 React 树）。 */
export interface ExtSection {
  slot: PanelSlotId;
  id: string;
  title: string;
  entry: string;
  /** 显示条件，形如 `serial.connected`。只是给宿主读的字符串，本批不做表达式求值。 */
  when?: string;
}

/** L3：改宿主已有面板的布局数据（隐藏 / 改标题 / 移动）。 */
export type ExtMutationOp = "hide" | "retitle" | "move";
export interface ExtMutation {
  /** 目标面板 id。落在 `NEVER_HIDEABLE_PANELS` 时 `hide` 一律拒。 */
  target: string;
  op: ExtMutationOp;
  title?: string;
  before?: string;
  note?: string;
}

export interface ExtInject {
  sections?: ExtSection[];
  mutations?: ExtMutation[];
}

/** 一枚插件主题：包内一份 CSS（变量块或整段组件覆盖），由宿主的净化器验过才用。 */
export interface ExtThemeDecl {
  id: string;
  title: string;
  /** 包内相对路径，通常 `theme.css`。 */
  entry: string;
  /** 供选择器预览用的底色倾向；不给就按 CSS 里实际声明推导。 */
  scheme?: "dark" | "light";
}

export interface ExtContributes {
  panels?: { id: string; title: string; entry: string }[];
  themes?: ExtThemeDecl[];
  commands?: { id: string; title: string }[];
  settings?: ExtSettingField[];
}

export interface ExtSettingField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "enum";
  default: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
}

export interface ExtensionManifest {
  format: typeof EXT_FORMAT;
  schemaVersion: typeof EXT_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  /** 可选：不给就是纯声明式插件（不起进程、不要任何权限）。 */
  main?: string;
  hostNode?: string;
  activation: string[];
  permissions: ExtPermissions;
  contributes: ExtContributes;
  inject: ExtInject;
  requires?: { services?: string[] };
  provenance?: { createdBy?: "agent" | "user" | "import"; source?: string };
}

export interface ExtValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: ExtensionManifest;
  /** 命中旧格式时为 true，调用方据此显示「格式已废弃」而不是「校验失败」。 */
  legacy?: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
/**
 * 包内局部 id（面板/插槽/区块）。允许单字符：`id: "x"` 完全合法，
 * 拒绝它没有任何安全收益，只会让人猜"为什么这也不行"。
 */
const LOCAL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@\-/]+$/;
const NODE_REQ_RE = /^>=\s*\d+(\.\d+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 旧格式识别。**先于一切其他校验**：否则旧包会先撞上"缺 main"之类的错，
 * 用户看到的是"你少写了个字段"，而真相是"这个格式整个不做数了"。
 */
/**
 * 旧版插件：**同一个格式名、版本不是 3**。
 *
 * 与 A2 那版判据的区别：那时新旧是两个格式名（`uartix-extension` vs `uartix-plugin`），
 * 于是"插件"这个词在代码里指两样东西。现在只有一个格式名，版本才是分界线——
 * 这样 `format` 永远读作"这是 uartix 插件"，`schemaVersion` 才说"哪一代"。
 */
export function isLegacyPackage(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  return raw.format === LEGACY_PLUGIN_FORMAT && raw.schemaVersion !== EXT_SCHEMA_VERSION;
}

export function rejectLegacy(): ExtValidation {
  return {
    ok: false,
    legacy: true,
    errors: [
      "这是旧版插件（uartix-plugin / schemaVersion 1 或 2），不再支持：当前只认 schemaVersion 3。" +
        "v3 是代码插件（plugin.json + main.mjs + 可选面板 HTML），能力面覆盖旧版并更宽：" +
        "请让 AI 助手按 v3 重新生成，或用插件市场里同功能的新版。" +
        "原文件仍在磁盘上，不会自动删除。",
    ],
    warnings: [],
  };
}

/**
 * 路径声明校验。读和写共用结构规则，但**语义不同**：
 * - 读：允许文件级 glob 写法（`$WS/**`），因为反正拦不住，语义靠提醒；
 * - 写：必须是**目录**（不许 `/**`、不许文件通配），因为它会变成 `--allow-fs-write` 的参数，
 *   而 Node 那个参数只认目录前缀。给一个 glob 进去，结果不是"更严"，是"整条参数失效"。
 */
export function validatePathDecl(raw: unknown, kind: "read" | "write"): string[] {
  const errs: string[] = [];
  if (raw === undefined) return errs;
  if (!Array.isArray(raw)) return [`permissions.fs.${kind} 必须是数组`];
  if (raw.length > 32) errs.push(`permissions.fs.${kind} 最多 32 条`);
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      errs.push(`permissions.fs.${kind} 的条目必须是非空字符串`);
      continue;
    }
    const p = item.trim();
    const startsWithVar = PATH_VARS.some((v) => p === v || p.startsWith(v + "/")) || EXT_VAR_RE.test(p);
    if (!startsWithVar) {
      errs.push(`permissions.fs.${kind}「${p}」必须以 $WS / $APP / $EXT:<key> 开头（不许写死绝对路径，否则换机器就废）`);
      continue;
    }
    if (p.includes("..")) {
      errs.push(`permissions.fs.${kind}「${p}」不允许出现 ..`);
      continue;
    }
    if (kind === "write") {
      // 写是喂给 `--allow-fs-write` 的，只能是目录，且不许通配
      if (p.endsWith("/**") || p.endsWith("/*") || p.includes("*")) {
        errs.push(`permissions.fs.write「${p}」必须是目录，不能带通配（它直接作为 --allow-fs-write 的参数）`);
      }
    }
  }
  return errs;
}

function validatePermissions(raw: unknown, out: ExtValidation): ExtPermissions {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    out.errors.push("permissions 必须是对象（没有特权就给 {} 或省略）");
    return {};
  }
  const perms: ExtPermissions = {};

  if (raw.fs !== undefined) {
    if (!isPlainObject(raw.fs)) {
      out.errors.push("permissions.fs 必须是对象");
    } else {
      out.errors.push(...validatePathDecl(raw.fs.read, "read"));
      out.errors.push(...validatePathDecl(raw.fs.write, "write"));
      const fs: ExtFsPermission = {};
      if (Array.isArray(raw.fs.read)) fs.read = (raw.fs.read as string[]).map((s) => s.trim());
      if (Array.isArray(raw.fs.write)) fs.write = (raw.fs.write as string[]).map((s) => s.trim().replace(/\/+$/, ""));
      perms.fs = fs;
    }
  }

  if (raw.process !== undefined) {
    if (!isPlainObject(raw.process) || (raw.process.spawn !== undefined && !Array.isArray(raw.process.spawn))) {
      out.errors.push("permissions.process.spawn 必须是字符串数组");
    } else {
      const spawn = Array.isArray(raw.process.spawn) ? (raw.process.spawn as unknown[]) : [];
      if (spawn.length > 32) out.errors.push("permissions.process.spawn 最多 32 条");
      for (const p of spawn) {
        // 只做形状校验：不许写路径，避免有人以为这能"锁定某个可执行文件"
        if (typeof p !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(p)) {
          out.errors.push(`permissions.process.spawn「${String(p)}」必须是裸程序名（不许带路径分隔符）`);
        }
      }
      perms.process = { spawn: spawn.filter((p): p is string => typeof p === "string") };
    }
  }

  if (raw.net !== undefined) {
    if (!isPlainObject(raw.net) || (raw.net.connect !== undefined && !Array.isArray(raw.net.connect))) {
      out.errors.push("permissions.net.connect 必须是字符串数组");
    } else {
      perms.net = {
        connect: (Array.isArray(raw.net.connect) ? (raw.net.connect as unknown[]) : []).filter(
          (s): s is string => typeof s === "string",
        ),
      };
    }
  }

  if (raw.ui !== undefined) {
    if (!isPlainObject(raw.ui)) out.errors.push("permissions.ui 必须是对象");
    else {
      perms.ui = {
        panel: raw.ui.panel === true,
        notify: raw.ui.notify === true,
        clipboard: raw.ui.clipboard === true,
        theme: raw.ui.theme === true,
      };
    }
  }

  if (raw.ai !== undefined) {
    if (!isPlainObject(raw.ai)) out.errors.push("permissions.ai 必须是对象");
    else {
      perms.ai = { registerTools: raw.ai.registerTools === true, ask: raw.ai.ask === true };
    }
  }

  if (raw.secrets !== undefined) {
    if (!Array.isArray(raw.secrets)) out.errors.push("permissions.secrets 必须是字符串数组");
    else if (raw.secrets.length > EXT_LIMITS.secrets) out.errors.push(`permissions.secrets 最多 ${EXT_LIMITS.secrets} 条`);
    else {
      const names = (raw.secrets as unknown[]).filter((s): s is string => typeof s === "string");
      perms.secrets = names;
    }
  }

  return perms;
}

function validateInject(raw: unknown, out: ExtValidation): ExtInject {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    out.errors.push("inject 必须是对象");
    return {};
  }
  const inject: ExtInject = {};

  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) out.errors.push("inject.sections 必须是数组");
    else if (raw.sections.length > EXT_LIMITS.sections) out.errors.push(`inject.sections 最多 ${EXT_LIMITS.sections} 条`);
    else {
      const list: ExtSection[] = [];
      const seen = new Set<string>();
      for (const s of raw.sections) {
        if (!isPlainObject(s)) {
          out.errors.push("inject.sections 的条目必须是对象");
          continue;
        }
        const slot = s.slot;
        if (typeof slot !== "string" || !(PANEL_SLOTS as readonly string[]).includes(slot)) {
          out.errors.push(`inject.sections.slot「${String(slot)}」不是已登记的插槽（可选：${PANEL_SLOTS.join(" / ")}）`);
          continue;
        }
        const id = typeof s.id === "string" ? s.id : "";
        if (!LOCAL_ID_RE.test(id)) {
          out.errors.push(`inject.sections.id「${id}」必须匹配 ${LOCAL_ID_RE}`);
          continue;
        }
        if (seen.has(id)) {
          out.errors.push(`inject.sections.id「${id}」重复`);
          continue;
        }
        const entry = typeof s.entry === "string" ? s.entry : "";
        if (!REL_PATH_RE.test(entry)) {
          out.errors.push(`inject.sections[${id}].entry「${entry}」必须是包内相对路径`);
          continue;
        }
        seen.add(id);
        list.push({
          slot: slot as PanelSlotId,
          id,
          title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 60) : id,
          entry,
          ...(typeof s.when === "string" && s.when.trim() ? { when: s.when.trim().slice(0, 120) } : {}),
        });
      }
      inject.sections = list;
    }
  }

  if (raw.mutations !== undefined) {
    if (!Array.isArray(raw.mutations)) out.errors.push("inject.mutations 必须是数组");
    else if (raw.mutations.length > EXT_LIMITS.mutations) out.errors.push(`inject.mutations 最多 ${EXT_LIMITS.mutations} 条`);
    else {
      const list: ExtMutation[] = [];
      for (const m of raw.mutations) {
        if (!isPlainObject(m)) {
          out.errors.push("inject.mutations 的条目必须是对象");
          continue;
        }
        const target = typeof m.target === "string" ? m.target.trim() : "";
        if (!target) {
          out.errors.push("inject.mutations.target 必填");
          continue;
        }
        const op = m.op;
        if (op !== "hide" && op !== "retitle" && op !== "move") {
          out.errors.push(`inject.mutations.op 只认 hide / retitle / move，实际「${String(op)}」`);
          continue;
        }
        // 装包时就拦住：允许 hide 掉设置/插件管理/批准卡/运行控制，等于把出口焊死
        if (op === "hide" && (NEVER_HIDEABLE_PANELS as readonly string[]).includes(target)) {
          out.errors.push(
            `inject.mutations 不能隐藏「${target}」：它是用户自救入口（设置/插件管理/批准卡/运行控制），` +
              `允许插件关掉它等于把关不掉的后门装进系统`,
          );
          continue;
        }
        if (op === "retitle" && (typeof m.title !== "string" || !m.title.trim())) {
          out.errors.push(`inject.mutations[${target}] retitle 必须给 title`);
          continue;
        }
        if (op === "move" && (typeof m.before !== "string" || !m.before.trim())) {
          out.errors.push(`inject.mutations[${target}] move 必须给 before`);
          continue;
        }
        list.push({
          target,
          op,
          ...(typeof m.title === "string" ? { title: m.title.trim().slice(0, 40) } : {}),
          ...(typeof m.before === "string" ? { before: m.before.trim() } : {}),
          ...(typeof m.note === "string" ? { note: m.note.slice(0, 200) } : {}),
        });
      }
      inject.mutations = list;
    }
  }

  return inject;
}

function validateContributes(raw: unknown, out: ExtValidation): ExtContributes {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    out.errors.push("contributes 必须是对象");
    return {};
  }
  const c: ExtContributes = {};

  if (raw.panels !== undefined) {
    if (!Array.isArray(raw.panels)) out.errors.push("contributes.panels 必须是数组");
    else if (raw.panels.length > EXT_LIMITS.panels) out.errors.push(`contributes.panels 最多 ${EXT_LIMITS.panels} 条`);
    else {
      const list: { id: string; title: string; entry: string }[] = [];
      const seen = new Set<string>();
      for (const p of raw.panels) {
        if (!isPlainObject(p)) {
          out.errors.push("contributes.panels 的条目必须是对象");
          continue;
        }
        const id = typeof p.id === "string" ? p.id : "";
        if (!LOCAL_ID_RE.test(id) || seen.has(id)) {
          out.errors.push(`contributes.panels.id「${id}」非法或重复`);
          continue;
        }
        const entry = typeof p.entry === "string" ? p.entry : "";
        if (!REL_PATH_RE.test(entry)) {
          out.errors.push(`contributes.panels[${id}].entry「${entry}」必须是包内相对路径`);
          continue;
        }
        seen.add(id);
        list.push({
          id,
          title: typeof p.title === "string" && p.title.trim() ? p.title.trim().slice(0, 60) : id,
          entry,
        });
      }
      c.panels = list;
    }
  }

  if (raw.themes !== undefined) {
    if (!Array.isArray(raw.themes)) out.errors.push("contributes.themes 必须是数组");
    else if (raw.themes.length > EXT_LIMITS.themes) out.errors.push(`contributes.themes 最多 ${EXT_LIMITS.themes} 条`);
    else {
      const list: ExtThemeDecl[] = [];
      const seen = new Set<string>();
      for (const t of raw.themes) {
        if (!isPlainObject(t)) {
          out.errors.push("contributes.themes 的条目必须是对象");
          continue;
        }
        const id = typeof t.id === "string" ? t.id : "";
        if (!LOCAL_ID_RE.test(id) || seen.has(id)) {
          out.errors.push(`contributes.themes.id「${id}」非法或重复`);
          continue;
        }
        const entry = typeof t.entry === "string" ? t.entry : "";
        if (!REL_PATH_RE.test(entry)) {
          out.errors.push(`contributes.themes[${id}].entry「${entry}」必须是包内相对路径`);
          continue;
        }
        const scheme = t.scheme;
        if (scheme !== undefined && scheme !== "dark" && scheme !== "light") {
          out.errors.push(`contributes.themes[${id}].scheme 只能是 "dark" / "light"`);
          continue;
        }
        seen.add(id);
        list.push({
          id,
          title: typeof t.title === "string" && t.title.trim() ? t.title.trim().slice(0, 60) : id,
          entry,
          ...(scheme ? { scheme } : {}),
        });
      }
      c.themes = list;
    }
  }

  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) out.errors.push("contributes.commands 必须是数组");
    else if (raw.commands.length > EXT_LIMITS.commands) out.errors.push(`contributes.commands 最多 ${EXT_LIMITS.commands} 条`);
    else {
      const list: { id: string; title: string }[] = [];
      for (const cmd of raw.commands) {
        if (!isPlainObject(cmd)) {
          out.errors.push("contributes.commands 的条目必须是对象");
          continue;
        }
        const id = typeof cmd.id === "string" ? cmd.id : "";
        // 命令 id 用点分（`yolo.train`）：面板与 AI 工具都按这个找
        if (!/^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,3}$/.test(id)) {
          out.errors.push(`contributes.commands.id「${id}」必须是点分小写（如 yolo.train）`);
          continue;
        }
        list.push({ id, title: typeof cmd.title === "string" ? cmd.title.slice(0, 60) : id });
      }
      c.commands = list;
    }
  }

  if (raw.settings !== undefined) {
    if (!Array.isArray(raw.settings)) out.errors.push("contributes.settings 必须是数组");
    else if (raw.settings.length > EXT_LIMITS.settingsFields) {
      out.errors.push(`contributes.settings 最多 ${EXT_LIMITS.settingsFields} 项`);
    } else {
      const fields: ExtSettingField[] = [];
      const seen = new Set<string>();
      for (const f of raw.settings) {
        if (!isPlainObject(f) || typeof f.key !== "string" || !/^[a-z][A-Za-z0-9]{0,39}$/.test(f.key)) {
          out.errors.push("contributes.settings 字段 key 必须是 camelCase");
          continue;
        }
        if (seen.has(f.key)) {
          out.errors.push(`contributes.settings key「${f.key}」重复`);
          continue;
        }
        seen.add(f.key);
        const type = f.type;
        if (type !== "number" && type !== "string" && type !== "boolean" && type !== "enum") {
          out.errors.push(`contributes.settings.${f.key} type 非法`);
          continue;
        }
        const def = f.default;
        const typeOk =
          (type === "number" && typeof def === "number" && Number.isFinite(def)) ||
          (type === "boolean" && typeof def === "boolean") ||
          ((type === "string" || type === "enum") && typeof def === "string");
        if (!typeOk) {
          out.errors.push(`contributes.settings.${f.key} default 与 type 不匹配`);
          continue;
        }
        fields.push({
          key: f.key,
          label: typeof f.label === "string" && f.label.trim() ? f.label.slice(0, 60) : f.key,
          type,
          default: def as number | string | boolean,
          ...(typeof f.min === "number" ? { min: f.min } : {}),
          ...(typeof f.max === "number" ? { max: f.max } : {}),
          ...(type === "enum" && Array.isArray(f.options)
            ? { options: (f.options as unknown[]).filter((o): o is string => typeof o === "string").slice(0, 32) }
            : {}),
        });
      }
      c.settings = fields;
    }
  }

  return c;
}

function validateActivation(raw: unknown, hasMain: boolean, out: ExtValidation): string[] {
  if (raw === undefined) {
    if (hasMain) out.warnings.push("有 main 但没给 activation：插件只能被手动调用，不会自动激活");
    return [];
  }
  if (!Array.isArray(raw)) {
    out.errors.push("activation 必须是数组");
    return [];
  }
  const list: string[] = [];
  for (const a of raw) {
    if (typeof a !== "string" || !/^on[A-Z][A-Za-z]*:[A-Za-z0-9._-]{1,64}$/.test(a)) {
      out.errors.push(`activation「${String(a)}」格式非法，应为 onPanel:xxx / onCommand:xxx / onAITool:xxx`);
      continue;
    }
    list.push(a);
  }
  if (!hasMain && list.length) {
    // 没有入口却声明了激活事件 = 一定会失败，装的时候就该说清
    out.errors.push("没有 main 却声明了 activation：没有可执行的入口，请去掉 activation 或补上 main");
  }
  return list;
}

/** 校验并规范化一份 s3 清单。通过时返回规范形态，否则 errors 非空。 */
export function validateExtension(raw: unknown): ExtValidation {
  const out: ExtValidation = { ok: false, errors: [], warnings: [] };

  // 1) 旧格式先拦：这句话必须比"缺字段"更早出现
  if (isLegacyPackage(raw)) return rejectLegacy();

  if (!isPlainObject(raw)) {
    out.errors.push("清单必须是 JSON 对象");
    return out;
  }

  // 2) 体积与标识
  const bytes = JSON.stringify(raw).length;
  if (bytes > 1024 * 1024) {
    out.errors.push(`清单本体 ${bytes} 字节，超过 1 MiB（清单不该塞代码或图片）`);
  }
  if (raw.format !== EXT_FORMAT) {
    out.errors.push(`format 必须是 "${EXT_FORMAT}"（同一个格式名，版本由 schemaVersion 决定；当前为 3）`);
  }
  if (raw.schemaVersion !== EXT_SCHEMA_VERSION) {
    out.errors.push(`schemaVersion 必须是 ${EXT_SCHEMA_VERSION}`);
  }
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    out.errors.push('id 必须是小写点分标识（如 "user.yolo.workbench"）');
  }
  if (typeof raw.version !== "string" || !VER_RE.test(raw.version)) {
    out.errors.push("version 必须是 semver（如 1.0.0）");
  }
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 60) {
    out.errors.push("name 必须是 1..60 字符");
  }

  // 3) 入口
  let main: string | undefined;
  if (raw.main !== undefined) {
    if (typeof raw.main !== "string" || !REL_PATH_RE.test(raw.main)) {
      out.errors.push("main 必须是包内相对路径（如 main.mjs）");
    } else if (!/\.(mjs|js|cjs)$/.test(raw.main)) {
      out.errors.push("main 必须是 .mjs / .js / .cjs");
    } else {
      main = raw.main;
    }
  }
  const hasMain = !!main;

  if (raw.hostNode !== undefined) {
    if (typeof raw.hostNode !== "string" || !NODE_REQ_RE.test(raw.hostNode.trim())) {
      out.errors.push('hostNode 只支持 ">=20" 这种最低版本写法');
    }
  }

  // 4) 权限 / 贡献 / 注入
  const permissions = validatePermissions(raw.permissions, out);
  const contributes = validateContributes(raw.contributes, out);
  const inject = validateInject(raw.inject, out);
  const activation = validateActivation(raw.activation, hasMain, out);

  // 5) 语义交叉校验（单字段都合法、组合起来不成立的那几类）
  const hasPanelPerm = permissions.ui?.panel === true;
  const wantsPanel = (contributes.panels?.length ?? 0) > 0 || (inject.sections?.length ?? 0) > 0;
  const wantsTheme = (contributes.themes?.length ?? 0) > 0;
  if (wantsTheme && permissions.ui?.theme !== true) {
    // 与面板同一条规矩：**改了界面就要在批准卡上说出来**，而不是装完才发现"我的配色是自己变的"
    out.errors.push("要贡献主题（改界面长相），必须在 permissions.ui.theme 声明 true");
  }
  if (wantsPanel && !hasPanelPerm) {
    out.errors.push("要贡献面板或往插槽注入，必须在 permissions.ui.panel 声明 true");
  }
  if (!hasMain) {
    const needsCode: string[] = [];
    if (permissions.process?.spawn?.length) needsCode.push("permissions.process");
    if (permissions.net?.connect?.length) needsCode.push("permissions.net");
    if (permissions.fs?.write?.length) needsCode.push("permissions.fs.write");
    if (needsCode.length) {
      out.errors.push(`没有 main 却声明了 ${needsCode.join(" / ")}：纯声明式插件没有可执行入口，这些权限用不上`);
    }
    if (inject.sections?.some((s) => !s.entry)) {
      out.errors.push("inject.sections 缺 entry：没有 main 时无法动态生成内容");
    }
  }
  if (permissions.ai?.registerTools && !hasMain) {
    out.errors.push("permissions.ai.registerTools 需要 main：工具要有代码才能注册");
  }

  // 6) 汇总
  if (out.errors.length) return out;

  out.ok = true;
  out.manifest = {
    format: EXT_FORMAT,
    schemaVersion: EXT_SCHEMA_VERSION,
    id: raw.id as string,
    version: raw.version as string,
    name: (raw.name as string).trim(),
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: raw.description.trim().slice(0, 300) }
      : {}),
    ...(typeof raw.author === "string" && raw.author.trim() ? { author: raw.author.trim().slice(0, 40) } : {}),
    ...(typeof raw.homepage === "string" && /^https:\/\/\S+$/i.test(raw.homepage) ? { homepage: raw.homepage } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license.slice(0, 40) } : {}),
    ...(main ? { main } : {}),
    ...(typeof raw.hostNode === "string" ? { hostNode: raw.hostNode.trim() } : {}),
    activation,
    permissions,
    contributes,
    inject,
    ...(isPlainObject(raw.requires) ? { requires: { services: [] as string[] } } : {}),
    provenance: {
      createdBy: (["agent", "user", "import"] as const).find(
        (k) => isPlainObject(raw.provenance) && raw.provenance.createdBy === k,
      ) ?? "import",
      ...(isPlainObject(raw.provenance) && typeof raw.provenance.source === "string"
        ? { source: raw.provenance.source.slice(0, 120) }
        : {}),
    },
  };
  return out;
}

/** 变量展开所需的实参。由宿主在**调用时**注入，校验器本身不读任何全局状态。 */
export interface PathVarBinding {
  /** 工作区根（`$WS`）。未登记时为空串 → 用到它的作业会拿到空路径，调用方必须自己判。 */
  workspace: string;
  /** 应用数据目录（`$APP`）。 */
  appDir: string;
  /** 外部根登记表（`$EXT:<key>`）。 */
  extra: Record<string, string>;
}

/**
 * 展开一条路径声明；无法展开（变量没绑定）时返回 null，由调用方决定是拒还是跳过。
 *
 * 分隔符一律**归一成正斜杠**：Windows 上 Node 的 fs 与这几个启动参数都接受 `/`
 * （详设 §5.4 的实测就是用 `D:/a` 跑的），而混用两种斜杠会让日志和断言都难读。
 */
export function expandPathSpec(spec: string, bind: PathVarBinding): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const s = norm(spec.trim());
  if (s === "$WS" || s.startsWith("$WS/")) {
    if (!bind.workspace) return null;
    return norm(bind.workspace) + s.slice(3);
  }
  if (s === "$APP" || s.startsWith("$APP/")) {
    if (!bind.appDir) return null;
    return norm(bind.appDir) + s.slice(4);
  }
  const m = s.match(EXT_VAR_RE);
  if (m) {
    const dir = bind.extra[m[1]];
    if (!dir) return null;
    return norm(dir) + s.slice(`$EXT:${m[1]}`.length);
  }
  return null;
}

/**
 * 生成扩展宿主的 Node 命令行参数。
 *
 * **这是"牢笼"落地的唯一一处**，所以三件事写死在这里而不是散在调用方：
 * 1. `--allow-fs-read=*` 是被迫的：Windows 上精确读白名单不生效（详设 §5.4 有 8 种写法的实测）；
 * 2. `--allow-child-process` 无条件给：既然不按名单拦，就别留"声明漏了跑不起来"的坑；
 * 3. `--allow-fs-write` 只按展开后的**目录**给；一条都展开不出来时**不给这个参数**——
 *    不给就意味着整个进程只能读不能写，这是最紧的那一档。
 */
export function buildHostNodeArgs(manifest: ExtensionManifest, bind: PathVarBinding): string[] {
  const args = ["--permission", "--allow-fs-read=*"];
  const writeDirs: string[] = [];
  for (const spec of manifest.permissions.fs?.write ?? []) {
    const dir = expandPathSpec(spec, bind);
    if (!dir) continue; // 变量没登记 → 跳过（宁可不给写，也不给一个空/错路径）
    if (dir.includes("*")) continue; // 通配进了参数只会让整条失效，已在校验期拒，这里再兜一层
    writeDirs.push(dir);
  }
  const uniq = [...new Set(writeDirs)];
  for (const d of uniq) args.push(`--allow-fs-write=${d}`);
  args.push("--allow-child-process");
  return args;
}

/**
 * 这个扩展是否要用工作区根（`$WS`）。
 *
 * 读和写都算：一个只读 `$WS` 的扩展没有工作区同样跑不了。
 * 判据放在这里而不是 `hostPlan` 里内联，是因为**界面也要问同一个问题**
 * （"声明了工作区但没登记"要在面板上顶一条黄条，而不是等用户点启动才被拒）。
 */
export function usesWorkspace(m: ExtensionManifest): boolean {
  const specs = [...(m.permissions.fs?.write ?? []), ...(m.permissions.fs?.read ?? [])];
  return specs.some((p) => p === "$WS" || p.startsWith("$WS/"));
}

/** 一个插件是否要求任何"会被限制"的权限（批准卡据此决定要不要单列一段）。 */
export function hasEnforcedPermissions(m: ExtensionManifest): boolean {
  return (m.permissions.fs?.write?.length ?? 0) > 0;
}

/** 是否会改动宿主已有面板（批准卡要单独列一句，不许混在权限里）。 */
export function touchesHostPanels(m: ExtensionManifest): boolean {
  return (m.inject.sections?.length ?? 0) > 0 || (m.inject.mutations?.length ?? 0) > 0;
}
