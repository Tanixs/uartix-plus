/**
 * P99a-B2：`module` 产物的 **Worker 总线**——注册、派发、超时强杀、违规上报。
 *
 * 三条不可让的规矩（详设 §5.3/§11，全部有测试钉）：
 * 1. **探针通过之前不谈特权**：worker 只准回报 `aiw:mod-probe/aiw:mod-error`，
 *    在 `live` 之前发来 `aiw:tool-def` 一律拒 + 计违规；
 * 2. **权力一律宿主判**：工具名强制前缀、`effect/domain` 由包的 caps 与固定映射派生，
 *    插件自报的 `effect`/`dangerous` 之类字段**看都不看**；
 * 3. **超时不是回个错就完事**：`terminate()` + 重建 worker，否则一次卡死的调用
 *    会把这个包的后续全堵在同一个 realm 里。
 *
 * 环约束（§8-33）：本文件只依赖 plugins 层叶子 + `toolSchemaLite`，**不准** import agent 层
 * （那边反过来 import 这里）。
 */
import { verdictPluginMessage } from "./pluginIsolation";
import {
  MODULE_CALL_TIMEOUT_MS,
  MODULE_MAX_REBUILDS,
  MODULE_PROBE_WAIT_MS,
  PLUGIN_ACK_MAX_BYTES,
  PLUGIN_TOOL_DESC_MAX,
} from "./pluginLimits";
import {
  addPluginToolDefs,
  clearPluginTools,
  removePluginTools,
  type PluginToolDef,
} from "./pluginToolDefs";
import { MOD_ERROR, MOD_PROBE, MOD_READY, moduleWorkerSource } from "./moduleLockdown";
import { MAX_ARGS_BYTES, validateLiteSchema } from "./toolSchemaLite";

export type ModuleStatus = "probing" | "live" | "blocked" | "dead";

export interface OpenModuleOpts {
  pkgId: string;
  pkgName: string;
  version: string;
  code: string;
  /** 与 iframe 同一套 nonce 语义：消息没带对 n 就拒 + 计违规 */
  nonce: string;
  caps: string[];
  onViolation?: (pkgId: string, why: string) => void;
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  /** 归因码：plugin_timeout / plugin_error / module_not_live / args_invalid / args_too_large / plugin_unreachable */
  code?: string;
  err?: string;
}

/** 建 worker 的那一步单独可注入：node 测试环境没有 Worker，只能拿替身来跑注册/派发/超时这三条路。 */
export interface WorkerLike {
  postMessage: (m: unknown) => void;
  terminate: () => void;
  addEventListener: (t: string, fn: (e: { data: unknown }) => void) => void;
}
export type WorkerFactory = (source: string) => { worker: WorkerLike; dispose: () => void };

export interface ProbeOutcome {
  status: ModuleStatus | "none";
  probeFailed: string[];
}

interface Mod {
  opts: OpenModuleOpts;
  /** 建 worker 的方式（重建时沿用它，测试替身不会在第一次超时后降级成真 Worker） */
  factory: WorkerFactory;
  worker: WorkerLike | null;
  dispose: () => void;
  status: ModuleStatus;
  probeFailed: string[];
  /**
   * 插件代码求值完了吗（收到 `aiw:mod-ready`）。
   * **这比"探针过了"更晚一条**：`uartix.tools.register()` 是在代码求值里同步发出的，
   * 探针回报和 tool-def 是两条消息两个任务。臂模块的人如果只等探针，就会在
   * "工具还没登记完"的时刻去取快照 ⇒ 第一个任务看不见新工具，第二个才看见。
   */
  ready: boolean;
  readyWaiters: Array<() => void>;
  pending: Map<string, { resolve: (r: ToolCallResult) => void; timer: ReturnType<typeof setTimeout> }>;
  rebuilds: number;
  /** 等探针结论的人（启用路径要 await 它才知道该不该放行） */
  probeWaiters: Array<(m: Mod) => void>;
}

/** 状态一旦落定（live/blocked/dead）就叫醒等探针的人——包括等"求值完成"的那批。 */
function settleProbe(m: Mod): void {
  const waiters = m.probeWaiters;
  m.probeWaiters = [];
  for (const fn of waiters) fn(m);
}

function settleReady(m: Mod): void {
  const waiters = m.readyWaiters;
  m.readyWaiters = [];
  for (const fn of waiters) fn();
  // 求值失败/被封时也是"等的人该醒了"的时刻：状态已是 blocked/dead 就按探针语义一并放行
  if (m.status !== "live" && m.status !== "probing") settleProbe(m);
}

/**
 * 等一次封网自证的结论。worker 的探针是异步回报的，而"能不能启用"必须等它——
 * 超时按失败处理（证明不了＝不放行）。
 */
export function waitModuleProbe(pkgId: string, timeoutMs = MODULE_PROBE_WAIT_MS): Promise<ProbeOutcome> {
  const m = mods.get(pkgId);
  if (!m) return Promise.resolve({ status: "none", probeFailed: ["no-module"] });
  if (m.status !== "probing") return Promise.resolve({ status: m.status, probeFailed: m.probeFailed });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: m.status, probeFailed: m.probeFailed });
    };
    const timer = setTimeout(() => {
      violate(m, "probe:timeout");
      m.status = "blocked";
      m.probeFailed = ["probe-timeout"];
      teardown(m);
      clearPluginTools(pkgId);
      finish();
    }, timeoutMs);
    m.probeWaiters.push(finish);
  });
}

/**
 * 等"封网过了 **且** 插件代码求值完了"——臂模块的调用方要的是这个时刻，
 * 因为工具登记发生在求值里。求值报错（`aiw:mod-error`）也会醒来，但那时 status 已是 dead。
 */
export function waitModuleReady(pkgId: string, timeoutMs = MODULE_PROBE_WAIT_MS): Promise<ProbeOutcome> {
  const m = mods.get(pkgId);
  if (!m) return Promise.resolve({ status: "none", probeFailed: ["no-module"] });
  if (m.ready || m.status === "blocked" || m.status === "dead") {
    return Promise.resolve({ status: m.status, probeFailed: m.probeFailed });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: m.status, probeFailed: m.probeFailed });
    };
    const timer = setTimeout(() => {
      // 求值迟迟不结束：不杀 worker（可能是插件在等别的消息），但如实报"没等到 ready"
      m.probeFailed = [...new Set([...m.probeFailed, "not-ready"])];
      violate(m, "ready:timeout");
      finish();
    }, timeoutMs);
    m.readyWaiters.push(finish);
  });
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;
const MAX_INFLIGHT_PER_MODULE = 4;
const MAX_DEFS_PER_MESSAGE = 16;

const mods = new Map<string, Mod>();

function realWorkerFactory(source: string): { worker: WorkerLike; dispose: () => void } {
  const g = globalThis as {
    Worker?: new (url: string) => WorkerLike;
    Blob?: typeof Blob;
    URL?: typeof URL;
  };
  if (!g.Worker || !g.Blob || !g.URL) throw new Error("当前环境没有 Worker");
  const url = g.URL.createObjectURL(new g.Blob([source], { type: "text/javascript" }));
  const worker = new g.Worker(url);
  return { worker, dispose: () => { try { g.URL!.revokeObjectURL(url); } catch { /* 已回收 */ } } };
}

function violate(m: Mod, why: string): void {
  try {
    m.opts.onViolation?.(m.opts.pkgId, why);
  } catch (err) {
    console.warn(`[moduleBus] onViolation 抛错：${String(err)}`);
  }
}

function settleAll(m: Mod, code: string, note: string): void {
  for (const [, p] of m.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, code, err: note });
  }
  m.pending.clear();
}

function teardown(m: Mod): void {
  try {
    m.worker?.terminate();
  } catch {
    /* 已经死了 */
  }
  m.dispose();
  m.worker = null;
}

/** 打开（或重开）一个包的 worker。同一 pkgId 重复调用＝先关旧的，不留两个 realm。 */
export function openModule(opts: OpenModuleOpts, factory: WorkerFactory = realWorkerFactory): ModuleStatus {
  closeModule(opts.pkgId);
  let worker: WorkerLike;
  let dispose: () => void;
  const mod: Mod = {
    opts,
    factory,
    worker: null,
    dispose: () => undefined,
    status: "probing",
    probeFailed: [],
    ready: false,
    readyWaiters: [],
    pending: new Map(),
    rebuilds: 0,
    probeWaiters: [],
  };
  try {
    const made = factory(moduleWorkerSource(opts.code, opts.nonce, opts.pkgId));
    worker = made.worker;
    dispose = made.dispose;
  } catch (err) {
    // 环境没有 Worker（node/测试）或内核拒绝创建：判失败，不是"没测就算通过"
    mod.status = "blocked";
    mod.probeFailed = ["no-worker"];
    mods.set(opts.pkgId, mod);
    clearPluginTools(opts.pkgId);
    settleProbe(mod);
    console.warn(`[moduleBus] ${opts.pkgId} 起不来 worker：${String((err as Error)?.message ?? err)}`);
    return mod.status;
  }
  mod.worker = worker;
  mod.dispose = dispose;
  mods.set(opts.pkgId, mod);
  worker.addEventListener("message", (e) => handleWorkerMessage(mod, e.data));
  worker.addEventListener("error", () => {
    if (mod.status === "probing") {
      mod.status = "blocked";
      mod.probeFailed = ["worker-error"];
      settleAll(mod, "plugin_unreachable", "worker 启动即报错");
      violate(mod, "worker:error");
      teardown(mod);
      settleProbe(mod);
      return;
    }
    mod.status = "dead";
    settleAll(mod, "plugin_unreachable", "worker 运行中崩溃");
    violate(mod, "worker:crash");
    teardown(mod);
    clearPluginTools(opts.pkgId);
    settleProbe(mod);
  });
  return mod.status;
}

/** 消息进来的唯一入口：先过与 iframe **同一张**裁决表，再按状态机受理。 */
export function handleWorkerMessage(m: Mod, raw: unknown): void {
  routeWorkerMessage(m, raw);
  // 状态一旦离开 probing 就叫醒等探针的人（启用路径靠这个决定放不放行）；
  // 被封/崩溃时也要叫醒等 ready 的人，否则他们要干等到超时
  if (m.status !== "probing") settleProbe(m);
  if (m.status === "blocked" || m.status === "dead") settleReady(m);
}

function routeWorkerMessage(m: Mod, raw: unknown): void {
  const d = raw as { type?: string; n?: string } & Record<string, unknown>;
  if (!d || typeof d.type !== "string") return;
  const verdict = verdictPluginMessage(d.type, d.n, { caps: m.opts.caps, nonce: m.opts.nonce });
  if (verdict !== "allow") {
    violate(m, `${d.type}:${verdict}`);
    return;
  }
  if (d.type === MOD_PROBE) {
    const failed = Array.isArray(d.failed) ? (d.failed as string[]) : ["probe-malformed"];
    m.probeFailed = d.ok === true ? [] : failed;
    if (d.ok === true) {
      m.status = "live";
      // 每次真正上线都从空面开始：插件会在求值里重新 register 它那一套。
      // 沿用上一次的定义等于"改了代码还剩着旧工具"（注销不掉的僵尸面）
      clearPluginTools(m.opts.pkgId);
      return;
    }
    m.status = "blocked";
    violate(m, `lockdown:${failed.join(",")}`.slice(0, 120));
    settleAll(m, "module_not_live", "封网自证未通过");
    clearPluginTools(m.opts.pkgId);
    teardown(m);
    return;
  }
  if (d.type === MOD_ERROR) {
    m.status = "dead";
    settleAll(m, "plugin_error", String(d.err ?? "模块求值失败").slice(0, 400));
    violate(m, "module:eval-error");
    teardown(m);
    clearPluginTools(m.opts.pkgId);
    return;
  }
  if (d.type === MOD_READY) {
    // 求值跑完了：`uartix.tools.register()` 都在里面同步发过，此刻取快照才是完整的
    m.ready = true;
    settleReady(m);
    return;
  }
  // 探针没通过 ⇒ 后面这些特权消息一概不受理（规矩 1）
  if (m.status !== "live") {
    violate(m, `${d.type}:pre-probe`);
    return;
  }
  const reqId = typeof d.reqId === "string" ? d.reqId : "";
  if (d.type === "aiw:tool-def") {
    const r = acceptToolDefs(m, d.tools);
    if (reqId) m.worker?.postMessage({ type: "aiw:tool-def-res", reqId, n: m.opts.nonce, ok: r.ok, data: r.info, err: r.err });
    return;
  }
  if (d.type === "aiw:tool-undef") {
    const names = Array.isArray(d.names) ? d.names.filter((x): x is string => typeof x === "string") : [];
    if (!names.length) {
      violate(m, "tool-undef:shape");
      return;
    }
    removePluginTools(m.opts.pkgId, names);
    if (reqId) m.worker?.postMessage({ type: "aiw:tool-undef-res", reqId, n: m.opts.nonce, ok: true, data: { names } });
  }
  if (d.type === "aiw:tool-ack") settleAck(m, d);
}

/** 注册受理：名字/描述/schema 三关，全在宿主侧；插件自报的其它字段一律不进决策。 */
function acceptToolDefs(
  m: Mod,
  tools: unknown,
): { ok: boolean; info: { added: string[]; rejected: { name: string; reason: string }[] }; err?: string } {
  if (!Array.isArray(tools) || !tools.length) {
    violate(m, "tool-def:shape");
    return { ok: false, info: { added: [], rejected: [] }, err: "tools 必须是非空数组" };
  }
  const defs: PluginToolDef[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const raw of tools.slice(0, MAX_DEFS_PER_MESSAGE)) {
    const t = raw as Record<string, unknown>;
    const name = typeof t?.name === "string" ? t.name : "";
    if (!TOOL_NAME_RE.test(name)) {
      rejected.push({ name: name.slice(0, 40), reason: "名字必须匹配 ^[a-z][a-z0-9_]{2,39}$" });
      continue;
    }
    const description = typeof t.description === "string" ? t.description.trim().slice(0, PLUGIN_TOOL_DESC_MAX) : "";
    if (!description) {
      rejected.push({ name, reason: "description 必填（它进每一轮模型请求，不能空）" });
      continue;
    }
    const sc = validateLiteSchema(t.parameters ?? { type: "object", properties: {}, additionalProperties: false });
    if (!sc.ok) {
      rejected.push({ name, reason: sc.errors[0] });
      continue;
    }
    defs.push({
      pkgId: m.opts.pkgId,
      pkgName: m.opts.pkgName,
      version: m.opts.version,
      baseName: name,
      description,
      parameters: t.parameters as Record<string, unknown>,
      caps: [...m.opts.caps],
    });
  }
  if (!defs.length) {
    violate(m, "tool-def:all-rejected");
    return { ok: false, info: { added: [], rejected }, err: "没有一支工具通过校验" };
  }
  const r = addPluginToolDefs(defs);
  for (const x of r.rejected) rejected.push(x);
  if (r.rejected.length) violate(m, "tool-def:limit");
  return { ok: r.ok, info: { added: r.added, rejected } };
}

function settleAck(m: Mod, d: Record<string, unknown>): void {
  const callId = typeof d.callId === "string" ? d.callId : "";
  const p = m.pending.get(callId);
  if (!p) {
    // 没有人在等这条 callId：要么已超时清掉，要么伪造。都算违规，且绝不回写任何东西
    violate(m, `tool-ack:orphan:${callId.slice(0, 40)}`);
    return;
  }
  m.pending.delete(callId);
  clearTimeout(p.timer);
  if (d.ok !== true) {
    p.resolve({ ok: false, code: "plugin_error", err: String(d.err ?? "插件执行失败").slice(0, 400) });
    return;
  }
  p.resolve({ ok: true, data: capAckData(d.data) });
}

/** 回执体积兜底（A7：超限必须带截断标记，不静默裁）。 */
function capAckData(data: unknown): unknown {
  let size: number;
  try {
    size = JSON.stringify(data ?? null)?.length ?? 0;
  } catch {
    return { truncated: true, note: "插件返回值无法序列化", head: String(data).slice(0, 2000) };
  }
  if (size <= PLUGIN_ACK_MAX_BYTES) return data;
  return {
    truncated: true,
    bytes: size,
    limit: PLUGIN_ACK_MAX_BYTES,
    head: JSON.stringify(data).slice(0, PLUGIN_ACK_MAX_BYTES),
  };
}

/**
 * 宿主 → 插件的一次调用。走 `aiw:tool-ack` 的 callId 关联；超时**强杀并重建**。
 */
export function callPluginTool(pkgId: string, baseName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const m = mods.get(pkgId);
  if (!m || m.status !== "live" || !m.worker) {
    return Promise.resolve({ ok: false, code: "module_not_live", err: `模块未在线（${m ? m.status : "none"}）` });
  }
  if (m.pending.size >= MAX_INFLIGHT_PER_MODULE) {
    return Promise.resolve({ ok: false, code: "module_busy", err: `该插件并发调用已达 ${MAX_INFLIGHT_PER_MODULE} 上限` });
  }
  let json: string;
  try {
    json = JSON.stringify(args ?? {});
  } catch {
    return Promise.resolve({ ok: false, code: "args_invalid", err: "参数无法序列化" });
  }
  if (json.length > MAX_ARGS_BYTES) {
    return Promise.resolve({ ok: false, code: "args_too_large", err: `参数 ${json.length} 字节，超过 ${MAX_ARGS_BYTES}` });
  }
  const callId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<ToolCallResult>((resolve) => {
    const timer = setTimeout(() => {
      if (!m.pending.delete(callId)) return;
      violate(m, `timeout:${baseName}`);
      rebuild(m, `工具「${baseName}」超时 ${MODULE_CALL_TIMEOUT_MS}ms`);
      resolve({ ok: false, code: "plugin_timeout", err: `插件工具「${baseName}」${MODULE_CALL_TIMEOUT_MS}ms 未返回，已终止并重建该模块` });
    }, MODULE_CALL_TIMEOUT_MS);
    m.pending.set(callId, { resolve, timer });
    m.worker?.postMessage({ type: "aiw:mod-call", n: m.opts.nonce, callId, tool: baseName, args });
  });
}

/**
 * 超时/失控之后重建：旧 worker 直接 terminate，重新走一遍 openModule（插件自己会再注册工具）。
 *
 * **重建有熔断**：连续第 `MAX_REBUILDS` 次失控后不再重建，判 `dead` 等人工停用/再启用。
 * 没有这一条，一支"每次调用都卡死"的工具就等于让 Agent 每轮都能拉起一次 worker 重建，
 * 把失败做成免费的循环（DoS 自己不算大事，但"永远不报错只是永远慢"很难归因）。
 */
function rebuild(m: Mod, why: string): void {
  const prevRebuilds = m.rebuilds + 1;
  const pkgId = m.opts.pkgId;
  settleAll(m, "plugin_unreachable", why);
  clearPluginTools(pkgId);
  teardown(m);
  if (prevRebuilds > MODULE_MAX_REBUILDS) {
    console.warn(`[moduleBus] ${pkgId} 连续失控 ${prevRebuilds} 次，停止重建（请在插件库停用后重新启用）`);
    const dead: Mod = {
      ...m, worker: null, status: "dead", rebuilds: prevRebuilds, pending: new Map(),
      ready: false, readyWaiters: [],
    };
    mods.set(pkgId, dead);
    settleReady(dead);
    return;
  }
  console.warn(`[moduleBus] ${pkgId} 重建 worker：${why}`);
  openModule(m.opts, m.factory);
  const next = mods.get(pkgId);
  if (next) next.rebuilds = prevRebuilds;
}

export function closeModule(pkgId: string): void {
  const m = mods.get(pkgId);
  if (!m) return;
  if (m.status === "probing") m.status = "dead";
  settleAll(m, "plugin_unreachable", "模块已停用");
  teardown(m);
  clearPluginTools(pkgId);
  mods.delete(pkgId);
  settleProbe(m);
  settleReady(m);
}

export function moduleStatusOf(pkgId: string): ModuleStatus | "none" {
  return mods.get(pkgId)?.status ?? "none";
}

/** 封网已过且求值完成（工具已登记）——臂模块的幂等判据用这个，不用单看 status */
export function moduleIsReady(pkgId: string): boolean {
  const m = mods.get(pkgId);
  return !!m && m.status === "live" && m.ready;
}

export function moduleDiagnostics(pkgId: string): { status: ModuleStatus | "none"; probeFailed: string[]; rebuilds: number } {
  const m = mods.get(pkgId);
  return { status: m?.status ?? "none", probeFailed: m?.probeFailed ?? [], rebuilds: m?.rebuilds ?? 0 };
}

export function liveModuleIds(): string[] {
  return [...mods.entries()].filter(([, m]) => m.status === "live").map(([id]) => id);
}
