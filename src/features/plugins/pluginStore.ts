/**
 * P88b-3 §9.3：本地插件库。
 * 状态机：draft → validated → previewed → installed_disabled → enabled → disabled
 *         / update_pending / quarantined
 * - 安装走 staging（内存暂存校验通过）→ installStaged 单次 emit 原子入库；
 * - 更新先建候选（update_pending），批准后原子切换，旧版本保留可回滚；
 * - 导入一律 installed_disabled 且不执行；禁止静默覆盖同 ID 包（冲突转副本）；
 * - 导出走白名单：不含用户配置值与 nonce，疑似秘密字段直接拒绝；
 * - widget/panel/theme 启用时向 extensionStore 同步运行时投影（影子扩展），
 *   停用/卸载/隔离即移除投影，复用既有浮窗/桌面/工作区挂载链路。
 */
import { useSyncExternalStore } from "react";
import * as extStore from "../ai/extensionStore";
import {
  HOST_API,
  PLUGIN_FORMAT,
  PLUGIN_SCHEMA_VERSION,
  MAX_PACKAGE_FILES,
  containsSecretLike,
  validateManifest,
  describeDiff,
  manifestDiff,
  type PluginCap,
  type PluginManifest,
} from "./pluginManifest";
import { renderDeclarativeHtml } from "./declarativePanel";
import { kindOfContribKey } from "./artifact";
import { moduleArtifactsOf } from "./moduleHost";
import { closeModule, moduleDiagnostics, moduleIsReady, openModule, waitModuleReady } from "./moduleBus";
// P99a-F2：工具面变化的账本（`pluginToolDefs` 只依赖 pluginLimits，是叶子，不构成环）
import { commitToolSnapshot, describeToolChange } from "./pluginToolDefs";

/* ---------------- 样式层回调（P92-F：禁止在此静态 import extRuntime） ----------------
 * 曾经的写法是 `import { applyStyleExts } from "../ai/extRuntime"` + 模块加载即
 * `restoreProjections()`。那会成环：
 *   extRuntime → chatStore → agentRun → agentAdapter → pluginStore → extRuntime
 * 环里 pluginStore 的模块体在 extRuntime **自身求值完成之前**执行，于是它调进
 * extRuntime 的 `let appliedVars` 命中 TDZ —— `ReferenceError: Cannot access
 * 'appliedVars' before initialization`，React 从未挂载，`#root` 空节点 = **整窗白屏**，
 * 而 tsc/vitest/build/cargo 当时全绿（构建期 rollup 把环拉平了，只有 dev 的 ESM
 * 求值顺序会炸）。
 * 改成注册式 + 脏标记：谁先求值都不丢样式层、也不靠 App 启动顺序。 */
let applyStyleFn: (() => void) | null = null;
let stylesDirty = false;

/** 投影变了，请重贴样式层；applier 尚未注册（模块求值期）就先记账，注册时补一次。 */
function scheduleStyles(): void {
  if (!applyStyleFn) {
    stylesDirty = true;
    return;
  }
  stylesDirty = false;
  applyStyleFn();
}

/** 由 extRuntime 在自身求值时注册；带脏标记则立刻补跑一次。 */
export function setStyleApplier(fn: () => void): void {
  applyStyleFn = fn;
  if (stylesDirty) scheduleStyles();
}

export type PluginState =
  | "draft"
  | "validated"
  | "previewed"
  | "installed_disabled"
  | "enabled"
  | "disabled"
  | "update_pending"
  | "quarantined";

export const PLUGIN_STATE_LABEL: Record<PluginState, string> = {
  draft: "草稿",
  validated: "已校验",
  previewed: "已预览",
  installed_disabled: "已安装（停用）",
  enabled: "已启用",
  disabled: "已停用",
  update_pending: "待批准更新",
  quarantined: "已隔离",
};

export interface PluginVersionEntry {
  version: string;
  createdAt: number;
  pkg: PluginManifest;
}

export interface PluginRecord {
  pkg: PluginManifest;
  state: PluginState;
  /** 新插件 iframe 握手 nonce */
  nonce: string;
  config: Record<string, unknown>;
  versions: PluginVersionEntry[];
  candidate?: PluginManifest;
  createdAt: number;
  updatedAt: number;
}

export interface PluginSnapshot {
  plugins: PluginRecord[];
}

const KEY = "vs.pluginLib.v1";
const MAX_VERSIONS = 5;
const VIOLATION_WINDOW_MS = 60_000;
const VIOLATION_THRESHOLD = 3;

function load(): PluginSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PluginSnapshot>;
      const all = Array.isArray(p.plugins) ? (p.plugins as PluginRecord[]) : [];
      // P99a-B1a 零兼容（用户裁决：软件未发布、旧形态不适配）：带 `legacy` 的迁移记录直接丢弃，
      // 但**不静默**——留一行读数，否则用户只会看到"我装的插件不见了"。
      const dropped = all.filter((r) => (r as { legacy?: unknown }).legacy);
      if (dropped.length)
        console.warn(`[pluginStore] 已丢弃 ${dropped.length} 条旧扩展迁移记录（legacy 形态已废弃，请在插件库重新保存）`);
      // nonce 是桥握手的不变量，缺了它这个包永远过不了裁决 ⇒ 就地补，而不是留一个哑插件
      return {
        plugins: all
          .filter((r) => !(r as { legacy?: unknown }).legacy)
          .map((r) => (typeof r.nonce === "string" && r.nonce ? r : { ...r, nonce: crypto.randomUUID() })),
      };
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { plugins: [] };
}

let snapshot: PluginSnapshot = load();
const listeners = new Set<() => void>();

/** persist 失败（配额超限等）时的最近错误，供安装入口如实提示。 */
let lastPersistError: string | null = null;
export function consumePersistError(): string | null {
  const e = lastPersistError;
  lastPersistError = null;
  return e;
}

function emit() {
  snapshot = { ...snapshot };
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
    lastPersistError = null;
  } catch (e) {
    lastPersistError = `插件库保存失败（本地存储配额超限）：${String(e).slice(0, 120)}`;
  }
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): PluginSnapshot {
  return snapshot;
}

export function usePlugins(): PluginSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getPlugin(id: string): PluginRecord | undefined {
  return snapshot.plugins.find((p) => p.pkg.id === id);
}

function upsert(record: PluginRecord) {
  const idx = snapshot.plugins.findIndex((p) => p.pkg.id === record.pkg.id);
  if (idx >= 0) snapshot.plugins[idx] = record;
  else snapshot.plugins.push(record);
}

/* ---------------- staging 与安装 ---------------- */

interface StagedEntry {
  stagingId: string;
  manifest: PluginManifest;
  createdAt: number;
}
const staged = new Map<string, StagedEntry>();

/** staging：完整校验后内存暂存，不动库（§9.3 安装先 staging 后原子切换）。 */
export function stagePackage(manifest: unknown): { ok: boolean; errors: string[]; warnings: string[]; stagingId?: string } {
  const v = validateManifest(manifest);
  if (!v.ok || !v.manifest) return { ok: false, errors: v.errors, warnings: v.warnings };
  if (getPlugin(v.manifest.id)) {
    return { ok: false, errors: [`已存在同 ID 插件：${v.manifest.id}（更新请走「检查更新/另存副本」）`], warnings: v.warnings };
  }
  const stagingId = crypto.randomUUID();
  staged.set(stagingId, { stagingId, manifest: v.manifest, createdAt: Date.now() });
  // staging 上限 32，超出淘汰最早的
  if (staged.size > 32) {
    const oldest = [...staged.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) staged.delete(oldest.stagingId);
  }
  return { ok: true, errors: [], warnings: v.warnings, stagingId };
}

/** 原子入库：staging 校验通过的记录一次性进入 installed_disabled。 */
export function installStaged(stagingId: string): { ok: boolean; msg: string; id?: string } {
  const s = staged.get(stagingId);
  if (!s) return { ok: false, msg: "暂存不存在或已过期" };
  staged.delete(stagingId);
  const now = Date.now();
  const record: PluginRecord = {
    pkg: s.manifest,
    state: "installed_disabled",
    nonce: crypto.randomUUID(),
    config: defaultConfig(s.manifest),
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
  upsert(record);
  emit();
  return { ok: true, msg: `已安装「${s.manifest.name}」（默认停用）`, id: s.manifest.id };
}

export function defaultConfig(manifest: PluginManifest): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const f of manifest.settingsSchema ?? []) cfg[f.key] = f.default;
  return cfg;
}

/* ---------------- 启停与投影 ---------------- */

export function shadowExtId(pkgId: string, contribId: string): string {
  return `plg:${pkgId}:${contribId}`;
}

/** 产物 → 影子扩展 HTML（declarative 由宿主渲染器生成，html 原样；format 缺省按内容推断）。 */
function artifactHtml(payload: Record<string, unknown>): string {
  const format = payload.format ?? (typeof payload.html === "string" ? "html" : "declarative");
  if (format === "declarative") {
    return renderDeclarativeHtml(payload.blocks as never, { title: "" });
  }
  return typeof payload.html === "string" ? payload.html : "";
}

/** 启用：为每个贡献条目创建影子扩展；返回错误消息（可启用为 null）。 */
function buildProjections(record: PluginRecord): string | null {
  const { pkg } = record;
  /** 没人认领的 contributions 键（＝产物形态已下架）：不静默跳过，库里与控制台都要看得见（§13.1 零兼容） */
  const orphan: string[] = [];
  for (const [key, list] of Object.entries(pkg.contributions)) {
    if (!kindOfContribKey(key)) {
      if (list?.length && !orphan.includes(key)) orphan.push(key);
      continue;
    }
    for (const it of list ?? []) {
      const artifact = pkg.artifacts[it.entry];
      if (!artifact) continue;
      const sid = shadowExtId(pkg.id, it.id);
      if (key === "themes") {
        extStore.upsertProjection({
          id: sid,
          type: "theme",
          name: it.name ?? pkg.name,
          desc: `插件 ${pkg.name} v${pkg.version}`,
          version: pkg.version,
          enabled: true,
          createdAt: Date.now(),
          pluginRef: pkg.id,
          vars: (artifact.vars as Record<string, string>) ?? {},
          ...(artifact.scheme === "dark" || artifact.scheme === "light" ? { scheme: artifact.scheme } : {}),
          ...(typeof artifact.css === "string" && artifact.css ? { css: artifact.css } : {}),
        });
      } else if (key === "widgets") {
        extStore.upsertProjection({
          id: sid,
          type: "widget",
          name: it.name ?? pkg.name,
          desc: `插件 ${pkg.name} v${pkg.version}`,
          version: pkg.version,
          enabled: true,
          createdAt: Date.now(),
          pluginRef: pkg.id,
          html: artifactHtml(artifact),
          ...(artifact.chrome === "none" ? { chrome: "none" as const } : {}),
        });
      } else if (key === "panels") {
        extStore.upsertProjection({
          id: sid,
          type: "panel",
          name: it.name ?? pkg.name,
          desc: `插件 ${pkg.name} v${pkg.version}`,
          version: pkg.version,
          enabled: true,
          createdAt: Date.now(),
          pluginRef: pkg.id,
          html: artifactHtml(artifact),
        });
      }
      // workspacePresets / workflows 的"投影"是插件库里的一次用户动作（应用布局 / 载入 AI 助手），
      // 不在启用时自动发生：布局会改用户的工作台，模板会指向输入框，两者都不该静默生效
    }
  }
  if (orphan.length) {
    console.warn(`[pluginStore] 包 ${pkg.id} 带着已下架的产物形态（${orphan.join("、")}）：它不会出现在任何运行时里，请在 AI 助手里重新生成`);
  }
  return null;
}

/** 这个包里"已下架但还躺在库中"的产物键（插件库据此显式说明，而不是让它看着像一个正常插件）。 */
export function deprecatedContribKeys(pkg: PluginManifest): string[] {
  return Object.entries(pkg.contributions)
    .filter(([key, list]) => !!list?.length && !kindOfContribKey(key))
    .map(([key]) => key);
}

/**
 * 一个包里可用的 theme 产物（选择器、互斥判定、投影三处共用同一份枚举）。
 * 放在这里而不是各算一遍：什么叫"带主题产物的包"只能有一处答案（§8-48）。
 */
export interface ThemeArt {
  entryId: string;
  name: string;
  artifact: Record<string, unknown>;
  extId: string;
}

export function themeArtsOf(pkg: PluginManifest): ThemeArt[] {
  const out: ThemeArt[] = [];
  for (const it of pkg.contributions?.themes ?? []) {
    const artifact = pkg.artifacts?.[it.entry] as Record<string, unknown> | undefined;
    if (!artifact) continue;
    out.push({
      entryId: it.id,
      name: it.name ?? pkg.name,
      artifact,
      extId: shadowExtId(pkg.id, it.id),
    });
  }
  return out;
}

const hasThemeArt = (pkg: PluginManifest) => themeArtsOf(pkg).length > 0;

/**
 * 主题互斥的**唯一执行点**：把除 `selfId` 以外所有"启用中的带 theme 包"停掉，返回被挤掉的名字。
 * 叫它的地方只有一处：`setEnabled`——那是唯一能把包置为 enabled 的入口。
 * `approveUpdate`/`rollback` 都不叫：前者那一步只可能在本包**原本就 enabled** 时重新上屏，
 * 而那意味着互斥早在启用它时就把别的主题停掉了（详见 `approveUpdate` 里那段注释——
 * 这条是证伪时实测出来的：加了再摘掉，测试全绿，说明它永远不生效）；后者换的是同一个包的版本。
 */
function enforceThemeMutex(selfId: string): string[] {
  const record = getPlugin(selfId);
  if (!record || !hasThemeArt(record.pkg)) return [];
  const pushed: string[] = [];
  for (const other of snapshot.plugins) {
    if (other.pkg.id === selfId || other.state !== "enabled" || !hasThemeArt(other.pkg)) continue;
    removeProjections(other.pkg.id);
    other.state = "disabled";
    other.updatedAt = Date.now();
    upsert(other);
    pushed.push(other.pkg.name);
  }
  return pushed;
}

/** 库里所有"带 theme 产物"的包（互斥入口收敛与选择器都读它，不许各自 filter） */
export function themeBearingPackages(): PluginRecord[] {
  return snapshot.plugins.filter((r) => hasThemeArt(r.pkg));
}

/**
 * 把这个包从运行时里摘掉：影子扩展 + 逻辑模块 worker + 它注册的工具，一次摘干净。
 * 停用/卸载/隔离/换版本都走这一个出口（分开摘会留"扩展没了但工具还在"的半死态）。
 */
function removeProjections(pkgId: string) {
  closeModule(pkgId);
  const prefix = `plg:${pkgId}:`;
  for (const e of extStore.getSnapshot().exts) {
    if (e.pluginRef === pkgId || e.id.startsWith(prefix)) extStore.removeProjection(e.id);
  }
}

export function setEnabled(id: string, enabled: boolean): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  if (record.state === "quarantined" && enabled) {
    return { ok: false, msg: "插件已被隔离（多次违反隔离约束），请先卸载后重新安装" };
  }
  if (enabled) {
    // P91 D2：**已启用也要重建投影**。旧实现在这里早退"已启用"，而 theme 投影
    // 已不再持久化（P91 D1）——早退等于"库里说已启用、界面什么都没应用"。
    const err = buildProjections(record);
    if (err) return { ok: false, msg: err };
    record.state = "enabled";
    /**
     * P99b-N5 R2①：**主题互斥在入口收敛**。启用一个带 theme 产物的包 ⇒ 把其它启用中的
     * 带 theme 包一并停掉（走既有 `removeProjections`，不加状态位、不另记一份"谁是当前主题"）。
     *
     * 为什么不在渲染层"挑一枚"就算了：那会留下"库里三个开关都亮着、只有一枚在画"的分裂态，
     * 而这正是这一路在灭的东西（详设 §1-9）。渲染侧仍留一层兜底挑选 + 点名，
     * 因为存量数据与 `restoreProjections()` 重启重建都可能带着多枚（②那半）。
     */
    const pushed = enforceThemeMutex(id);
    scheduleStyles();
    record.updatedAt = Date.now();
    upsert(record);
    emit();
    return {
      ok: true,
      msg: pushed.length
        ? `已启用「${record.pkg.name}」；主题互斥，同时停用了 ${pushed.length} 枚：${pushed.join("、")}`
        : `已启用「${record.pkg.name}」`,
    };
  }
  removeProjections(id);
  record.state = record.state === "enabled" ? "disabled" : "installed_disabled";
  scheduleStyles();
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  return { ok: true, msg: `已停用「${record.pkg.name}」` };
}

/**
 * P91 D1：启动时从插件库重建全部启用件的投影（theme 的唯一真相在这里，不在 vs.aiExts）。
 * 模块加载即执行，因此不依赖 App 的启动顺序；样式层走 `scheduleStyles()`（本文件顶部
 * P92-F 注释），求值期未注册就记脏、由 extRuntime 注册时补跑，**不会再在求值期调进
 * 尚未初始化的 extRuntime**。
 */
function restoreProjections() {
  let changed = false;
  for (const record of snapshot.plugins) {
    if (record.state !== "enabled") continue;
    if (buildProjections(record) === null) changed = true;
  }
  if (changed) scheduleStyles();
}

restoreProjections();

/**
 * P99a-B1/B2：把一个包的逻辑模块臂起来（起 Worker + 等封网自证）。
 *
 * 通不过就**保持停用**，并把逐 entry 的失败原因原样回给调用方（插件库开关 / `enable_plugin`）。
 * 幂等：已经在线的直接返回——run 起点会遍历已启用包臂一次，不能每次任务都把 worker 重启。
 *
 * 为什么不做进 `setEnabled`：它是同步的，而探针要等 worker 回报。把异步门做成"先启用、
 * 回头再标红"就是 §8-37 说的"假装生效的安全控件"。
 */
export async function armModulePackage(id: string): Promise<{ ok: boolean; msg: string; modules: number }> {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在", modules: 0 };
  const mods = moduleArtifactsOf(record.pkg);
  if (!mods.length) return { ok: true, msg: "本包没有逻辑模块", modules: 0 };
  if (moduleIsReady(id)) return { ok: true, msg: "逻辑模块已在线", modules: 1 };
  const failed = (why: string) => ({ ok: false, msg: `逻辑模块未通过封网自证，保持停用——${why}`, modules: 1 });
  openModule({
    pkgId: record.pkg.id,
    pkgName: record.pkg.name,
    version: record.pkg.version,
    code: mods[0].code,
    nonce: record.nonce,
    caps: record.pkg.capabilities,
    onViolation: (pkgId, why) => reportViolation(pkgId, why),
  });
  /**
   * 等的是 **ready**（封网过了 **且** 插件代码求值完），不是只等探针：
   * `uartix.tools.register()` 在求值里同步发出，探针回报与 tool-def 是两条消息两个任务——
   * 只等探针就去取工具快照，会得到"这次任务没工具、下次才有"的鬼现象。
   */
  const outcome = await waitModuleReady(id);
  if (outcome.status !== "live") {
    const diag = moduleDiagnostics(id);
    closeModule(id);
    return failed(diag.probeFailed.join("/") || `状态 ${outcome.status}`);
  }
  /**
   * P99a-F2：这一刻才是"这一版的工具面报齐了"的时刻，所以差异也只能在这里算
   * （批准卡上说不清"多了哪几支工具"是结构性的，不是偷懒——E2 已把这句话写进面板）。
   */
  const note = describeToolChange(commitToolSnapshot(id));
  return { ok: true, msg: `逻辑模块已通过封网自证并在线${note ? `；${note}` : ""}`, modules: 1 };
}

/** 收掉一个包的逻辑模块（停用/卸载/隔离/换版本都走它）：worker 终止、它的工具当场注销。 */
export function disarmModulePackage(id: string): void {
  closeModule(id);
}

/**
 * run 起点臂一遍所有"已启用且带逻辑模块"的包。
 * 臂失败的包**不注册工具**，但一定要出声：静默少了工具，下一次排查只会去怀疑模型。
 */
export async function armEnabledModules(): Promise<{ live: string[]; blocked: { id: string; msg: string }[] }> {
  const live: string[] = [];
  const blocked: { id: string; msg: string }[] = [];
  for (const record of snapshot.plugins) {
    if (record.state !== "enabled") continue;
    if (!moduleArtifactsOf(record.pkg).length) continue;
    const r = await armModulePackage(record.pkg.id);
    if (r.ok) live.push(record.pkg.id);
    else blocked.push({ id: record.pkg.id, msg: r.msg });
  }
  return { live, blocked };
}

/** 标记已预览（状态机 draft/validated → previewed）。 */
export function markPreviewed(id: string) {
  const record = getPlugin(id);
  if (!record) return;
  if (record.state === "draft" || record.state === "validated") {
    record.state = "previewed";
    record.updatedAt = Date.now();
    upsert(record);
    emit();
  }
}

/* ---------------- 配置 ---------------- */

export function setConfigValues(id: string, values: Record<string, unknown>): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  const schema = record.pkg.settingsSchema ?? [];
  const next: Record<string, unknown> = { ...record.config };
  for (const [k, v] of Object.entries(values)) {
    const f = schema.find((s) => s.key === k);
    if (!f) return { ok: false, msg: `未知配置项：${k}` };
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, msg: `配置项 ${f.label} 必须是数字` };
      if (f.min !== undefined && n < f.min) return { ok: false, msg: `配置项 ${f.label} 不能小于 ${f.min}` };
      if (f.max !== undefined && n > f.max) return { ok: false, msg: `配置项 ${f.label} 不能大于 ${f.max}` };
      next[k] = n;
    } else if (f.type === "boolean") {
      next[k] = !!v;
    } else if (f.type === "enum") {
      if (!f.options?.includes(String(v))) return { ok: false, msg: `配置项 ${f.label} 取值非法` };
      next[k] = String(v);
    } else {
      next[k] = String(v).slice(0, 500);
    }
  }
  record.config = next;
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  return { ok: true, msg: "配置已保存" };
}

/* ---------------- 更新与回滚 ---------------- */

/** 更新现有版本：先建候选（update_pending），批准后原子切换（§9.3）。 */
export function proposeUpdate(id: string, manifest: unknown): { ok: boolean; msg: string; warnings?: string[] } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  const v = validateManifest(manifest);
  if (!v.ok || !v.manifest) return { ok: false, msg: v.errors.join("；") };
  if (v.manifest.id !== id) return { ok: false, msg: `候选包 ID（${v.manifest.id}）与现有插件（${id}）不一致` };
  if (v.manifest.version === record.pkg.version) return { ok: false, msg: "候选版本号与当前版本相同" };
  // 差异**现算不落盘**（E2）：候选包与现役包都在 record 里，落一份 diff 就是第二真相。
  const diff = manifestDiff(record.pkg, v.manifest);
  record.candidate = v.manifest;
  record.state = "update_pending";
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  const d = describeDiff(diff);
  return {
    ok: true,
    msg: d ? `候选已就绪；${d}` : "候选已就绪（与当前版本无能力/产物差异）",
    warnings: v.warnings,
  };
}

export function approveUpdate(id: string): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record || !record.candidate) return { ok: false, msg: "没有待批准的候选" };
  const wasEnabled = record.state === "update_pending" ? removeProjectionsCheck(id) : false;
  // 原子切换：旧版本入历史，候选转正，单次 emit
  record.versions = [
    ...record.versions.slice(-(MAX_VERSIONS - 1)),
    { version: record.pkg.version, createdAt: record.updatedAt, pkg: record.pkg },
  ];
  // 切换前先算差异：这句要出现在回执里（E2 的"说真话"，不是新增审批——批准本来就是那一次点击）
  const diffText = describeDiff(manifestDiff(record.pkg, record.candidate));
  record.pkg = record.candidate;
  record.candidate = undefined;
  record.config = { ...defaultConfig(record.pkg), ...record.config };
  record.updatedAt = Date.now();
  record.state = wasEnabled ? "enabled" : "disabled";
  if (wasEnabled) {
    /**
     * 这里**不叫** `enforceThemeMutex`（我先加了，证伪时摘掉它测试全绿 —— 那条路不可达，
     * 留着就是一段"看着像门、其实永远不生效"的代码，正是 M2 清退的那类假控件）。不可达的理由：
     * 走到这一支要求本包原先是 enabled，而任何其它包被启用时都经过 `setEnabled` 的收敛，
     * 那一刻本包已被置为 disabled —— 于是"本包 enabled 且另有第二枚主题 enabled"只剩
     * **存量数据（升级前就两枚都亮着）** 这一个来源，而那一份的处理方式是"点名 + 一键收敛"，
     * 不该由一次批准更新顺手替用户改掉（详设 §0-1 Q1）。
     */
    const err = buildProjections(record);
    if (err) {
      // 投影重建失败：回退到旧包（§9.3 失败自动回退）
      const prev = record.versions[record.versions.length - 1];
      if (prev) {
        record.pkg = prev.pkg;
        record.versions = record.versions.slice(0, -1);
        record.state = "enabled";
        buildProjections(record);
      }
      upsert(record);
      emit();
      scheduleStyles();
      return { ok: false, msg: `更新失败已回退：${err}` };
    }
    scheduleStyles();
  }
  upsert(record);
  emit();
  return { ok: true, msg: `已更新到 v${record.pkg.version}${diffText ? `（${diffText}）` : ""}` };
}

function removeProjectionsCheck(pkgId: string): boolean {
  const had = extStore.getSnapshot().exts.some((e) => e.pluginRef === pkgId);
  removeProjections(pkgId);
  return had;
}

export function rejectUpdate(id: string): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record || !record.candidate) return { ok: false, msg: "没有待批准的候选" };
  record.candidate = undefined;
  record.state = extStore.getSnapshot().exts.some((e) => e.pluginRef === id) ? "enabled" : "disabled";
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  return { ok: true, msg: "已拒绝候选，保持当前版本" };
}

/** 回滚到上一版本（历史栈弹出）；不承诺撤销设备效果（§9.3）。 */
export function rollback(id: string): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  const prev = record.versions[record.versions.length - 1];
  if (!prev) return { ok: false, msg: "没有可回滚的历史版本" };
  const wasEnabled = record.state === "enabled";
  if (wasEnabled) removeProjections(id);
  const current: PluginVersionEntry = { version: record.pkg.version, createdAt: record.updatedAt, pkg: record.pkg };
  record.pkg = prev.pkg;
  record.versions = [...record.versions.slice(0, -1), current];
  record.updatedAt = Date.now();
  record.state = wasEnabled ? "enabled" : "disabled";
  if (wasEnabled) buildProjections(record);
  upsert(record);
  emit();
  scheduleStyles();
  return { ok: true, msg: `已回滚到 v${record.pkg.version}` };
}

/* ---------------- 复制 / 卸载 / 隔离 ---------------- */

export function duplicate(id: string): { ok: boolean; msg: string; id?: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  let n = 1;
  let newId = `${id}.copy${n}`;
  while (getPlugin(newId)) newId = `${id}.copy${++n}`;
  const now = Date.now();
  const copy: PluginRecord = {
    pkg: {
      ...structuredClone(record.pkg),
      id: newId,
      name: `${record.pkg.name} 副本`,
      provenance: { ...record.pkg.provenance, createdBy: "user", reviewed: false },
    },
    state: "installed_disabled",
    nonce: crypto.randomUUID(),
    config: { ...record.config },
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
  upsert(copy);
  emit();
  return { ok: true, msg: `已创建副本 ${newId}（默认停用）`, id: newId };
}

export function uninstall(id: string): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  removeProjections(id);
  snapshot.plugins = snapshot.plugins.filter((p) => p.pkg.id !== id);
  emit();
  scheduleStyles();
  return { ok: true, msg: `已卸载「${record.pkg.name}」（历史版本一并删除）` };
}

const violationLog = new Map<string, number[]>();

/** iframe 隔离约束违规上报：窗口内累计 3 次进入隔离（§9.3 quarantined）。 */
export function reportViolation(pkgId: string, code: string): void {
  const now = Date.now();
  const list = (violationLog.get(pkgId) ?? []).filter((t) => now - t < VIOLATION_WINDOW_MS);
  list.push(now);
  violationLog.set(pkgId, list);
  if (list.length < VIOLATION_THRESHOLD) {
    console.warn(`[插件隔离] ${pkgId} 违规（${code}）${list.length}/${VIOLATION_THRESHOLD}`);
    return;
  }
  violationLog.delete(pkgId);
  const record = getPlugin(pkgId);
  if (!record || record.state === "quarantined") return;
  removeProjections(pkgId);
  record.state = "quarantined";
  record.updatedAt = now;
  upsert(record);
  emit();
  scheduleStyles();
  console.warn(`[插件隔离] ${pkgId} 已隔离（60 秒内违规 ${VIOLATION_THRESHOLD} 次，最近：${code}）`);
}

/* ---------------- 导入导出（白名单） ---------------- */

const COLLECTION_KIND = "uartix-plugin-collection";

/** 导出指定插件：pkg 原样（reviewed 恒为 false），不含 config/nonce/版本历史。 */
export function exportPackages(ids: string[]): { ok: boolean; msg: string; json?: string } {
  const records = ids.map(getPlugin);
  const pkgs: PluginManifest[] = [];
  for (const r of records) {
    if (!r) continue;
    const hit = containsSecretLike(r.pkg);
    if (hit) return { ok: false, msg: `插件「${r.pkg.name}」含疑似秘密字段（${hit}），已拒绝导出` };
    pkgs.push(r.pkg);
  }
  if (!pkgs.length) return { ok: false, msg: "没有可导出的插件" };
  const json =
    pkgs.length === 1
      ? JSON.stringify(pkgs[0], null, 2)
      : JSON.stringify({ kind: COLLECTION_KIND, version: PLUGIN_SCHEMA_VERSION, data: pkgs }, null, 2);
  return { ok: true, msg: `已导出 ${pkgs.length} 个插件`, json };
}

/**
 * 导入：一律 installed_disabled 且不执行（§9.3）；同 ID 冲突自动另存副本，
 * provenance.reviewed 强制重置（作者自报不构成信任）。
 */
export function importPackages(json: string): { ok: boolean; msg: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, msg: "JSON 解析失败" };
  }
  const list: unknown[] = [];
  const obj = parsed as { kind?: string; data?: unknown };
  if (obj?.kind === COLLECTION_KIND && Array.isArray(obj.data)) list.push(...obj.data);
  else list.push(parsed);
  let n = 0;
  const errs: string[] = [];
  for (const item of list) {
    const v = validateManifest(item);
    if (!v.ok || !v.manifest) {
      errs.push(v.errors.join("；"));
      continue;
    }
    const manifest = structuredClone(v.manifest);
    manifest.provenance = { ...manifest.provenance, createdBy: "import", reviewed: false };
    // 同 ID 冲突：另存副本，不静默覆盖
    if (getPlugin(manifest.id)) {
      let n2 = 1;
      while (getPlugin(`${manifest.id}.copy${n2}`)) n2++;
      manifest.id = `${manifest.id}.copy${n2}`;
    }
    const now = Date.now();
    upsert({
      pkg: manifest,
      state: "installed_disabled",
      nonce: crypto.randomUUID(),
      config: defaultConfig(manifest),
      versions: [],
      createdAt: now,
      updatedAt: now,
    });
    n++;
  }
  if (n === 0) return { ok: false, msg: `没有可导入的插件：${errs[0] ?? "文件为空"}` };
  emit();
  const quota = consumePersistError();
  if (quota) return { ok: false, msg: quota };
  return {
    ok: true,
    msg: `已导入 ${n} 个插件（默认停用）${errs.length ? `；${errs.length} 个包校验失败被跳过` : ""}`,
  };
}

/* ---------------- WidgetFrame 隔离上下文 ---------------- */

export interface PluginFrameCtx {
  pkgId: string;
  caps: PluginCap[];
  nonce: string;
}

/** 由影子扩展的 pluginRef 解析插件隔离上下文；非插件扩展返回 undefined。 */
export function pluginCtxForExt(pluginRef: string | undefined): PluginFrameCtx | undefined {
  if (!pluginRef) return undefined;
  const record = getPlugin(pluginRef);
  if (!record) return undefined;
  return { pkgId: record.pkg.id, caps: record.pkg.capabilities, nonce: record.nonce };
}

/** 常量复出口（供 UI/测试单一来源）。 */
export { PLUGIN_FORMAT, PLUGIN_SCHEMA_VERSION, HOST_API, MAX_PACKAGE_FILES };
