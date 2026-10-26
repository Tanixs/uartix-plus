/**
 * P174-A6：插件仓库的前端 IO 层（读盘、装、卸、跑）。
 *
 * 分工仍然和 A5 一样：
 * - 纯判据在 `install.ts` / `repo.ts` / `manifest.ts`（可单测）；
 * - 状态机与日志缓冲在 `uiRuntime.ts`（可单测）；
 * - **这个文件只做"调命令 + 拼顺序 + 把结果喂回去"**，`invoke` 在 vitest 里跑不起来，
 *   所以这里一行判据都不该有。写在这里的 `if` 只允许是"上一步失败了就别做下一步"。
 *
 * A6 相对 A5 的最大变化：状态从"只有一个内置示例"变成"一张装过的表"。
 * 示例插件已经删掉了——现在装一个真包（`examples/plugins/hello-uartix`）就能看到同样的东西，
 * 而"内置一个假插件"会让人永远分不清"插件真的跑起来了"和"示例跑起来了"。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { BOOTSTRAP_SOURCE } from "./bootstrap";
import { ROOT_KEY_RE, validateExtension, type PluginManifest } from "./manifest";
import { setActiveExtTheme, themeKey, type ActiveExtTheme } from "./activeTheme";
import { planHostStart, HostPlanError } from "./hostPlan";
import { guardThemeCss, type ThemeCssResult } from "./themeCss";
import { decodeMessage, encodeMessage, RPC_TIMEOUT_MS, type PluginToHost } from "./protocol";
import {
  applyInstall,
  applyUninstall,
  fingerprintOf,
  needsApproval,
  planInstall,
  trustRecordFor,
  type InstallPlan,
} from "./install";
import {
  REPO_VERSION,
  emptyIndex,
  emptyTrust,
  pluginDir,
  flattenPermissions,
  resolveInExtDir,
  STAGING_DIR,
  trustVerdict,
  type PluginIndex,
  type PluginIndexItem,
  type TrustBook,
  type TrustVerdict,
} from "./repo";
import {
  emptyPluginEngineSettings,
  loadPluginEngineSettings,
  loadJournal,
  savePluginEngineSettings,
  saveJournal,
  loadIndex,
  loadTrust,
  saveIndex,
  saveTrust,
  type PluginEngineSettings,
} from "./store";
import {
  appendJournalEvent,
  approveJournalEvent,
  createJournalBook,
  installJournalEvent,
  toJournalState,
  verifyJournal,
  type JournalBook,
  type JournalEvent,
} from "./journal";
import {
  applyPluginConfigPatch,
  effectivePluginConfig,
  normalizePluginConfig,
} from "./pluginConfig";
import {
  appendLog,
  canStart,
  canStop,
  nextPhase,
  type PluginLogLine,
  type PluginPhase,
  readinessAction,
} from "./runtime";
import { discardDraft, draftDirOf, getDraft } from "./draft";
import { queueDraftPromotion, type DraftPromotionRequest } from "./draftRequests";
import {
  closeOut,
  logWriteIssue,
  logsFileDir,
  scheduleFlush,
  setLogsRootResolver,
} from "./hostLogsSink";

/** 一枚可用的插件主题（已过净化）。 */
export interface PluginThemeItem {
  /** `plg:<pluginId>:<themeId>` */
  key: string;
  id: string;
  title: string;
  scheme: "dark" | "light" | null;
  css: string;
}

/** 一个已安装的插件：**账本上的事实**（装在哪、批过什么）+ **运行时状态**（在不在跑、日志）。 */
export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  dir: string;
  version: string;
  installedAt: number;
  source: PluginIndexItem["source"];
  /** 来源（`github:owner/name`）；空 = 本地目录装的。市场那栏据此把卡片标成「已安装」。 */
  origin?: string;
  /**
   * 用户启用了它吗。**装完是 false**：不启用的插件不进「+面板」、不许起进程。
   * 与 `verdict` 是两件事：`enabled` 是意愿，`verdict` 是"批过没有"。面板要两个都成立才出现。
   */
  enabled: boolean;
  /** 与信任库比出来的三态；`needs-approval`/`changed` 的面板会顶一条黄条。 */
  verdict: TrustVerdict;
  permissions: string[];
  /** `contributes.settings` 的覆盖值（只含与默认值不同的键）。 */
  config: Record<string, unknown>;
  /** 这个插件贡献的主题（CSS 已经过宿主净化器；没过的不会出现在这里，问题在 issues 里）。 */
  themes: PluginThemeItem[];
  phase: PluginPhase;
  pid?: number;
  error?: string;
  logs: PluginLogLine[];
  nodePath?: string;
  nodeVersion?: string;
}

export interface PluginEngineSnapshot {
  loading: boolean;
  appDir: string;
  /** 工作区根（`$WS`）；空串 = 没登记。面板要据此提示"某个插件需要它"。 */
  workspaceRoot: string;
  /** 当前在画的插件主题键；空串 = 用内置主题。 */
  activeTheme: string;
  /** 外部目录登记表（`$EXT:<key>` → 绝对路径）。面板要据此提示"某个插件缺哪个目录"。 */
  roots: Record<string, string>;
  entries: InstalledPlugin[];
  /**
   * 变更账本的事件（oldest→newest，纯判据与上限在 `journal.ts`）。
   *
   * 为什么进快照：账本早就在写、也一直在被 `verifyJournal` 校验，**但没有任何一面展示过它**——
   * "谁批准了哪一版""这条命令是什么时候跑的"今天只能去翻 JSON 文件。R7② 把它做成
   * 「运行日志」的第二个通道，所以它必须与其余状态同一个引用、同一次 emit（§1-8：不许有第二处真相）。
   */
  journal: JournalEvent[];
  /** 读盘过程中发现的问题（坏清单、悬空目录、账本损坏…）。**不吞**，面板上要能看见。 */
  issues: string[];
}

export interface PluginPaths {
  appDir: string;
  pluginsRoot: string;
  hostDir: string;
  bootstrapPath: string;
}

/** 一次目录绑定的**归因**：谁请的、它是不是用来写的。设置页与场景改动时不给（那是用户自己在动手）。 */
export interface RootBindOrigin {
  pluginId: string;
  forWrite: boolean;
}

/** 安装"成功但有话说"的事实。空对象 = 什么也不用说。 */
export interface InstallWarn {
  skippedLinks: number;
}

export interface NodeProbe {
  found: boolean;
  path: string;
  version: string;
  tried: string[];
}

interface FsReadResult {
  exists: boolean;
  text: string;
  truncated: boolean;
}

/** 历史版本归档目录（`.versions/<id>/<version>-<ts>/`）。reload 的目录列举要跳过它。 */
export const VERSIONS_DIR = ".versions";

let paths: PluginPaths | null = null;
let node: NodeProbe | null = null;
let index: PluginIndex | null = null;
let trust: TrustBook | null = null;
/** 变更日志（B4）。`null` = 还没起底；磁盘上真没有时由 `reload()` 按当前账本建一份。 */
let journal: JournalBook | null = null;
/** 最近一次日志写失败。下一次 reload 把它摆在 issues 第一条，不让它随刷新消失。 */
let journalWriteIssue: string | null = null;

/**
 * 每个 handle 一枚 token。
 *
 * 为什么不是模块级的一个 string：装了第二个插件、它也起了一次，后起的那次会把值覆盖掉，
 * 于是前一个插件的 `dispose` 带着错的 token 过去——**引导脚本会静默丢弃它**（那是设计），
 * 表现是"disposer 没跑"：插件没来得及把状态落盘就被杀了。丢的是数据，不是一条报错。
 */
const tokens = new Map<string, string>();

/** 遗留宿主只收回一次（判据在 `reload()` 里）：`reload()` 会被装包/启用反复调用，每次都收就等于杀正在跑的插件。 */
let reclaimedOrphanHosts = false;

/**
 * 在途 RPC。键是宿主自己生成的 id（不是插件给的），值带一个超时定时器。
 *
 * 为什么要超时：`call` 发出去之后，插件可能因为死循环、等一个永不返回的 Promise、
 * 或者干脆崩了而永远不回 `result`。没有定时器的话，面板上的那一次点击就永远转圈，
 * 而且**看不出是插件的问题还是界面的问题**。
 */
interface PendingCall {
  res: (v: unknown) => void;
  rej: (e: Error) => void;
  timer: number;
  /** 谁发的：进程退出时要按 handle 把它的在途调用单独拒掉，不能一锅端（别的插件还在跑）。 */
  handle: string;
}
const pending = new Map<string, PendingCall>();
let callSeq = 0;

/** 面板事件订阅（插件 `ctx.panels.emit` 的另一端）。 */
export interface PanelEvent {
  pluginId: string;
  panelId: string;
  event: string;
  payload: unknown;
}
type PanelEventCb = (p: PanelEvent) => void;
const panelSubs = new Set<PanelEventCb>();

export function onPanelEvent(cb: PanelEventCb): () => void {
  panelSubs.add(cb);
  return () => panelSubs.delete(cb);
}

let repo: PluginEngineSnapshot = { loading: true, appDir: "", workspaceRoot: "", activeTheme: "", roots: {}, entries: [], journal: [], issues: [] };
/** 插件子系统自己的设置（工作区根、外部目录、当前主题）。 */
let extSettings: PluginEngineSettings = emptyPluginEngineSettings();
const subs = new Set<() => void>();
const unlisteners: UnlistenFn[] = [];
let loadingPromise: Promise<void> | null = null;

function emit(): void {
  // `useSyncExternalStore` 靠引用变化决定要不要重渲染：原地改就等于"数据变了界面不动"
  repo = { ...repo, entries: repo.entries.slice(), issues: repo.issues.slice() };
  for (const f of subs) f();
}

function patch(id: string, p: Partial<InstalledPlugin>): void {
  const i = repo.entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  const next = repo.entries.slice();
  next[i] = { ...next[i], ...p };
  repo = { ...repo, entries: next };
  emit();
}

function log(id: string, line: PluginLogLine): void {
  const i = repo.entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  const next = repo.entries.slice();
  next[i] = { ...next[i], logs: appendLog(next[i].logs, line) };
  repo = { ...repo, entries: next };
  emit();
  // 顺手记一笔盘（攒批，2 秒一刷；判据与轮转在 `hostLogsSink` + Rust 的 `plugin_fs_append`）。
  // 没有这一步，"上次崩在哪"就只活到本次会话结束——而那正是最该被看见的一段。
  scheduleFlush(id, line);
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getSnapshot(): PluginEngineSnapshot {
  return repo;
}

export function getEntry(id: string): InstalledPlugin | undefined {
  return repo.entries.find((e) => e.id === id);
}

/* ============================ 读盘 ============================ */

/** 把 `<root>/<id>/plugin.json` 读出来并校验。返回的 issues 由调用方合并（不静默丢）。 */
async function readManifestOf(dir: string, root: string): Promise<{ manifest?: PluginManifest; issue?: string }> {
  const r = await invoke<FsReadResult>("plugin_fs_read", { path: `${dir}/plugin.json`, roots: [root] });
  if (!r.exists) return { issue: "缺 plugin.json（不是插件目录）" };
  if (r.truncated) return { issue: "plugin.json 超过 256 KiB，已拒绝解析" };
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { issue: "plugin.json 不是合法 JSON" };
  }
  const v = validateExtension(raw);
  if (!v.ok) return { issue: v.errors[0] ?? "清单校验失败" };
  return { manifest: v.manifest };
}

/**
 * 追加一条变更日志并落盘。失败返回一句人话，**不抛**——
 * 账本已经写成功了，为了日志没写上而去回滚账本，才是真丢数据。
 */
async function appendJournal(ev: JournalEvent): Promise<string | null> {
  if (!paths) return "变更日志没有写入：插件目录还没读到";
  if (!journal) {
    journal = createJournalBook(
      toJournalState(index ?? emptyIndex(), trust ?? emptyTrust(), extSettings.activeTheme),
      ev.at,
    );
  }
  journal = appendJournalEvent(journal, ev);
  // 立刻进快照：「运行日志」的操作账本通道读的就是这里。写完盘再发布的话，
  // 磁盘慢的那几百毫秒里界面是旧的，而这次操作明明已经生效了。
  repo = { ...repo, journal: journal.events.slice() };
  emit();
  try {
    await saveJournal(journal, [paths.pluginsRoot]);
    return null;
  } catch (e) {
    return `变更日志写入失败：${String((e as Error)?.message ?? e)}`;
  }
}

/** 写账本成功之后调：日志写失败只上报，不影响这次操作的结果。 */
async function recordJournal(ev: JournalEvent): Promise<void> {
  const err = await appendJournal(ev);
  if (!err) return;
  journalWriteIssue = err;
  repo = { ...repo, issues: [...repo.issues, err] };
  emit();
}

/**
 * 重新读一遍整个仓库（磁盘是唯一真相）。
 *
 * 顺序刻意是"先列目录、再读每份清单、最后读两本账"：
 * 账本只用来补 `installedAt`/`source`/`verdict`，**不是**"有哪些插件"的来源。
 * 反过来相信账本的后果是：用户手工删了目录，界面上还留着一个点了就报错的条目。
 */
export async function reload(): Promise<void> {
  repo = { ...repo, loading: true };
  emit();
  const issues: string[] = [];
  if (journalWriteIssue) {
    issues.push(journalWriteIssue);
    journalWriteIssue = null;
  }
  try {
    paths = await invoke<PluginPaths>("plugin_paths");
    // 落盘的日志文件在 `<appDir>/plugins/<id>/logs/`。这里注册的是"取值"而不是值本身：
    // 那一层不许反过来 import 引擎（会成环），而它 flush 的时候 `paths` 一定已经在这了。
    setLogsRootResolver(() => paths?.appDir ?? "");
    const root = paths.pluginsRoot;
    const listing = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("plugin_fs_list", {
      dir: root,
      roots: [root],
    });

    const loadedIndex = await loadIndex([root]);
    const loadedTrust = await loadTrust([root]);
    const loadedSettings = await loadPluginEngineSettings([root]);
    const loadedJournal = await loadJournal([root]);
    index = loadedIndex.index;
    trust = loadedTrust.trust;
    extSettings = loadedSettings.settings;
    journal = loadedJournal.journal;
    issues.push(...loadedIndex.issues, ...loadedTrust.issues, ...loadedSettings.issues, ...loadedJournal.issues);

    const entries: InstalledPlugin[] = [];
    // 重读盘**不能把运行时状态清掉**：装 B 的时候 A 可能正跑着，
    // 一次 reload 把它刷成"未启动"就会出现"界面说没跑、进程还活着"（点启动会以为在重试）。
    // 只在版本没变时沿用，版本变了说明是另一个构建，旧日志与旧状态都不再有意义。
    const before = new Map(repo.entries.map((e) => [e.id, e]));
    for (const item of listing.items) {
      if (!item.dir || item.name === STAGING_DIR || item.name === VERSIONS_DIR) continue;
      const dir = `${root}/${item.name}`;
      const { manifest, issue } = await readManifestOf(dir, root);
      if (!manifest) {
        issues.push(`「${item.name}」已跳过：${issue}`);
        continue;
      }
      // 目录名与清单 id 不一致 ⇒ 宿主按清单 id 拼路径，会指到一个不存在的目录。
      // 这种包"装上了但点不动"，与其让用户在启动失败里猜，不如现在就说清楚。
      if (manifest.id !== item.name) {
        issues.push(`「${item.name}」已跳过：目录名与清单 id（${manifest.id}）不一致，请重装`);
        continue;
      }
      const fingerprint = fingerprintOf(manifest);
      const rec = trust.items[manifest.id];
      const old = before.get(manifest.id);
      const keep = old && old.version === manifest.version ? old : null;
      // 主题 CSS 在这里读（而不是等插件进程起来）：主题要在**面板关着**的时候也能画，
      // 而那时插件进程可能已经被空闲回收了。它只是包里的一个静态文件。
      const themes: PluginThemeItem[] = [];
      for (const decl of manifest.contributes.themes ?? []) {
        const got = await readThemeCss(dir, root, decl.entry);
        if (!got.css) {
          issues.push(`「${manifest.id}」的主题「${decl.title}」已跳过：${got.issue}`);
          continue;
        }
        themes.push({
          key: themeKey(manifest.id, decl.id),
          id: decl.id,
          title: decl.title,
          scheme: decl.scheme ?? null,
          css: got.css,
        });
      }
      entries.push({
        id: manifest.id,
        manifest,
        dir,
        version: manifest.version,
        installedAt: index.items[manifest.id]?.installedAt ?? 0,
        source: index.items[manifest.id]?.source ?? "import",
        enabled: index.items[manifest.id]?.enabled ?? true,
        origin: index.items[manifest.id]?.origin,
        verdict: trustVerdict(rec, fingerprint),
        permissions: flattenPermissions(manifest),
        config: { ...(extSettings.pluginConfig[manifest.id] ?? {}) },
        themes,
        phase: keep ? keep.phase : "idle",
        pid: keep?.pid,
        error: keep?.error,
        logs: keep ? keep.logs : [],
        nodePath: keep?.nodePath,
        nodeVersion: keep?.nodeVersion,
      });
    }
    // 账本里有、盘上没有的条目：说明目录被手工删过。说出来，别静默丢。
    for (const id of Object.keys(index.items)) {
      if (!entries.some((e) => e.id === id)) issues.push(`账本里有「${id}」，但目录已经不在了（可在此卸载）`);
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));

    /**
     * 谁来画：设置里那枚如果还在（插件没卸、主题没删）就用它，否则清空回到内置。
     * **找不到就清**——留一个画不出来的键，界面会一直"欠"一场不存在的主题切换。
     */
    const wanted = extSettings.activeTheme;
    const found = wanted ? entries.flatMap((e) => e.themes).find((t) => t.key === wanted) : undefined;
    const owner = found ? entries.find((e) => e.themes.some((t) => t.key === found.key)) : undefined;
    // 主题插件和面板/小部件/命令同一条门：**启用且已批准**才允许它的主题上屏。
    // 停用主题插件时若它正在供主题，这里会退回内置——否则“停用”只停了进程，界面还挂着它的皮。
    const ownerUsable = !!owner && owner.enabled && owner.verdict === "trusted";
    if (wanted && (!found || !owner || !ownerUsable)) {
      const why = !found || !owner
        ? "已经不在了"
        : !owner.enabled
          ? "的插件已停用"
          : "的插件权限还没批准";
      issues.push(`设置里选中的插件主题「${found?.title ?? wanted}」${why}，已回到内置主题`);
      extSettings = { ...extSettings, activeTheme: "" };
      if (paths) await savePluginEngineSettings(extSettings, [paths.pluginsRoot]);
      // 这次修复也是一次变更：不记下来，下一次核对就会把它报成"账本被人动过"。
      if (journal) {
        const err = await appendJournal({ t: "theme", at: Date.now(), key: "" });
        if (err) issues.push(err);
      }
    }
    setActiveExtTheme(
      found && owner && ownerUsable
        ? ({ id: found.key, name: found.title, scheme: found.scheme, css: found.css, pluginId: owner.id } satisfies ActiveExtTheme)
        : null,
    );

    /**
     * B4：日志与账本的核对。
     *
     * 没有日志（老版本升上来、文件被删/读坏）⇒ 以当前账本起底；**起底之后只追加**。
     * 有日志 ⇒ 从头重放，逐字段比。对不上不自动"修复"：那会把"有人动过账本"这件事
     * 抹成一次静默的重新起底，而这正是这条日志要防的。
     */
    const actualState = toJournalState(loadedIndex.index, loadedTrust.trust, extSettings.activeTheme);
    if (journal) {
      issues.push(...verifyJournal(journal, actualState));
    } else {
      journal = createJournalBook(actualState, Date.now());
      try {
        await saveJournal(journal, [root]);
      } catch (e) {
        issues.push(`变更日志起底失败：${String((e as Error)?.message ?? e)}`);
      }
    }

    /* R7 真机检查抓到的第二条：换页面（刷新 / 崩溃重载 / dev 重启）之后，Rust 那张表里
       还挂着上一张页面起的宿主，而这一张页面**没有它的 token**——对它说什么都不会被认
       （引导脚本按 token 丢消息）。表现就是"界面说没跑、进程还在占 GPU"，而且新起一次还要先替换它。
       所以每个前端生命周期只收回一次：只收"不是我起的"那些，运行中的插件绝不在这里被杀
       （`reload()` 会被装包/启用等动作反复调用， hence the one-shot guard）。 */
    if (!reclaimedOrphanHosts) {
      reclaimedOrphanHosts = true;
      try {
        const alive = await invoke<{ hosts: { handle: string; pid: number }[] }>("plugin_host_status");
        for (const h of alive.hosts) {
          if (tokens.has(h.handle)) continue;
          await invoke("plugin_host_stop", { handle: h.handle }).catch(() => undefined);
          const hit = entries.find((e) => e.id === h.handle);
          if (hit) hit.logs = appendLog(hit.logs, { at: Date.now(), level: "warn", text: `收回上一张页面遗留的宿主（pid ${h.pid}）` });
        }
      } catch {
        /* 状态查询失败不该挡住读盘；这张表下一次启动还会再收 */
      }
    }

    repo = {
      loading: false,
      appDir: paths.appDir,
      workspaceRoot: extSettings.workspaceRoot,
      activeTheme: extSettings.activeTheme,
      roots: { ...extSettings.roots },
      entries,
      journal: journal?.events.slice() ?? [],
      issues,
    };
    emit();
  } catch (e) {
    repo = {
      loading: false,
      appDir: paths?.appDir ?? "",
      workspaceRoot: extSettings.workspaceRoot,
      activeTheme: extSettings.activeTheme,
      roots: { ...extSettings.roots },
      entries: [],
      journal: journal?.events.slice() ?? [],
      issues: [...issues, `读取插件目录失败：${String((e as Error)?.message ?? e)}`],
    };
    emit();
  }
}

/** 幂等加载：面板挂载时调，重复调只读一次盘。 */
export function ensureLoaded(): Promise<void> {
  if (!loadingPromise) loadingPromise = reload().finally(() => (loadingPromise = null));
  return loadingPromise;
}

/**
 * 登记/清除工作区根（`$WS`）。
 *
 * **只影响下一次启动**：已经在跑的宿主进程，它的 `--allow-fs-write` 是启动那一刻定死的，
 * 改不了（内核参数没有"热改"这回事）。所以这里不重启任何东西，只在面板上说清楚。
 *
 * `by` 是**归因**，不是判据：设置页改的没有归因（那是用户自己在动手），
 * 插件面板里的「选工作区」按钮改的会带上是哪枚插件请的。两种都要进账本——
 * "工作区根在什么时候变成了哪个目录"这件事，与"谁请的"一样，都是要被回放出来的决定。
 */
export async function setWorkspaceRoot(path: string, by?: RootBindOrigin): Promise<void> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const value = path.trim();
  extSettings = { ...extSettings, workspaceRoot: value };
  await savePluginEngineSettings(extSettings, [paths.pluginsRoot]);
  repo = { ...repo, workspaceRoot: value };
  emit();
  await recordJournal({ t: "root", at: Date.now(), id: by?.pluginId ?? "", spec: "$WS", path: value, forWrite: by?.forWrite ?? false });
  if (by?.pluginId) log(by.pluginId, { at: Date.now(), level: "info", text: `工作区根已登记为 ${value || "（清除）"}，下一次启动生效` });
}

/**
 * 启用/停用一个插件。
 *
 * 两件事一起做，缺一件都是 bug：
 * 1. 写账本（`enabled`）——决定它的面板要不要出现在「+面板」；
 * 2. **停用时先把进程停掉**——否则界面里已经没有它的面板了，后台还挂着一个没人看得见的进程。
 *
 * 与"批准"是两条独立的路：批准是"我同意它的权限"，启用是"我现在要用它"。
 * 装完默认不启用，用户点这一下才算用上；权限变了的插件要重新批准才 `trusted`，
 * 在那之前即使 `enabled` 也不进菜单（见 `panelEnabled`）。
 */
export async function setEnabled(id: string, on: boolean): Promise<void> {
  const cur = getEntry(id);
  if (!cur) return;
  if (!on && canStop(cur.phase)) await stop(id);
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const index = (await loadIndex([paths.pluginsRoot])).index;
  const item = index.items[id];
  if (!item) return; // 账本里没有它（磁盘上躺着的孤儿）：等它走一次安装再说
  await saveIndex({ ...index, items: { ...index.items, [id]: { ...item, enabled: on } } }, [paths.pluginsRoot]);
  const ev: JournalEvent = on ? { t: "enable", at: Date.now(), id } : { t: "disable", at: Date.now(), id };
  await recordJournal(ev);
  await reload();
}

/**
 * 精确启用集（P174-B2）：不在 `ids` 里的插件全部停用，**只写一次账、只 reload 一次**。
 *
 * 为什么不让 Profile 循环调 `setEnabled`：一次场景切换会触发 N 次读盘 + N 次重绘，
 * 而中间态（停了一半 / 启了一半）会被界面看见。这里先停后启，账本一次落盘；
 * 停用仍逐个先停进程（顺序与 `setEnabled` 相同），避免"界面已经没了、后台还在跑"。
 */
export async function setEnabledSet(ids: readonly string[]): Promise<{ changed: { id: string; on: boolean }[] }> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const root = paths.pluginsRoot;
  // 用已加载的 index（reload 归一过的）：重新 loadIndex 遇到坏账本会得到空表，
  // 随后 saveIndex 一次就把所有插件的启用状态抹平了。没有加载过才读盘。
  const loaded = index ?? (await loadIndex([root])).index;
  const target = new Set(ids);
  const changed: { id: string; on: boolean }[] = [];
  for (const [id, item] of Object.entries(loaded.items)) {
    const on = target.has(id);
    if (item.enabled !== on) changed.push({ id, on });
  }
  if (!changed.length) return { changed: [] };

  for (const c of changed.filter((x) => !x.on).sort((a, b) => b.id.localeCompare(a.id))) {
    const e = getEntry(c.id);
    if (e && canStop(e.phase)) await stop(c.id);
  }

  const items = { ...loaded.items };
  for (const c of changed) items[c.id] = { ...items[c.id], enabled: c.on };
  const next: PluginIndex = { ...loaded, items };
  await saveIndex(next, [root]);
  index = next;
  for (const c of changed) {
    await recordJournal(
      c.on ? { t: "enable", at: Date.now(), id: c.id } : { t: "disable", at: Date.now(), id: c.id },
    );
  }
  await reload();
  return { changed };
}

/* ============================ 插件配置 ============================ */

/** 存储的覆盖值（只含用户改过的键）。 */
export function getPluginConfig(id: string): Record<string, unknown> {
  return { ...(extSettings.pluginConfig[id] ?? {}) };
}

/** 默认值 + 覆盖值 = 插件实际读到的配置。 */
export function getEffectivePluginConfig(id: string): Record<string, string | number | boolean> {
  const e = getEntry(id);
  if (!e) return {};
  return effectivePluginConfig(e.manifest.contributes.settings ?? [], extSettings.pluginConfig[id] ?? {});
}

async function commitPluginConfig(id: string, values: Record<string, string | number | boolean>): Promise<void> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const next = { ...extSettings.pluginConfig };
  if (Object.keys(values).length) next[id] = values;
  else delete next[id];
  extSettings = { ...extSettings, pluginConfig: next };
  await savePluginEngineSettings(extSettings, [paths.pluginsRoot]);
  patch(id, { config: { ...values } });
}

/** 键级 patch；`null` 删除覆盖、回落默认。校验失败整单拒绝（不写半套）。 */
export async function setPluginConfig(id: string, patchValues: Record<string, unknown>): Promise<void> {
  const e = getEntry(id);
  if (!e) throw new Error(`没有这个插件：${id}`);
  const r = applyPluginConfigPatch(
    e.manifest.contributes.settings ?? [],
    extSettings.pluginConfig[id] ?? {},
    patchValues,
  );
  if (!r.ok) throw new Error(r.errors.join("；"));
  await commitPluginConfig(id, r.values);
}

/** 用完整覆盖值替换（场景回退用）。 */
export async function replacePluginConfig(id: string, values: Record<string, unknown>): Promise<void> {
  const e = getEntry(id);
  if (!e) throw new Error(`没有这个插件：${id}`);
  const r = normalizePluginConfig(e.manifest.contributes.settings ?? [], values);
  if (!r.ok) throw new Error(r.errors.join("；"));
  await commitPluginConfig(id, r.values);
}

/** 场景应用/回退的审计事件；状态变化由 enable/disable/theme 各自入账。 */
export async function recordProfileEvent(id: string, name: string, action: "apply" | "revert"): Promise<void> {
  await recordJournal({ t: "profile", at: Date.now(), id, name, action });
}

/**
 * 把一份草稿转成**正式安装**（P174-B1）。
 *
 * 转正**必须走批准卡**：草稿是"谁都能写进来的东西"，它凭什么直接变成已装插件？
 * 所以这里只出安装计划；要弹批准条还是直接落盘，由调用方按 `needsApproval` 决定——
 * **不存在任何"免批准转正"路径**。
 *
 * 转正成功后清掉草稿：一份草稿已经变成账本上的事实，再留着就是两个真相。
 */
export async function promoteDraft(name: string): Promise<{ plan: InstallPlan; installed: boolean }> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const dir = draftDirOf(paths.appDir, name);
  const plan = await planFolder(dir, `draft-${Date.now().toString(36)}`);
  if (needsApproval(plan)) return { plan, installed: false };
  await commitDraftPromotion(plan, name);
  return { plan, installed: true };
}

/**
 * 批准之后的落盘半步：装 + 清草稿。
 *
 * 单独抽出来是因为"转正"有两条入口（面板上的转正按钮、AI 请求后的确认卡），
 * 两条都必须以**同一顺序**结束：先装成功，再删草稿。顺序反了——先删草稿再装——
 * 装失败时用户手里就什么都没有了。
 */
export async function commitDraftPromotion(plan: InstallPlan, draftName: string): Promise<InstallWarn> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const warn = await commitInstall(plan, { source: "ai" });
  await discardDraft(paths.appDir, draftName);
  return warn;
}

/**
 * AI 侧的"请求转正"：**只排队，不落盘**。
 *
 * 这里刻意不调 `commitInstall`，连 `promoteDraft` 的"trusted 直接装"那一支都不走：
 * 草稿是"谁都能写进来的东西"，转正必须有人点。工具能做的是把计划算清楚、把权限列出来、
 * 把请求放进待确认表；真正的安装由设置 → 插件管理上的那颗按钮发起。
 */
export async function requestDraftPromotion(
  name: string,
  note?: string,
): Promise<{ request: DraftPromotionRequest; plan: InstallPlan }> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const installed = Object.fromEntries(getSnapshot().entries.map((e) => [e.id, e.version]));
  const draft = await getDraft(paths.appDir, name);
  if (draft.issue || !draft.manifest) {
    throw new Error(`这份草稿不能转正：${draft.issue || "清单读不出来"}`);
  }
  const plan = await planFolder(draftDirOf(paths.appDir, name), `draft-${Date.now().toString(36)}`);
  if (plan.id !== draft.manifest.id) throw new Error("草稿在读取与出计划之间被改动过，请刷新后重试");
  const request: DraftPromotionRequest = {
    name,
    id: draft.id,
    title: draft.title,
    version: draft.version,
    permissions: plan.permissions,
    verdict: plan.verdict,
    requestedBy: "ai",
    at: Date.now(),
    ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}),
    ...(installed[draft.id] ? { installedVersion: installed[draft.id] } : {}),
  };
  queueDraftPromotion(request);
  return { request, plan };
}

/**
 * 绑定/解绑一个外部目录（`$EXT:<key>`）。`path` 传空串 = 解绑。
 *
 * 与工作区根同样的"只影响下一次启动"：`--allow-fs-write` 是启动参数。
 * 但这里**多走一步 reload**：面板要立刻显示"已绑/未绑"，否则用户以为没保存。
 * 绑错了键名（不合规）直接拒——那张表的键必须和清单里写得出来的键同一套规则，
 * 否则会出现"绑了但永远匹配不上"的鬼故事。
 */
export async function setExternalRoot(key: string, path: string, by?: RootBindOrigin): Promise<void> {
  if (!ROOT_KEY_RE.test(key)) throw new Error(`外部目录的键名不合规：${key}`);
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const next = { ...extSettings.roots };
  const v = path.trim();
  if (v) next[key] = v;
  else delete next[key];
  extSettings = { ...extSettings, roots: next };
  await savePluginEngineSettings(extSettings, [paths.pluginsRoot]);
  repo = { ...repo, roots: { ...next } };
  emit();
  const spec = `$EXT:${key}`;
  await recordJournal({ t: "root", at: Date.now(), id: by?.pluginId ?? "", spec, path: v, forWrite: by?.forWrite ?? false });
  if (by?.pluginId) log(by.pluginId, { at: Date.now(), level: "info", text: `${spec} 已登记为 ${v || "（解绑）"}，下一次启动生效` });
}


/**
 * 读一枚主题的 CSS 并过净化器。
 *
 * 判据在 `themeCss.ts` 里（纯函数，可测）。这里只负责读盘与两件与文件本身有关的事：
 * 文件在不在、有没有被截断。**净化不能省**——主题 CSS 是插件唯一能改整张界面的注入面。
 */
async function readThemeCss(dir: string, root: string, entry: string): Promise<ThemeCssResult> {
  const r = await invoke<FsReadResult>("plugin_fs_read", { path: `${dir}/${entry}`, roots: [root] });
  if (!r.exists) return { issue: `缺主题文件 ${entry}` };
  if (r.truncated) return { issue: `主题文件 ${entry} 超过 256 KiB，已拒绝（主题不该这么大）` };
  return guardThemeCss(r.text, entry);
}

/**
 * 选一枚插件主题来画（`key` 传空串 = 回到内置主题）。
 *
 * 只写账本 + 重读盘，**不直接改 DOM**：套用统一走 `applyThemeRuntime`（那张界面配色的唯一出口），
 * 它是被仓库变化触发的。这样"谁在画"只有一个事实源，不会出现两处各改一半。
 */
export async function setActiveTheme(key: string): Promise<void> {
  const want = key.trim();
  // 不能只靠"外观列表里没有这张卡"来挡：场景、AI、App Action 都能拿 key 直接调。
  // 判据与 reload 同一条——插件启用且已批准，主题才准上屏。
  if (want) {
    if (!repo.entries.length) await ensureLoaded();
    const owner = repo.entries.find((e) => e.themes.some((t) => t.key === want));
    if (!owner) throw new Error("这枚主题已经不在插件库里");
    if (!owner.enabled) throw new Error("这枚主题的插件还没启用，先在插件管理里启用它");
    if (owner.verdict !== "trusted") throw new Error("这枚主题的插件权限还没批准，先在插件管理里批准");
  }
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  extSettings = { ...extSettings, activeTheme: want };
  await savePluginEngineSettings(extSettings, [paths.pluginsRoot]);
  await recordJournal({ t: "theme", at: Date.now(), key: extSettings.activeTheme });
  await reload();
}

/* ============================ 装 ============================ */

/**
 * 第一步：从用户选的目录**算出一份安装计划**（不动任何文件）。
 *
 * 读源目录时 `roots` 就是源目录自己——用户刚刚亲手选的就是它，这不算越权。
 * 算完把 `verdict` 交给界面：`trusted` 直接装，其余先弹批准卡。
 */
export async function planFolder(srcDir: string, draftId: string): Promise<InstallPlan> {
  if (!paths) {
    paths = await invoke<PluginPaths>("plugin_paths");
  }
  const { manifest, issue } = await readManifestOf(srcDir, srcDir);
  if (!manifest) throw new Error(`这个目录不能当插件装：${issue ?? "清单读不出来"}`);
  if (!trust) {
    const r = await loadTrust([paths.pluginsRoot]);
    trust = r.trust;
  }
  return planInstall({ appDir: paths.appDir, srcDir, manifest, trust, draftId });
}

/**
 * 第二步：真正落盘。顺序是"复制 → 校验副本 → 对指纹 → 提升 → 写账本"。
 *
 * 为什么对指纹：批准卡上的信息来自**源目录**，而将要运行的是**副本**。这两者之间隔着
 * 一次复制，期间源目录可能被改动（用户自己改、别的程序改）。指纹不一致就中止——
 * 否则批准卡的承诺和实际跑的东西就不是一回事了。
 *
 * 返回"要说给用户听但不算失败"的事实（目前一条：包里有几个符号链接被跳过）。
 * 返回**结构化数据**而不是一句话：文案要在 `.tsx` 里过 `tx()`，否则英文界面上会蹦出一句中文。
 */
export async function commitInstall(
  plan: InstallPlan,
  opts?: { origin?: string; source?: PluginIndexItem["source"] },
): Promise<InstallWarn> {
  if (!paths) throw new Error("还没读到插件目录");
  const root = paths.pluginsRoot;

  const copied = await invoke<{ files: number; bytes: number; skippedLinks: number }>("plugin_copy_dir", {
    src: plan.srcDir,
    dst: plan.stagingPath,
    roots: [root],
  });
  // 跳过的链接不是错误，但**必须说出来**：少了文件却"装成功了"，之后的表现是
  // "某个功能运行时才炸"，那时没人会想到是安装时少拷了东西。（计数在下面的返回值里）

  const staged = await readManifestOf(plan.stagingPath, root);
  if (!staged.manifest) {
    await invoke("plugin_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error(`复制后的副本校验不过（已清理暂存）：${staged.issue ?? "未知"}`);
  }
  const stagedFingerprint = fingerprintOf(staged.manifest);
  if (stagedFingerprint !== plan.fingerprint) {
    await invoke("plugin_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error("包在你确认之后被改动过（权限面已变），请重新安装");
  }
  if (staged.manifest.id !== plan.id) {
    await invoke("plugin_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error(`副本的 id（${staged.manifest.id}）与批准的不一致，已中止`);
  }

  await archiveInstalledVersion(plan.id, plan.version, root);
  await invoke("plugin_promote", { draftId: plan.draftId, id: plan.id, roots: [root] });

  const now = Date.now();
  const next = applyInstall(index ?? { version: 1, items: {} }, trust ?? { version: 1, items: {} }, plan, {
    approvedAt: now,
    // 市场装的记 `market`，本地方向装的记 `local`；草稿转正记 `ai`——列表里要能分辨来路
    source: opts?.source ?? (opts?.origin ? "market" : "local"),
    origin: opts?.origin,
  });
  index = next.index;
  trust = next.trust;
  await saveIndex(next.index, [root]);
  if (needsApproval(plan)) await saveTrust(next.trust, [root]);
  // 信任库只有 needsApproval 时才写（`applyInstall` 的判据），事件里也必须跟着这个判据走：
  // 多带一条 trust 会把"批准时间"在重建里改成今天，正好违反那条不重写信任库的理由。
  await recordJournal(
    installJournalEvent(plan.id, next.index.items[plan.id], needsApproval(plan) ? next.trust.items[plan.id] : undefined, now),
  );

  await reload();
  return { skippedLinks: copied.skippedLinks };
}

export interface PluginVersionEntry {
  /** 归档目录的绝对路径。回滚时把它当 source 走同一套 planFolder/commitInstall。 */
  dir: string;
  version: string;
  title: string;
  archivedAt: number;
}

function safeVersion(v: string): string {
  return v.replace(/[^0-9A-Za-z._+-]/g, "_").slice(0, 40) || "0";
}

/** 归档目录名：`<base36 时间>-<版本>`，按名字排序就是时间顺序。 */
export function versionArchivePath(root: string, id: string, version: string, at: number): string {
  return `${root}/${VERSIONS_DIR}/${id}/${at.toString(36)}-${safeVersion(version)}`;
}

async function pruneVersionArchives(id: string, root: string, keep: number): Promise<void> {
  const base = `${root}/${VERSIONS_DIR}/${id}`;
  const r = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("plugin_fs_list", {
    dir: base,
    roots: [root],
  });
  const dirs = r.items.filter((x) => x.dir).map((x) => x.name).sort();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await invoke("plugin_remove_tree", { path: `${base}/${name}`, roots: [root] }).catch(() => undefined);
  }
}

/**
 * 升级前把当前目录留一份。归档失败**不阻断安装**（用户要的是更新），但要在 issues 里说出来——
 * 否则"回滚按钮呢"会变成下一次的谜。
 */
async function archiveInstalledVersion(id: string, nextVersion: string, root: string): Promise<void> {
  const cur = getEntry(id);
  if (!cur || cur.version === nextVersion) return;
  try {
    await invoke("plugin_copy_dir", {
      src: cur.dir,
      dst: versionArchivePath(root, id, cur.version, Date.now()),
      roots: [root],
    });
    await pruneVersionArchives(id, root, 3);
  } catch (e) {
    repo = { ...repo, issues: [...repo.issues, `「${id}」的旧版本归档失败：${String((e as Error)?.message ?? e)}`] };
    emit();
  }
}

/** 列出某个插件的历史版本（最新在前）。读不出的归档跳过，不拖垮整个列表。 */
export async function listVersions(id: string): Promise<PluginVersionEntry[]> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const root = paths.pluginsRoot;
  const base = `${root}/${VERSIONS_DIR}/${id}`;
  let names: string[];
  try {
    const r = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("plugin_fs_list", {
      dir: base,
      roots: [root],
    });
    names = r.items.filter((x) => x.dir).map((x) => x.name).sort().reverse();
  } catch {
    return [];
  }
  const out: PluginVersionEntry[] = [];
  for (const name of names.slice(0, 10)) {
    const got = await readManifestOf(`${base}/${name}`, root);
    if (!got.manifest) continue;
    const ts = Number.parseInt(name.split("-")[0] ?? "", 36);
    out.push({
      dir: `${base}/${name}`,
      version: got.manifest.version,
      title: got.manifest.name,
      archivedAt: Number.isFinite(ts) ? ts : 0,
    });
  }
  return out;
}

/**
 * 回滚到某个归档版本。走与安装完全相同的 planFolder/commitInstall（权限面变了照样弹批准卡），
 * 不存在"回滚绕过信任"的第二条路。
 */
export async function rollbackToVersion(
  id: string,
  dir: string,
): Promise<{ plan: InstallPlan; installed: boolean }> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const root = paths.pluginsRoot;
  const base = `${root}/${VERSIONS_DIR}/${id}/`;
  const norm = dir.replace(/\\/g, "/");
  if (!norm.startsWith(base) || norm.includes("..")) throw new Error("归档目录不合法");
  const plan = await planFolder(dir, `draft-${Date.now().toString(36)}`);
  if (plan.id !== id) throw new Error("归档里的插件 id 与当前插件不一致，已拒绝回滚");
  if (needsApproval(plan)) return { plan, installed: false };
  await commitInstall(plan);
  return { plan, installed: true };
}

/**
 * 卸载：先停进程（它可能正在写状态），再删目录，再摘账本。
 *
 * 顺序反了会怎样：进程还活着、目录已经没了 ⇒ 插件下一次写文件失败，那条错误出现在
 * 一个"已经卸载"的插件的日志里，而面板上它已经消失了——没人能看见那条日志。
 */
export async function uninstall(id: string): Promise<void> {
  const e = getEntry(id);
  if (!paths) throw new Error("还没读到插件目录");
  const root = paths.pluginsRoot;
  if (e && canStop(e.phase)) await stop(id);

  await invoke("plugin_remove_tree", { path: e?.dir ?? pluginDir(paths.appDir, id), roots: [root] });
  const next = applyUninstall(index ?? { version: 1, items: {} }, trust ?? { version: 1, items: {} }, id);
  index = next.index;
  trust = next.trust;
  await saveIndex(next.index, [root]);
  await saveTrust(next.trust, [root]);
  tokens.delete(id);
  if (paths) {
    await invoke("plugin_remove_tree", { path: `${paths.pluginsRoot}/${VERSIONS_DIR}/${id}`, roots: [root] }).catch(() => undefined);
  }
  await recordJournal({ t: "uninstall", at: Date.now(), id });
  await reload();
}

/**
 * 批量卸载（旧插件库的多选/批量功能迁入）。账本一次写、一次 reload；单个失败不拖垮其余，
 * 返回两列让界面如实说"哪些走了、哪些没走"。
 */
export async function uninstallMany(
  ids: readonly string[],
): Promise<{ removed: string[]; failed: { id: string; msg: string }[] }> {
  if (!paths) throw new Error("还没读到插件目录");
  const root = paths.pluginsRoot;
  const removed: string[] = [];
  const failed: { id: string; msg: string }[] = [];
  for (const id of ids) {
    const e = getEntry(id);
    try {
      if (e && canStop(e.phase)) await stop(id);
      await invoke("plugin_remove_tree", { path: e?.dir ?? pluginDir(paths.appDir, id), roots: [root] });
      removed.push(id);
    } catch (err) {
      failed.push({ id, msg: String((err as Error)?.message ?? err) });
    }
  }
  if (!removed.length) return { removed, failed };

  let nextIndex = index ?? emptyIndex();
  let nextTrust = trust ?? emptyTrust();
  for (const id of removed) {
    const n = applyUninstall(nextIndex, nextTrust, id);
    nextIndex = n.index;
    nextTrust = n.trust;
    tokens.delete(id);
  }
  index = nextIndex;
  trust = nextTrust;
  await saveIndex(nextIndex, [root]);
  await saveTrust(nextTrust, [root]);
  for (const id of removed) {
    await invoke("plugin_remove_tree", { path: `${root}/${VERSIONS_DIR}/${id}`, roots: [root] }).catch(() => undefined);
    await recordJournal({ t: "uninstall", at: Date.now(), id });
  }
  await reload();
  return { removed, failed };
}

/**
 * 批准一个**已经在磁盘上**的插件。
 *
 * 只有一条路径会用到这里：包是手工放进 `plugins/` 的，或者上一次安装崩在了中间。
 * 正常安装走的是 `commitInstall`——它在提升之后立刻写信任账，所以装完就是 trusted。
 */
export async function approve(id: string): Promise<void> {
  const e = getEntry(id);
  if (!e) throw new Error(`没有这个插件：${id}`);
  if (!paths) throw new Error("还没读到插件目录");
  const cur = trust ?? emptyTrust();
  const rec = trustRecordFor(e.manifest, Date.now());
  const next: TrustBook = { version: REPO_VERSION, items: { ...cur.items, [id]: rec } };
  trust = next;
  await saveTrust(next, [paths.pluginsRoot]);
  await recordJournal(approveJournalEvent(rec));
  await reload();
}

/* ============================ 跑 ============================ */

/**
 * 订阅宿主事件。只订阅一次。
 *
 * 每个事件里的 `line` 是一条 JSONL，先解码再按 `t` 分发——**解码失败也要落成一行日志**，
 * 否则"插件输出了一句非 JSON"在面板上就是彻底消失，而那种情况下用户最需要看见原文。
 */
async function ensureListeners(): Promise<void> {
  if (unlisteners.length) return;
  unlisteners.push(
    await listen<{ handle: string; stream: "stdout" | "stderr"; line: string }>("ext://line", (e) => {
      const { handle, stream, line } = e.payload;
      const d = decodeMessage(line);
      if (!d.ok) {
        log(handle, { at: Date.now(), level: "raw", text: line, stream });
        return;
      }
      const msg = d.msg as PluginToHost;
      if (msg.t === "log") {
        log(handle, { at: Date.now(), level: msg.level, text: msg.msg, stream });
        return;
      }
      if (msg.t === "ready") {
        patch(handle, { phase: nextPhase(getEntry(handle)?.phase ?? "starting", { type: "ready" }) });
        log(handle, { at: Date.now(), level: "info", text: `宿主已就绪（${msg.node}）` });
        // 握手成功才发 activate：顺序反了插件会在 token 还没对上的时候被执行
        void invoke("plugin_host_send", {
          handle,
          line: encodeMessage({ t: "activate", token: tokens.get(handle) ?? "" }),
        }).catch((err) => {
          patch(handle, { phase: "failed", error: String(err) });
        });
        return;
      }
      if (msg.t === "result") {
        const p = pending.get(msg.id);
        if (!p) return; // 超时之后才回来的结果：丢弃（调用方早就拿到 timeout 了）
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.res(msg.data);
        else p.rej(Object.assign(new Error(msg.err), { code: msg.code }));
        return;
      }
      if (msg.t === "emit") {
        const payload = msg.payload as { msg?: string } | null;
        log(handle, {
          at: Date.now(),
          level: "info",
          text: payload?.msg ? `[通知] ${payload.msg}` : `${msg.event}: ${JSON.stringify(msg.payload)}`,
        });
        // 面板事件要**转给界面**，不只是记一行日志：日志是给人看的，事件是给 iframe 用的
        for (const cb of panelSubs) {
          try {
            cb({ pluginId: handle, panelId: msg.panelId, event: msg.event, payload: msg.payload });
          } catch {
            /* 某个面板的监听器抛错不该打断别的面板 */
          }
        }
        return;
      }
      if (msg.t === "disposed") {
        log(handle, { at: Date.now(), level: "info", text: "插件已清理完毕" });
      }
    }),
  );
  unlisteners.push(
    await listen<{ handle: string }>("ext://exit", (e) => {
      const h = e.payload.handle;
      patch(h, { phase: nextPhase(getEntry(h)?.phase ?? "running", { type: "exit" }), pid: undefined });
      log(h, { at: Date.now(), level: "warn", text: "进程已退出" });
      // 进程没了，在途的调用不可能再有结果：立刻拒掉，别让面板等到超时
      rejectPendingOf(h, "宿主进程已退出");
      // 崩溃前的那几行最值钱，不能跟着 2 秒窗口一起丢在内存里
      void closeOut(h);
    }),
  );
  unlisteners.push(
    await listen<{ handle: string }>("ext://idle", (e) => {
      const h = e.payload.handle;
      patch(h, { phase: nextPhase(getEntry(h)?.phase ?? "running", { type: "idle" }), pid: undefined });
      log(h, { at: Date.now(), level: "warn", text: "空闲 60 秒，宿主已回收（下次打开面板会重新拉起）" });
      void closeOut(h);
    }),
  );
}

export async function start(id: string): Promise<void> {
  const cur = getEntry(id);
  if (!cur) return;
  if (!canStart(cur.phase)) return;
  // 没启用就没面板，也没理由起进程。这里再说一次（面板那侧已经把它挡在菜单外了）：
  // 起进程要走 IPC，重活一点不假，但"不该活的进程活着"更难查。
  if (!cur.enabled) {
    const msg = "这个插件还没启用：先在详情里点「启用」，它的面板才会进入「+面板」";
    patch(id, { phase: nextPhase(cur.phase, { type: "failed", error: msg }), error: msg });
    log(id, { at: Date.now(), level: "warn", text: msg });
    return;
  }
  // 没批准过就不许跑。安装路径上本来就会拦（`commitInstall` 之前没有批准按钮），
  // 但"磁盘上直接躺着一个包"这条路绕过了安装——信任模型必须在**启动**这一层再拦一次，
  // 否则它就只是安装向导里的一个装饰。
  if (cur.verdict !== "trusted") {
    const msg = "这个插件的权限还没批准：在右侧点「批准」之后才能启动";
    patch(id, { phase: nextPhase(cur.phase, { type: "failed", error: msg }), error: msg });
    log(id, { at: Date.now(), level: "warn", text: msg });
    return;
  }

  patch(id, { phase: "starting", error: undefined });
  // 本地一份给本次启动用，同时登记到表里给 ready 回调与 stop 用（两处不能各生成一枚）
  const token = newToken();
  tokens.set(id, token);

  try {
    paths = await invoke<PluginPaths>("plugin_paths");
    node = await invoke<NodeProbe>("plugin_probe_node");
    patch(id, { nodePath: node.path, nodeVersion: node.version });

    if (!node.found) {
      throw new Error(
        `没找到 Node 运行时。试过：${node.tried.join("、") || "(空)"}。请装 Node 20+ 或把 node.exe 放进 PATH。`,
      );
    }

    // 1) 引导脚本落盘（roots 用 appDir：bootstrap 在 `<appDir>/plugin-host/` 下）
    await invoke("plugin_fs_write", {
      path: paths.bootstrapPath,
      content: BOOTSTRAP_SOURCE,
      roots: [paths.appDir],
    });

    await ensureListeners();

    // 2) 起进程
    if (cur.pid) {
      // 同 id 会先停旧实例（绝不双开）。旧实例的退出**不再**发事件（那是我们自己停的），
      // 所以这条替换要留在这里说一声，否则日志里会少一段"它为什么换了 pid"。
      log(id, { at: Date.now(), level: "info", text: `替换旧实例（pid ${cur.pid}）后重新启动` });
    }
    const plan = planHostStart({
      manifest: cur.manifest,
      bind: { workspace: extSettings.workspaceRoot, appDir: paths.appDir, extra: extSettings.roots },
      // appDir 是顶层的、不属于 bind：pluginDir 由它 + manifest.id 推出，
      // 调用方不能自己另给一份（给了就会和 staging 校验对不上）
      appDir: paths.appDir,
      scriptPath: paths.bootstrapPath,
      nodePath: node.path,
      token,
    });
    const res = await invoke<{ pid: number }>("plugin_host_start", {
      handle: plan.handle,
      nodePath: plan.nodePath,
      args: plan.args,
      scriptPath: plan.scriptPath,
      pluginDir: plan.pluginDir,
      cwd: plan.cwd,
    });
    patch(id, { pid: res.pid });
    log(id, { at: Date.now(), level: "info", text: `宿主进程已启动（pid ${res.pid}，node ${node.version}）` });

    // 3) 握手；ready 到达后由监听器发 activate
    await invoke("plugin_host_send", {
      handle: id,
      line: encodeMessage({
        t: "hello",
        v: 1,
        token,
        // 插件的 `ctx.workspace` 就是它：空串 = 没登记，插件必须自己判
        workspace: extSettings.workspaceRoot,
        appDir: paths.appDir,
        // 外部目录：插件拿到的是一份**副本**，改它不会回流（`ctx.roots` 那侧也 freeze 了）
        roots: { ...extSettings.roots },
        // 插件自己的配置（默认值 + 覆盖值）。改配置要重启宿主才生效，面板上会写明。
        config: getEffectivePluginConfig(id),
        dev: true,
      }),
    });

    // 4) 握手超时兜底：8s 没到 ready 就判失败（不留一个"正在启动"永远转圈）
    window.setTimeout(() => {
      const now = getEntry(id);
      if (now && now.phase === "starting") {
        patch(id, { phase: "failed", error: "宿主 8 秒内没有回应 ready" });
        void invoke("plugin_host_stop", { handle: id }).catch(() => undefined);
      }
    }, 8000);
  } catch (e) {
    const msg = e instanceof HostPlanError ? e.message : String((e as Error)?.message ?? e);
    patch(id, { phase: nextPhase("starting", { type: "failed", error: msg }), error: msg });
    log(id, { at: Date.now(), level: "error", text: msg });
  }
}

export async function stop(id: string): Promise<void> {
  const cur = getEntry(id);
  if (!cur || !canStop(cur.phase)) return;
  try {
    // 先让插件跑 disposer（它可能要把状态落盘），再停进程。
    // token 从表里取这个 handle 自己那一枚：拿别人的会被引导脚本静默丢弃，disposer 就不跑了。
    const own = tokens.get(id) ?? "";
    await invoke("plugin_host_send", { handle: id, line: encodeMessage({ t: "dispose", token: own, reason: "disable" }) });
  } catch {
    /* 进程可能已经没了——下面照样 stop */
  }
  try {
    await invoke("plugin_host_stop", { handle: id });
  } catch {
    /* 已经不在了也算停成功 */
  }
  tokens.delete(id);
  patch(id, { phase: nextPhase(cur.phase, { type: "stopped" }), pid: undefined });
  // 停了就把攒着没写的日志收尾：不等那 2 秒窗口，否则"停了之后最后几行没了"
  // 恰好落在最该看的地方（崩溃前那几句）。
  void closeOut(id);
}

/** 面板每次交互调一次，重置空闲计时（"用着的东西不能被回收"）。 */
export async function touch(id: string): Promise<void> {
  try {
    await invoke("plugin_host_touch", { handle: id });
  } catch {
    /* 没在跑就算了 */
  }
}

/** 这个插件的日志文件在哪（给「运行日志」的「打开目录」）。没读到盘时是空串。 */
export function pluginLogsDir(id: string): string {
  return repo.appDir ? logsFileDir(repo.appDir, id) : "";
}

/** 某个插件最近一次日志落盘失败的话（空串 = 没失败过）。盘上缺了哪一段要说得出来。 */
export function hostLogIssue(id: string): string {
  return logWriteIssue(id);
}

/** 把某个 handle 的在途调用全部拒掉（进程退出时用）。 */
function rejectPendingOf(handle: string, why: string): void {
  for (const [id, p] of pending) {
    if (p.handle !== handle) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.rej(Object.assign(new Error(why), { code: "unsupported" }));
  }
}

/**
 * 调插件注册的方法（`ctx.commands.register` 或 `ctx.panels.register` 的处理器）。
 *
 * 面板传进来的是 `panel.<panelId>.<method>`，命令是 `command.<id>`——前缀由**调用方**拼，
 * 这里不做猜测：拼错的后果是插件侧一句 `not_found`，比宿主瞎猜一个方法名好查。
 */
export async function callExt(
  handle: string,
  method: string,
  args?: unknown,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const e = getEntry(handle);
  if (!e) throw Object.assign(new Error(`没有这个插件：${handle}`), { code: "not_found" });
  if (e.phase !== "running") {
    throw Object.assign(new Error("插件还没在运行：先启动它"), { code: "unsupported" });
  }
  await ensureListeners();
  const id = `c${(++callSeq).toString(36)}`;
  return new Promise((res, rej) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      rej(Object.assign(new Error(`调用超时（${timeoutMs}ms）：${method}`), { code: "timeout" }));
    }, timeoutMs);
    pending.set(id, { res, rej, timer, handle });
    void invoke("plugin_host_send", {
      handle,
      line: encodeMessage({ t: "call", token: tokens.get(handle) ?? "", id, method, args: args ?? null }),
    }).catch((err) => {
      pending.delete(id);
      clearTimeout(timer);
      rej(Object.assign(new Error(String((err as Error)?.message ?? err)), { code: "unsupported" }));
    });
  });
}

/** 等一个插件进入 `running`（命令与面板的调用都要发给活着的宿主）。超时与启动失败都如实报，不静默卡住。 */
function waitForRunning(pluginId: string, timeoutMs = 12_000): Promise<void> {
  if (getEntry(pluginId)?.phase === "running") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let off: () => void = () => {};
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      off();
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    off = subscribe(() => {
      const e = getEntry(pluginId);
      if (!e) return finish(new Error(`插件已经不在：${pluginId}`));
      if (e.phase === "running") finish();
      else if (e.phase === "failed" || e.phase === "stopped") {
        finish(new Error(e.error || "插件没能启动，这次调用没有执行"));
      }
    });
    const timer = window.setTimeout(
      () => finish(new Error("插件 12 秒内没有就绪，这次调用没有执行")),
      timeoutMs,
    );
  });
}

/**
 * P174-R6：「用到它的时候把它拉起来，并且等到真的能用」——面板与命令共用这一条路。
 *
 * 补的是"启动"和"可用"之间那半秒的空隙：宿主进程要 spawn Node、走 hello/ready 握手，
 * 而面板的 HTML 一挂载就发第一句请求。`callExt` 只能如实拒绝"还没在运行"，面板又只在启动时
 * 读一次状态，于是用户看到的是"在插件管理里点了启用，面板还是不能用"，
 * 必须回详情页再按一次启动——同一件事做两遍，第二遍还是人替机器等的。
 *
 * 这不是放松判据：判据全在 `start()` 里（`enabled`、批准、Node 探测、握手超时），
 * 这里只是"等它跑完"，等不到的那句错误原样递回面板。
 */
export async function ensureRunning(id: string, timeoutMs = 12_000): Promise<void> {
  const cur = getEntry(id);
  if (!cur) throw new Error(`没有这个插件：${id}`);
  // 只有界面的插件（主题/小部件）没有宿主进程：不必启动、也等不到 ready。
  // 报一句人话，别让它去撞 hostPlan 的"没有 main"然后被上层反复重试。
  if (!cur.manifest.main) throw Object.assign(new Error("这个插件只有界面、没有主进程：它的面板/小部件可以直接显示，但没有可调用的方法"), { code: "unsupported" });
  const act = readinessAction(cur.phase);
  if (act === "none") return;
  if (act === "start") await start(id);
  await waitForRunning(id, timeoutMs);
}

/**
 * P174-G1：执行一条插件贡献的命令（命令面板的 `ext:<pluginId>:<commandId>` 落到这里）。
 *
 * 三条前置判据在这里**再查一遍**，不靠命令面板的过滤：
 *  - 已安装、已启用、已批准（`enabled` + `verdict`）——未批准的东西不许因为"点的是命令"
 *    就绕过启动门；
 *  - 清单里真的声明了这条命令（拼错 id 不该被派发成宿主自己的方法）；
 *  - 宿主没在跑就先拉起（命令和面板共用同一个进程；不能要求用户"先打开面板再点命令"）。
 */
export async function runCommand(pluginId: string, commandId: string): Promise<unknown> {
  const cur = getEntry(pluginId);
  if (!cur) throw new Error(`没有这个插件：${pluginId}`);
  if (!cur.enabled) throw new Error("这个插件还没启用：先在插件详情里启用它");
  if (cur.verdict !== "trusted") throw new Error("这个插件的权限还没批准：批准之后才能执行它的命令");
  if (!(cur.manifest.contributes.commands ?? []).some((c) => c.id === commandId)) {
    throw new Error(`插件没有声明这条命令：${commandId}`);
  }
  await ensureRunning(pluginId);
  try {
    const out = await callExt(pluginId, `command.${commandId}`, {});
    await recordJournal({ t: "command", at: Date.now(), id: pluginId, command: commandId, ok: true });
    return out;
  } catch (e) {
    // 记一条失败再原样抛：命令面板那侧要 toast，日志那侧要留痕——两边都不能省。
    await recordJournal({ t: "command", at: Date.now(), id: pluginId, command: commandId, ok: false });
    throw e;
  }
}

/** 包内相对路径 → 绝对路径；越界返回 null（面板侧拿到的是 `denied`，不是"文件不存在"）。 */
async function resolveInExt(handle: string, rel: string): Promise<string | null> {
  if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
  const dir = getEntry(handle)?.dir ?? pluginDir(paths.appDir, handle);
  return resolveInExtDir(dir, rel);
}

/**
 * 面板读包内文件。
 *
 * 为什么不让 iframe 自己去 fetch：不透明源的文档没有可用的基址，也拿不到文件系统；
 * 走这条路顺带把"它到底读了哪个文件"留在宿主这边——出问题时能看见它读的是什么。
 */
export async function readInExt(handle: string, rel: string): Promise<string> {
  const abs = await resolveInExt(handle, rel);
  if (!abs) throw Object.assign(new Error(`路径越界或非法：${rel}`), { code: "denied" });
  if (!paths) throw new Error("还没读到插件目录");
  const r = await invoke<{ exists: boolean; text: string; truncated: boolean }>("plugin_fs_read", {
    path: abs,
    roots: [paths.pluginsRoot],
  });
  if (!r.exists) throw Object.assign(new Error(`包内没有这个文件：${rel}`), { code: "not_found" });
  return r.text;
}

export async function writeInExt(handle: string, rel: string, content: string): Promise<void> {
  const abs = await resolveInExt(handle, rel);
  if (!abs) throw Object.assign(new Error(`路径越界或非法：${rel}`), { code: "denied" });
  if (!paths) throw new Error("还没读到插件目录");
  await invoke("plugin_fs_write", { path: abs, content, roots: [paths.pluginsRoot] });
}

export async function listInExt(handle: string, rel: string): Promise<{ name: string; dir: boolean }[]> {
  /* `""` = **包根**：发布要先把整包列一遍，而 `resolveInExtDir` 按设计把空路径判成非法
     （读写一个空路径没有意义）。所以这里单独放行"列根目录"，读写仍然只收具体相对路径。
     真机症状：一键发布直接报「读取包内文件失败：路径越界或非法：」。 */
  let abs: string | null;
  if (rel === "") {
    if (!paths) paths = await invoke<PluginPaths>("plugin_paths");
    abs = getEntry(handle)?.dir ?? pluginDir(paths.appDir, handle);
  } else {
    abs = await resolveInExt(handle, rel);
  }
  if (!abs) throw Object.assign(new Error(`路径越界或非法：${rel}`), { code: "denied" });
  if (!paths) throw new Error("还没读到插件目录");
  const r = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("plugin_fs_list", {
    dir: abs,
    roots: [paths.pluginsRoot],
  });
  return r.items;
}

function newToken(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch {
    /* 退到随机串 */
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
