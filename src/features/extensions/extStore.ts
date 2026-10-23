/**
 * P174-A6：插件仓库的前端 IO 层（读盘、装、卸、跑）。
 *
 * 分工仍然和 A5 一样：
 * - 纯判据在 `install.ts` / `repo.ts` / `manifest.ts`（可单测）；
 * - 状态机与日志缓冲在 `extRuntime.ts`（可单测）；
 * - **这个文件只做"调命令 + 拼顺序 + 把结果喂回去"**，`invoke` 在 vitest 里跑不起来，
 *   所以这里一行判据都不该有。写在这里的 `if` 只允许是"上一步失败了就别做下一步"。
 *
 * A6 相对 A5 的最大变化：状态从"只有一个内置示例"变成"一张装过的表"。
 * 示例插件已经删掉了——现在装一个真包（`examples/extensions/hello-uartix`）就能看到同样的东西，
 * 而"内置一个假插件"会让人永远分不清"插件真的跑起来了"和"示例跑起来了"。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { BOOTSTRAP_SOURCE } from "./bootstrap";
import { ROOT_KEY_RE, validateExtension, type ExtensionManifest } from "./manifest";
import { setActiveExtTheme, themeKey, type ActiveExtTheme } from "./activeTheme";
import { planHostStart, HostPlanError } from "./hostPlan";
import { guardThemeCss, type ThemeCssResult } from "./themeCss";
import { decodeMessage, encodeMessage, RPC_TIMEOUT_MS, type ExtToHost } from "./protocol";
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
  extDir,
  emptyTrust,
  flattenPermissions,
  resolveInExtDir,
  STAGING_DIR,
  trustVerdict,
  type ExtIndex,
  type ExtIndexItem,
  type TrustBook,
  type TrustVerdict,
} from "./repo";
import {
  emptyExtSettings,
  loadExtSettings,
  saveExtSettings,
  loadIndex,
  loadTrust,
  saveIndex,
  saveTrust,
  type ExtSettings,
} from "./store";
import {
  appendLog,
  canStart,
  canStop,
  nextPhase,
  type ExtLogLine,
  type ExtPhase,
} from "./extRuntime";

/** 一枚可用的插件主题（已过净化）。 */
export interface ExtThemeItem {
  /** `plg:<pluginId>:<themeId>` */
  key: string;
  id: string;
  title: string;
  scheme: "dark" | "light" | null;
  css: string;
}

/** 一个已安装的插件：**账本上的事实**（装在哪、批过什么）+ **运行时状态**（在不在跑、日志）。 */
export interface ExtEntry {
  id: string;
  manifest: ExtensionManifest;
  dir: string;
  version: string;
  installedAt: number;
  source: ExtIndexItem["source"];
  /** 与信任库比出来的三态；`needs-approval`/`changed` 的面板会顶一条黄条。 */
  verdict: TrustVerdict;
  permissions: string[];
  /** 这个插件贡献的主题（CSS 已经过宿主净化器；没过的不会出现在这里，问题在 issues 里）。 */
  themes: ExtThemeItem[];
  phase: ExtPhase;
  pid?: number;
  error?: string;
  logs: ExtLogLine[];
  nodePath?: string;
  nodeVersion?: string;
}

export interface ExtRepo {
  loading: boolean;
  appDir: string;
  /** 工作区根（`$WS`）；空串 = 没登记。面板要据此提示"某个插件需要它"。 */
  workspaceRoot: string;
  /** 当前在画的插件主题键；空串 = 用内置主题。 */
  activeTheme: string;
  /** 外部目录登记表（`$EXT:<key>` → 绝对路径）。面板要据此提示"某个插件缺哪个目录"。 */
  roots: Record<string, string>;
  entries: ExtEntry[];
  /** 读盘过程中发现的问题（坏清单、悬空目录、账本损坏…）。**不吞**，面板上要能看见。 */
  issues: string[];
}

export interface ExtPaths {
  appDir: string;
  extensionsRoot: string;
  hostDir: string;
  bootstrapPath: string;
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

let paths: ExtPaths | null = null;
let node: NodeProbe | null = null;
let index: ExtIndex | null = null;
let trust: TrustBook | null = null;

/**
 * 每个 handle 一枚 token。
 *
 * 为什么不是模块级的一个 string：装了第二个插件、它也起了一次，后起的那次会把值覆盖掉，
 * 于是前一个插件的 `dispose` 带着错的 token 过去——**引导脚本会静默丢弃它**（那是设计），
 * 表现是"disposer 没跑"：插件没来得及把状态落盘就被杀了。丢的是数据，不是一条报错。
 */
const tokens = new Map<string, string>();

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
  extId: string;
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

let repo: ExtRepo = { loading: true, appDir: "", workspaceRoot: "", activeTheme: "", roots: {}, entries: [], issues: [] };
/** 插件子系统自己的设置（工作区根、外部目录、当前主题）。 */
let extSettings: ExtSettings = emptyExtSettings();
const subs = new Set<() => void>();
const unlisteners: UnlistenFn[] = [];
let loadingPromise: Promise<void> | null = null;

function emit(): void {
  // `useSyncExternalStore` 靠引用变化决定要不要重渲染：原地改就等于"数据变了界面不动"
  repo = { ...repo, entries: repo.entries.slice(), issues: repo.issues.slice() };
  for (const f of subs) f();
}

function patch(id: string, p: Partial<ExtEntry>): void {
  const i = repo.entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  const next = repo.entries.slice();
  next[i] = { ...next[i], ...p };
  repo = { ...repo, entries: next };
  emit();
}

function log(id: string, line: ExtLogLine): void {
  const i = repo.entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  const next = repo.entries.slice();
  next[i] = { ...next[i], logs: appendLog(next[i].logs, line) };
  repo = { ...repo, entries: next };
  emit();
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getSnapshot(): ExtRepo {
  return repo;
}

export function getEntry(id: string): ExtEntry | undefined {
  return repo.entries.find((e) => e.id === id);
}

/* ============================ 读盘 ============================ */

/** 把 `<root>/<id>/plugin.json` 读出来并校验。返回的 issues 由调用方合并（不静默丢）。 */
async function readManifestOf(dir: string, root: string): Promise<{ manifest?: ExtensionManifest; issue?: string }> {
  const r = await invoke<FsReadResult>("ext_fs_read", { path: `${dir}/plugin.json`, roots: [root] });
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
  try {
    paths = await invoke<ExtPaths>("ext_paths");
    const root = paths.extensionsRoot;
    const listing = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("ext_fs_list", {
      dir: root,
      roots: [root],
    });

    const loadedIndex = await loadIndex([root]);
    const loadedTrust = await loadTrust([root]);
    const loadedSettings = await loadExtSettings([root]);
    index = loadedIndex.index;
    trust = loadedTrust.trust;
    extSettings = loadedSettings.settings;
    issues.push(...loadedIndex.issues, ...loadedTrust.issues, ...loadedSettings.issues);

    const entries: ExtEntry[] = [];
    // 重读盘**不能把运行时状态清掉**：装 B 的时候 A 可能正跑着，
    // 一次 reload 把它刷成"未启动"就会出现"界面说没跑、进程还活着"（点启动会以为在重试）。
    // 只在版本没变时沿用，版本变了说明是另一个构建，旧日志与旧状态都不再有意义。
    const before = new Map(repo.entries.map((e) => [e.id, e]));
    for (const item of listing.items) {
      if (!item.dir || item.name === STAGING_DIR) continue;
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
      const themes: ExtThemeItem[] = [];
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
        verdict: trustVerdict(rec, fingerprint),
        permissions: flattenPermissions(manifest),
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
    if (wanted && (!found || !owner)) {
      issues.push(`设置里选中的插件主题「${wanted}」已经不在了，已回到内置主题`);
      extSettings = { ...extSettings, activeTheme: "" };
      if (paths) await saveExtSettings(extSettings, [paths.extensionsRoot]);
    }
    setActiveExtTheme(
      found && owner
        ? ({ id: found.key, name: found.title, scheme: found.scheme, css: found.css, pluginId: owner.id } satisfies ActiveExtTheme)
        : null,
    );

    repo = {
      loading: false,
      appDir: paths.appDir,
      workspaceRoot: extSettings.workspaceRoot,
      activeTheme: extSettings.activeTheme,
      roots: { ...extSettings.roots },
      entries,
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
 */
export async function setWorkspaceRoot(path: string): Promise<void> {
  if (!paths) paths = await invoke<ExtPaths>("ext_paths");
  extSettings = { ...extSettings, workspaceRoot: path.trim() };
  await saveExtSettings(extSettings, [paths.extensionsRoot]);
  repo = { ...repo, workspaceRoot: extSettings.workspaceRoot };
  emit();
}

/**
 * 绑定/解绑一个外部目录（`$EXT:<key>`）。`path` 传空串 = 解绑。
 *
 * 与工作区根同样的"只影响下一次启动"：`--allow-fs-write` 是启动参数。
 * 但这里**多走一步 reload**：面板要立刻显示"已绑/未绑"，否则用户以为没保存。
 * 绑错了键名（不合规）直接拒——那张表的键必须和清单里写得出来的键同一套规则，
 * 否则会出现"绑了但永远匹配不上"的鬼故事。
 */
export async function setExtRoot(key: string, path: string): Promise<void> {
  if (!ROOT_KEY_RE.test(key)) throw new Error(`外部目录的键名不合规：${key}`);
  if (!paths) paths = await invoke<ExtPaths>("ext_paths");
  const next = { ...extSettings.roots };
  const v = path.trim();
  if (v) next[key] = v;
  else delete next[key];
  extSettings = { ...extSettings, roots: next };
  await saveExtSettings(extSettings, [paths.extensionsRoot]);
  repo = { ...repo, roots: { ...next } };
  emit();
}


/**
 * 读一枚主题的 CSS 并过净化器。
 *
 * 判据在 `themeCss.ts` 里（纯函数，可测）。这里只负责读盘与两件与文件本身有关的事：
 * 文件在不在、有没有被截断。**净化不能省**——主题 CSS 是插件唯一能改整张界面的注入面。
 */
async function readThemeCss(dir: string, root: string, entry: string): Promise<ThemeCssResult> {
  const r = await invoke<FsReadResult>("ext_fs_read", { path: `${dir}/${entry}`, roots: [root] });
  if (!r.exists) return { issue: `缺主题文件 ${entry}` };
  if (r.truncated) return { issue: `主题文件 ${entry} 超过 256 KiB，已拒绝（主题不该这么大）` };
  return guardThemeCss(r.text, entry);
}

/**
 * 选一枚插件主题来画（`key` 传空串 = 回到内置主题）。
 *
 * 只写账本 + 重读盘，**不直接改 DOM**：套用统一走 `applyStyleExts`（那张界面配色的唯一出口），
 * 它是被仓库变化触发的。这样"谁在画"只有一个事实源，不会出现两处各改一半。
 */
export async function setActiveTheme(key: string): Promise<void> {
  if (!paths) paths = await invoke<ExtPaths>("ext_paths");
  extSettings = { ...extSettings, activeTheme: key.trim() };
  await saveExtSettings(extSettings, [paths.extensionsRoot]);
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
    paths = await invoke<ExtPaths>("ext_paths");
  }
  const { manifest, issue } = await readManifestOf(srcDir, srcDir);
  if (!manifest) throw new Error(`这个目录不能当插件装：${issue ?? "清单读不出来"}`);
  if (!trust) {
    const r = await loadTrust([paths.extensionsRoot]);
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
export async function commitInstall(plan: InstallPlan): Promise<InstallWarn> {
  if (!paths) throw new Error("还没读到插件目录");
  const root = paths.extensionsRoot;

  const copied = await invoke<{ files: number; bytes: number; skippedLinks: number }>("ext_copy_dir", {
    src: plan.srcDir,
    dst: plan.stagingPath,
    roots: [root],
  });
  // 跳过的链接不是错误，但**必须说出来**：少了文件却"装成功了"，之后的表现是
  // "某个功能运行时才炸"，那时没人会想到是安装时少拷了东西。（计数在下面的返回值里）

  const staged = await readManifestOf(plan.stagingPath, root);
  if (!staged.manifest) {
    await invoke("ext_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error(`复制后的副本校验不过（已清理暂存）：${staged.issue ?? "未知"}`);
  }
  const stagedFingerprint = fingerprintOf(staged.manifest);
  if (stagedFingerprint !== plan.fingerprint) {
    await invoke("ext_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error("包在你确认之后被改动过（权限面已变），请重新安装");
  }
  if (staged.manifest.id !== plan.id) {
    await invoke("ext_remove_tree", { path: plan.stagingPath, roots: [root] }).catch(() => undefined);
    throw new Error(`副本的 id（${staged.manifest.id}）与批准的不一致，已中止`);
  }

  await invoke("ext_promote", { draftId: plan.draftId, id: plan.id, roots: [root] });

  const now = Date.now();
  const next = applyInstall(index ?? { version: 1, items: {} }, trust ?? { version: 1, items: {} }, plan, {
    approvedAt: now,
    source: "local",
  });
  index = next.index;
  trust = next.trust;
  await saveIndex(next.index, [root]);
  if (needsApproval(plan)) await saveTrust(next.trust, [root]);

  await reload();
  return { skippedLinks: copied.skippedLinks };
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
  const root = paths.extensionsRoot;
  if (e && canStop(e.phase)) await stop(id);

  await invoke("ext_remove_tree", { path: e?.dir ?? extDir(paths.appDir, id), roots: [root] });
  const next = applyUninstall(index ?? { version: 1, items: {} }, trust ?? { version: 1, items: {} }, id);
  index = next.index;
  trust = next.trust;
  await saveIndex(next.index, [root]);
  await saveTrust(next.trust, [root]);
  tokens.delete(id);
  await reload();
}

/**
 * 批准一个**已经在磁盘上**的插件。
 *
 * 只有一条路径会用到这里：包是手工放进 `extensions/` 的，或者上一次安装崩在了中间。
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
  await saveTrust(next, [paths.extensionsRoot]);
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
      const msg = d.msg as ExtToHost;
      if (msg.t === "log") {
        log(handle, { at: Date.now(), level: msg.level, text: msg.msg, stream });
        return;
      }
      if (msg.t === "ready") {
        patch(handle, { phase: nextPhase(getEntry(handle)?.phase ?? "starting", { type: "ready" }) });
        log(handle, { at: Date.now(), level: "info", text: `宿主已就绪（${msg.node}）` });
        // 握手成功才发 activate：顺序反了插件会在 token 还没对上的时候被执行
        void invoke("ext_host_send", {
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
            cb({ extId: handle, panelId: msg.panelId, event: msg.event, payload: msg.payload });
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
    }),
  );
  unlisteners.push(
    await listen<{ handle: string }>("ext://idle", (e) => {
      const h = e.payload.handle;
      patch(h, { phase: nextPhase(getEntry(h)?.phase ?? "running", { type: "idle" }), pid: undefined });
      log(h, { at: Date.now(), level: "warn", text: "空闲 60 秒，宿主已回收（下次打开面板会重新拉起）" });
    }),
  );
}

export async function start(id: string): Promise<void> {
  const cur = getEntry(id);
  if (!cur) return;
  if (!canStart(cur.phase)) return;
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
    paths = await invoke<ExtPaths>("ext_paths");
    node = await invoke<NodeProbe>("ext_probe_node");
    patch(id, { nodePath: node.path, nodeVersion: node.version });

    if (!node.found) {
      throw new Error(
        `没找到 Node 运行时。试过：${node.tried.join("、") || "(空)"}。请装 Node 20+ 或把 node.exe 放进 PATH。`,
      );
    }

    // 1) 引导脚本落盘（roots 用 appDir：bootstrap 在 `<appDir>/ext-host/` 下）
    await invoke("ext_fs_write", {
      path: paths.bootstrapPath,
      content: BOOTSTRAP_SOURCE,
      roots: [paths.appDir],
    });

    await ensureListeners();

    // 2) 起进程
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
    const res = await invoke<{ pid: number }>("ext_host_start", {
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
    await invoke("ext_host_send", {
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
        dev: true,
      }),
    });

    // 4) 握手超时兜底：8s 没到 ready 就判失败（不留一个"正在启动"永远转圈）
    window.setTimeout(() => {
      const now = getEntry(id);
      if (now && now.phase === "starting") {
        patch(id, { phase: "failed", error: "宿主 8 秒内没有回应 ready" });
        void invoke("ext_host_stop", { handle: id }).catch(() => undefined);
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
    await invoke("ext_host_send", { handle: id, line: encodeMessage({ t: "dispose", token: own, reason: "disable" }) });
  } catch {
    /* 进程可能已经没了——下面照样 stop */
  }
  try {
    await invoke("ext_host_stop", { handle: id });
  } catch {
    /* 已经不在了也算停成功 */
  }
  tokens.delete(id);
  patch(id, { phase: nextPhase(cur.phase, { type: "stopped" }), pid: undefined });
}

/** 面板每次交互调一次，重置空闲计时（"用着的东西不能被回收"）。 */
export async function touch(id: string): Promise<void> {
  try {
    await invoke("ext_host_touch", { handle: id });
  } catch {
    /* 没在跑就算了 */
  }
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
    void invoke("ext_host_send", {
      handle,
      line: encodeMessage({ t: "call", token: tokens.get(handle) ?? "", id, method, args: args ?? null }),
    }).catch((err) => {
      pending.delete(id);
      clearTimeout(timer);
      rej(Object.assign(new Error(String((err as Error)?.message ?? err)), { code: "unsupported" }));
    });
  });
}

/** 包内相对路径 → 绝对路径；越界返回 null（面板侧拿到的是 `denied`，不是"文件不存在"）。 */
async function resolveInExt(handle: string, rel: string): Promise<string | null> {
  if (!paths) paths = await invoke<ExtPaths>("ext_paths");
  const dir = getEntry(handle)?.dir ?? extDir(paths.appDir, handle);
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
  const r = await invoke<{ exists: boolean; text: string; truncated: boolean }>("ext_fs_read", {
    path: abs,
    roots: [paths.extensionsRoot],
  });
  if (!r.exists) throw Object.assign(new Error(`包内没有这个文件：${rel}`), { code: "not_found" });
  return r.text;
}

export async function writeInExt(handle: string, rel: string, content: string): Promise<void> {
  const abs = await resolveInExt(handle, rel);
  if (!abs) throw Object.assign(new Error(`路径越界或非法：${rel}`), { code: "denied" });
  if (!paths) throw new Error("还没读到插件目录");
  await invoke("ext_fs_write", { path: abs, content, roots: [paths.extensionsRoot] });
}

export async function listInExt(handle: string, rel: string): Promise<{ name: string; dir: boolean }[]> {
  const abs = await resolveInExt(handle, rel);
  if (!abs) throw Object.assign(new Error(`路径越界或非法：${rel}`), { code: "denied" });
  if (!paths) throw new Error("还没读到插件目录");
  const r = await invoke<{ exists: boolean; items: { name: string; dir: boolean }[] }>("ext_fs_list", {
    dir: abs,
    roots: [paths.extensionsRoot],
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
