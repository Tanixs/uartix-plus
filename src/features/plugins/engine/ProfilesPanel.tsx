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
    <section>
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

export function ProfilesPanel() {
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

  async function pickRoot(key: string): Promise<void> {
    if (!draft) return;
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: tx(`选择 $EXT:${key} 的目录`, `Pick the folder for $EXT:${key}`),
      });
      if (typeof dir === "string" && dir) {
        update((p) => {
          p.patch.settings = { ...(p.patch.settings ?? {}) };
          p.patch.settings.roots = { ...(p.patch.settings.roots ?? {}), [key]: dir };
        });
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  const activeId = ps.book.activeId;
  const activeName = ps.book.profiles.find((p) => p.id === activeId)?.name ?? "";
  const settingsPatch = draft?.patch.settings;
  const wsHas = !!settingsPatch && Object.prototype.hasOwnProperty.call(settingsPatch, "workspaceRoot");
  const wsMode: "keep" | "set" | "clear" = !wsHas ? "keep" : settingsPatch!.workspaceRoot === null ? "clear" : "set";
  const wsValue = wsHas && typeof settingsPatch!.workspaceRoot === "string" ? settingsPatch!.workspaceRoot : "";
  const advancedCount = (wsHas ? 1 : 0) + (settingsPatch?.roots ? Object.keys(settingsPatch.roots).length : 0);
  const nameOf = (id: string): string => repo.entries.find((e) => e.id === id)?.manifest.name ?? id;
  const themeLabel = (v: string | null | undefined): string => {
    if (v === undefined) return tx("保持现状", "Keep current");
    if (v === null || v === "") return tx("内置主题", "Built-in theme");
    return themeOptions.find((t) => t.key === v)?.title ?? v;
  };

  return (
    <div className="prof-page">
      <aside className="prof-side">
        <div className="prof-side-actions">
          <button className="btn" disabled={!!busy} onClick={() => void doNew()} title={tx("新建一个空白场景", "Create an empty scene")}>
            {tx("新建场景", "New")}
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void doSaveCurrent()} title={tx("把当前启用的插件、主题与目录保存成场景", "Capture the current plugins, theme and paths as a scene")}>
            {tx("保存当前", "Capture")}
          </button>
        </div>

        {activeId ? (
          <div className="prof-active">
            <span className="mode">{tx("使用中", "Active")}</span>
            <span className="name" title={activeName}>{activeName}</span>
            <button className="btn" disabled={!!busy} onClick={() => void doRevert()} title={tx("恢复应用前的插件启停、主题、目录与配置", "Restore plugins, theme, paths and config from before applying")}>
              {tx("撤销", "Undo")}
            </button>
          </div>
        ) : null}

        <div className="prof-list">
          {ps.loading ? <div className="prof-empty">{tx("正在读取…", "Loading…")}</div> : null}
          {!ps.loading && !ps.book.profiles.length ? (
            <div className="prof-empty">{tx("还没有场景。新建一个，或把当前状态存下来。", "No scenes yet. Create one or capture the current state.")}</div>
          ) : null}
          {ps.book.profiles.map((p) => (
            <button key={p.id} className={`prof-card${p.id === selected ? " on" : ""}`} onClick={() => selectProfile(p.id)}>
              <span className="nm">{p.name}</span>
              <span className="meta">
                {tx(`${p.plugins.length} 个插件`, `${p.plugins.length} plugin(s)`)}
                {p.note ? ` · ${p.note}` : ""}
              </span>
            </button>
          ))}
          {ps.issues.map((s, i) => (
            <div key={i} className="prof-issue">{s}</div>
          ))}
        </div>
      </aside>

      <main className="prof-main">
        {!draft ? (
          <div className="prof-empty">{tx("从左边选一个场景，或者新建一份。", "Pick a scene on the left, or create one.")}</div>
        ) : (
          <div className="prof-editor">
            {error ? <div className="prof-banner danger">{error}</div> : null}
            {notice ? <div className="prof-banner">{notice}</div> : null}

            <div className="prof-title-row">
              <div className="prof-title-fields">
                <input
                  className="input prof-title-input"
                  value={draft.name}
                  maxLength={40}
                  aria-label={tx("场景名字", "Scene name")}
                  onChange={(e) => update((p) => (p.name = e.target.value))}
                />
                <input
                  className="input"
                  value={draft.note ?? ""}
                  maxLength={200}
                  placeholder={tx("备注（可选）", "Note (optional)")}
                  onChange={(e) =>
                    update((p) => {
                      const v = e.target.value.trim();
                      if (v) p.note = v;
                      else delete p.note;
                    })
                  }
                />
              </div>
              <div className="prof-actions">
                <button className="btn" disabled={!!busy || !dirty} onClick={() => void doSave()}>
                  {tx("保存", "Save")}
                </button>
                <button className="btn primary" disabled={!!busy || !preview?.ok} onClick={() => void doApply()}>
                  {busy === "apply" ? tx("应用中…", "Applying…") : tx("应用场景", "Apply")}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => void doDuplicate()} title={tx("复制这个场景", "Duplicate this scene")}>
                  {tx("复制", "Duplicate")}
                </button>
                <button
                  className="btn"
                  style={confirmDelete === selected ? { color: "var(--danger)" } : undefined}
                  disabled={!!busy}
                  onClick={() => void doDelete()}
                  title={confirmDelete === selected ? tx("再点一次确认删除", "Click again to confirm") : undefined}
                >
                  {confirmDelete === selected ? tx("确认删除", "Confirm") : tx("删除", "Delete")}
                </button>
              </div>
            </div>
            {dirty ? <div className="prof-dirty">{tx("有未保存的改动", "Unsaved changes")}</div> : null}

            {preview ? (
              preview.ok ? (
                <div className="prof-summary">
                  <span>
                    {tx(
                      `应用后启用 ${preview.plan.enabledSet.length} 个插件${preview.plan.toDisable.length ? `，停用 ${preview.plan.toDisable.length} 个未勾选的` : ""}`,
                      `Enables ${preview.plan.enabledSet.length} plugin(s)${preview.plan.toDisable.length ? `, disables ${preview.plan.toDisable.length} unchecked` : ""}`,
                    )}
                  </span>
                  {preview.plan.extensionPatch.activeTheme !== undefined ? (
                    <span>{tx(`主题：${themeLabel(preview.plan.extensionPatch.activeTheme)}`, `Theme: ${themeLabel(preview.plan.extensionPatch.activeTheme)}`)}</span>
                  ) : null}
                  {preview.plan.skipped
                    .filter((x) => x.reason === "untrusted")
                    .map((x) => (
                      <span key={x.id} className="warn">{tx(`${nameOf(x.id)} 未批准，应用时会跳过`, `${nameOf(x.id)} is not approved and will be skipped`)}</span>
                    ))}
                  {preview.plan.skipped
                    .filter((x) => x.reason === "missing")
                    .map((x) => (
                      <span key={x.id} className="warn">{tx(`${nameOf(x.id)} 没有安装，应用时会跳过`, `${nameOf(x.id)} is not installed and will be skipped`)}</span>
                    ))}
                </div>
              ) : (
                <div className="prof-summary danger">
                  {preview.errors.map((e, i) => (
                    <div key={i}>· {e}</div>
                  ))}
                </div>
              )
            ) : null}

            <Section
              title={tx("启用哪些插件", "Enabled plugins")}
              hint={tx("勾选这个场景要用的插件；应用时会停用未勾选的已启用插件", "Checked plugins are enabled by this scene; unchecked enabled plugins are disabled on apply")}
            >
              <div className="prof-plugins">
                {repo.entries.map((entry) => {
                  const on = draft.plugins.some((p) => p.id === entry.id);
                  return (
                    <label key={entry.id} className={`prof-plugin${on ? "" : " off"}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          update((p) => {
                            if (e.target.checked) p.plugins.push({ id: entry.id });
                            else p.plugins = p.plugins.filter((x) => x.id !== entry.id);
                          })
                        }
                        aria-label={entry.manifest.name}
                      />
                      <span className="nm">{entry.manifest.name}</span>
                      <span className="id">{entry.id} · v{entry.version}</span>
                      {entry.verdict !== "trusted" ? <span className="warn">{tx("未批准，场景不会替你启用", "not approved; the scene will skip it")}</span> : null}
                    </label>
                  );
                })}
                {!repo.entries.length ? <div className="prof-empty">{tx("还没装插件。", "No plugins installed yet.")}</div> : null}
              </div>
            </Section>

            <Section title={tx("外观", "Appearance")} hint={tx("没选的项目保持现状", "Anything not set here stays as it is")}>
              <div className="prof-field-grid theme">
                <FieldShell label={tx("主题", "Theme")}>
                  <select
                    className="input"
                    value={
                      !settingsPatch || !("activeTheme" in settingsPatch)
                        ? "__keep"
                        : !settingsPatch.activeTheme
                          ? "__builtin"
                          : settingsPatch.activeTheme
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
                    <option value="__builtin">{tx("内置主题（清除插件主题）", "Built-in theme (clear plugin theme)")}</option>
                    {themeOptions.map((t) => (
                      <option key={t.key} value={t.key}>{t.title}</option>
                    ))}
                  </select>
                </FieldShell>
              </div>
            </Section>

            <details className="prof-adv">
              <summary>
                {tx("高级覆盖：工作区根 / 外部目录", "Advanced: workspace root / external paths")}
                {advancedCount ? <span className="prof-count">{advancedCount}</span> : null}
              </summary>
              <div className="prof-adv-body">
                <p className="prof-adv-hint">
                  {tx(
                    "一般不用改；只有这个场景需要换工作区或外部目录时才设置。未设置的项目保持现状。",
                    "Usually unnecessary; set these only when this scene needs a different workspace or external path. Unset items stay as they are.",
                  )}
                </p>
                <div className="prof-field-grid">
                  <FieldShell label={tx("工作区根（$WS）", "Workspace root ($WS)")}>
                    <div className="prof-path-row">
                      <select
                        className="input"
                        value={wsMode}
                        onChange={(e) =>
                          update((p) => {
                            p.patch.settings = { ...(p.patch.settings ?? {}) };
                            const v = e.target.value;
                            if (v === "keep") delete p.patch.settings.workspaceRoot;
                            else if (v === "clear") p.patch.settings.workspaceRoot = null;
                            else if (typeof p.patch.settings.workspaceRoot !== "string") p.patch.settings.workspaceRoot = repo.workspaceRoot ?? "";
                          })
                        }
                        style={{ flex: "0 0 112px" }}
                      >
                        <option value="keep">{tx("保持现状", "Keep current")}</option>
                        <option value="set">{tx("指定目录", "Set path")}</option>
                        <option value="clear">{tx("清空", "Clear")}</option>
                      </select>
                      {wsMode === "set" ? (
                        <>
                          <input
                            className="input"
                            value={wsValue}
                            placeholder={tx("绝对路径", "Absolute path")}
                            onChange={(e) =>
                              update((p) => {
                                p.patch.settings = { ...(p.patch.settings ?? {}) };
                                p.patch.settings.workspaceRoot = e.target.value;
                              })
                            }
                          />
                          <button className="btn" onClick={() => void pickWorkspace()}>{tx("选择…", "Pick…")}</button>
                        </>
                      ) : null}
                    </div>
                  </FieldShell>
                </div>

                {rootKeyList.length ? (
                  <div className="prof-field-grid">
                    {rootKeyList.map((key) => {
                      const roots = settingsPatch?.roots ?? {};
                      const has = Object.prototype.hasOwnProperty.call(roots, key);
                      const v = roots[key];
                      const mode = !has ? "keep" : v === null ? "unbind" : "bind";
                      return (
                        <FieldShell key={key} label={`$EXT:${key}`}>
                          <div className="prof-path-row">
                            <select
                              className="input"
                              value={mode}
                              onChange={(e) =>
                                update((p) => {
                                  p.patch.settings = { ...(p.patch.settings ?? {}) };
                                  const next = { ...(p.patch.settings.roots ?? {}) };
                                  if (e.target.value === "keep") delete next[key];
                                  else if (e.target.value === "unbind") next[key] = null;
                                  else next[key] = repo.roots[key] ?? "";
                                  p.patch.settings.roots = next;
                                })
                              }
                              style={{ flex: "0 0 112px" }}
                            >
                              <option value="keep">{tx("保持现状", "Keep current")}</option>
                              <option value="bind">{tx("绑定目录", "Bind")}</option>
                              <option value="unbind">{tx("解绑", "Unbind")}</option>
                            </select>
                            {mode === "bind" ? (
                              <>
                                <input
                                  className="input"
                                  value={typeof v === "string" ? v : ""}
                                  placeholder={tx("绝对路径", "Absolute path")}
                                  onChange={(e) =>
                                    update((p) => {
                                      p.patch.settings = { ...(p.patch.settings ?? {}) };
                                      p.patch.settings.roots = { ...(p.patch.settings.roots ?? {}), [key]: e.target.value };
                                    })
                                  }
                                />
                                <button className="btn" onClick={() => void pickRoot(key)}>{tx("选择…", "Pick…")}</button>
                              </>
                            ) : null}
                          </div>
                        </FieldShell>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </details>

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

          </div>
        )}
      </main>
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
