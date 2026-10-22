/**
 * P174-A6：扩展仓库的前端 IO 层（读盘、装、卸、跑）。
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
import { validateExtension, type ExtensionManifest } from "./manifest";
import { planHostStart, HostPlanError } from "./hostPlan";
import { decodeMessage, encodeMessage, type ExtToHost } from "./protocol";
import {
  applyInstall,
  applyUninstall,
  fingerprintOf,
  needsApproval,
  planInstall,
  type InstallPlan,
} from "./install";
import {
  extDir,
  flattenPermissions,
  STAGING_DIR,
  trustVerdict,
  type ExtIndex,
  type ExtIndexItem,
  type TrustBook,
  type TrustVerdict,
} from "./repo";
import { loadIndex, loadTrust, saveIndex, saveTrust } from "./store";
import {
  appendLog,
  canStart,
  canStop,
  nextPhase,
  type ExtLogLine,
  type ExtPhase,
} from "./extRuntime";

/** 一个已安装的扩展：**账本上的事实**（装在哪、批过什么）+ **运行时状态**（在不在跑、日志）。 */
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

let repo: ExtRepo = { loading: true, appDir: "", entries: [], issues: [] };
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

/** 把 `<root>/<id>/extension.json` 读出来并校验。返回的 issues 由调用方合并（不静默丢）。 */
async function readManifestOf(dir: string, root: string): Promise<{ manifest?: ExtensionManifest; issue?: string }> {
  const r = await invoke<FsReadResult>("ext_fs_read", { path: `${dir}/extension.json`, roots: [root] });
  if (!r.exists) return { issue: "缺 extension.json（不是扩展目录）" };
  if (r.truncated) return { issue: "extension.json 超过 256 KiB，已拒绝解析" };
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { issue: "extension.json 不是合法 JSON" };
  }
  const v = validateExtension(raw);
  if (!v.ok) return { issue: v.errors[0] ?? "清单校验失败" };
  return { manifest: v.manifest };
}

/**
 * 重新读一遍整个仓库（磁盘是唯一真相）。
 *
 * 顺序刻意是"先列目录、再读每份清单、最后读两本账"：
 * 账本只用来补 `installedAt`/`source`/`verdict`，**不是**"有哪些扩展"的来源。
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
    index = loadedIndex.index;
    trust = loadedTrust.trust;
    issues.push(...loadedIndex.issues, ...loadedTrust.issues);

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
      entries.push({
        id: manifest.id,
        manifest,
        dir,
        version: manifest.version,
        installedAt: index.items[manifest.id]?.installedAt ?? 0,
        source: index.items[manifest.id]?.source ?? "import",
        verdict: trustVerdict(rec, fingerprint),
        permissions: flattenPermissions(manifest),
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
    repo = { loading: false, appDir: paths.appDir, entries, issues };
    emit();
  } catch (e) {
    repo = {
      loading: false,
      appDir: paths?.appDir ?? "",
      entries: [],
      issues: [...issues, `读取扩展目录失败：${String((e as Error)?.message ?? e)}`],
    };
    emit();
  }
}

/** 幂等加载：面板挂载时调，重复调只读一次盘。 */
export function ensureLoaded(): Promise<void> {
  if (!loadingPromise) loadingPromise = reload().finally(() => (loadingPromise = null));
  return loadingPromise;
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
  if (!manifest) throw new Error(`这个目录不能当扩展装：${issue ?? "清单读不出来"}`);
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
  if (!paths) throw new Error("还没读到扩展目录");
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
 * 一个"已经卸载"的扩展的日志里，而面板上它已经消失了——没人能看见那条日志。
 */
export async function uninstall(id: string): Promise<void> {
  const e = getEntry(id);
  if (!paths) throw new Error("还没读到扩展目录");
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
      if (msg.t === "emit") {
        const payload = msg.payload as { msg?: string } | null;
        log(handle, {
          at: Date.now(),
          level: "info",
          text: payload?.msg ? `[通知] ${payload.msg}` : `${msg.event}: ${JSON.stringify(msg.payload)}`,
        });
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
      bind: { workspace: "", appDir: paths.appDir, extra: {} },
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
        workspace: "",
        appDir: paths.appDir,
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
