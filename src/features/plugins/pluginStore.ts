/**
 * P174-A18：旧 `pluginStore` 的**最小兼容层**。
 *
 * 真正的存储与生命周期已经搬到 `features/artifact/store.ts`（AI 产物的唯一真相）。
 * 这个文件只剩两件事：
 *  1. 把旧调用方仍在用的"包"形状（`pkg.contributions/artifacts`）**翻译**成产物记录，
 *     好让外观工具、主题选择器、宿主目录与 AI 工具面在迁移期不改话术；
 *  2. 保留旧安装链的**函数名**（stagePackage → installStaged → setEnabled），
 *     避免 `appearanceTools` 的动态导入在行为上出现第二种写法。
 *
 * 刻意不做的事：不校验旧清单的 schema、不处理 module/worker、不维护 config/导入导出。
 * 那些属于已删除的旧第三方插件系统；这里只服务"AI 造出来的主题/小部件/面板"。
 */
import { useSyncExternalStore } from "react";
import * as artifacts from "../artifact/store";
import { shadowExtId } from "../artifact/store";

export { setStyleApplier } from "../artifact/store";
export { shadowExtId };

/* ---------------- 旧形状（只保留调用方真正读的字段） ---------------- */

export type PluginState = "installed_disabled" | "enabled" | "quarantined";

export interface LegacyContribution {
  id: string;
  entry: string;
  name?: string;
}

export interface PluginManifest {
  format?: string;
  schemaVersion?: number;
  id: string;
  version: string;
  name: string;
  desc?: string;
  hostApi?: string;
  capabilities: string[];
  contributions: Record<string, LegacyContribution[]>;
  artifacts: Record<string, Record<string, unknown> & { kind?: string }>;
  provenance?: { createdBy?: "agent" | "user" | "import"; reviewed?: boolean };
}

export interface PluginVersionEntry {
  version: string;
  createdAt: number;
  pkg: PluginManifest;
}

export interface PluginRecord {
  pkg: PluginManifest;
  state: PluginState;
  nonce: string;
  config: Record<string, unknown>;
  versions: PluginVersionEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface PluginSnapshot {
  plugins: PluginRecord[];
}

const CONTRIB_BY_KIND: Record<artifacts.ArtifactKind, string> = {
  theme: "themes",
  widget: "widgets",
  panel: "panels",
};

const KIND_BY_CONTRIB: Record<string, artifacts.ArtifactKind> = {
  themes: "theme",
  widgets: "widget",
  panels: "panel",
};

function toPkg(a: artifacts.ArtifactRecord): PluginManifest {
  return {
    format: "uartix-plugin",
    schemaVersion: 3,
    id: a.id,
    version: a.version,
    name: a.name,
    ...(a.desc ? { desc: a.desc } : {}),
    capabilities: [...artifacts.artifactKindMeta(a.kind).caps],
    contributions: { [CONTRIB_BY_KIND[a.kind]]: [{ id: "main", entry: "main.json", name: a.name }] },
    artifacts: { "main.json": { ...a.data, kind: a.kind } },
    provenance: { createdBy: a.createdBy, reviewed: false },
  };
}

function toRecord(a: artifacts.ArtifactRecord): PluginRecord {
  return {
    pkg: toPkg(a),
    state: a.quarantined ? "quarantined" : a.enabled ? "enabled" : "installed_disabled",
    nonce: a.nonce,
    config: {},
    versions: a.versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      pkg: { ...toPkg(a), version: v.version, artifacts: { "main.json": { ...v.data, kind: a.kind } } },
    })),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/* ---------------- 快照 ---------------- */

let cachedFrom: artifacts.ArtifactSnapshot | null = null;
let cached: PluginSnapshot = { plugins: [] };

export function getSnapshot(): PluginSnapshot {
  const src = artifacts.getSnapshot();
  if (src !== cachedFrom) {
    cachedFrom = src;
    cached = { plugins: src.artifacts.map(toRecord) };
  }
  return cached;
}

export function subscribe(cb: () => void): () => void {
  return artifacts.subscribe(cb);
}

export function usePlugins(): PluginSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getPlugin(id: string): PluginRecord | undefined {
  const a = artifacts.getArtifact(id);
  return a ? toRecord(a) : undefined;
}

/** 一个包里的 theme 产物（外观选择器与互斥判定共用同一份枚举）。 */
export interface ThemeArt {
  entryId: string;
  name: string;
  artifact: Record<string, unknown>;
  extId: string;
}

export function themeArtsOf(pkg: PluginManifest): ThemeArt[] {
  const out: ThemeArt[] = [];
  for (const it of pkg.contributions?.themes ?? []) {
    const art = pkg.artifacts?.[it.entry];
    if (!art) continue;
    out.push({
      entryId: it.id,
      name: it.name ?? pkg.name,
      artifact: art,
      extId: shadowExtId(pkg.id, it.id),
    });
  }
  return out;
}

export function themeBearingPackages(): PluginRecord[] {
  return getSnapshot().plugins.filter((r) => themeArtsOf(r.pkg).length > 0);
}

/* ---------------- 安装 / 更新 / 回滚 ---------------- */

interface StagedEntry {
  id: string;
  manifest: PluginManifest;
  createdAt: number;
}

const staged = new Map<string, StagedEntry>();
const candidates = new Map<string, PluginManifest>();

function kindOfManifest(manifest: PluginManifest): artifacts.ArtifactKind | null {
  for (const key of Object.keys(manifest.contributions ?? {})) {
    const hit = KIND_BY_CONTRIB[key];
    if (hit) return hit;
  }
  const main = manifest.artifacts?.["main.json"];
  const k = main?.kind;
  if (k === "theme" || k === "widget" || k === "panel") return k;
  return null;
}

function payloadOfManifest(manifest: PluginManifest): Record<string, unknown> {
  const main = manifest.artifacts?.["main.json"] ?? {};
  const { kind: _kind, ...payload } = main;
  return payload;
}

function checkManifest(manifest: unknown): { ok: boolean; errors: string[]; warnings: string[]; manifest?: PluginManifest } {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, errors: ["产物清单必须是对象"], warnings: [] };
  }
  const m = manifest as Partial<PluginManifest>;
  const errors: string[] = [];
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/.test(m.id)) {
    errors.push("id 必须是小写点分标识（每段 ≤32 字符）");
  }
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push("version 必须是 semver");
  if (typeof m.name !== "string" || !m.name.trim()) errors.push("name 必须是 1..60 字符");
  const kind = kindOfManifest(m as PluginManifest);
  if (!kind) errors.push("贡献里没有可识别的产物种类（只支持 theme / widget / panel）");
  if (kind) {
    const v = artifacts.validateArtifactPayload(kind, payloadOfManifest(m as PluginManifest));
    errors.push(...v.errors);
    if (!v.ok) return { ok: false, errors, warnings: v.warnings };
    if (errors.length) return { ok: false, errors, warnings: v.warnings };
    return {
      ok: true,
      errors: [],
      warnings: v.warnings,
      manifest: { ...(m as PluginManifest), contributions: { ...(m.contributions ?? {}) } },
    };
  }
  return { ok: false, errors, warnings: [] };
}

export function stagePackage(manifest: unknown): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stagingId?: string;
} {
  const v = checkManifest(manifest);
  if (!v.ok || !v.manifest) return { ok: false, errors: v.errors, warnings: v.warnings };
  if (getPlugin(v.manifest.id)) {
    return { ok: false, errors: [`已存在同 ID 产物：${v.manifest.id}（更新请走 proposeUpdate）`], warnings: v.warnings };
  }
  const stagingId = crypto.randomUUID();
  staged.set(stagingId, { id: v.manifest.id, manifest: v.manifest, createdAt: Date.now() });
  if (staged.size > 32) {
    const oldest = [...staged.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) staged.delete(oldest.id);
  }
  return { ok: true, errors: [], warnings: v.warnings, stagingId };
}

export function installStaged(stagingId: string): { ok: boolean; msg: string; id?: string } {
  const s = staged.get(stagingId);
  if (!s) return { ok: false, msg: "暂存不存在或已过期" };
  staged.delete(stagingId);
  const kind = kindOfManifest(s.manifest);
  if (!kind) return { ok: false, msg: "贡献里没有可识别的产物种类" };
  const r = artifacts.writeArtifact({
    id: s.manifest.id,
    kind,
    name: s.manifest.name,
    desc: s.manifest.desc,
    version: s.manifest.version,
    payload: payloadOfManifest(s.manifest),
    createdBy: s.manifest.provenance?.createdBy ?? "user",
  });
  return r.ok ? { ok: true, msg: `已安装「${s.manifest.name}」（默认停用）`, id: r.id } : { ok: false, msg: r.msg };
}

/** 更新现有产物：先建候选，批准后原子替换（调用方仍按旧名字使用）。 */
export function proposeUpdate(id: string, manifest: unknown): { ok: boolean; msg: string; warnings?: string[] } {
  if (!getPlugin(id)) return { ok: false, msg: "产物不存在" };
  const v = checkManifest(manifest);
  if (!v.ok || !v.manifest) return { ok: false, msg: v.errors.join("；") };
  if (v.manifest.id !== id) return { ok: false, msg: `候选包 ID（${v.manifest.id}）与现有产物（${id}）不一致` };
  if (v.manifest.version === getPlugin(id)!.pkg.version) return { ok: false, msg: "候选版本号与当前版本相同" };
  candidates.set(id, v.manifest);
  return { ok: true, msg: "候选已就绪", warnings: v.warnings };
}

export function approveUpdate(id: string): { ok: boolean; msg: string } {
  const m = candidates.get(id);
  if (!m) return { ok: false, msg: "没有待批准的候选" };
  const kind = kindOfManifest(m);
  if (!kind) return { ok: false, msg: "贡献里没有可识别的产物种类" };
  const r = artifacts.replaceArtifact(id, {
    name: m.name,
    desc: m.desc,
    version: m.version,
    payload: payloadOfManifest(m),
  });
  if (r.ok) candidates.delete(id);
  return r;
}

/** 兼容旧调用方：这里不再是"启用"的动作，只清掉候选。 */
export function rejectUpdate(id: string): { ok: boolean; msg: string } {
  if (!candidates.has(id)) return { ok: false, msg: "没有待批准的候选" };
  candidates.delete(id);
  return { ok: true, msg: "已拒绝候选，保持当前版本" };
}

export function rollback(id: string): { ok: boolean; msg: string } {
  return artifacts.rollbackArtifact(id);
}

export function setEnabled(id: string, enabled: boolean): { ok: boolean; msg: string } {
  return artifacts.setEnabled(id, enabled);
}

export function uninstall(id: string): { ok: boolean; msg: string } {
  return artifacts.removeArtifact(id);
}

/** 另存副本（旧调用方与版本链测试用）：副本一律记成用户作品，Agent 不得静默改它。 */
export function duplicate(id: string): { ok: boolean; msg: string; id?: string } {
  const src = artifacts.getArtifact(id);
  if (!src) return { ok: false, msg: "产物不存在" };
  let n = 1;
  let nextId = `${id}.copy${n}`;
  while (artifacts.getArtifact(nextId)) nextId = `${id}.copy${++n}`;
  const r = artifacts.writeArtifact({
    id: nextId,
    kind: src.kind,
    name: `${src.name} 副本`,
    desc: src.desc,
    version: "0.1.0",
    payload: src.data,
    createdBy: "user",
  });
  return r.ok && r.id ? { ok: true, msg: `已创建副本 ${r.id}（默认停用）`, id: r.id } : { ok: false, msg: r.msg };
}
