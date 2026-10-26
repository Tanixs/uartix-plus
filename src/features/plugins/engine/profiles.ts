/**
 * P174-B2：Profile（工作场景）的**纯判据**。
 *
 * 一个 Profile 只做四件事：按序启用一组插件、停用未列出的插件、对插件状态做键级 patch、
 * 对插件配置做键级 patch。它**不是** dsh 的整行替换，也不碰全局设置/AI 密钥。
 *
 * 这一层没有 IO：应用计划、回滚步骤、归一化都能在 vitest 里跑。真正的副作用在
 * `profilesStore.ts`，通过 `ProfileIo` 注入。
 *
 * 两条底线：
 * 1. 未批准（`needs-approval` / `changed`）的插件**不启用**——Profile 不是绕批准卡的旁路；
 * 2. patch 是键级合并，`null` 才是删除；缺省键一律不动。
 */

import type { PluginSettingField } from "./manifest";
import type { TrustVerdict } from "./repo";
import { applyPluginConfigPatch, diffPluginConfig } from "./pluginConfig";
import { ROOT_KEY_RE } from "./manifest";
import { parseThemeKey } from "./activeTheme";
import { createScope } from "../../artifact/effects";

export const PROFILES_VERSION = 1;
export const MAX_PROFILES = 100;
export const MAX_PROFILE_PLUGINS = 128;

export interface WorkProfilePluginRef {
  id: string;
}

export interface WorkProfilePatch {
  settings?: {
    activeTheme?: string | null;
    workspaceRoot?: string | null;
    roots?: Record<string, string | null>;
  };
  /** 插件 id → contributes.settings 的键级 patch；null = 删除覆盖、回落默认 */
  pluginSettings?: Record<string, Record<string, unknown>>;
}

export interface WorkProfile {
  id: string;
  name: string;
  note?: string;
  /** 有序启用集；不在表里的已启用插件在应用时停用 */
  plugins: WorkProfilePluginRef[];
  patch: WorkProfilePatch;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileBefore {
  /** 应用前全部已启用插件 id（精确集合恢复） */
  enabled: string[];
  settings: { activeTheme: string; workspaceRoot: string; roots: Record<string, string> };
  /** 被 patch 触碰的插件在应用前的覆盖值 */
  pluginSettings: Record<string, Record<string, unknown>>;
}

export interface ProfilesBook {
  version: number;
  profiles: WorkProfile[];
  activeId: string;
  applied?: { id: string; at: number; before: ProfileBefore };
}

export function emptyProfilesBook(): ProfilesBook {
  return { version: PROFILES_VERSION, profiles: [], activeId: "" };
}

/* ============================ 计划 ============================ */

export interface ProfilePluginFact {
  id: string;
  enabled: boolean;
  verdict: TrustVerdict;
  fields: readonly PluginSettingField[];
  /** 当前存储的覆盖值（不是生效值） */
  config: Readonly<Record<string, unknown>>;
}

export interface ProfileWorld {
  activeTheme: string;
  workspaceRoot: string;
  roots: Record<string, string>;
  /** 当前可选的插件主题键（`plg:<id>:<theme>`） */
  themes: readonly string[];
  /** 当前已装清单声明过的外部目录键 */
  rootKeys: readonly string[];
}

export interface ProfilePlan {
  profileId: string;
  name: string;
  /** 预览：按 id 倒序停用 */
  toDisable: string[];
  /** 预览：按 profile 顺序启用 */
  toEnable: string[];
  /** 执行：应用后的完整启用集合（只含已安装且已批准的 id） */
  enabledSet: string[];
  skipped: { id: string; reason: "missing" | "untrusted" | "duplicate" }[];
  extensionPatch: {
    activeTheme?: string | null;
    workspaceRoot?: string | null;
    roots: [key: string, value: string | null][];
  };
  settings: { id: string; patch: Record<string, unknown> }[];
  before: ProfileBefore;
  warnings: string[];
}

export type ProfilePlanResult = { ok: true; plan: ProfilePlan } | { ok: false; errors: string[] };

/**
 * 把「场景 + 当前世界」算成一份可执行计划。
 *
 * 失败（配置类型错、未知字段）是**整单拒绝**：不做"能应用几条算几条"——那会让用户
 * 以为场景完整生效，实际只生效了一半。
 */
export function planProfileApply(profile: WorkProfile, facts: readonly ProfilePluginFact[], world: ProfileWorld): ProfilePlanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const skipped: ProfilePlan["skipped"] = [];
  const enabledSet: string[] = [];

  for (const ref of profile.plugins) {
    if (seen.has(ref.id)) {
      skipped.push({ id: ref.id, reason: "duplicate" });
      warnings.push(`场景里的「${ref.id}」重复出现，已按第一次的位置处理`);
      continue;
    }
    seen.add(ref.id);
    const fact = byId.get(ref.id);
    if (!fact) {
      skipped.push({ id: ref.id, reason: "missing" });
      warnings.push(`场景里的「${ref.id}」没有安装，已跳过`);
      continue;
    }
    if (fact.verdict !== "trusted") {
      skipped.push({ id: ref.id, reason: "untrusted" });
      warnings.push(`「${ref.id}」的权限还没批准，场景不会替你启用它`);
      continue;
    }
    enabledSet.push(ref.id);
  }

  const targetSet = new Set(enabledSet);
  const toEnable = enabledSet.filter((id) => !byId.get(id)!.enabled);
  const toDisable = facts
    .filter((f) => f.enabled && !targetSet.has(f.id))
    .map((f) => f.id)
    .sort()
    .reverse();
  if (toDisable.length) {
    warnings.push(`场景是精确集合：${toDisable.length} 个未列出的插件会被停用（${toDisable.join("、")}）`);
  }

  const extensionPatch: ProfilePlan["extensionPatch"] = { roots: [] };
  const ext = profile.patch.settings;
  if (ext) {
    if ("activeTheme" in ext) {
      const v = ext.activeTheme;
      if (v === null) extensionPatch.activeTheme = "";
      else if (typeof v === "string") {
        if (!v || v === "") extensionPatch.activeTheme = v;
        else if (!world.themes.includes(v)) warnings.push(`场景里的主题「${v}」已经不在了，已忽略这一条`);
        else {
          // 主题插件和面板/命令同一条门：场景必须把提供者一起启用（且它已批准），
          // 否则引擎会在应用时把主题退回内置，用户却以为场景完整生效了。
          const owner = parseThemeKey(v)?.pluginId ?? "";
          if (owner && !enabledSet.includes(owner)) {
            warnings.push(`场景里的主题「${v}」来自未启用的插件「${owner}」，已跳过这一条`);
          } else {
            extensionPatch.activeTheme = v;
          }
        }
      }
    }
    if ("workspaceRoot" in ext) {
      const v = ext.workspaceRoot;
      if (v === null) extensionPatch.workspaceRoot = "";
      else if (typeof v === "string") extensionPatch.workspaceRoot = v.trim();
    }
    if (ext.roots) {
      for (const [key, value] of Object.entries(ext.roots)) {
        if (!ROOT_KEY_RE.test(key)) {
          warnings.push(`外部目录键「${key}」不合规，已忽略`);
          continue;
        }
        if (!world.rootKeys.includes(key)) {
          warnings.push(`当前没有插件声明外部目录「${key}」，已忽略`);
          continue;
        }
        if (value === null) extensionPatch.roots.push([key, null]);
        else if (typeof value === "string" && value.trim()) extensionPatch.roots.push([key, value.trim()]);
      }
    }
  }

  const settings: ProfilePlan["settings"] = [];
  const beforeSettings: Record<string, Record<string, unknown>> = {};
  if (profile.patch.pluginSettings) {
    for (const [id, patch] of Object.entries(profile.patch.pluginSettings)) {
      const fact = byId.get(id);
      if (!fact) {
        warnings.push(`配置补丁指向没有安装的插件「${id}」，已跳过`);
        continue;
      }
      const r = applyPluginConfigPatch(fact.fields, fact.config, patch);
      if (!r.ok) {
        errors.push(...r.errors.map((e) => `「${id}」的配置：${e}`));
        continue;
      }
      const delta = diffPluginConfig(fact.fields, fact.config, r.values);
      if (Object.keys(delta).length) {
        settings.push({ id, patch: delta });
        beforeSettings[id] = { ...fact.config };
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      profileId: profile.id,
      name: profile.name,
      toDisable,
      toEnable,
      enabledSet,
      skipped,
      extensionPatch,
      settings,
      before: {
        enabled: facts.filter((f) => f.enabled).map((f) => f.id),
        settings: {
          activeTheme: world.activeTheme,
          workspaceRoot: world.workspaceRoot,
          roots: { ...world.roots },
        },
        pluginSettings: beforeSettings,
      },
      warnings,
    },
  };
}

/* ============================ 执行 ============================ */

export interface ProfileIo {
  setEnabledSet(ids: readonly string[]): Promise<unknown>;
  setActiveTheme(key: string): Promise<void>;
  setWorkspaceRoot(path: string): Promise<void>;
  setExternalRoot(key: string, path: string): Promise<void>;
  setPluginConfig(id: string, patch: Record<string, unknown>): Promise<void>;
  replacePluginConfig(id: string, values: Record<string, unknown>): Promise<void>;
}

export class ProfileApplyError extends Error {
  readonly failed: number;
  constructor(message: string, failed: number, cause?: unknown) {
    super(message);
    this.name = "ProfileApplyError";
    this.failed = failed;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * 执行计划。**每一步先把 undo 登记进 scope，再执行**——反过来的话，执行到一半失败时
 * 已发生的副作用没有任何人能撤回（`createScope.add` 的规则）。
 */
export async function applyProfilePlan(plan: ProfilePlan, io: ProfileIo): Promise<void> {
  const scope = createScope(`profile:${plan.profileId}`);
  try {
    scope.add("restore-enabled", () => io.setEnabledSet(plan.before.enabled).then(() => undefined));
    await io.setEnabledSet(plan.enabledSet);

    if (plan.extensionPatch.activeTheme !== undefined) {
      const prev = plan.before.settings.activeTheme;
      scope.add("restore-theme", () => io.setActiveTheme(prev));
      await io.setActiveTheme(plan.extensionPatch.activeTheme ?? "");
    }
    if (plan.extensionPatch.workspaceRoot !== undefined) {
      const prev = plan.before.settings.workspaceRoot;
      scope.add("restore-workspace", () => io.setWorkspaceRoot(prev));
      await io.setWorkspaceRoot(plan.extensionPatch.workspaceRoot ?? "");
    }
    for (const [key, value] of plan.extensionPatch.roots) {
      const prev = plan.before.settings.roots[key] ?? "";
      scope.add(`restore-root:${key}`, () => io.setExternalRoot(key, prev));
      await io.setExternalRoot(key, value ?? "");
    }
    for (const s of plan.settings) {
      const prev = plan.before.pluginSettings[s.id] ?? {};
      scope.add(`restore-config:${s.id}`, () => io.replacePluginConfig(s.id, prev));
      await io.setPluginConfig(s.id, s.patch);
    }
  } catch (e) {
    const { failed } = await scope.disposeAll();
    throw new ProfileApplyError("场景应用失败，已撤回", failed, e);
  }
}

/** 回到应用前。显式用户动作；失败要报条数，不能装作成功。 */
export async function revertProfileState(
  before: ProfileBefore,
  io: ProfileIo,
  currentRoots: Record<string, string>,
): Promise<{ failed: number; errors: string[] }> {
  const errors: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}：${String((e as Error)?.message ?? e)}`);
    }
  };

  await step("恢复启用集", () => io.setEnabledSet(before.enabled));
  await step("恢复主题", () => io.setActiveTheme(before.settings.activeTheme));
  await step("恢复工作区", () => io.setWorkspaceRoot(before.settings.workspaceRoot));
  for (const key of Object.keys(currentRoots)) {
    if (!(key in before.settings.roots)) await step(`解绑 ${key}`, () => io.setExternalRoot(key, ""));
  }
  for (const [key, value] of Object.entries(before.settings.roots)) {
    await step(`恢复 ${key}`, () => io.setExternalRoot(key, value));
  }
  for (const [id, values] of Object.entries(before.pluginSettings)) {
    await step(`恢复配置 ${id}`, () => io.replacePluginConfig(id, values));
  }
  return { failed: errors.length, errors };
}

/* ============================ 归一（磁盘上的普通 JSON） ============================ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function normalizePatch(raw: unknown, issues: string[], where: string): WorkProfilePatch {
  const out: WorkProfilePatch = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    issues.push(`${where} 的补丁不是对象，已忽略`);
    return out;
  }
  if (raw.settings !== undefined) {
    if (!isObj(raw.settings)) issues.push(`${where} 的插件补丁不是对象，已忽略`);
    else {
      const ext: NonNullable<WorkProfilePatch["settings"]> = {};
      if ("activeTheme" in raw.settings) {
        const v = raw.settings.activeTheme;
        if (v === null || typeof v === "string") ext.activeTheme = v;
        else issues.push(`${where} 的主题补丁不是字符串/null，已忽略`);
      }
      if ("workspaceRoot" in raw.settings) {
        const v = raw.settings.workspaceRoot;
        if (v === null || typeof v === "string") ext.workspaceRoot = v;
        else issues.push(`${where} 的工作区补丁不是字符串/null，已忽略`);
      }
      if (raw.settings.roots !== undefined) {
        if (!isObj(raw.settings.roots)) issues.push(`${where} 的外部目录补丁不是对象，已忽略`);
        else {
          const roots: Record<string, string | null> = {};
          for (const [k, v] of Object.entries(raw.settings.roots)) {
            if (!ROOT_KEY_RE.test(k)) {
              issues.push(`${where} 的外部目录键「${k}」不合规，已忽略`);
              continue;
            }
            if (v === null || typeof v === "string") roots[k] = v;
            else issues.push(`${where} 的外部目录「${k}」不是字符串/null，已忽略`);
          }
          ext.roots = roots;
        }
      }
      out.settings = ext;
    }
  }
  if (raw.pluginSettings !== undefined) {
    if (!isObj(raw.pluginSettings)) issues.push(`${where} 的插件配置补丁不是对象，已忽略`);
    else {
      const ps: Record<string, Record<string, unknown>> = {};
      for (const [id, patch] of Object.entries(raw.pluginSettings)) {
        if (!ID_RE.test(id)) {
          issues.push(`${where} 的插件配置键「${id}」不合规，已忽略`);
          continue;
        }
        if (!isObj(patch)) {
          issues.push(`${where} 的插件配置「${id}」不是对象，已忽略`);
          continue;
        }
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (isPrimitive(v)) clean[k] = v;
          else issues.push(`${where} 的配置项「${id}.${k}」不是基本值，已忽略`);
        }
        ps[id] = clean;
      }
      out.pluginSettings = ps;
    }
  }
  return out;
}

function normalizeBefore(raw: unknown, issues: string[], where: string): ProfileBefore | null {
  if (!isObj(raw)) return null;
  const enabledRaw = raw.enabled;
  if (!Array.isArray(enabledRaw) || enabledRaw.some((x) => typeof x !== "string")) {
    issues.push(`${where} 的启用快照形状不对，已丢弃`);
    return null;
  }
  const ext = raw.settings;
  if (!isObj(ext) || typeof ext.activeTheme !== "string" || typeof ext.workspaceRoot !== "string" || !isObj(ext.roots)) {
    issues.push(`${where} 的插件快照形状不对，已丢弃`);
    return null;
  }
  const roots: Record<string, string> = {};
  for (const [k, v] of Object.entries(ext.roots)) if (typeof v === "string") roots[k] = v;
  const ps: Record<string, Record<string, unknown>> = {};
  if (raw.pluginSettings !== undefined) {
    if (!isObj(raw.pluginSettings)) {
      issues.push(`${where} 的配置快照形状不对，已丢弃`);
      return null;
    }
    for (const [id, values] of Object.entries(raw.pluginSettings)) {
      if (!isObj(values)) continue;
      ps[id] = { ...values };
    }
  }
  return {
    enabled: enabledRaw as string[],
    settings: { activeTheme: ext.activeTheme, workspaceRoot: ext.workspaceRoot, roots },
    pluginSettings: ps,
  };
}

export function normalizeProfile(raw: unknown, pos: number, issues: string[]): WorkProfile | null {
  const where = `场景第 ${pos + 1} 条`;
  if (!isObj(raw)) {
    issues.push(`${where} 不是对象，已跳过`);
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!ID_RE.test(id)) {
    issues.push(`${where}的 id${id ? `「${id}」` : ""}不合规，已跳过`);
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  if (!name) {
    issues.push(`${where}缺名字，已跳过`);
    return null;
  }
  if (!Array.isArray(raw.plugins)) {
    issues.push(`${where}缺启用集，已跳过`);
    return null;
  }
  const plugins: WorkProfilePluginRef[] = [];
  for (const p of raw.plugins.slice(0, MAX_PROFILE_PLUGINS)) {
    if (isObj(p) && typeof p.id === "string" && ID_RE.test(p.id)) plugins.push({ id: p.id });
    else issues.push(`${where} 的插件项不合规，已跳过那一项`);
  }
  return {
    id,
    name,
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim().slice(0, 200) } : {}),
    plugins,
    patch: normalizePatch(raw.patch, issues, where),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

/** 归一。坏条目逐条丢弃并说清楚；`applied` 读不出来时宁可让 activeId 归零，也不留一个回不去的场景。 */
export function normalizeProfiles(raw: unknown): { book: ProfilesBook; issues: string[] } {
  const issues: string[] = [];
  if (raw === null || raw === undefined) return { book: emptyProfilesBook(), issues };
  if (!isObj(raw)) return { book: emptyProfilesBook(), issues: ["场景账本不是预期形状，已按空账本启动"] };
  if (raw.version !== PROFILES_VERSION) {
    return {
      book: emptyProfilesBook(),
      issues: [`场景账本版本是 ${String(raw.version)}，当前只认 ${PROFILES_VERSION}，已按空账本启动`],
    };
  }
  if (!Array.isArray(raw.profiles)) {
    return { book: emptyProfilesBook(), issues: ["场景账本缺 profiles 表，已按空账本启动"] };
  }
  const profiles: WorkProfile[] = [];
  const seen = new Set<string>();
  raw.profiles.slice(0, MAX_PROFILES).forEach((p, i) => {
    const norm = normalizeProfile(p, i, issues);
    if (!norm) return;
    if (seen.has(norm.id)) {
      issues.push(`场景 id「${norm.id}」重复，已跳过后一条`);
      return;
    }
    seen.add(norm.id);
    profiles.push(norm);
  });
  if (raw.profiles.length > MAX_PROFILES) issues.push(`场景超过 ${MAX_PROFILES} 个，多出的已跳过`);

  let activeId = typeof raw.activeId === "string" ? raw.activeId : "";
  if (activeId && !seen.has(activeId)) {
    issues.push(`活动场景「${activeId}」不存在，已清空`);
    activeId = "";
  }
  let applied: ProfilesBook["applied"];
  if (raw.applied !== undefined) {
    if (!isObj(raw.applied) || typeof raw.applied.id !== "string") {
      issues.push("场景的应用前快照形状不对，已丢弃（无法再回到应用前）");
      activeId = "";
    } else {
      const before = normalizeBefore(raw.applied.before, issues, "场景的应用前快照");
      if (!before) {
        activeId = "";
      } else {
        applied = {
          id: raw.applied.id,
          at: typeof raw.applied.at === "number" ? raw.applied.at : 0,
          before,
        };
      }
    }
  }
  if (activeId && !applied) {
    issues.push(`活动场景「${activeId}」没有可用的应用前快照，已清空活动状态`);
    activeId = "";
  }
  return {
    book: {
      version: PROFILES_VERSION,
      profiles,
      activeId,
      ...(applied ? { applied } : {}),
    },
    issues,
  };
}
