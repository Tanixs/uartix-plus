/**
 * P174-A5：扩展运行时的 store（IO 层）。
 *
 * 分工：状态机与日志缓冲在 `extRuntime.ts`（纯函数、可单测）；这里只做
 * "调命令 + 订阅事件 + 把结果喂给状态机"。之所以这样分，是因为这一层里的
 * `invoke` / `listen` 在 vitest 里跑不起来，判据放进来就等于没测。
 *
 * 这一批只跑**内置示例**（`demoExtension.ts`）：装包、批准卡、市场都还没有。
 * 但它走的是完整链路——落盘 bootstrap → 落盘插件 → 起进程 → 握手 → 激活 → 日志 → 停。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { BOOTSTRAP_SOURCE } from "./bootstrap";
import { DEMO_EXT_ID, DEMO_MAIN, demoManifest } from "./demoExtension";
import { planHostStart, HostPlanError } from "./hostPlan";
import { decodeMessage, encodeMessage, type ExtToHost } from "./protocol";
import {
  appendLog,
  canStart,
  canStop,
  nextPhase,
  type ExtLogLine,
  type ExtPhase,
} from "./extRuntime";
import type { ExtensionManifest } from "./manifest";

export interface ExtRuntimeState {
  id: string;
  name: string;
  manifest: ExtensionManifest;
  phase: ExtPhase;
  pid?: number;
  error?: string;
  logs: ExtLogLine[];
  nodePath?: string;
  nodeVersion?: string;
  /** 宿主侧最近一次报告的空闲毫秒数（面板上显示"还有多久被回收"） */
  idleMs?: number;
}

export interface ExtPaths {
  appDir: string;
  extensionsRoot: string;
  hostDir: string;
  bootstrapPath: string;
}

export interface NodeProbe {
  found: boolean;
  path: string;
  version: string;
  tried: string[];
}

let paths: ExtPaths | null = null;
let node: NodeProbe | null = null;
/**
 * 每个 handle 一枚 token。
 *
 * 为什么不是模块级的一个 string：装了第二个插件、它也起了一次，后起的那次会把值覆盖掉，
 * 于是前一个插件的 `dispose` 带着错的 token 过去——**引导脚本会静默丢弃它**（那是设计），
 * 表现是"disposer 没跑"：插件没来得及把状态落盘就被杀了。丢的是数据，不是一条报错。
 */
const tokens = new Map<string, string>();
let snapshot: Record<string, ExtRuntimeState> = {};
const subs = new Set<() => void>();
const unlisteners: UnlistenFn[] = [];

function emit(): void {
  snapshot = { ...snapshot };
  for (const f of subs) f();
}

function patch(id: string, p: Partial<ExtRuntimeState>): void {
  const cur = snapshot[id];
  if (!cur) return;
  snapshot = { ...snapshot, [id]: { ...cur, ...p } };
  emit();
}

function log(id: string, line: ExtLogLine): void {
  const cur = snapshot[id];
  if (!cur) return;
  snapshot = { ...snapshot, [id]: { ...cur, logs: appendLog(cur.logs, line) } };
  emit();
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getSnapshot(): Record<string, ExtRuntimeState> {
  return snapshot;
}

export function getRuntime(id: string): ExtRuntimeState | undefined {
  return snapshot[id];
}

/** 确保示例扩展在状态里（幂等）。真实装包到位后，这里换成"从 index 读"。 */
export function ensureDemo(): void {
  if (snapshot[DEMO_EXT_ID]) return;
  const m = demoManifest();
  snapshot = {
    ...snapshot,
    [DEMO_EXT_ID]: {
      id: DEMO_EXT_ID,
      name: m.name,
      manifest: m,
      phase: "idle",
      logs: [],
    },
  };
  emit();
}

/** 打开它的面板（走 App 里那条 `ux:open-ext-panel` 事件，不另开一条通路）。 */
export function openDemoPanel(): void {
  window.dispatchEvent(new CustomEvent<string>("ux:open-ext-panel", { detail: DEMO_EXT_ID }));
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
        patch(handle, { phase: nextPhase(snapshot[handle]?.phase ?? "starting", { type: "ready" }) });
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
      patch(h, { phase: nextPhase(snapshot[h]?.phase ?? "running", { type: "exit" }), pid: undefined });
      log(h, { at: Date.now(), level: "warn", text: "进程已退出" });
    }),
  );
  unlisteners.push(
    await listen<{ handle: string }>("ext://idle", (e) => {
      const h = e.payload.handle;
      patch(h, { phase: nextPhase(snapshot[h]?.phase ?? "running", { type: "idle" }), pid: undefined });
      log(h, { at: Date.now(), level: "warn", text: "空闲 60 秒，宿主已回收（下次打开面板会重新拉起）" });
    }),
  );
}

export async function start(id: string): Promise<void> {
  const cur = snapshot[id];
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

    // 2) 插件文件落盘（roots 用 extensionsRoot）
    await invoke("ext_fs_write", {
      path: `${paths.extensionsRoot}/${id}/main.mjs`,
      content: DEMO_MAIN,
      roots: [paths.extensionsRoot],
    });

    await ensureListeners();

    // 3) 起进程
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

    // 4) 握手；ready 到达后由监听器发 activate
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

    // 5) 握手超时兜底：8s 没到 ready 就判失败（不留一个"正在启动"永远转圈）
    window.setTimeout(() => {
      const now = snapshot[id];
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
  const cur = snapshot[id];
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
