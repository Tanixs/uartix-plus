/**
 * P174-R2：旧插件管理壳里的**新引擎列表**。
 *
 * 旧外壳（`PluginLibraryDialog` 的工具栏/样式）保留，这一块只换数据源：
 * 新引擎的已安装插件、草稿、安装计划都从 `plugins/engine` 来。旧 `pluginStore` 的
 * 记录不再展示（R3 再删数据与代码）。
 *
 * 视觉不另起一套：复用旧 UI 的 `plg-item / plg-detail / plg-sec / plg-switch` 类名，
 * 这样它看起来仍是同一个插件库，而不是"设置里又嵌了一个新面板"。
 *
 * P174-R7①：**这一面是插件管理的唯一一面**。此前它和 dock 面板里的 `PluginEnginePanel`
 * 各有一半——这边有版本/配置/发布/元信息，那边有目录绑定与进程日志，用户被迫两头跑，
 * 而"装完在哪启用、在哪看它为什么没起来"这种问题根本没有两个答案的道理。
 * 那边整面退役：目录绑定搬进这里（顶上一根 + 每个插件详情里它自己那份），
 * 进程日志与操作账本搬进新的「运行日志」面（诊断归诊断，管理归管理）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import { IconPuzzle } from "../../../shared/icons";
import { requestOpenPanel } from "../../ai/appBus";
import {
  approve,
  commitInstall,
  ensureLoaded,
  getSnapshot,
  planFolder,
  promoteDraft,
  reload,
  setActiveTheme,
  setEnabled,
  setEnabledSet,
  setTrustTier,
  subscribe,
  uninstall,
  uninstallMany,
  commitDraftPromotion,
  type InstalledPlugin,
} from "./pluginEngine";
import { discardDraft, draftPreviewTarget, listDrafts, type DraftEntry } from "./draft";
import type { InstallPlan } from "./install";
import { panelViewId } from "./panelBridge";
import { pluginMatches } from "./pluginListQuery";
import { metaAuthor, metaDescription, metaHomepage, metaName, removePluginMeta, usePluginMetaBook } from "./pluginMeta";
import { PluginMetaEditor } from "./PluginMetaEditor";
import { PluginConfigEditor } from "./PluginConfigEditor";
import { PluginVersions } from "./PluginVersions";
import { PluginPublishForm } from "./PluginPublishForm";
import { PluginMarketView } from "./PluginMarketView";
import type { MarketInstalled } from "./marketStatus";
import { PluginContribActions } from "./PluginContribActions";
import { PluginRootsFold, WorkspaceRootRow } from "./PluginRootsSection";
import { DraftPreviewDialog } from "./DraftPreviewDialog";
import { declaredRootKeys, DEFAULT_TRUST_TIER, type TrustTier } from "./manifest";
import { closeMarketDialog, useMarketDialogOpen } from "./marketDialog";
import { hideWidget, showWidget, useHiddenWidgets, widgetKey } from "./widgetVisibility";
import { cleanIncoming, commitRepoInstall, prepareRepoInstall } from "./marketClient";
import type { GhRepo } from "./ghSearch";
import { kindsOrFallback, matchesFilter, pluginKinds, type PluginFilter } from "./pluginKinds";

export interface PluginEngineSectionProps {
  /** 旧工具栏的搜索词；新列表跟着它过滤。 */
  query?: string;
  /** 按**产物**筛选（面板/主题/小部件/预设与模板/命令/复合）。见 `pluginKinds.ts`。 */
  filter?: PluginFilter;
}

function stateLabel(p: InstalledPlugin): string {
  if (p.verdict === "needs-approval") return tx("待批准", "Needs approval");
  if (p.verdict === "changed") return tx("权限已变", "Permissions changed");
  return p.enabled ? tx("已启用", "Enabled") : tx("已停用", "Disabled");
}

function trustLabel(p: InstalledPlugin): string {
  if (p.verdict === "needs-approval") return tx("未批准", "Not approved");
  if (p.verdict === "changed") return tx("权限面变了，需重批", "Permission surface changed; re-approval required");
  return tx("已批准", "Approved");
}

function Fold(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <details className="plg-fold">
      <summary className="plg-sec">
        <span>{props.title}</span>
        {props.hint ? <span className="plg-fold-hint">{props.hint}</span> : null}
      </summary>
      <div className="plg-fold-body">{props.children}</div>
    </details>
  );
}

/* ============================ 授权档位（2026-11-03） ============================ */

/**
 * 档位文案。**授权卡不再逐条列 23 行路径**——用户 2026-11-03 的原话是
 * "把权限面放开，不要搞这么多安全限制"。所以这里只说三件事：
 * 档位叫什么、它实际放开了什么、你放弃了什么。
 * 完整清单仍然留在 `trust.json` 里（审计用），界面上折叠成"可选查看"。
 */
function tierTitle(t: TrustTier): string {
  return t === "full" ? tx("完全信任", "Full trust") : tx("受限", "Restricted");
}

function tierOneLine(t: TrustTier): string {
  return t === "full"
    ? tx(
        "可读写任意路径、启动任意程序、连接任意域名。",
        "Reads and writes anywhere, runs any program, connects to any domain.",
      )
    : tx(
        "写入只落在它声明的目录；启动程序与联网按清单声明判断（本机不逐项拦截）。",
        "Writes stay inside the folders it declares; programs and network follow the manifest (not intercepted per item here).",
      );
}

function tierSacrifice(t: TrustTier): string {
  return t === "full"
    ? tx(
        "你放弃的是：工作区隔离。完全信任档等于插件可写任意路径；现有回收站只覆盖工作区内路径，跨盘误删不可恢复。",
        "You give up workspace isolation. Full trust means the plugin can write to any path; the existing trash only covers paths inside the workspace, so deletions on another drive cannot be recovered.",
      )
    : tx(
        "你放弃的是：它写不进未声明的目录，依赖新目录的功能会不可用。",
        "You give up: it cannot write to undeclared folders, so features that need new folders will not work.",
      );
}

/**
 * 档位选择器。**默认受限**；完全信任不藏在第二个对话框里——选中它，
 * 风险句就出现在同一张卡上，随后的确认按钮就是那次"一次确认"。
 */
function TierPicker(props: {
  tier: TrustTier;
  onChange: (t: TrustTier) => void;
  disabled?: boolean;
}) {
  const { tier, onChange, disabled = false } = props;
  return (
    <div className="plg-tier">
      <div className="plg-tier-opts" role="radiogroup" aria-label={tx("授权档位", "Trust level")}>
        {(["restricted", "full"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={tier === t}
            className={`plg-tier-opt${tier === t ? " on" : ""}${t === "full" ? " full" : ""}`}
            disabled={disabled}
            onClick={() => onChange(t)}
          >
            <span className="plg-tier-name">{tierTitle(t)}</span>
            <span className="plg-tier-one">{tierOneLine(t)}</span>
          </button>
        ))}
      </div>
      {/* 完全信任的"你放弃了什么"同时就是那条醒目提示：同一句话不重复两遍 */}
      {tier === "full" ? (
        <div className="plg-tier-risk" role="alert">
          {tierSacrifice("full")}
        </div>
      ) : (
        <div className="plg-tier-sacrifice">{tierSacrifice("restricted")}</div>
      )}
    </div>
  );
}

/** 完整权限清单（审计用）。默认折叠：批准卡上先给结论，再给证据。 */
function PermissionDetails(props: { lines: string[] }) {
  return (
    <details className="plg-perm-detail">
      <summary>{tx(`完整权限清单（${props.lines.length} 项，审计用）`, `Full permission list (${props.lines.length} items, for audit)`)}</summary>
      {props.lines.length ? (
        <ul>
          {props.lines.map((x) => <li key={x}>{x}</li>)}
        </ul>
      ) : (
        <div className="plg-detail-dim">{tx("没有申请任何权限", "No permissions requested")}</div>
      )}
    </details>
  );
}

export function PluginEngineSection({ query = "", filter = "all" }: PluginEngineSectionProps) {
  useLocale();
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const metaBook = usePluginMetaBook();
  const marketOpen = useMarketDialogOpen();
  const hiddenWidgets = useHiddenWidgets();
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [openId, setOpenId] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState("");
  const [pendingInstall, setPendingInstall] = useState<InstallPlan | null>(null);
  const [pendingDraft, setPendingDraft] = useState<{ plan: InstallPlan; name: string } | null>(null);
  const [pendingMarket, setPendingMarket] = useState<{ plan: InstallPlan; repo: GhRepo; incomingDir: string } | null>(null);
  /** 授权卡上当前选中的档位（所有"待安装"卡共用；每开一张新卡重置成受限）。 */
  const [pendingTier, setPendingTier] = useState<TrustTier>(DEFAULT_TRUST_TIER);
  /** 已装插件详情里的档位草稿（按插件 id 记；没选过就沿用账上的档位）。 */
  const [tierChoices, setTierChoices] = useState<Record<string, TrustTier>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  /** R12：草稿预览（转正之前先看一眼画面，不装、不跑）。 */
  const [previewDraft, setPreviewDraft] = useState<DraftEntry | null>(null);

  useEffect(() => {
    void ensureLoaded();
  }, []);

  const installedKey = repo.entries.map((e) => `${e.id}@${e.version}`).join(",");
  useEffect(() => {
    if (!repo.appDir) return;
    let alive = true;
    listDrafts(repo.appDir, Object.fromEntries(repo.entries.map((e) => [e.id, e.version])))
      .then((d) => {
        if (alive) setDrafts(d);
      })
      .catch((e) => {
        if (alive) setErr(String((e as Error)?.message ?? e));
      });
    return () => {
      alive = false;
    };
    // installedKey 是稳定串；直接用 entries 数组会在每来一行日志时重扫一次草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.appDir, installedKey]);

  const installedRepos = useMemo(() => {
    const out: Record<string, MarketInstalled> = {};
    for (const e of repo.entries) {
      // 市场只认得"从市场装的那批"：本地方向装的 origin 是空的，拿仓库去比版本会指错东西
      if (!e.origin?.startsWith("github:")) continue;
      out[e.origin.slice("github:".length).split("@")[0]] = {
        version: e.version,
        enabled: e.enabled,
        trusted: e.verdict === "trusted",
      };
    }
    return out;
  }, [repo.entries]);

  const visible = useMemo(
    () => repo.entries
      .filter((e) => matchesFilter(pluginKinds(e.manifest), filter) && pluginMatches(e, query, metaBook.items[e.id]))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [repo.entries, query, filter, metaBook.items],
  );

  async function refreshDrafts(): Promise<void> {
    if (!repo.appDir) return;
    setDrafts(await listDrafts(repo.appDir, Object.fromEntries(repo.entries.map((e) => [e.id, e.version]))));
  }

  async function doEnable(p: InstalledPlugin, on: boolean): Promise<void> {
    setBusy(p.id);
    setErr("");
    const wasActiveTheme = p.themes.some((t) => t.key === repo.activeTheme);
    const shipsThemes = (p.manifest.contributes.themes?.length ?? 0) > 0;
    try {
      await setEnabled(p.id, on);
      if (!on && wasActiveTheme) {
        setNotice(tx(`已停用「${p.manifest.name}」；它正在提供的主题已退回内置主题`, `Disabled “${p.manifest.name}”; its active theme fell back to a built-in one`));
      } else if (on && shipsThemes) {
        setNotice(
          p.verdict === "trusted"
            ? tx(`已启用「${p.manifest.name}」；它的主题已出现在 设置 → 外观 的插件主题里`, `Enabled “${p.manifest.name}”; its themes now appear under Settings → Appearance`)
            : tx(`已启用「${p.manifest.name}」；权限批准后它的主题才会进入 设置 → 外观`, `Enabled “${p.manifest.name}”; its themes enter Settings → Appearance after approval`),
        );
      } else {
        setNotice(on ? tx(`已启用「${p.manifest.name}」`, `Enabled “${p.manifest.name}”`) : tx(`已停用「${p.manifest.name}」`, `Disabled “${p.manifest.name}”`));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doApprove(p: InstalledPlugin, tier: TrustTier = DEFAULT_TRUST_TIER): Promise<void> {
    setBusy(p.id);
    setErr("");
    try {
      await approve(p.id, tier);
      setTierChoices((prev) => ({ ...prev, [p.id]: tier }));
      setNotice(
        tier === "full"
          ? tx(`已按「完全信任」批准「${p.manifest.name}」；它可以写任意路径`, `Approved “${p.manifest.name}” with full trust; it can write any path`)
          : tx(`已按「受限」批准「${p.manifest.name}」的权限`, `Approved permissions for “${p.manifest.name}” (restricted)`),
      );
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  /**
   * 已批准插件切档位。**切完宿主会被停掉**（`setTrustTier` 负责）：
   * Node 的权限参数是启动时定死的，只改账不停进程等于界面说"已受限"、后台仍可写全盘。
   */
  async function doSetTier(p: InstalledPlugin, tier: TrustTier): Promise<void> {
    setBusy(p.id);
    setErr("");
    try {
      const wasRunning = p.phase === "running" || p.phase === "starting";
      await setTrustTier(p.id, tier);
      setTierChoices((prev) => ({ ...prev, [p.id]: tier }));
      setNotice(
        tx(
          `「${p.manifest.name}」已切换为「${tierTitle(tier)}」档${wasRunning ? "；宿主已停止，下次启动按新档位运行" : "；下次启动按新档位运行"}`,
          `“${p.manifest.name}” is now “${tierTitle(tier)}”${wasRunning ? "; the host was stopped and will use the new tier next time" : "; the new tier applies next time it starts"}`,
        ),
      );
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doUninstall(id: string): Promise<void> {
    if (confirmUninstall !== id) {
      setConfirmUninstall(id);
      return;
    }
    setBusy(id);
    setErr("");
    try {
      await uninstall(id);
      removePluginMeta(id);
      setConfirmUninstall("");
      setOpenId("");
      setNotice(tx("已卸载", "Uninstalled"));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function pickInstall(): Promise<void> {
    setErr("");
    try {
      const dir = await open({ directory: true, multiple: false, title: tx("选择插件文件夹（含 plugin.json）", "Pick a plugin folder (with plugin.json)") });
      if (typeof dir !== "string" || !dir) return;
      setBusy("install");
      const plan = await planFolder(dir, `draft-${Date.now().toString(36)}`);
      // 每张新卡都从**受限**开始：不继承上一张卡的档位选择，避免"顺手点过一次完全信任"变成默认值
      setPendingTier(DEFAULT_TRUST_TIER);
      setPendingInstall(plan);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function confirmInstall(): Promise<void> {
    if (!pendingInstall) return;
    setBusy("install");
    setErr("");
    try {
      await commitInstall({ ...pendingInstall, tier: pendingTier });
      setPendingInstall(null);
      setNotice(
        pendingTier === "full"
          ? tx("已按「完全信任」安装（默认停用，去列表里点启用）", "Installed with full trust (disabled by default — enable it in the list)")
          : tx("已安装（默认停用，去列表里点启用）", "Installed (disabled by default — enable it in the list)"),
      );
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doPromote(d: DraftEntry): Promise<void> {
    setBusy(d.name);
    setErr("");
    try {
      const got = await promoteDraft(d.name);
      if (got.installed) {
        setNotice(tx(`草稿「${d.title}」已转正`, `Promoted draft “${d.title}”`));
        await refreshDrafts();
      } else {
        setPendingTier(DEFAULT_TRUST_TIER);
        setPendingDraft({ plan: got.plan, name: d.name });
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function confirmPromote(): Promise<void> {
    if (!pendingDraft) return;
    setBusy("promote");
    setErr("");
    try {
      await commitDraftPromotion({ ...pendingDraft.plan, tier: pendingTier }, pendingDraft.name);
      setPendingDraft(null);
      setNotice(
        pendingTier === "full"
          ? tx("草稿已按「完全信任」转正", "Draft promoted with full trust")
          : tx("草稿已转正", "Draft promoted"),
      );
      await refreshDrafts();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doDiscard(name: string): Promise<void> {
    if (confirmDiscard !== name) {
      setConfirmDiscard(name);
      return;
    }
    setBusy(name);
    setErr("");
    try {
      if (!repo.appDir) throw new Error(tx("还没读到插件目录", "Plugin folder is not loaded yet"));
      await discardDraft(repo.appDir, name);
      setConfirmDiscard("");
      await refreshDrafts();
      setNotice(tx("草稿已丢弃", "Draft discarded"));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function installFromMarket(repo: GhRepo): Promise<void> {
    setBusy(`market:${repo.full}`);
    setErr("");
    try {
      const preview = await prepareRepoInstall(repo);
      setPendingTier(DEFAULT_TRUST_TIER);
      setPendingMarket({ plan: preview.plan, repo, incomingDir: preview.incomingDir });
      closeMarketDialog();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      throw e;
    } finally {
      setBusy("");
    }
  }

  async function confirmMarket(): Promise<void> {
    if (!pendingMarket) return;
    setBusy("market-install");
    setErr("");
    try {
      await commitRepoInstall({ ...pendingMarket.plan, tier: pendingTier }, pendingMarket.repo);
      await cleanIncoming(pendingMarket.incomingDir);
      setPendingMarket(null);
      setNotice(
        pendingTier === "full"
          ? tx("市场插件已按「完全信任」安装（默认停用）", "Market plugin installed with full trust (disabled by default)")
          : tx("市场插件已安装（默认停用）", "Market plugin installed (disabled by default)"),
      );
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function cancelMarket(): Promise<void> {
    if (!pendingMarket) return;
    await cleanIncoming(pendingMarket.incomingDir);
    setPendingMarket(null);
  }

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBatch(false);
  }

  function exitSelect(): void {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmBatch(false);
  }

  async function batchEnable(): Promise<void> {
    const ids = [...selected].filter((id) => repo.entries.find((e) => e.id === id)?.verdict === "trusted");
    const skipped = selected.size - ids.length;
    const current = repo.entries.filter((e) => e.enabled).map((e) => e.id);
    setBusy("batch");
    setErr("");
    try {
      await setEnabledSet([...new Set([...current, ...ids])]);
      setNotice(tx(`已启用 ${ids.length} 个${skipped ? `（跳过 ${skipped} 个未批准）` : ""}`, `Enabled ${ids.length}${skipped ? ` (skipped ${skipped} unapproved)` : ""}`));
      exitSelect();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function batchDisable(): Promise<void> {
    const current = repo.entries.filter((e) => e.enabled).map((e) => e.id);
    setBusy("batch");
    setErr("");
    try {
      await setEnabledSet(current.filter((id) => !selected.has(id)));
      setNotice(tx(`已停用 ${selected.size} 个插件`, `Disabled ${selected.size} plugin(s)`));
      exitSelect();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function batchUninstall(): Promise<void> {
    if (!confirmBatch) {
      setConfirmBatch(true);
      return;
    }
    setBusy("batch");
    setErr("");
    try {
      const r = await uninstallMany([...selected]);
      for (const id of r.removed) removePluginMeta(id);
      setNotice(
        r.failed.length
          ? tx(`已卸载 ${r.removed.length} 个；${r.failed.length} 个失败：${r.failed[0].id}`, `Uninstalled ${r.removed.length}; ${r.failed.length} failed: ${r.failed[0].id}`)
          : tx(`已卸载 ${r.removed.length} 个插件`, `Uninstalled ${r.removed.length} plugin(s)`),
      );
      exitSelect();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  /** 当前这张授权卡对应的安装计划（市场 / 本地 / 草稿三选一）。 */
  const pendingPlan = pendingMarket?.plan ?? pendingInstall ?? pendingDraft?.plan ?? null;
  const pendingPerms = pendingPlan?.permissions ?? [];
  /** 纯声明式插件没有主进程：完全信任不会多给任何能力，选择器里禁掉它。 */
  const pendingHasMain = !!pendingPlan?.manifest.main;

  return (
    /* P179-UI09：市场从"盖在插件管理上的第二层模态"改成同一页的右分栏。
       左栏仍是已装列表，右栏是市场（点「插件市场」展开）；两栏各自滚动，
       不再有 backdrop、不再把用户从设置页里拔出去，也不需要关掉再回来继续管插件。 */
    <div className="plg-eng-root">
      <div className="plg-eng-main">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "0 var(--sp-1)" }}>
        <span style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>{tx("插件", "Plugins")}</span>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>{visible.length + drafts.length}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!!busy} onClick={() => void pickInstall()}>
          {busy === "install" ? tx("读取中…", "Reading…") : tx("安装文件夹…", "Install folder…")}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void reload()}>
          {tx("刷新", "Refresh")}
        </button>
        <button className={`plg-fchip${selectMode ? " on" : ""}`} disabled={!!busy} onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}>
          {selectMode ? tx("退出选择", "Exit selection") : tx("选择", "Select")}
        </button>
      </div>

      {/* R7①：目录绑定跟着管理面一起住在这儿。`$WS` 是所有声明它的插件共用的一根，
          所以它在列表顶上；`$EXT:<key>` 从插件详情的「目录绑定」里逐个绑（键名由那枚清单决定）。 */}
      <WorkspaceRootRow workspaceRoot={repo.workspaceRoot} disabled={!!busy} onError={setErr} />

      {selectMode ? (
        <div className="plg-batch" role="group" aria-label={tx("批量操作", "Batch actions")}>
          <button className="btn" onClick={() => setSelected(new Set(visible.map((p) => p.id)))}>{tx("全选", "Select all")}</button>
          <button className="btn" onClick={() => setSelected(new Set(visible.filter((p) => !selected.has(p.id)).map((p) => p.id)))}>{tx("反选", "Invert")}</button>
          <span className="plg-batch-n">{tx(`已选 ${selected.size}`, `${selected.size} selected`)}</span>
          <span className="plg-batch-spacer" />
          <button className="btn" disabled={!selected.size || !!busy} onClick={() => void batchEnable()}>{tx("启用", "Enable")}</button>
          <button className="btn" disabled={!selected.size || !!busy} onClick={() => void batchDisable()}>{tx("停用", "Disable")}</button>
          <button className="btn danger" disabled={!selected.size || !!busy} onClick={() => void batchUninstall()}>
            {confirmBatch ? tx("再点一次确认卸载", "Click again to uninstall") : tx("卸载", "Uninstall")}
          </button>
          <button className="btn" onClick={exitSelect}>{tx("取消", "Cancel")}</button>
        </div>
      ) : null}

      {err ? <div className="plg-notice err" role="status">{err}</div> : null}
      {notice ? <div className="plg-notice ok" role="status">{notice}</div> : null}

      {pendingMarket ? (
        <div className="plg-item open">
          <div className="plg-detail">
            <h4 className="plg-sec">
              {tx(`要安装 GitHub 上的「${pendingMarket.plan.name}」吗？（v${pendingMarket.plan.version}）`, `Install “${pendingMarket.plan.name}” from GitHub? (v${pendingMarket.plan.version})`)}
            </h4>
            <p className="plg-detail-desc">
              {tx(`来源：${pendingMarket.repo.full}；安装后默认停用。先选授权档位，再装入。`, `Source: ${pendingMarket.repo.full}; installed disabled. Pick a trust level, then install.`)}
            </p>
            {pendingMarket.plan.verdict === "changed" && pendingMarket.plan.previousTier ? (
              <div className="plg-detail-dim">
                {tx(`上次批准的是「${tierTitle(pendingMarket.plan.previousTier)}」档；权限面变了，这次请重新确认。`, `Last approved tier was “${tierTitle(pendingMarket.plan.previousTier)}”; the permission surface changed, so please confirm again.`)}
              </div>
            ) : null}
            {pendingHasMain ? (
              <TierPicker tier={pendingTier} onChange={setPendingTier} disabled={!!busy} />
            ) : (
              <div className="plg-detail-dim">
                {tx("这个插件没有主进程，不涉及进程权限；按「受限」档记录。", "This plugin has no host process, so process permissions do not apply; it is recorded as restricted.")}
              </div>
            )}
            <PermissionDetails lines={pendingPerms} />
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button
                className={`btn ${pendingTier === "full" ? "danger" : "primary"}`}
                disabled={!!busy}
                onClick={() => void confirmMarket()}
              >
                {pendingTier === "full" ? tx("完全信任并装入", "Install with full trust") : tx("装入（受限）", "Install (restricted)")}
              </button>
              <button className="btn" disabled={!!busy} onClick={() => void cancelMarket()}>
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingInstall || pendingDraft ? (
        <div className="plg-item open">
          <div className="plg-detail">
            <h4 className="plg-sec">
              {pendingDraft
                ? tx(`要转正草稿「${pendingDraft.name}」吗？`, `Promote draft “${pendingDraft.name}”?`)
                : tx(`要安装「${pendingInstall?.name}」吗？（v${pendingInstall?.version}）`, `Install “${pendingInstall?.name}”? (v${pendingInstall?.version})`)}
            </h4>
            <p className="plg-detail-desc">
              {tx("先选授权档位，再装入；安装后默认停用，启用后才会跑。", "Pick a trust level, then install. It starts disabled; enable it when you want it to run.")}
            </p>
            {pendingPlan?.verdict === "changed" && pendingPlan.previousTier ? (
              <div className="plg-detail-dim">
                {tx(`上次批准的是「${tierTitle(pendingPlan.previousTier)}」档；权限面变了，这次请重新确认。`, `Last approved tier was “${tierTitle(pendingPlan.previousTier)}”; the permission surface changed, so please confirm again.`)}
              </div>
            ) : null}
            {pendingHasMain ? (
              <TierPicker tier={pendingTier} onChange={setPendingTier} disabled={!!busy} />
            ) : (
              <div className="plg-detail-dim">
                {tx("这个插件没有主进程，不涉及进程权限；按「受限」档记录。", "This plugin has no host process, so process permissions do not apply; it is recorded as restricted.")}
              </div>
            )}
            <PermissionDetails lines={pendingPerms} />
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button
                className={`btn ${pendingTier === "full" ? "danger" : "primary"}`}
                disabled={!!busy}
                onClick={() => void (pendingDraft ? confirmPromote() : confirmInstall())}
              >
                {pendingDraft
                  ? pendingTier === "full"
                    ? tx("完全信任并转正", "Promote with full trust")
                    : tx("批准并转正（受限）", "Approve and promote (restricted)")
                  : pendingTier === "full"
                    ? tx("完全信任并装入", "Install with full trust")
                    : tx("装入（受限）", "Install (restricted)")}
              </button>
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => {
                  setPendingInstall(null);
                  setPendingDraft(null);
                }}
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {visible.map((p) => {
        const on = p.enabled;
        const open = !selectMode && openId === p.id;
        const meta = metaBook.items[p.id];
        /**
         * 详情里的档位草稿。**未批准/权限已变时默认回受限**，不沿用账上的旧档：
         * `changed` 意味着用户这次看到的是新权限面，就该重新做一次决定。
         */
        const chosenTier = tierChoices[p.id] ?? (p.verdict === "trusted" ? p.tier : DEFAULT_TRUST_TIER);
        return (
          <div key={p.id} className={`plg-item${open ? " open" : ""}`}>
            <div className="plg-item-row">
              {selectMode ? (
                <input
                  type="checkbox"
                  className="plg-item-check"
                  checked={selected.has(p.id)}
                  onChange={() => toggleSelect(p.id)}
                  aria-label={tx(`选择 ${p.manifest.name}`, `Select ${p.manifest.name}`)}
                />
              ) : null}
              <button
                className="plg-item-main"
                onClick={() => (selectMode ? toggleSelect(p.id) : setOpenId(open ? "" : p.id))}
                title={selectMode ? tx("选中/取消", "Check / uncheck") : tx("展开详情", "Expand details")}
              >
                <span className="plg-cover" aria-hidden="true">
                  {meta?.cover ? <img src={meta.cover} alt="" /> : <span className="plg-item-ico"><IconPuzzle size={28} /></span>}
                </span>
                <span className="plg-item-body">
                  <span className="plg-item-line">
                    <span className="plg-item-name">{metaName(p.manifest.name, meta)}</span>
                    <span className="plg-item-id">{p.id}</span>
                    {/* R15：徽标说"它给你什么"（面板/主题/小部件…），不再是一律「代码插件」——
                        那个词对筛选没有信息量（v3 里每个插件都是代码插件）。 */}
                    {kindsOrFallback(pluginKinds(p.manifest)).map((k) => (
                      <span key={k.zh} className="plg-chip">{tx(k.zh, k.en)}</span>
                    ))}
                    {/* 完全信任在列表里就要看得见：不能等展开详情才知道它能写全盘 */}
                    {p.verdict === "trusted" && p.tier === "full" ? (
                      <span className="plg-chip warn">{tx("完全信任 · 可写任意路径", "full trust · writes any path")}</span>
                    ) : null}
                    {p.verdict !== "trusted" ? <span className="plg-chip warn">{tx("未批准", "not approved")}</span> : null}
                  </span>
                  <span className="plg-item-desc">{metaDescription(p.manifest.description ?? "", meta) || tx("（没有描述）", "(no description)")}</span>
                </span>
                <span className={`plg-state ${on && p.verdict === "trusted" ? "s-enabled" : "s-disabled"}`}>{stateLabel(p)}</span>
              </button>
              <label className="plg-switch" title={on ? tx("停用", "Disable") : tx("启用", "Enable")}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!!busy || selectMode || p.verdict !== "trusted"}
                  onChange={(e) => void doEnable(p, e.target.checked)}
                />
                <span className="plg-switch-ui" aria-hidden="true" />
              </label>
            </div>
            {open ? (
              <div className="plg-detail">
                {/* R14：展开栏第一行给**描述**。版本/来源/安装时间在右列「概览」里已经有了，
                    同一份事实写两遍只是让这两行互相稀释。清单没写描述时也要说清楚，不留空行。 */}
                <p className="plg-detail-desc" style={{ margin: 0, color: "var(--text)", fontSize: "var(--fs-sm)", lineHeight: "var(--lh-read)" }}>
                  {metaDescription(p.manifest.description ?? "", meta) || tx("（这个插件没有写描述）", "(this plugin has no description)")}
                </p>
                <div className="plg-cols">
                  <section className="plg-col-main">
                    {p.verdict !== "trusted" ? (
                      <div className="plg-approve-bar">
                        <span>{tx("权限还没批准，插件不会启动", "Permissions are not approved; the plugin will not start")}</span>
                        <button className="btn primary" disabled={!!busy} onClick={() => void doApprove(p, DEFAULT_TRUST_TIER)}>
                          {tx("批准（受限）", "Approve (restricted)")}
                        </button>
                        <span className="plg-detail-dim">
                          {tx("要完全信任？在下面「权限与批准」里切档位。", "Want full trust? Switch the tier under “Permissions & approval” below.")}
                        </span>
                      </div>
                    ) : null}

                    <Fold
                      title={tx("权限与批准", "Permissions & approval")}
                      hint={tx(`${tierTitle(p.tier)} · ${p.permissions.length} 项`, `${tierTitle(p.tier)} · ${p.permissions.length} item(s)`)}
                    >
                      {p.verdict === "changed" ? (
                        <div className="plg-detail-dim">
                          {tx(`权限面变了；上次批准的是「${tierTitle(p.tier)}」档，这次要重新选一次。`, `The permission surface changed; last approved tier was “${tierTitle(p.tier)}”. Choose again.`)}
                        </div>
                      ) : null}
                      {p.manifest.main ? (
                        <TierPicker
                          tier={chosenTier}
                          onChange={(t) => setTierChoices((prev) => ({ ...prev, [p.id]: t }))}
                          disabled={!!busy}
                        />
                      ) : (
                        <div className="plg-detail-dim">
                          {tx("这个插件没有主进程，不涉及进程权限；按「受限」档记录。", "This plugin has no host process, so process permissions do not apply; it is recorded as restricted.")}
                        </div>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                        {p.verdict !== "trusted" ? (
                          <button
                            className={`btn ${chosenTier === "full" ? "danger" : "primary"}`}
                            disabled={!!busy}
                            onClick={() => void doApprove(p, chosenTier)}
                          >
                            {chosenTier === "full" ? tx("完全信任并批准", "Approve with full trust") : tx("批准（受限）", "Approve (restricted)")}
                          </button>
                        ) : chosenTier !== p.tier ? (
                          <button
                            className={`btn ${chosenTier === "full" ? "danger" : "primary"}`}
                            disabled={!!busy}
                            onClick={() => void doSetTier(p, chosenTier)}
                          >
                            {chosenTier === "full"
                              ? tx("改为完全信任（可写任意路径）", "Switch to full trust (writes any path)")
                              : tx("改为受限（下次启动生效）", "Switch to restricted (applies next start)")}
                          </button>
                        ) : (
                          <span className="plg-detail-dim">
                            {tx(`当前档位「${tierTitle(p.tier)}」已生效`, `Current tier “${tierTitle(p.tier)}” is active`)}
                          </span>
                        )}
                        {p.verdict === "trusted" && p.tier === "full" ? (
                          <span className="plg-chip warn">{tx("可写任意路径", "writes any path")}</span>
                        ) : null}
                      </div>
                      <PermissionDetails lines={p.permissions} />
                    </Fold>

                    <Fold title={tx("插件信息与封面", "Info & cover")} hint={tx("只改展示层", "display only")}>
                      <PluginMetaEditor entry={p} meta={meta} onNotice={setNotice} onError={setErr} />
                    </Fold>

                    {(p.manifest.contributes.settings?.length ?? 0) > 0 ? (
                      <>
                        <h4 className="plg-sec">{tx("插件配置", "Plugin settings")}</h4>
                        <PluginConfigEditor entry={p} onNotice={setNotice} onError={setErr} />
                      </>
                    ) : null}

                    {declaredRootKeys(p.manifest).length ? (
                      <Fold title={tx("目录绑定", "Folder bindings")} hint={tx("它申请过哪些目录", "which folders it asked for")}>
                        <PluginRootsFold entry={p} roots={repo.roots} onError={setErr} />
                      </Fold>
                    ) : null}

                    {p.manifest.contributes.panels?.length ? (
                      <>
                        <h4 className="plg-sec">{tx("面板", "Panels")}</h4>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                          {p.manifest.contributes.panels.map((panel) => (
                            <button
                              key={panel.id}
                              className="btn"
                              disabled={!on || p.verdict !== "trusted"}
                              onClick={() => requestOpenPanel(panelViewId(p.id, panel.id))}
                            >
                              {tx(`打开「${panel.title}」`, `Open “${panel.title}”`)}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {p.themes.length ? (
                      <>
                        <h4 className="plg-sec">{tx("主题", "Themes")}</h4>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                          {p.themes.map((th) => (
                            <button key={th.key} className="btn" disabled={!on || p.verdict !== "trusted"} onClick={() => void setActiveTheme(th.key)}>
                              {th.title}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {(p.manifest.contributes.widgets?.length ?? 0) > 0 ? (
                      <>
                        <h4 className="plg-sec">{tx("小部件", "Widgets")}</h4>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                          {(p.manifest.contributes.widgets ?? []).map((w) => {
                            const key = widgetKey(p.id, w.id);
                            const hidden = hiddenWidgets.includes(key);
                            return (
                              <button
                                key={w.id}
                                className="btn"
                                disabled={!on || p.verdict !== "trusted"}
                                onClick={() => (hidden ? showWidget(key) : hideWidget(key))}
                              >
                                {hidden ? tx(`显示「${w.title}」`, `Show “${w.title}”`) : tx(`隐藏「${w.title}」`, `Hide “${w.title}”`)}
                              </button>
                            );
                          })}
                        </div>
                        <div className="plg-detail-dim" style={{ fontSize: "var(--fs-xs)" }}>
                          {tx("小部件是主窗口内的浮层，不是系统级窗口；透明/无边框只是它的一种表现形态。关闭只影响本次会话。", "Widgets are in-window overlays, not system windows; transparency/frameless is just one presentation. Closing only affects this session.")}
                        </div>
                      </>
                    ) : null}

                    {p.manifest.contributes.commands?.length ? (
                      <>
                        <h4 className="plg-sec">{tx("命令", "Commands")}</h4>
                        <div className="plg-detail-dim">{p.manifest.contributes.commands.map((c) => c.title || c.id).join(" · ")}</div>
                      </>
                    ) : null}

                    <PluginContribActions entry={p} usable={on && p.verdict === "trusted"} onNotice={setNotice} onError={setErr} />

                    {p.error || p.logs.length ? (
                      <Fold title={tx("诊断", "Diagnostics")} hint={p.error ? tx("有错误", "has error") : tx("最近日志", "recent logs")}>
                        {p.error ? <div className="plg-detail-desc" style={{ color: "var(--danger)" }}>{p.error}</div> : null}
                        <div className="plg-detail-desc" style={{ fontFamily: "var(--font-mono)", maxHeight: 160, overflow: "auto" }}>
                          {p.logs.slice(-8).map((l, i) => <div key={i}>{l.text}</div>)}
                        </div>
                      </Fold>
                    ) : null}
                  </section>

                  <aside className="plg-col-side">
                    <h4 className="plg-sec">{tx("概览", "Overview")}</h4>
                    <div className="plg-detail-dim" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span>{tx("版本", "Version")} v{p.version}</span>
                      <span>{tx("来源", "Source")} {p.source}{p.origin ? ` · ${p.origin}` : ""}</span>
                      <span>{tx("安装于", "Installed")} {p.installedAt ? new Date(p.installedAt).toLocaleString() : "—"}</span>
                      <span>{tx("作者", "Author")} {metaAuthor(p.manifest.author ?? "—", meta)}</span>
                      {metaHomepage(p.manifest.homepage ?? "", meta) !== "" ? (
                        <span style={{ wordBreak: "break-all" }}>{metaHomepage(p.manifest.homepage ?? "", meta)}</span>
                      ) : null}
                      {p.manifest.license ? <span>{tx("许可证", "License")} {p.manifest.license}</span> : null}
                    </div>

                    <h4 className="plg-sec">{tx("信任", "Trust")}</h4>
                    <div className="plg-detail-dim">
                      {trustLabel(p)} · {tierTitle(p.tier)} · {tx(`${p.permissions.length} 项声明`, `${p.permissions.length} declared item(s)`)}
                    </div>
                    {p.verdict !== "trusted" ? (
                      <div style={{ marginTop: "var(--sp-2)" }}>
                        <button className="btn primary" disabled={!!busy} onClick={() => void doApprove(p, DEFAULT_TRUST_TIER)}>
                          {tx("批准（受限）", "Approve (restricted)")}
                        </button>
                      </div>
                    ) : null}

                    <h4 className="plg-sec">{tx("版本历史", "Version history")}</h4>
                    <PluginVersions
                      entry={p}
                      onNotice={setNotice}
                      onError={setErr}
                      onPending={(plan) => {
                        // 回滚也是一次新安装：档位重新从受限开始选
                        setPendingTier(DEFAULT_TRUST_TIER);
                        setPendingInstall(plan);
                      }}
                    />

                    <div style={{ marginTop: "var(--sp-3)" }}>
                      <PluginPublishForm entry={p} meta={meta} onNotice={setNotice} onError={setErr} />
                    </div>

                    <div className="plg-danger-zone">
                      <h4 className="plg-sec">{tx("危险操作", "Danger zone")}</h4>
                      <div className="plg-actions plg-danger">
                        <button className="btn danger" disabled={!!busy} onClick={() => void doUninstall(p.id)}>
                          {confirmUninstall === p.id ? tx("再点一次确认卸载", "Click again to uninstall") : tx("卸载", "Uninstall")}
                        </button>
                      </div>
                    </div>
                  </aside>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {drafts.length ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)", marginTop: "var(--sp-2)" }}>
            <span style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>{tx("草稿", "Drafts")}</span>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-faint)" }}>{drafts.length}</span>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{tx("草稿不会安装、不会启动；转正必须过批准卡", "Drafts are not installed or started; promotion needs approval")}</span>
          </div>
          {drafts.map((d) => (
            <div key={d.name} className="plg-item">
              <div className="plg-item-row">
                <div className="plg-item-main" style={{ cursor: "default" }}>
                  <span className="plg-cover" aria-hidden="true"><span className="plg-item-ico"><IconPuzzle size={28} /></span></span>
                  <span className="plg-item-body">
                    <span className="plg-item-line">
                      <span className="plg-item-name">{d.title}</span>
                      <span className="plg-item-id">{d.name}</span>
                      <span className="plg-chip">{tx("草稿", "draft")}</span>
                      {/* 草稿也按产物标：用户/AI 说的是"一份主题草稿"，不是"一份代码草稿"。 */}
                      {d.manifest
                        ? kindsOrFallback(pluginKinds(d.manifest)).map((k) => (
                            <span key={k.zh} className="plg-chip">{tx(k.zh, k.en)}</span>
                          ))
                        : null}
                    </span>
                    <span className="plg-item-desc">
                      {d.version ? `v${d.version}` : tx("清单有问题", "manifest issue")}
                      {d.issue ? ` · ${d.issue}` : ""}
                    </span>
                  </span>
                </div>
                <button
                  className="btn"
                  disabled={!draftPreviewTarget(d)}
                  title={draftPreviewTarget(d) ? tx("先看画面：不安装、不运行主进程", "See what it looks like: installs nothing, runs no host") : tx("这份草稿没有可预览的界面", "Nothing visual to preview")}
                  onClick={() => setPreviewDraft(d)}
                >
                  {tx("预览", "Preview")}
                </button>
                <button className="btn primary" disabled={!!busy || !!d.issue} onClick={() => void doPromote(d)}>
                  {tx("转正", "Promote")}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => void doDiscard(d.name)}>
                  {confirmDiscard === d.name ? tx("再点一次丢弃", "Click again to discard") : tx("丢弃", "Discard")}
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {!visible.length && !drafts.length && !pendingInstall && !pendingDraft && !pendingMarket ? (
        <div className="plg-empty">
          <IconPuzzle />
          {tx("还没有插件", "No plugins yet")}
        </div>
      ) : null}

      {repo.issues.length ? (
        <div className="plg-notice err" role="status" style={{ whiteSpace: "pre-wrap" }}>
          {repo.issues.slice(0, 6).join("\n")}
        </div>
      ) : null}

      {previewDraft && repo.appDir ? (
        <DraftPreviewDialog appDir={repo.appDir} name={previewDraft.name} entry={previewDraft} onClose={() => setPreviewDraft(null)} />
      ) : null}

      </div>

      {marketOpen ? (
        <aside className="plg-market-pane" aria-label={tx("插件市场", "Plugin market")}>
          <div className="plg-head">
            <span className="plg-title">{tx("插件市场", "Plugin market")}</span>
            <span className="plg-sub">{tx("GitHub 话题检索；装前仍过权限批准卡", "GitHub topic search; permissions are still approved before install")}</span>
            <div className="plg-head-actions">
              <button className="btn" onClick={() => closeMarketDialog()}>{tx("收起市场", "Hide market")}</button>
            </div>
          </div>
          <div className="plg-market-body">
            <PluginMarketView installed={installedRepos} onInstall={installFromMarket} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
