/**
 * 自动编排器仓库（P74-4）：FlowDoc 增删改 + localStorage 持久化 + 导入导出 +
 * 序列套件转换器（设计 §7，零改动序列器）。
 *
 * 持久化分两键：
 * - `vs.orchestrator`      → FlowDoc（结构/变量声明）
 * - `vs.orchestrator.vars` → 「持久」变量的运行值镜像（P74c A1）
 *   引擎是运行值的唯一真源，store 通过 setVarsProvider 注入的 getter 取快照落盘；
 *   首次装载把快照作为 seed 交给引擎回填 → 「持久」语义闭环。
 *
 * 惯例与 sequencerStore 相同：模块级单例、快照订阅、防抖落盘、beforeunload
 * flush（带 typeof window 守卫）。引擎同步由 orchestratorBind 订阅本仓库完成
 * （store 不 import bind，防环）。
 *
 * 规范化红线：导入/加载的所有数据都过 normalize*（钳位到 ORCH_LIMITS），
 * 深度超限丢弃、未知类型丢弃、非法值回默认——绝不让脏数据进引擎。
 * 容量红线（组数 32 / 变量数 64）在**写入侧**也拦截，不只靠读侧截断兜底。
 *
 * Operator 只读边界（P74c C1，用户拍板「禁编辑、允许运行」）：
 * 本模块的**配置类**改动全部过 guardLocked()；**运行类**（setMasterOn 总开关）
 * 与**视图类**（updateGroup 的 collapsed 折叠）刻意放行——只读 ≠ 不能测试运行、
 * 不能展开看结构。守卫放在 store 而非 UI：AI/MCP/扩展面板等一切调用方同样受约束。
 */

import { guardLocked } from "../operator/lock";
import { newId } from "./blockRegistry";
import { ORCH_LIMITS, VAR_NAME_RE } from "./types";
import type {
  Cond,
  EventBlock,
  ExecBlock,
  FlowDoc,
  FlowNode,
  FlowVar,
  GroupNode,
  LogicBlock,
  OrchOp,
  VarFrom,
} from "./types";
import type { CmpOp, ExpectVal, FrameMatch, SendPayload, Suite, Step } from "../sequencer/types";

const KEY = "vs.orchestrator";
/**
 * 持久变量「运行值」区（P74c A1）。
 * 与文档分键存放：老版本存的是裸 FlowDoc，共用一键会破坏兼容。
 * 键值语义：{ 变量名: 现值 }，只镜像 persist=true 的变量（引擎 persistVars 决定）。
 */
const VARS_KEY = "vs.orchestrator.vars";

export interface OrchestratorState {
  doc: FlowDoc;
}

const listeners = new Set<() => void>();

let state: OrchestratorState = { doc: EMPTY_DOC() };

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function EMPTY_DOC(): FlowDoc {
  return { version: 1, title: "自动编排", vars: [], groups: [], settings: { masterOn: false } };
}

/* ================= 快照与订阅 ================= */

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): OrchestratorState {
  return state;
}

function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
  schedulePersist();
}

/* ================= 持久化 ================= */

let persistedVars: Record<string, number | string | boolean> = {};
let varsProvider: (() => Record<string, number | string | boolean>) | null = null;
let varsTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * bind 注入「引擎持久变量现值」供给（P74c A1）。
 * store 不 import bind（防环），所以用注入而不是直接读引擎。
 */
export function setVarsProvider(fn: (() => Record<string, number | string | boolean>) | null): void {
  varsProvider = fn;
}

/** 首次装载时交给引擎回填的持久值快照（返回副本，防外部改写内部状态） */
export function getPersistVars(): Record<string, number | string | boolean> {
  return { ...persistedVars };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const doc = normalizeDoc(JSON.parse(raw));
    if (doc) state = { doc };
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 无痕模式：忽略 */
    }
  }
}

function loadVars() {
  try {
    const raw = localStorage.getItem(VARS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const out: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
    persistedVars = out;
  } catch {
    persistedVars = {};
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 400);
}

/** 持久变量变动 → 防抖落盘（引擎 deps.onVarsChanged 直调；与文档落盘同节奏） */
export function scheduleVarsPersist() {
  if (varsTimer) clearTimeout(varsTimer);
  varsTimer = setTimeout(() => {
    varsTimer = null;
    refreshVars();
    writeVars();
  }, 400);
}

export function flush() {
  if (persistTimer) clearTimeout(persistTimer);
  persistNow();
}

function persistNow() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state.doc));
  } catch {
    /* 配额或无痕：内存状态仍在，忽略 */
  }
  // 文档与持久值区同步落盘：删变量/改类型/取消「持久」勾选都在这一步自净
  refreshVars();
  writeVars();
}

function refreshVars(): void {
  if (varsProvider) persistedVars = varsProvider();
}

function writeVars(): void {
  try {
    if (Object.keys(persistedVars).length === 0) localStorage.removeItem(VARS_KEY);
    else localStorage.setItem(VARS_KEY, JSON.stringify(persistedVars));
  } catch {
    /* 配额或无痕：忽略 */
  }
}

load();
loadVars();
if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);

/* ================= 规范化（导入 / 加载共用） ================= */

const num = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, def: string, cap = 200): string =>
  typeof v === "string" ? v.slice(0, cap) : def;
const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
const int = (v: unknown, def: number, lo: number, hi: number): number => num(v, def, lo, Math.max(lo, hi)) | 0;

const ORCH_OPS: readonly OrchOp[] = ["eq", "ne", "gt", "lt", "ge", "le", "approx"];

function normalizeOp(v: unknown, def: OrchOp): OrchOp {
  return ORCH_OPS.includes(v as OrchOp) ? (v as OrchOp) : def;
}

function normalizeScalar(v: unknown, def: number | string | boolean): number | string | boolean {
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return def;
}

function normalizeMatch(m: unknown): FrameMatch {
  if (!m || typeof m !== "object") return { by: "raw", hex: "" };
  const x = m as Record<string, unknown>;
  if (x.by === "tpl" && typeof x.tplId === "string") return { by: "tpl", tplId: x.tplId };
  if (x.by === "field" && typeof x.tplId === "string" && typeof x.fieldName === "string") {
    const op = ["eq", "ne", "gt", "lt", "ge", "le", "changed", "approx"].includes(x.op as string)
      ? (x.op as CmpOp)
      : "eq";
    const expected: ExpectVal =
      x.expected && typeof x.expected === "object" && typeof (x.expected as Record<string, unknown>).var === "string"
        ? { var: String((x.expected as Record<string, unknown>).var) }
        : typeof x.expected === "number"
          ? x.expected
          : 0;
    return { by: "field", tplId: x.tplId, fieldName: str(x.fieldName, "", 100), op, expected };
  }
  return { by: "raw", hex: str(x.hex, "", 512) };
}

function normalizeCond(v: unknown): Cond | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  switch (x.k) {
    case "chan":
      return {
        k: "chan",
        chId: str(x.chId, "", 100),
        op: normalizeOp(x.op, "gt"),
        value: num(x.value, 0, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        tol: num(x.tol, 0, 0, 1e9),
      };
    case "var":
      return {
        k: "var",
        name: str(x.name, "", 32),
        op: normalizeOp(x.op, "eq"),
        value: normalizeScalar(x.value, 0),
        tol: num(x.tol, 0, 0, 1e9),
      };
    case "expr":
      return { k: "expr", src: str(x.src, "", 512) };
    case "evtField":
      return {
        k: "evtField",
        field: str(x.field, "", 64),
        op: normalizeOp(x.op, "eq"),
        value: typeof x.value === "number" || typeof x.value === "string" ? x.value : 0,
        tol: num(x.tol, 0, 0, 1e9),
      };
    case "session":
      return x.state === "open" || x.state === "streaming" || x.state === "idle"
        ? { k: "session", state: x.state }
        : null;
    default:
      return null;
  }
}

function normalizeConds(v: unknown, cap = 8): Cond[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, cap).map((c) => normalizeCond(c)).filter(Boolean) as Cond[];
}

function normalizePayload(v: unknown): SendPayload {
  if (!v || typeof v !== "object") return { type: "hex", text: "" };
  const x = v as Record<string, unknown>;
  if (x.type === "ascii") return { type: "ascii", text: str(x.text, "", 2048) };
  if (x.type === "cmd") return { type: "cmd", cmdId: str(x.cmdId, "", 100) };
  if (x.type === "factory" && x.spec && typeof x.spec === "object") {
    return { type: "factory", spec: x.spec as Record<string, unknown> };
  }
  return { type: "hex", text: str(x.text, "", 2048) };
}

function normalizeVarFrom(v: unknown): VarFrom {
  if (!v || typeof v !== "object") return { k: "const", value: 0 };
  const x = v as Record<string, unknown>;
  if (x.k === "chan") return { k: "chan", chId: str(x.chId, "", 100) };
  if (x.k === "expr") return { k: "expr", src: str(x.src, "", 512) };
  if (x.k === "evtField") return { k: "evtField", field: str(x.field, "", 64) };
  return { k: "const", value: normalizeScalar(x.value, 0) };
}

function normalizeEvents(v: unknown): EventBlock[] {
  if (!Array.isArray(v)) return [];
  const out: EventBlock[] = [];
  for (const raw of v.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const x = raw as Record<string, unknown>;
    const id = str(x.id, "", 40) || newId("ev");
    switch (x.kind) {
      case "manual":
        out.push({ id, kind: "manual" });
        break;
      case "session":
        out.push({ id, kind: "session", phase: x.phase === "stop" ? "stop" : "start" });
        break;
      case "frame":
        out.push({ id, kind: "frame", match: normalizeMatch(x.match), stride: int(x.stride, 1, 1, 10000) });
        break;
      case "threshold":
        out.push({
          id,
          kind: "threshold",
          chId: str(x.chId, "", 100),
          op: x.op === "below" ? "below" : "above",
          value: num(x.value, 0, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
          edge: x.edge === "exit" ? "exit" : "enter",
          debounceMs: int(x.debounceMs, 0, 0, 60000),
        });
        break;
      case "timer":
        out.push({ id, kind: "timer", intervalMs: int(x.intervalMs, 5000, 50, 3600000) });
        break;
      case "sentinel":
        out.push({ id, kind: "sentinel", level: x.level === "crit" ? "crit" : "warn" });
        break;
      case "varChanged":
        out.push({ id, kind: "varChanged", varName: str(x.varName, "", 32) });
        break;
    /* ---------- B4d 新增 ---------- */
    case "frameError":
      out.push({ id, kind: "frameError", stride: int(x.stride, 1, 1, 10000) });
      break;
    case "chanChanged":
      out.push({
        id,
        kind: "chanChanged",
        chId: str(x.chId, "", 100),
        tol: num(x.tol, 0, 0, Number.MAX_SAFE_INTEGER),
        minIntervalMs: int(x.minIntervalMs, 1000, 50, 3600000),
      });
      break;
    case "newTpl":
      out.push({ id, kind: "newTpl", tplId: str(x.tplId, "", 60) });
      break;
    case "flowEvt":
      out.push({ id, kind: "flowEvt", name: str(x.name, "", ORCH_LIMITS.flowEvtNameMax) });
      break;
    case "idle":
      out.push({ id, kind: "idle", idleMs: int(x.idleMs, 10000, 1000, 3600000) });
      break;
    }
  }
  return out;
}

function normalizeBlock(v: unknown, depth: number): FlowNode | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const base = { id: str(x.id, "", 40) || newId("b"), note: str(x.note, "", 200) || undefined, enabled: bool(x.enabled, true) };

  if (x.kind === "group" && depth < ORCH_LIMITS.nodeDepthMax) {
    return {
      kind: "group",
      ...base,
      name: str(x.name, "子组", 60) || "子组",
      note: str(x.note, "", 200) || undefined,
      collapsed: bool(x.collapsed, false),
      cooldownMs: int(x.cooldownMs, 0, 0, 600000),
      queuePolicy:
        x.queuePolicy === "dropOld" || x.queuePolicy === "stopOld" ? x.queuePolicy : "dropNew",
      events: normalizeEvents(x.events),
      children: normalizeNodes(x.children, depth + 1),
    } satisfies GroupNode;
  }

  const eBase = {
    ...base,
    onFail: x.onFail === "continue" ? ("continue" as const) : ("abort" as const),
  };

  switch (x.kind) {
    case "send":
      return { ...eBase, kind: "send", payload: normalizePayload(x.payload) } satisfies ExecBlock;
    case "wait":
      return { ...eBase, kind: "wait", ms: int(x.ms, 1000, ORCH_LIMITS.waitMinMs, ORCH_LIMITS.waitMaxMs) } satisfies ExecBlock;
    case "waitFrame":
      return {
        ...eBase,
        kind: "waitFrame",
        match: normalizeMatch(x.match),
        timeoutMs: int(x.timeoutMs, 3000, 0, ORCH_LIMITS.frameTimeoutMaxMs),
        ignoreFail: bool(x.ignoreFail, false),
      } satisfies ExecBlock;
    case "runSuite":
      return { ...eBase, kind: "runSuite", suiteId: str(x.suiteId, "", 60), wait: bool(x.wait, true) } satisfies ExecBlock;
    case "runGroup":
      return { ...eBase, kind: "runGroup", groupId: str(x.groupId, "", 60), wait: bool(x.wait, true) } satisfies ExecBlock;
    case "setVar":
      return { ...eBase, kind: "setVar", name: str(x.name, "", 32), from: normalizeVarFrom(x.from) } satisfies ExecBlock;
    case "toast":
      return {
        ...eBase,
        kind: "toast",
        level: x.level === "warn" || x.level === "crit" ? x.level : "info",
        text: str(x.text, "", 200),
      } satisfies ExecBlock;
    case "sound":
      return { ...eBase, kind: "sound", level: x.level === "crit" ? "crit" : "warn" } satisfies ExecBlock;
    /* ---------- B4c 新增 ---------- */
    case "setControl":
      return { ...eBase, kind: "setControl", varName: str(x.varName, "", 64), from: normalizeVarFrom(x.from) } satisfies ExecBlock;
    case "setSwitch":
      return {
        ...eBase,
        kind: "setSwitch",
        swName: str(x.swName, "", 60),
        state: x.state === "on" || x.state === "off" ? x.state : "toggle",
      } satisfies ExecBlock;
    case "modbusWrite":
      return {
        ...eBase,
        kind: "modbusWrite",
        slave: int(x.slave, 1, 0, ORCH_LIMITS.mbSlaveMax),
        fn: x.fn === 5 ? 5 : 6,
        addr: int(x.addr, 0, 0, ORCH_LIMITS.mbAddrMax),
        value: int(x.value, 0, -0x8000, 0xffff),
      } satisfies ExecBlock;
    case "log":
      return {
        ...eBase,
        kind: "log",
        level: x.level === "warn" || x.level === "crit" ? x.level : "info",
        text: str(x.text, "", 200),
      } satisfies ExecBlock;
    case "snapshot":
      return {
        ...eBase,
        kind: "snapshot",
        panel: x.panel === "plot3d" || x.panel === "spectrum" ? x.panel : "plot2d",
        note: str(x.note, "", 200),
      } satisfies ExecBlock;
    case "exportCsv":
      return {
        ...eBase,
        kind: "exportCsv",
        chanId: str(x.chanId, "", 100),
        lastN: int(x.lastN, 1000, 1, ORCH_LIMITS.csvLastNCap),
      } satisfies ExecBlock;
    case "stopSuite":
      return { ...eBase, kind: "stopSuite" } satisfies ExecBlock;
    case "emitFlow": {
      const raw = Array.isArray(x.data) ? x.data : [];
      const data = raw.slice(0, ORCH_LIMITS.emitFlowDataMax).map((d) => {
        const rec = (d ?? {}) as Record<string, unknown>;
        return { k: str(rec.k, "", ORCH_LIMITS.flowEvtNameMax), src: str(rec.src, "", 300) };
      });
      return { ...eBase, kind: "emitFlow", name: str(x.name, "", ORCH_LIMITS.flowEvtNameMax), data } satisfies ExecBlock;
    }
    case "clip":
      return { ...eBase, kind: "clip", text: str(x.text, "", 200) } satisfies ExecBlock;
    case "resetVars":
      return {
        ...eBase,
        kind: "resetVars",
        scope: x.scope === "one" ? "one" : "all",
        name: str(x.name, "", 32),
      } satisfies ExecBlock;
    case "if":
      if (depth >= ORCH_LIMITS.nodeDepthMax) return null;
      return {
        ...base,
        kind: "if",
        conds: normalizeConds(x.conds),
        then: normalizeNodes(x.then, depth + 1),
        els: normalizeNodes(x.els, depth + 1),
      } satisfies LogicBlock;
    case "loop":
      if (depth >= ORCH_LIMITS.nodeDepthMax) return null;
      return {
        ...base,
        kind: "loop",
        mode: x.mode === "while" ? "while" : "count",
        count: int(x.count, 3, 1, ORCH_LIMITS.loopIterCap),
        cond: normalizeConds(x.cond),
        intervalMs: int(x.intervalMs, 100, 0, 600000),
        body: normalizeNodes(x.body, depth + 1),
      } satisfies LogicBlock;
    case "break":
      return { ...base, kind: "break" } satisfies LogicBlock;
    case "abort":
      return { ...base, kind: "abort" } satisfies LogicBlock;
    default:
      return null;
  }
}

/** 块数组规范化 + onFail 补全（exec 块必须带 onFail，非 continue 一律 abort） */
function normalizeNodes(v: unknown, depth: number): FlowNode[] {
  if (!Array.isArray(v)) return [];
  const out: FlowNode[] = [];
  for (const raw of v.slice(0, 200)) {
    const n = normalizeBlock(raw, depth);
    if (!n) continue;
    if ("onFail" in n) {
      const e = n as ExecBlock;
      if (e.onFail !== "continue") e.onFail = "abort";
    }
    out.push(n);
  }
  return out;
}

function normalizeVar(v: unknown): FlowVar | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const name = str(x.name, "", 32);
  if (!VAR_NAME_RE.test(name)) return null;
  const type = x.type === "string" || x.type === "bool" ? x.type : "number";
  let def: number | string | boolean;
  if (type === "number") {
    const n = typeof x.def === "number" && Number.isFinite(x.def) ? x.def : 0;
    def = n;
  } else if (type === "bool") {
    // 与引擎 converge 同语义：1/"1"/"true" → true；0/"0"/"false"/"" → false
    const d = x.def;
    if (typeof d === "boolean") def = d;
    else if (d === 1 || d === "1" || d === "true") def = true;
    else if (d === 0 || d === "0" || d === "false" || d === "") def = false;
    else def = false;
  } else {
    def = str(x.def, "", ORCH_LIMITS.varStrCap);
  }
  return { name, type, def, persist: bool(x.persist, false) };
}

export function normalizeDoc(v: unknown): FlowDoc | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (!Array.isArray(x.groups)) return null;

  // 变量：非法名跳过、重名去重、数量钳位
  const vars: FlowVar[] = [];
  const seen = new Set<string>();
  for (const raw of (Array.isArray(x.vars) ? x.vars : []).slice(0, ORCH_LIMITS.varCap)) {
    const v = normalizeVar(raw);
    if (v && !seen.has(v.name)) {
      seen.add(v.name);
      vars.push(v);
    }
  }

  const groups: GroupNode[] = [];
  const gids = new Set<string>();
  for (const raw of x.groups.slice(0, ORCH_LIMITS.groupCap)) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = str(g.id, "", 40) || newId("g");
    if (gids.has(id)) continue;
    gids.add(id);
    groups.push({
      kind: "group",
      id,
      name: str(g.name, "未命名组", 60) || "未命名组",
      note: str(g.note, "", 200) || undefined,
      enabled: bool(g.enabled, true),
      collapsed: bool(g.collapsed, false),
      cooldownMs: int(g.cooldownMs, 0, 0, 600000),
      queuePolicy:
        g.queuePolicy === "dropOld" || g.queuePolicy === "stopOld" ? g.queuePolicy : "dropNew",
      events: normalizeEvents(g.events),
      children: normalizeNodes(g.children, 1),
    });
  }

  return {
    version: 1,
    title: str(x.title, "自动编排", 120) || "自动编排",
    vars,
    groups,
    settings: {
      masterOn: bool((x.settings as Record<string, unknown> | undefined)?.masterOn, false),
    },
  };
}

/* ================= 组操作 ================= */

/** 总开关 = 运行类操作：Operator 只读模式下放行（用户拍板：禁编辑、允许运行） */
export function setMasterOn(b: boolean) {
  state.doc.settings.masterOn = b;
  emit();
}

/**
 * 新建组。返回 null = 已达 groupCap（红线 32）**或** Operator 只读锁定——写入侧拦截，
 * 不再制造「加进去了但引擎静默截断不触发」的假象（P74c A4）。
 */
export function addGroup(name?: string): string | null {
  if (guardLocked()) return null;
  if (state.doc.groups.length >= ORCH_LIMITS.groupCap) return null;
  const g = makeGroup(name);
  state.doc.groups.push(g);
  emit();
  return g.id;
}

/** 组数是否已达上限（UI 事前置灰/计数用） */
export function atGroupCap(): boolean {
  return state.doc.groups.length >= ORCH_LIMITS.groupCap;
}

/**
 * 从内置模板导入组（B4e 模板库）：build() 已生成全新 id。
 * **默认未启用**（模板参数是示意值）——与序列导入同红线：用户检查后手动打开。
 * 返回 null = Operator 只读 / 达 groupCap。
 */
export function importPresetGroup(g: GroupNode): string | null {
  if (guardLocked()) return null;
  if (state.doc.groups.length >= ORCH_LIMITS.groupCap) return null;
  state.doc.groups.push(g);
  emit();
  return g.id;
}

export function makeGroup(name?: string): GroupNode {
  return {
    kind: "group",
    id: newId("g"),
    name: name ?? `编排组 ${state.doc.groups.length + 1}`,
    enabled: true,
    cooldownMs: 0,
    queuePolicy: "dropNew",
    events: [],
    children: [],
  };
}

export function removeGroup(groupId: string) {
  if (guardLocked()) return;
  const i = state.doc.groups.findIndex((g) => g.id === groupId);
  if (i >= 0) {
    state.doc.groups.splice(i, 1);
    emit();
  }
}

export function updateGroup(
  groupId: string,
  patch: Partial<Pick<GroupNode, "name" | "enabled" | "collapsed" | "cooldownMs" | "queuePolicy" | "note">>,
) {
  // 折叠/展开是「看结构」不是「改配置」：Operator 只读时放行，其余字段锁定（P74c C1）
  const viewOnly = Object.keys(patch).every((k) => k === "collapsed");
  if (!viewOnly && guardLocked()) return;
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  if (patch.name !== undefined) g.name = str(patch.name, g.name, 60) || g.name;
  if (patch.enabled !== undefined) g.enabled = patch.enabled;
  if (patch.collapsed !== undefined) g.collapsed = patch.collapsed;
  if (patch.cooldownMs !== undefined) g.cooldownMs = int(patch.cooldownMs, 0, 0, 600000);
  if (patch.queuePolicy !== undefined) g.queuePolicy = patch.queuePolicy;
  if (patch.note !== undefined) g.note = str(patch.note, "", 200) || undefined;
  emit();
}

export function moveGroup(groupId: string, toIndex: number) {
  if (guardLocked()) return;
  const list = state.doc.groups;
  const from = list.findIndex((g) => g.id === groupId);
  if (from < 0) return;
  const [g] = list.splice(from, 1);
  const to = Math.min(list.length, Math.max(0, toIndex > from ? toIndex - 1 : toIndex));
  list.splice(to, 0, g);
  emit();
}

export function duplicateGroup(groupId: string): string | null {
  if (guardLocked()) return null;
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return null;
  if (state.doc.groups.length >= ORCH_LIMITS.groupCap) return null;
  const copy = reId(JSON.parse(JSON.stringify(g)) as FlowNode) as GroupNode;
  copy.id = newId("g");
  copy.name = `${g.name} 副本`;
  state.doc.groups.push(copy);
  emit();
  return copy.id;
}

/** 深拷贝后重写全部 id（组/块/事件） */
function reId(node: FlowNode): FlowNode {
  node.id = newId("b");
  if (node.kind === "group") {
    node.events = node.events.map((e) => ({ ...e, id: newId("ev") }));
    node.children = node.children.map(reId);
  } else if (node.kind === "if") {
    node.then = node.then.map(reId);
    node.els = node.els.map(reId);
  } else if (node.kind === "loop") {
    node.body = node.body.map(reId);
  }
  return node;
}

/* ================= 事件槽操作 ================= */

export function addEvent(groupId: string, ev: EventBlock) {
  if (guardLocked()) return;
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g || g.events.length >= 8) return;
  g.events.push({ ...ev, id: ev.id || newId("ev") });
  emit();
}

export function updateEvent(groupId: string, eventId: string, patch: Partial<EventBlock>) {
  if (guardLocked()) return;
  const g = state.doc.groups.find((x) => x.id === groupId);
  const ev = g?.events.find((e) => e.id === eventId);
  if (!g || !ev) return;
  Object.assign(ev, patch, { id: ev.id, kind: ev.kind });
  emit();
}

export function removeEvent(groupId: string, eventId: string) {
  if (guardLocked()) return;
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  const i = g.events.findIndex((e) => e.id === eventId);
  if (i >= 0) {
    g.events.splice(i, 1);
    emit();
  }
}

/** 事件槽内拖拽排序：to=-1 → 移到末尾；to=事件 id → 移到该事件之前 */
export function moveEventTo(groupId: string, eventId: string, to: string | number): boolean {
  if (guardLocked()) return false;
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return false;
  const from = g.events.findIndex((e) => e.id === eventId);
  if (from < 0) return false;
  const [ev] = g.events.splice(from, 1);
  const at =
    typeof to === "number"
      ? to < 0
        ? g.events.length
        : Math.min(g.events.length, Math.max(0, to))
      : Math.max(0, g.events.findIndex((e) => e.id === to));
  g.events.splice(at, 0, ev);
  emit();
  return true;
}

/* ================= 块树操作 ================= */

export interface BlockLoc {
  parentId: string | null;
  index: number;
  list: FlowNode[];
}

/** 在组内全树定位块（含 if/loop/嵌套组的子列表） */
export function locate(groupId: string, blockId: string): BlockLoc | null {
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return null;
  const walk = (list: FlowNode[], parentId: string | null): BlockLoc | null => {
    const i = list.findIndex((n) => n.id === blockId);
    if (i >= 0) return { parentId, index: i, list };
    for (const n of list) {
      const subs =
        n.kind === "group" ? [n.children] : n.kind === "if" ? [n.then, n.els] : n.kind === "loop" ? [n.body] : [];
      for (const sub of subs) {
        const hit = walk(sub, n.id);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(g.children, null);
}

function listFor(groupId: string, parentId: string | null, which?: "then" | "els"): FlowNode[] | null {
  const g = state.doc.groups.find((x) => x.id === groupId);
  if (!g) return null;
  if (parentId === null) return g.children;
  const p = locate(groupId, parentId);
  if (!p) return null;
  const pn = p.list[p.index];
  return pn.kind === "group" ? pn.children : pn.kind === "if" ? (which === "els" ? pn.els : pn.then) : pn.kind === "loop" ? pn.body : null;
}

/** 添加块：parentId=null → 组顶层；否则必须是容器（group/if/loop）id，if 用 which 选 then/els。返回块 id */
export function addBlock(groupId: string, parentId: string | null, index: number | null, node: FlowNode, which?: "then" | "els"): string | null {
  if (guardLocked()) return null;
  const list = listFor(groupId, parentId, which);
  if (!list) return null;
  if (list.length >= 200) return null;
  const at = index === null ? list.length : Math.min(list.length, Math.max(0, index));
  list.splice(at, 0, node);
  emit();
  return node.id;
}

export function updateBlock(groupId: string, blockId: string, patch: Record<string, unknown>) {
  if (guardLocked()) return;
  const loc = locate(groupId, blockId);
  if (!loc) return;
  const n = loc.list[loc.index];
  // 守卫字段：身份不可改
  const { id: _id, kind: _kind, ...rest } = patch;
  void _id;
  void _kind;
  Object.assign(n, rest);
  emit();
}

export function removeBlock(groupId: string, blockId: string) {
  if (guardLocked()) return;
  const loc = locate(groupId, blockId);
  if (!loc) return;
  loc.list.splice(loc.index, 1);
  emit();
}

export function duplicateBlock(groupId: string, blockId: string): string | null {
  if (guardLocked()) return null;
  const loc = locate(groupId, blockId);
  if (!loc) return null;
  const copy = reId(JSON.parse(JSON.stringify(loc.list[loc.index])) as FlowNode);
  loc.list.splice(loc.index + 1, 0, copy);
  emit();
  return copy.id;
}

/** 移动块（拖拽落点）。防自嵌套：目标父列表在拖动块子树内 → 拒绝。if 容器用 which 选 then/els（默认 then） */
export function moveBlock(groupId: string, blockId: string, parentId: string | null, index: number, which?: "then" | "els"): boolean {
  if (guardLocked()) return false;
  const loc = locate(groupId, blockId);
  const target = listFor(groupId, parentId, which);
  if (!loc || !target) return false;
  // 自嵌套守卫：从自身子树往外挪合法，往自身子树里挪非法
  const inSubtree = (() => {
    let p: string | null = parentId;
    while (p !== null) {
      if (p === blockId) return true;
      const pl = locate(groupId, p);
      if (!pl) return true;
      p = pl.parentId;
    }
    return false;
  })();
  if (inSubtree) return false;
  const [n] = loc.list.splice(loc.index, 1);
  // 同列表内删除后索引修正：删除点在插入点之前 → 插入索引左移一位
  let at = Math.min(target.length, Math.max(0, index));
  if (target === loc.list && loc.index < index) at -= 1;
  target.splice(at, 0, n);
  emit();
  return true;
}

/**
 * 跨组移动块（P75 B3）：拖拽跨组卡的既有语义补全——旧内核里跨组悬停会被
 * locate(源组, 外组行) 静默吞掉，用户视角就是"拖不动"。
 * 同组直接转走 moveBlock（保留自嵌套守卫与同列表索引修正）；
 * 异组时两棵组树不相交，无自嵌套问题，摘出即插。
 */
export function moveBlockAcross(fromGid: string, blockId: string, toGid: string, parentId: string | null, index: number, which?: "then" | "els"): boolean {
  if (guardLocked()) return false;
  if (fromGid === toGid) return moveBlock(fromGid, blockId, parentId, index, which);
  const loc = locate(fromGid, blockId);
  const target = listFor(toGid, parentId, which);
  if (!loc || !target) return false;
  const [n] = loc.list.splice(loc.index, 1);
  target.splice(Math.min(target.length, Math.max(0, index)), 0, n);
  emit();
  return true;
}

/* ================= 变量库操作 ================= */

export function addVar(v: FlowVar): boolean {
  if (guardLocked()) return false;
  if (state.doc.vars.length >= ORCH_LIMITS.varCap || !VAR_NAME_RE.test(v.name)) return false;
  if (state.doc.vars.some((x) => x.name === v.name)) return false;
  state.doc.vars.push({ ...v, def: clampVarDef(v) });
  emit();
  return true;
}

export function updateVar(name: string, patch: Partial<FlowVar>) {
  if (guardLocked()) return;
  const v = state.doc.vars.find((x) => x.name === name);
  if (!v) return;
  if (patch.name !== undefined && VAR_NAME_RE.test(patch.name) && !state.doc.vars.some((x) => x.name === patch.name && x !== v)) {
    v.name = patch.name;
  }
  if (patch.type !== undefined) v.type = patch.type;
  if (patch.def !== undefined) v.def = patch.def;
  v.def = clampVarDef(v);
  if (patch.persist !== undefined) v.persist = patch.persist;
  emit();
}

export function removeVar(name: string) {
  if (guardLocked()) return;
  const i = state.doc.vars.findIndex((x) => x.name === name);
  if (i >= 0) {
    state.doc.vars.splice(i, 1);
    emit();
  }
}

function clampVarDef(v: FlowVar): number | string | boolean {
  if (v.type === "number") return typeof v.def === "number" && Number.isFinite(v.def) ? v.def : 0;
  if (v.type === "bool") return typeof v.def === "boolean" ? v.def : false;
  return String(v.def ?? "").slice(0, ORCH_LIMITS.varStrCap);
}

/* ================= 导入 / 导出 ================= */

export function exportJSON(): string {
  return JSON.stringify(state.doc, null, 2);
}

/** 导入（整文档替换）。返回 null = 成功；否则为错误说明 */
export function importJSON(text: string): string | null {
  // 锁定时 guardLocked 已给出提示；返回 null（当作「已处理」）避免 UI 二次弹窗
  if (guardLocked()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "不是合法的 JSON 文件";
  }
  const doc = normalizeDoc(parsed);
  if (!doc) return "文件缺少 groups 数组，不是编排文档";
  state = { doc };
  emit();
  return null;
}

/* ================= 工厂（B4a：迁至 blockRegistry，此处仅转发保持旧 import 路径不破） ================= */

export { makeBlock, makeEvent, newId } from "./blockRegistry";
export type { NewBlockKind, NewEventKind } from "./blockRegistry";

/* ================= 序列套件 → 编排组转换器（设计 §7） ================= */

const EXPR_OP: Record<string, string> = { eq: "==", ne: "!=", gt: ">", lt: "<", ge: ">=", le: "<=" };

function baseOf(step: Step): { id: string; note?: string; enabled: boolean } {
  return { id: step.id || newId("b"), note: step.note || undefined, enabled: step.enabled };
}

function assertToCond(step: Extract<Step, { kind: "assertVar" }>): Cond | null {
  const op = step.op;
  if (op === "changed") return null; // 序列器运行期语义，编排器无对应（设计：跳过）
  const e = step.expected;
  if (e === undefined || typeof e === "number") {
    if (op === "approx") return { k: "var", name: step.varName, op: "approx", value: e ?? 0, tol: step.tolerance ?? 0 };
    return { k: "var", name: step.varName, op: op as OrchOp, value: e ?? 0 };
  }
  // 期望值引用变量 → 表达式条件（approx 用区间与表达）
  if (op === "approx") {
    const t = step.tolerance ?? 0;
    return { k: "expr", src: `${step.varName} >= ${e.var} - ${t} && ${step.varName} <= ${e.var} + ${t}` };
  }
  return { k: "expr", src: `${step.varName} ${EXPR_OP[op] ?? "=="} ${e.var}` };
}

function convertSteps(steps: Step[], onFailure: "abort" | "continue", depth: number): FlowNode[] {
  const out: FlowNode[] = [];
  let pendingNote: string | undefined;
  for (const s of steps) {
    const base = baseOf(s);
    const onFail = onFailure;
    switch (s.kind) {
      case "send":
        out.push({ ...base, note: s.note || pendingNote, kind: "send", onFail, payload: s.payload });
        pendingNote = undefined;
        break;
      case "wait":
        out.push({ ...base, note: s.note || pendingNote, kind: "wait", onFail, ms: s.ms });
        pendingNote = undefined;
        break;
      case "waitForFrame":
        out.push({ ...base, note: s.note || pendingNote, kind: "waitFrame", onFail, match: s.match, timeoutMs: s.timeoutMs, ignoreFail: false });
        pendingNote = undefined;
        break;
      case "assertVar": {
        const cond = assertToCond(s);
        if (!cond) {
          pendingNote = [pendingNote, `断言 ${s.varName}（changed 需手动补条件）`].filter(Boolean).join("；");
          break;
        }
        out.push({
          ...base,
          note: s.note || pendingNote,
          kind: "if",
          conds: [cond],
          then: [],
          els: [{ id: newId("b"), enabled: true, kind: "abort", note: `断言失败：${s.varName}` }],
        });
        pendingNote = undefined;
        break;
      }
      case "note":
        pendingNote = [pendingNote, s.text].filter(Boolean).join("；");
        break;
      case "group": {
        if (depth >= ORCH_LIMITS.nodeDepthMax - 1) {
          pendingNote = [pendingNote, `分组「${s.name}」超深度上限，未导入`].filter(Boolean).join("；");
          break;
        }
        const children =
          s.repeats > 1
            ? [
                {
                  id: newId("b"),
                  enabled: true,
                  kind: "loop" as const,
                  mode: "count" as const,
                  count: Math.min(s.repeats, ORCH_LIMITS.loopIterCap),
                  intervalMs: 0,
                  body: convertSteps(s.children, s.onFailure, depth + 1),
                },
              ]
            : convertSteps(s.children, s.onFailure, depth + 1);
        out.push({
          ...base,
          note: s.note || pendingNote,
          kind: "group",
          name: s.name,
          events: [],
          children,
        });
        pendingNote = undefined;
        break;
      }
    }
  }
  return out;
}

/** 序列套件 → 编排组（设计 §7：导入后「未启用」，事件转事件槽，含 onFrame 触发） */
export function convertSuite(suite: Suite): GroupNode {
  const events: EventBlock[] = [];
  let cooldownMs = 0;
  if (suite.trigger.mode === "onFrame") {
    events.push({ id: newId("ev"), kind: "frame", match: suite.trigger.match, stride: 1 });
    cooldownMs = suite.trigger.cooldownMs;
  }
  return {
    kind: "group",
    id: newId("g"),
    name: suite.name || "导入的序列",
    enabled: false, // 用户检查后手动开（设计红线）
    cooldownMs,
    queuePolicy: "dropNew",
    events,
    children: convertSteps(suite.steps, suite.failFast ? "abort" : "continue", 1),
  };
}

/** 从序列导入：追加为未启用组。返回组 id 或 null（套件为空 / 达上限 / Operator 只读） */
export function importSuite(suite: Suite): string | null {
  if (guardLocked()) return null;
  if (!suite.steps.length) return null;
  const g = convertSuite(suite);
  if (state.doc.groups.length >= ORCH_LIMITS.groupCap) return null;
  state.doc.groups.push(g);
  emit();
  return g.id;
}
