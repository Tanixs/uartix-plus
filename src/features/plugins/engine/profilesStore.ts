/**
 * P174-B2：Profile 的 IO 与编排层。
 *
 * 纯判据在 `profiles.ts`；这里只做四件事：从盘上读、把计划接到 pluginEngine、把结果写回、
 * 通知界面。**任何一步失败都不能留下"半应用"的场景**——执行器在 `profiles.ts` 里用
 * `createScope` 逆序撤销，这一层负责在成功后落 `activeId`/应用前快照。
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pluginRootKeys } from "./manifest";
import {
  ensureLoaded as ensureExtLoaded,
  getSnapshot as getExtSnapshot,
  recordProfileEvent,
  replacePluginConfig,
  setActiveTheme,
  setEnabledSet,
  setExternalRoot,
  setPluginConfig,
  setWorkspaceRoot,
} from "./pluginEngine";
import { loadProfiles, saveProfiles } from "./store";
import {
  applyProfilePlan,
  emptyProfilesBook,
  normalizeProfile,
  planProfileApply,
  revertProfileState,
  type WorkProfile,
  type ProfileIo,
  type ProfilePluginFact,
  type ProfilesBook,
} from "./profiles";

export interface ProfilesState {
  loading: boolean;
  book: ProfilesBook;
  issues: string[];
}

let state: ProfilesState = { loading: true, book: emptyProfilesBook(), issues: [] };
let root: string | null = null;
let loadingPromise: Promise<void> | null = null;
const subs = new Set<() => void>();

function emit(): void {
  state = { ...state, book: { ...state.book, profiles: state.book.profiles.slice() }, issues: state.issues.slice() };
  for (const f of subs) f();
}

export function subscribeProfiles(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getProfiles(): ProfilesState {
  return state;
}

export function useProfiles(): ProfilesState {
  return useSyncExternalStore(subscribeProfiles, getProfiles, getProfiles);
}

async function resolveRoot(): Promise<string> {
  if (root) return root;
  const p = await invoke<{ pluginsRoot: string }>("plugin_paths");
  root = p.pluginsRoot;
  return root;
}

export async function ensureProfilesLoaded(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    state = { ...state, loading: true };
    emit();
    const issues: string[] = [];
    try {
      await ensureExtLoaded();
      const r = await loadProfiles([await resolveRoot()]);
      state = { loading: false, book: r.book, issues: [...issues, ...r.issues] };
    } catch (e) {
      state = {
        loading: false,
        book: emptyProfilesBook(),
        issues: [...issues, `读取场景失败：${String((e as Error)?.message ?? e)}`],
      };
    }
    emit();
  })().finally(() => {
    loadingPromise = null;
  });
  return loadingPromise;
}

async function persist(next: ProfilesBook): Promise<void> {
  await saveProfiles(next, [await resolveRoot()]);
  state = { ...state, book: next };
  emit();
}

function io(): ProfileIo {
  return {
    setEnabledSet,
    setActiveTheme,
    setWorkspaceRoot,
    setExternalRoot,
    setPluginConfig,
    replacePluginConfig,
  };
}

function newId(): string {
  const taken = new Set(state.book.profiles.map((p) => p.id));
  const base = `p-${Date.now().toString(36)}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

function makeProfile(name: string, note?: string): WorkProfile {
  const now = Date.now();
  return {
    id: newId(),
    name: name.trim().slice(0, 40) || "未命名场景",
    ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}),
    plugins: [],
    patch: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** 用当前已启用插件 + 当前插件状态/配置造一个场景（不改变任何状态）。 */
export function captureCurrentProfile(name: string): WorkProfile {
  const repo = getExtSnapshot();
  const profile = makeProfile(name);
  profile.plugins = repo.entries.filter((e) => e.enabled).map((e) => ({ id: e.id }));
  profile.patch = {
    settings: {
      activeTheme: repo.activeTheme,
      workspaceRoot: repo.workspaceRoot,
      roots: { ...repo.roots },
    },
    ...(repo.entries.some((e) => Object.keys(e.config).length)
      ? {
          pluginSettings: Object.fromEntries(
            repo.entries.filter((e) => Object.keys(e.config).length).map((e) => [e.id, { ...e.config }]),
          ),
        }
      : {}),
  };
  return profile;
}

export async function saveProfile(profile: WorkProfile): Promise<void> {
  await ensureProfilesLoaded();
  const issues: string[] = [];
  const norm = normalizeProfile({ ...profile, updatedAt: Date.now() }, 0, issues);
  if (!norm) throw new Error(issues[0] ?? "场景形状不合法");
  const exists = state.book.profiles.some((p) => p.id === norm.id);
  const profiles = exists
    ? state.book.profiles.map((p) => (p.id === norm.id ? { ...norm, createdAt: p.createdAt } : p))
    : [...state.book.profiles, norm];
  await persist({ ...state.book, profiles });
}

export async function createProfile(name: string): Promise<string> {
  await ensureProfilesLoaded();
  if (state.book.profiles.length >= 100) throw new Error("场景数量已达上限（100）");
  const profile = makeProfile(name);
  await persist({ ...state.book, profiles: [...state.book.profiles, profile] });
  return profile.id;
}

export async function saveCurrentAsProfile(name: string): Promise<string> {
  await ensureProfilesLoaded();
  if (state.book.profiles.length >= 100) throw new Error("场景数量已达上限（100）");
  const profile = captureCurrentProfile(name);
  await persist({ ...state.book, profiles: [...state.book.profiles, profile] });
  return profile.id;
}

export async function duplicateProfile(id: string): Promise<string> {
  await ensureProfilesLoaded();
  const src = state.book.profiles.find((p) => p.id === id);
  if (!src) throw new Error("没有这个场景");
  if (state.book.profiles.length >= 100) throw new Error("场景数量已达上限（100）");
  const now = Date.now();
  const copy: WorkProfile = {
    ...structuredClone(src),
    id: newId(),
    name: `${src.name} 副本`.slice(0, 40),
    createdAt: now,
    updatedAt: now,
  };
  await persist({ ...state.book, profiles: [...state.book.profiles, copy] });
  return copy.id;
}

export async function deleteProfile(id: string): Promise<void> {
  await ensureProfilesLoaded();
  if (state.book.activeId === id) throw new Error("这个场景正在使用中，先「回到应用前」再删除");
  await persist({ ...state.book, profiles: state.book.profiles.filter((p) => p.id !== id) });
}

/** 当前世界 → 计划的事实表。 */
function facts(): ProfilePluginFact[] {
  return getExtSnapshot().entries.map((e) => ({
    id: e.id,
    enabled: e.enabled,
    verdict: e.verdict,
    fields: e.manifest.contributes.settings ?? [],
    config: e.config,
  }));
}

function world(): {
  activeTheme: string;
  workspaceRoot: string;
  roots: Record<string, string>;
  themes: string[];
  rootKeys: string[];
} {
  const repo = getExtSnapshot();
  const themeKeys = repo.entries.flatMap((e) => e.themes.map((t) => t.key));
  const rootKeys = [...new Set(repo.entries.flatMap((e) => pluginRootKeys(e.manifest)))].sort();
  return {
    activeTheme: repo.activeTheme,
    workspaceRoot: repo.workspaceRoot,
    roots: { ...repo.roots },
    themes: themeKeys,
    rootKeys,
  };
}

export interface ProfileApplyResult {
  warnings: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * 应用场景。若已有别的场景在生效，先回退它——不允许两个 patch 叠加后丢失原始状态。
 * 未批准插件由纯计划跳过，这里不提供任何绕过批准卡的入口。
 */
export async function applyProfile(id: string): Promise<ProfileApplyResult> {
  await ensureProfilesLoaded();
  const profile = state.book.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("没有这个场景");

  if (state.book.activeId && state.book.activeId !== id) {
    await revertActiveProfile();
  }

  const planned = planProfileApply(profile, facts(), world());
  if (!planned.ok) throw new Error(planned.errors.join("；"));
  await applyProfilePlan(planned.plan, io());

  const alreadyActive = state.book.activeId === id && state.book.applied;
  if (!alreadyActive) {
    await persist({
      ...state.book,
      activeId: id,
      applied: { id, at: Date.now(), before: planned.plan.before },
    });
  }
  await recordProfileEvent(id, profile.name, "apply");
  return { warnings: planned.plan.warnings, skipped: planned.plan.skipped };
}

/** 回到应用前。失败时保留 activeId，让用户能重试（不装作成功）。 */
export async function revertActiveProfile(): Promise<void> {
  await ensureProfilesLoaded();
  const applied = state.book.applied;
  if (!applied) throw new Error("当前没有可回退的场景");
  const repo = getExtSnapshot();
  const r = await revertProfileState(applied.before, io(), { ...repo.roots });
  if (r.failed) {
    throw new Error(`回退有 ${r.failed} 步失败：${r.errors.slice(0, 4).join("；")}`);
  }
  const profile = state.book.profiles.find((p) => p.id === applied.id);
  await recordProfileEvent(applied.id, profile?.name ?? applied.id, "revert");
  const next: ProfilesBook = { ...state.book, activeId: "" };
  delete next.applied;
  await persist(next);
}

/** 给界面预览用：不执行，只算会改什么。 */
export function previewProfile(id: string): ReturnType<typeof planProfileApply> {
  const profile = state.book.profiles.find((p) => p.id === id);
  if (!profile) return { ok: false, errors: ["没有这个场景"] };
  return planProfileApply(profile, facts(), world());
}

/** 预览**编辑中的草稿**（尚未保存）；判据与真正应用完全相同。 */
export function previewProfileDraft(profile: WorkProfile): ReturnType<typeof planProfileApply> {
  return planProfileApply(profile, facts(), world());
}
