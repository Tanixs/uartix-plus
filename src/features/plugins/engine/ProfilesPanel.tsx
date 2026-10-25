/**
 * P174-B2：工作场景（Profile）面板。
 *
 * 这一面只做「保存一组工作状态 / 一键切过去 / 一键回到应用前」。它不改变旧插件管理的视觉，
 * 也不把场景硬塞进某个已有页面——场景是横跨插件、主题、目录与配置的东西，单独一面最诚实。
 *
 * 所有写操作都先过纯计划（`previewProfileDraft`）：按钮旁边就能看见"会启用谁、停用谁、
 * 改哪些配置、谁因为没批准被跳过"，不是点完才知道。
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import { pluginRootKeys } from "./manifest";
import { getSnapshot as getPluginEngineSnapshot, ensureLoaded as ensureExtLoaded, subscribe } from "./pluginEngine";
import {
  applyProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  ensureProfilesLoaded,
  getProfiles,
  previewProfileDraft,
  revertActiveProfile,
  saveCurrentAsProfile,
  saveProfile,
  useProfiles,
} from "./profilesStore";
import type { WorkProfile } from "./profiles";

function clone(p: WorkProfile): WorkProfile {
  return structuredClone(p);
}

function Section(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: "var(--sp-4)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
        <span style={{ fontWeight: 600, fontSize: "var(--fs-sm)" }}>{props.title}</span>
        {props.hint ? <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{props.hint}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function FieldShell(props: { label: string; children: ReactNode; note?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
        {props.label}
        {props.note ? <span style={{ marginLeft: 6, color: "var(--text-faint)" }}>{props.note}</span> : null}
      </span>
      {props.children}
    </div>
  );
}

const btn = (primary = false): CSSProperties => ({
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: primary ? "var(--accent)" : "var(--bg-panel)",
  color: primary ? "var(--on-accent)" : "var(--text)",
  padding: "5px 10px",
  fontSize: "var(--fs-xs)",
  cursor: "pointer",
});

const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--panel)",
  padding: "var(--sp-3)",
};

export function ProfilesPanel(props: { /** 已经在设置页里（页头由应用给），不再重复标题与说明。 */ embedded?: boolean } = {}) {
  useLocale();
  const ps = useProfiles();
  const repo = useSyncExternalStore(subscribe, getPluginEngineSnapshot, getPluginEngineSnapshot);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<WorkProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  useEffect(() => {
    void ensureProfilesLoaded();
    void ensureExtLoaded();
  }, []);

  useEffect(() => {
    if (ps.loading || selected || !ps.book.profiles.length) return;
    selectProfile(ps.book.activeId || ps.book.profiles[0].id);
    // selectProfile 只依赖当前 book；这里刻意只在"首次可用"时自动选一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.loading, ps.book.profiles.length, ps.book.activeId, selected]);

  function selectProfile(id: string) {
    // 用 store 的最新快照：刚创建/保存的场景不可能出现在本次 render 闭包的 ps 里
    const p = getProfiles().book.profiles.find((x) => x.id === id);
    setSelected(id);
    setDraft(p ? clone(p) : null);
    setDirty(false);
    setConfirmDelete("");
    setError("");
    setNotice("");
  }

  function update(fn: (p: WorkProfile) => void) {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = clone(cur);
      fn(next);
      return next;
    });
    setDirty(true);
    setNotice("");
  }

  const preview = draft ? previewProfileDraft(draft) : null;

  const rootKeyList = useMemo(
    () => [...new Set(repo.entries.flatMap((e) => pluginRootKeys(e.manifest)))].sort(),
    [repo.entries],
  );

  const themeOptions = useMemo(
    () => repo.entries.flatMap((e) => e.themes.map((t) => ({ key: t.key, title: `${e.manifest.name} · ${t.title}` }))),
    [repo.entries],
  );

  async function doSave(): Promise<void> {
    if (!draft) return;
    setBusy("save");
    setError("");
    try {
      await saveProfile(draft);
      setDirty(false);
      setNotice(tx("场景已保存", "Workspace saved"));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doApply(): Promise<void> {
    if (!draft) return;
    setBusy("apply");
    setError("");
    setNotice("");
    try {
      if (dirty) await saveProfile(draft);
      setDirty(false);
      const r = await applyProfile(draft.id);
      setNotice(
        r.warnings.length
          ? tx(`场景已应用；${r.warnings.join("；")}`, `Workspace applied; ${r.warnings.join("; ")}`)
          : tx("场景已应用", "Workspace applied"),
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doRevert(): Promise<void> {
    setBusy("revert");
    setError("");
    setNotice("");
    try {
      await revertActiveProfile();
      setNotice(tx("已回到应用前", "Back to the state before applying"));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doSaveCurrent(): Promise<void> {
    setBusy("capture");
    setError("");
    try {
      const name = tx(`场景 ${ps.book.profiles.length + 1}`, `Workspace ${ps.book.profiles.length + 1}`);
      const id = await saveCurrentAsProfile(name);
      selectProfile(id);
      setNotice(tx("已把当前状态保存成场景", "Current state saved as a workspace"));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doNew(): Promise<void> {
    setBusy("new");
    setError("");
    try {
      const id = await createProfile(tx(`场景 ${ps.book.profiles.length + 1}`, `Workspace ${ps.book.profiles.length + 1}`));
      selectProfile(id);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doDuplicate(): Promise<void> {
    if (!selected) return;
    setBusy("dup");
    setError("");
    try {
      const id = await duplicateProfile(selected);
      selectProfile(id);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doDelete(): Promise<void> {
    if (!selected) return;
    if (confirmDelete !== selected) {
      setConfirmDelete(selected);
      return;
    }
    setBusy("del");
    setError("");
    try {
      await deleteProfile(selected);
      setConfirmDelete("");
      const rest = getProfiles().book.profiles.filter((p) => p.id !== selected);
      if (rest.length) selectProfile(rest[0].id);
      else {
        setSelected("");
        setDraft(null);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function pickWorkspace(): Promise<void> {
    if (!draft) return;
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: tx("选择这个场景的工作区根", "Pick the workspace root for this scene"),
      });
      if (typeof dir === "string" && dir) {
        update((p) => {
          p.patch.settings = { ...(p.patch.settings ?? {}), workspaceRoot: dir };
        });
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  const activeId = ps.book.activeId;
  const activeName = ps.book.profiles.find((p) => p.id === activeId)?.name ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-3)",
          borderBottom: "1px solid var(--border)",
          flex: "0 0 auto",
          flexWrap: "wrap",
        }}
      >
        {props.embedded ? null : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 600 }}>{tx("工作场景", "Profiles")}</span>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
              {tx(
                "一份场景 = 一组有序启用的插件 + 主题/目录/配置补丁。应用前会先给你看会改什么。",
                "A workspace is an ordered plugin set plus theme/path/config patches. You see what will change before applying.",
              )}
            </span>
          </div>
        )}
        <span style={{ flex: 1 }} />
        {activeId ? (
          <span
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--accent)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-pill)",
              padding: "2px 8px",
            }}
          >
            {tx(`使用中：${activeName}`, `Active: ${activeName}`)}
          </span>
        ) : null}
        <button style={btn()} disabled={!!busy} onClick={() => void doRevert()} title={tx("恢复应用前的插件启停、主题、目录与配置", "Restore enabled plugins, theme, paths and config from before applying")}>
          {tx("回到应用前", "Undo apply")}
        </button>
        <button style={btn()} disabled={!!busy} onClick={() => void doSaveCurrent()}>
          {tx("保存当前为场景", "Save current as workspace")}
        </button>
        <button style={btn()} disabled={!!busy} onClick={() => void doNew()}>
          {tx("新建场景", "New workspace")}
        </button>
      </header>

      {error ? (
        <div style={{ padding: "var(--sp-2) var(--sp-3)", color: "var(--danger)", fontSize: "var(--fs-xs)", borderBottom: "1px solid var(--border)" }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div style={{ padding: "var(--sp-2) var(--sp-3)", color: "var(--text-dim)", fontSize: "var(--fs-xs)", borderBottom: "1px solid var(--border)" }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <aside style={{ width: 270, flex: "0 0 auto", borderRight: "1px solid var(--border)", overflow: "auto", padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          {ps.loading ? <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-xs)" }}>{tx("正在读取…", "Loading…")}</div> : null}
          {!ps.loading && !ps.book.profiles.length ? (
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
              {tx("还没有场景。点右上角「保存当前为场景」，或新建一份。", "No workspaces yet. Use “Save current as workspace” or create one.")}
            </div>
          ) : null}
          {ps.book.profiles.map((p) => {
            const on = p.id === selected;
            return (
              <button
                key={p.id}
                onClick={() => selectProfile(p.id)}
                style={{
                  ...card,
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: on ? "var(--accent)" : "var(--border)",
                  background: on ? "var(--bg-hover)" : "var(--panel)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: "var(--fs-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  {p.id === activeId ? <span style={{ fontSize: "var(--fs-xs)", color: "var(--accent)" }}>{tx("使用中", "active")}</span> : null}
                </span>
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>
                  {tx(`${p.plugins.length} 个插件`, `${p.plugins.length} plugin(s)`)}
                  {p.patch.settings?.activeTheme ? ` · ${tx("带主题", "theme")}` : ""}
                </span>
                {p.note ? <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.note}</span> : null}
              </button>
            );
          })}
          {ps.issues.length ? (
            <div style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-xs)", color: "var(--warn)", lineHeight: 1.5 }}>
              {ps.issues.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
          ) : null}
        </aside>

        <main style={{ flex: "1 1 auto", minWidth: 0, overflow: "auto", padding: "var(--sp-3)" }}>
          {!draft ? (
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", padding: "var(--sp-4)" }}>
              {tx("从左边选一个场景，或者新建一份。", "Pick a workspace on the left, or create one.")}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "1 1 260px" }}>
                  <label style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{tx("名字", "Name")}</label>
                  <input
                    className="input"
                    value={draft.name}
                    maxLength={40}
                    onChange={(e) => update((p) => (p.name = e.target.value))}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "2 1 320px" }}>
                  <label style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{tx("备注（可选）", "Note (optional)")}</label>
                  <input
                    className="input"
                    value={draft.note ?? ""}
                    maxLength={200}
                    onChange={(e) =>
                      update((p) => {
                        const v = e.target.value.trim();
                        if (v) p.note = v;
                        else delete p.note;
                      })
                    }
                  />
                </div>
                <button style={btn()} disabled={!!busy || !dirty} onClick={() => void doSave()}>
                  {tx("保存", "Save")}
                </button>
                <button style={btn(true)} disabled={!!busy} onClick={() => void doApply()}>
                  {busy === "apply" ? tx("应用中…", "Applying…") : tx("应用这个场景", "Apply workspace")}
                </button>
                <button style={btn()} disabled={!!busy} onClick={() => void doDuplicate()}>
                  {tx("复制", "Duplicate")}
                </button>
                <button
                  style={{ ...btn(), color: confirmDelete === selected ? "var(--danger)" : "var(--text)" }}
                  disabled={!!busy}
                  onClick={() => void doDelete()}
                >
                  {confirmDelete === selected ? tx("再点一次确认删除", "Click again to delete") : tx("删除", "Delete")}
                </button>
              </div>

              <Section title={tx("插件（按启用顺序）", "Plugins (enabled order)")} hint={tx("勾选 = 这个场景启用它；未勾选的已启用插件会在应用时停用", "Checked = enabled by this workspace; enabled plugins not checked will be disabled")}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[...draft.plugins.map((p) => p.id), ...repo.entries.filter((e) => !draft.plugins.some((p) => p.id === e.id)).map((e) => e.id)].map((id) => {
                    const entry = repo.entries.find((e) => e.id === id);
                    if (!entry) return null;
                    const pos = draft.plugins.findIndex((p) => p.id === id);
                    const on = pos >= 0;
                    return (
                      <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: on ? "var(--panel)" : "transparent" }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            update((p) => {
                              if (e.target.checked) p.plugins.push({ id });
                              else p.plugins = p.plugins.filter((x) => x.id !== id);
                            })
                          }
                          aria-label={entry.manifest.name}
                        />
                        <span style={{ fontWeight: 500, fontSize: "var(--fs-sm)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.manifest.name}</span>
                        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>{entry.id} · v{entry.version}</span>
                        {entry.verdict !== "trusted" ? (
                          <span style={{ fontSize: "var(--fs-xs)", color: "var(--warn)" }}>{tx("未批准：场景不会替你启用", "not approved: scene will skip it")}</span>
                        ) : null}
                        <span style={{ flex: 1 }} />
                        {on ? (
                          <>
                            <button
                              style={btn()}
                              disabled={pos <= 0}
                              onClick={() => update((p) => {
                                const arr = p.plugins;
                                [arr[pos - 1], arr[pos]] = [arr[pos], arr[pos - 1]];
                              })}
                              aria-label={tx("上移", "Move up")}
                            >
                              ↑
                            </button>
                            <button
                              style={btn()}
                              disabled={pos >= draft.plugins.length - 1}
                              onClick={() => update((p) => {
                                const arr = p.plugins;
                                [arr[pos + 1], arr[pos]] = [arr[pos], arr[pos + 1]];
                              })}
                              aria-label={tx("下移", "Move down")}
                            >
                              ↓
                            </button>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                  {!repo.entries.length ? <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{tx("还没装插件。", "No plugins installed yet.")}</div> : null}
                </div>
              </Section>

              <Section title={tx("外观与目录", "Appearance & paths")} hint={tx("只写这里出现的键；其余保持现状", "Only keys shown here are changed")}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--sp-2)" }}>
                  <FieldShell label={tx("插件主题", "Plugin theme")}>
                    <select
                      className="input"
                      value={
                        !draft.patch.settings || !("activeTheme" in draft.patch.settings)
                          ? "__keep"
                          : !draft.patch.settings.activeTheme
                            ? "__builtin"
                            : draft.patch.settings.activeTheme
                      }
                      onChange={(e) =>
                        update((p) => {
                          p.patch.settings = { ...(p.patch.settings ?? {}) };
                          if (e.target.value === "__keep") delete p.patch.settings.activeTheme;
                          else p.patch.settings.activeTheme = e.target.value === "__builtin" ? "" : e.target.value;
                        })
                      }
                    >
                      <option value="__keep">{tx("保持现状", "Keep current")}</option>
                      <option value="__builtin">{tx("内置主题", "Built-in theme")}</option>
                      {themeOptions.map((t) => (
                        <option key={t.key} value={t.key}>{t.title}</option>
                      ))}
                    </select>
                  </FieldShell>
                  <FieldShell label={tx("工作区根（$WS）", "Workspace root ($WS)")} note={tx("留空 = 清空", "empty = clear")}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        className="input"
                        value={!draft.patch.settings || !("workspaceRoot" in draft.patch.settings) ? "__keep" : "__set"}
                        onChange={(e) =>
                          update((p) => {
                            p.patch.settings = { ...(p.patch.settings ?? {}) };
                            if (e.target.value === "__keep") delete p.patch.settings.workspaceRoot;
                            else if (!("workspaceRoot" in p.patch.settings)) {
                              p.patch.settings.workspaceRoot = repo.workspaceRoot;
                            }
                          })
                        }
                        style={{ flex: "0 0 92px" }}
                      >
                        <option value="__keep">{tx("保持", "keep")}</option>
                        <option value="__set">{tx("设置", "set")}</option>
                      </select>
                      {draft.patch.settings && "workspaceRoot" in draft.patch.settings ? (
                        <>
                          <input
                            className="input"
                            value={draft.patch.settings.workspaceRoot ?? ""}
                            placeholder={tx("绝对路径；留空 = 清空", "absolute path; empty = clear")}
                            onChange={(e) => update((p) => {
                              p.patch.settings = { ...(p.patch.settings ?? {}) };
                              p.patch.settings.workspaceRoot = e.target.value;
                            })}
                          />
                          <button style={btn()} onClick={() => void pickWorkspace()}>{tx("选择…", "Pick…")}</button>
                        </>
                      ) : null}
                    </div>
                  </FieldShell>
                </div>

                {rootKeyList.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--sp-2)", marginTop: "var(--sp-2)" }}>
                    {rootKeyList.map((key) => {
                      const roots = draft.patch.settings?.roots ?? {};
                      const has = Object.prototype.hasOwnProperty.call(roots, key);
                      const v = roots[key];
                      const mode = !has ? "inherit" : v === null ? "unbind" : "bind";
                      return (
                        <FieldShell key={key} label={`$EXT:${key}`}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <select
                              className="input"
                              value={mode}
                              onChange={(e) => update((p) => {
                                p.patch.settings = { ...(p.patch.settings ?? {}) };
                                const next = { ...(p.patch.settings.roots ?? {}) };
                                if (e.target.value === "inherit") delete next[key];
                                else if (e.target.value === "unbind") next[key] = null;
                                else next[key] = repo.roots[key] ?? "";
                                p.patch.settings.roots = next;
                              })}
                              style={{ flex: "0 0 96px" }}
                            >
                              <option value="inherit">{tx("保持", "keep")}</option>
                              <option value="bind">{tx("绑定", "bind")}</option>
                              <option value="unbind">{tx("解绑", "unbind")}</option>
                            </select>
                            {mode === "bind" ? (
                              <input
                                className="input"
                                value={typeof v === "string" ? v : ""}
                                placeholder={tx("绝对路径", "absolute path")}
                                onChange={(e) => update((p) => {
                                  p.patch.settings = { ...(p.patch.settings ?? {}) };
                                  p.patch.settings.roots = { ...(p.patch.settings.roots ?? {}), [key]: e.target.value };
                                })}
                              />
                            ) : null}
                          </div>
                        </FieldShell>
                      );
                    })}
                  </div>
                ) : null}
              </Section>

              {draft.plugins.some((p) => (repo.entries.find((e) => e.id === p.id)?.manifest.contributes.settings?.length ?? 0) > 0) ? (
                <Section title={tx("插件配置", "Plugin settings")} hint={tx("「默认」= 应用时删掉覆盖值；什么都不选 = 保持现状", "“Default” removes the override; untouched = keep current")}>
                  {draft.plugins.map((p) => {
                    const entry = repo.entries.find((e) => e.id === p.id);
                    const fields = entry?.manifest.contributes.settings ?? [];
                    if (!entry || !fields.length) return null;
                    return (
                      <div key={p.id} style={{ ...card, marginBottom: "var(--sp-2)" }}>
                        <div style={{ fontWeight: 600, fontSize: "var(--fs-sm)", marginBottom: "var(--sp-2)" }}>{entry.manifest.name}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-2)" }}>
                          {fields.map((f) => {
                            const patch = draft.patch.pluginSettings?.[p.id] ?? {};
                            const has = Object.prototype.hasOwnProperty.call(patch, f.key);
                            const raw = has ? patch[f.key] : undefined;
                            const v = raw === null || raw === undefined ? entry.config[f.key] ?? f.default : raw;
                            return (
                              <FieldShell key={f.key} label={f.label || f.key} note={raw === null ? tx("应用时恢复默认", "reset to default on apply") : `${f.key} · ${f.type}`}>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                  {f.type === "boolean" ? (
                                    <input
                                      type="checkbox"
                                      checked={Boolean(v)}
                                      onChange={(e) => setSetting(p.id, f.key, e.target.checked)}
                                    />
                                  ) : f.type === "enum" ? (
                                    <select className="input" value={String(v)} onChange={(e) => setSetting(p.id, f.key, e.target.value)}>
                                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  ) : (
                                    <input
                                      className="input"
                                      type={f.type === "number" ? "number" : "text"}
                                      value={String(v)}
                                      min={f.min}
                                      max={f.max}
                                      onChange={(e) => setSetting(p.id, f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
                                    />
                                  )}
                                  <button style={btn()} onClick={() => setSetting(p.id, f.key, null)} title={tx("应用时删除覆盖，回落清单默认值", "Remove the override on apply; fall back to the manifest default")}>
                                    {tx("默认", "Default")}
                                  </button>
                                </div>
                              </FieldShell>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </Section>
              ) : null}

              <Section title={tx("应用预览", "Apply preview")}>
                <div style={{ ...card, display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--fs-xs)", lineHeight: 1.6 }}>
                  {!preview ? null : preview.ok ? (
                    <>
                      <div>
                        {tx("启用：", "Enable: ")}
                        {preview.plan.toEnable.length ? preview.plan.toEnable.join("、") : tx("（无）", "(none)")}
                      </div>
                      <div>
                        {tx("停用：", "Disable: ")}
                        {preview.plan.toDisable.length ? preview.plan.toDisable.join("、") : tx("（无）", "(none)")}
                      </div>
                      <div>
                        {tx("改动：", "Changes: ")}
                        {[
                          preview.plan.extensionPatch.activeTheme !== undefined ? tx("主题", "theme") : "",
                          preview.plan.extensionPatch.workspaceRoot !== undefined ? tx("工作区根", "workspace root") : "",
                          preview.plan.extensionPatch.roots.length ? tx(`${preview.plan.extensionPatch.roots.length} 个外部目录`, `${preview.plan.extensionPatch.roots.length} external path(s)`) : "",
                          preview.plan.settings.length ? tx(`${preview.plan.settings.length} 个插件的配置`, `config for ${preview.plan.settings.length} plugin(s)`) : "",
                        ].filter(Boolean).join("、") || tx("（无）", "(none)")}
                      </div>
                      {preview.plan.warnings.map((w, i) => (
                        <div key={i} style={{ color: "var(--warn)" }}>· {w}</div>
                      ))}
                    </>
                  ) : (
                    preview.errors.map((e, i) => <div key={i} style={{ color: "var(--danger)" }}>· {e}</div>)
                  )}
                </div>
              </Section>
            </>
          )}
        </main>
      </div>
    </div>
  );

  function setSetting(id: string, key: string, value: string | number | boolean | null): void {
    update((p) => {
      const ps = { ...(p.patch.pluginSettings ?? {}) };
      const cur = { ...(ps[id] ?? {}) };
      cur[key] = value;
      ps[id] = cur;
      p.patch.pluginSettings = ps;
    });
  }
}
