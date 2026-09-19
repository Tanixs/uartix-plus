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
import { applyStyleExts } from "../ai/extRuntime";
import {
  HOST_API,
  PLUGIN_FORMAT,
  PLUGIN_SCHEMA_VERSION,
  MAX_PACKAGE_FILES,
  containsSecretLike,
  validateManifest,
  type PluginCap,
  type PluginManifest,
} from "./pluginManifest";
import { renderDeclarativeHtml } from "./declarativePanel";

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
  /** 旧扩展迁移来源；requiresReview 的记录不可启用（script 迁移） */
  legacy?: { fromExtType: string; requiresReview?: boolean; note?: string; code?: string };
  /** 新插件 iframe 握手 nonce（legacy 迁移件不强制） */
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
      return { plugins: Array.isArray(p.plugins) ? (p.plugins as PluginRecord[]) : [] };
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

/** legacy 迁移件直接落库（不走 staging：记录本身即为待审状态，§9.4）。 */
export function upsertLegacyRecord(record: PluginRecord) {
  upsert(record);
  emit();
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
  for (const [key, list] of Object.entries(pkg.contributions)) {
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
          perms: ["css"],
          enabled: true,
          createdAt: Date.now(),
          pluginRef: pkg.id,
          vars: (artifact.vars as Record<string, string>) ?? {},
          ...(typeof artifact.css === "string" && artifact.css ? { css: artifact.css } : {}),
        });
      } else if (key === "widgets") {
        extStore.upsertProjection({
          id: sid,
          type: "widget",
          name: it.name ?? pkg.name,
          desc: `插件 ${pkg.name} v${pkg.version}`,
          version: pkg.version,
          perms: ["read", "send"],
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
          perms: ["read", "send"],
          enabled: true,
          createdAt: Date.now(),
          pluginRef: pkg.id,
          html: artifactHtml(artifact),
        });
      }
      // 其余产物类型（motionPreset/workspacePreset/workflow/reportView）首版仅库内保存/导出
    }
  }
  return null;
}

function removeProjections(pkgId: string) {
  const prefix = `plg:${pkgId}:`;
  for (const e of extStore.getSnapshot().exts) {
    if (e.pluginRef === pkgId || e.id.startsWith(prefix)) extStore.removeProjection(e.id);
  }
}

export function setEnabled(id: string, enabled: boolean): { ok: boolean; msg: string } {
  const record = getPlugin(id);
  if (!record) return { ok: false, msg: "插件不存在" };
  if (record.legacy?.requiresReview) {
    return { ok: false, msg: "该迁移件包含脚本等无法安全转换的内容，保持停用等待人工处理" };
  }
  if (record.state === "quarantined" && enabled) {
    return { ok: false, msg: "插件已被隔离（多次违反隔离约束），请先卸载后重新安装" };
  }
  if (enabled) {
    if (record.state === "enabled") return { ok: true, msg: "已启用" };
    const err = buildProjections(record);
    if (err) return { ok: false, msg: err };
    record.state = "enabled";
    applyStyleExts();
  } else {
    removeProjections(id);
    record.state = record.state === "enabled" ? "disabled" : "installed_disabled";
    applyStyleExts();
  }
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  return { ok: true, msg: enabled ? `已启用「${record.pkg.name}」` : `已停用「${record.pkg.name}」` };
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
  if (record.legacy) return { ok: false, msg: "迁移件不支持在线更新（请在插件库另存新版本）" };
  const v = validateManifest(manifest);
  if (!v.ok || !v.manifest) return { ok: false, msg: v.errors.join("；") };
  if (v.manifest.id !== id) return { ok: false, msg: `候选包 ID（${v.manifest.id}）与现有插件（${id}）不一致` };
  if (v.manifest.version === record.pkg.version) return { ok: false, msg: "候选版本号与当前版本相同" };
  // 新增能力需要用户在批准时看到
  const addedCaps = v.manifest.capabilities.filter((c) => !record.pkg.capabilities.includes(c));
  record.candidate = v.manifest;
  record.state = "update_pending";
  record.updatedAt = Date.now();
  upsert(record);
  emit();
  return {
    ok: true,
    msg: addedCaps.length ? `候选已就绪；新增能力：${addedCaps.join("、")}` : "候选已就绪",
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
  const nextCaps = record.candidate.capabilities;
  record.pkg = record.candidate;
  record.candidate = undefined;
  record.config = { ...defaultConfig(record.pkg), ...record.config };
  record.updatedAt = Date.now();
  record.state = wasEnabled ? "enabled" : "disabled";
  if (wasEnabled) {
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
      applyStyleExts();
      return { ok: false, msg: `更新失败已回退：${err}` };
    }
    applyStyleExts();
  }
  upsert(record);
  emit();
  void nextCaps;
  return { ok: true, msg: `已更新到 v${record.pkg.version}` };
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
  applyStyleExts();
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
  applyStyleExts();
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
  applyStyleExts();
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
  /** 迁移件保持旧行为（M1 存量旁路）：不强制 nonce/能力校验 */
  legacy: boolean;
}

/** 由影子扩展的 pluginRef 解析插件隔离上下文；非插件扩展返回 undefined。 */
export function pluginCtxForExt(pluginRef: string | undefined): PluginFrameCtx | undefined {
  if (!pluginRef) return undefined;
  const record = getPlugin(pluginRef);
  if (!record) return undefined;
  return { pkgId: record.pkg.id, caps: record.pkg.capabilities, nonce: record.nonce, legacy: !!record.legacy };
}

/** 插件库统计（供入口徽标/诊断）。 */
export function stats(): { total: number; enabled: number; quarantined: number; legacy: number } {
  return {
    total: snapshot.plugins.length,
    enabled: snapshot.plugins.filter((p) => p.state === "enabled").length,
    quarantined: snapshot.plugins.filter((p) => p.state === "quarantined").length,
    legacy: snapshot.plugins.filter((p) => p.legacy).length,
  };
}

/** 常量复出口（供 UI/测试单一来源）。 */
export { PLUGIN_FORMAT, PLUGIN_SCHEMA_VERSION, HOST_API, MAX_PACKAGE_FILES };
