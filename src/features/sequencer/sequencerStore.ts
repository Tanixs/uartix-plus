/**
 * 测试序列仓库（T1）：Suite 的增删改 + localStorage 持久化。
 *
 * 与 slaveStore/pollStore 同一套惯例：模块级单例、快照订阅、防抖落盘、
 * beforeunload flush（带 typeof window 守卫，node 测试环境无 window）。
 * 运行态不在这里——引擎（runner.ts）自带互斥与进度回调，T3 再把两者绑到 UI。
 */

import {
  LIMITS,
  STEP_KINDS,
  type CmpOp,
  type ExpectVal,
  type FrameMatch,
  type Step,
  type StepKind,
  type Suite,
  type SuiteTrigger,
} from "./types";

const KEY = "vs.sequencer";

export interface SequencerState {
  suites: Suite[];
}

const listeners = new Set<() => void>();

let state: SequencerState = { suites: [] };

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idSeq = 0;

function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36).padStart(2, "0")}${Math.floor(
    Math.random() * 36 * 36,
  )
    .toString(36)
    .padStart(2, "0")}`;
}

/* ================= 快照与订阅 ================= */

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): SequencerState {
  return state;
}

function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
  schedulePersist();
}

/* ================= 持久化 ================= */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as { suites?: unknown };
    if (Array.isArray(s.suites)) {
      state = { suites: s.suites.flatMap((x) => normalizeSuite(x)).filter(Boolean) as Suite[] };
    }
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 无痕模式：忽略 */
    }
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 400);
}

/** 立即落盘（关窗前必须落一次，否则防抖窗口内的编辑会丢） */
export function flush() {
  if (persistTimer) clearTimeout(persistTimer);
  persistNow();
}

function persistNow() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ suites: state.suites }));
  } catch {
    /* 配额或无痕：内存状态仍在，忽略 */
  }
}

/* ================= 规范化（导入 / 加载共用） ================= */

const num = (v: unknown, def: number, lo: number, hi: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(hi, Math.max(lo, n));
};

function normalizeMatch(m: unknown): FrameMatch | null {
  if (!m || typeof m !== "object") return null;
  const x = m as Record<string, unknown>;
  if (x.by === "tpl" && typeof x.tplId === "string") return { by: "tpl", tplId: x.tplId };
  if (x.by === "raw" && typeof x.hex === "string") return { by: "raw", hex: x.hex };
  if (
    x.by === "field" &&
    typeof x.tplId === "string" &&
    typeof x.fieldName === "string" &&
    typeof x.op === "string"
  ) {
    return {
      by: "field",
      tplId: x.tplId,
      fieldName: x.fieldName,
      op: x.op as CmpOp,
      expected: (typeof x.expected === "number" ? x.expected : 0) as ExpectVal,
    };
  }
  return null;
}

function normalizeTrigger(t: unknown): SuiteTrigger {
  if (t && typeof t === "object") {
    const x = t as Record<string, unknown>;
    if (x.mode === "onFrame") {
      const match = normalizeMatch(x.match);
      if (match) {
        return { mode: "onFrame", match, cooldownMs: num(x.cooldownMs, 500, 0, 60_000) };
      }
    }
  }
  return { mode: "manual" };
}

/** 未知 kind / 结构损坏的步骤直接丢弃，不抛错（导入文件不可信） */
function normalizeStep(s: unknown, depth: number): Step | null {
  if (!s || typeof s !== "object") return null;
  const x = s as Record<string, unknown>;
  if (typeof x.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(x.kind)) return null;
  const base = {
    id: typeof x.id === "string" && x.id ? x.id : newId("st"),
    note: typeof x.note === "string" ? x.note : undefined,
    enabled: x.enabled !== false,
  };
  switch (x.kind) {
    case "send": {
      const p = x.payload as Record<string, unknown> | undefined;
      if (!p) return null;
      if (p.type === "hex" && typeof p.text === "string") {
        return { ...base, kind: "send", payload: { type: "hex", text: p.text } };
      }
      if (p.type === "ascii" && typeof p.text === "string") {
        return { ...base, kind: "send", payload: { type: "ascii", text: p.text } };
      }
      if (p.type === "cmd" && typeof p.cmdId === "string") {
        return { ...base, kind: "send", payload: { type: "cmd", cmdId: p.cmdId } };
      }
      // factory 载荷原样保留（v2 执行；校验交给执行期）
      if (p.type === "factory" && p.spec && typeof p.spec === "object") {
        return { ...base, kind: "send", payload: { type: "factory", spec: p.spec as Record<string, unknown> } };
      }
      return null;
    }
    case "wait":
      return { ...base, kind: "wait", ms: num(x.ms, 100, LIMITS.waitMinMs, LIMITS.waitMaxMs) };
    case "waitForFrame": {
      const match = normalizeMatch(x.match);
      if (!match) return null;
      return {
        ...base,
        kind: "waitForFrame",
        match,
        timeoutMs: num(x.timeoutMs, 3000, 0, LIMITS.frameTimeoutMaxMs),
      };
    }
    case "assertVar": {
      if (typeof x.varName !== "string" || !x.varName) return null;
      if (typeof x.op !== "string") return null;
      return {
        ...base,
        kind: "assertVar",
        varName: x.varName,
        op: x.op as CmpOp,
        expected: typeof x.expected === "number" ? x.expected : undefined,
        tolerance: typeof x.tolerance === "number" ? x.tolerance : undefined,
      };
    }
    case "group": {
      // depth 从 1 起算：groupDepthMax=4 表示最多 4 层组（与 runner 执行侧同语义）
      if (depth > LIMITS.groupDepthMax) return null;
      const children = Array.isArray(x.children)
        ? x.children.flatMap((c) => normalizeStep(c, depth + 1) ?? [])
        : [];
      return {
        ...base,
        kind: "group",
        name: typeof x.name === "string" ? x.name : "分组",
        repeats: num(x.repeats, 1, 1, LIMITS.groupRepeatsMax),
        onFailure: x.onFailure === "continue" ? "continue" : "abort",
        children,
      };
    }
    case "note":
      return { ...base, kind: "note", text: typeof x.text === "string" ? x.text : "" };
    default:
      return null;
  }
}

/** 导入/加载入口：损坏条目静默丢弃。返回 null = 整个对象无效 */
export function normalizeSuite(raw: unknown): Suite | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.name !== "string" || !x.name.trim()) return null;
  return {
    id: typeof x.id === "string" && x.id ? x.id : newId("sq"),
    name: x.name.trim().slice(0, 80),
    steps: Array.isArray(x.steps) ? x.steps.flatMap((s) => normalizeStep(s, 1) ?? []) : [],
    trigger: normalizeTrigger(x.trigger),
    failFast: x.failFast !== false,
  };
}

/* ================= CRUD ================= */

export function addSuite(name: string): Suite {
  const suite: Suite = {
    id: newId("sq"),
    name: name.trim().slice(0, 80) || `序列 ${state.suites.length + 1}`,
    steps: [],
    trigger: { mode: "manual" },
    failFast: true,
  };
  state = { suites: [...state.suites, suite] };
  emit();
  return suite;
}

export function renameSuite(id: string, name: string) {
  state = {
    suites: state.suites.map((s) =>
      s.id === id ? { ...s, name: name.trim().slice(0, 80) || s.name } : s,
    ),
  };
  emit();
}

export function removeSuite(id: string) {
  state = { suites: state.suites.filter((s) => s.id !== id) };
  emit();
}

/** 整体替换步骤树（编辑器每次结构变更调用；浅层不可变，引擎/报告拿到的引用稳定） */
export function setSteps(id: string, steps: Step[]) {
  state = { suites: state.suites.map((s) => (s.id === id ? { ...s, steps } : s)) };
  emit();
}

export function setTrigger(id: string, trigger: SuiteTrigger) {
  state = { suites: state.suites.map((s) => (s.id === id ? { ...s, trigger } : s)) };
  emit();
}

export function setFailFast(id: string, failFast: boolean) {
  state = { suites: state.suites.map((s) => (s.id === id ? { ...s, failFast } : s)) };
  emit();
}

export function getSuite(id: string): Suite | undefined {
  return state.suites.find((s) => s.id === id);
}

/* ================= 步骤树操作 ================= */

/** 各 kind 的默认步骤（编辑器「添加」用） */
export function newStep(kind: StepKind): Step {
  const id = newId("st");
  switch (kind) {
    case "send":
      return { id, kind: "send", enabled: true, payload: { type: "hex", text: "" } };
    case "wait":
      return { id, kind: "wait", enabled: true, ms: 100 };
    case "waitForFrame":
      return { id, kind: "waitForFrame", enabled: true, match: { by: "raw", hex: "" }, timeoutMs: 3000 };
    case "assertVar":
      return { id, kind: "assertVar", enabled: true, varName: "", op: "eq", expected: 0 };
    case "group":
      return { id, kind: "group", enabled: true, name: "分组", repeats: 1, onFailure: "abort", children: [] };
    case "note":
      return { id, kind: "note", enabled: true, text: "" };
  }
}

/** 根列表到目标节点的链（含自身）；找不到返回 null */
function pathTo(steps: Step[], id: string): Step[] | null {
  for (const s of steps) {
    if (s.id === id) return [s];
    if (s.kind === "group") {
      const sub = pathTo(s.children, id);
      if (sub) return [s, ...sub];
    }
  }
  return null;
}

export function findStep(suiteId: string, stepId: string): Step | undefined {
  const chain = pathTo(getSuite(suiteId)?.steps ?? [], stepId);
  return chain ? chain[chain.length - 1] : undefined;
}

/** 步骤现位：父组（null=根）与下标 */
export function locateStep(suiteId: string, stepId: string): { parentId: string | null; index: number } | null {
  const steps = getSuite(suiteId)?.steps;
  if (!steps) return null;
  const walk = (list: Step[], parent: string | null): { parentId: string | null; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.id === stepId) return { parentId: parent, index: i };
      if (s.kind === "group") {
        const r = walk(s.children, s.id);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(steps, null);
}

function patchIn(steps: Step[], id: string, fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    if (s.id === id) return fn(s);
    if (s.kind === "group") return { ...s, children: patchIn(s.children, id, fn) };
    return s;
  });
}

/** 行内编辑统一入口：fn 收到旧步骤返回新步骤（不可变替换） */
export function updateStep(suiteId: string, stepId: string, fn: (s: Step) => Step) {
  state = {
    suites: state.suites.map((su) => (su.id === suiteId ? { ...su, steps: patchIn(su.steps, stepId, fn) } : su)),
  };
  emit();
}

function removeFrom(steps: Step[], id: string): Step[] {
  return steps.flatMap((s): Step[] => {
    if (s.id === id) return [];
    if (s.kind === "group") return [{ ...s, children: removeFrom(s.children, id) }];
    return [s];
  });
}

export function removeStep(suiteId: string, stepId: string) {
  state = {
    suites: state.suites.map((su) => (su.id === suiteId ? { ...su, steps: removeFrom(su.steps, stepId) } : su)),
  };
  emit();
}

/** 在 parent（null=根）末尾追加新步骤；parent 必须是 group。返回新步骤或 null */
export function addStep(suiteId: string, parentId: string | null, kind: StepKind): Step | null {
  const suite = getSuite(suiteId);
  if (!suite) return null;
  if (parentId !== null) {
    const p = findStep(suiteId, parentId);
    if (!p || p.kind !== "group") return null;
  }
  const step = newStep(kind);
  state = {
    suites: state.suites.map((su) =>
      su.id === suiteId
        ? {
            ...su,
            steps:
              parentId === null
                ? [...su.steps, step]
                : patchIn(su.steps, parentId, (s) => {
                    if (s.kind !== "group") return s;
                    return { ...s, children: [...s.children, step] };
                  }),
          }
        : su,
    ),
  };
  emit();
  return step;
}

/** 节点内 group 嵌套层数（非 group = 0） */
function groupLevels(s: Step): number {
  if (s.kind !== "group") return 0;
  return 1 + s.children.reduce((m, c) => Math.max(m, groupLevels(c)), 0);
}

/** id 节点所在列表的 group 祖先层数（含自身若为组）。根列表 = 0；
 *  即「把一个节点插到 id 的 children 里，它拥有的组祖先数」。 */
function parentGroupDepth(steps: Step[], parentId: string | null): number | null {
  if (parentId === null) return 0;
  const chain = pathTo(steps, parentId);
  if (!chain) return null;
  return chain.filter((s) => s.kind === "group").length;
}

/**
 * 移动步骤到 parent 的 index 处。守卫：目标父存在且为组/根、不能移进自己或
 * 自己的子树、结果不得超 groupDepthMax。返回是否执行。
 */
export function moveStep(suiteId: string, dragId: string, parentId: string | null, index: number): boolean {
  const suite = getSuite(suiteId);
  if (!suite) return false;
  const loc = locateStep(suiteId, dragId);
  if (!loc) return false;
  const node = findStep(suiteId, dragId);
  if (!node) return false;

  const pd = parentGroupDepth(suite.steps, parentId);
  if (pd === null) return false;
  if (parentId !== null) {
    if (parentId === dragId) return false; // 移进自己 = 丢失
    const p = findStep(suiteId, parentId);
    if (!p || p.kind !== "group") return false;
    // 不能移进自己的子树（仅 group 有子树）
    if (node.kind === "group" && pathTo(node.children, parentId)) return false;
  }
  // 深度红线：插入点组深度 + 节点自身层数 ≤ 上限
  if (pd + groupLevels(node) > LIMITS.groupDepthMax) return false;

  const rest = removeFrom(suite.steps, dragId);
  // 同列表下移：先摘除再插入会让目标位左移一格
  let idx = Math.max(0, Math.round(index));
  if (loc.parentId === parentId && loc.index < idx) idx -= 1;

  const insert = (list: Step[], pid: string | null): Step[] => {
    if (pid === null) {
      const out = [...list];
      out.splice(Math.min(idx, out.length), 0, node);
      return out;
    }
    return list.map((s) => {
      if (s.kind === "group") {
        if (s.id === pid) {
          const ch = [...s.children];
          ch.splice(Math.min(idx, ch.length), 0, node);
          return { ...s, children: ch };
        }
        return { ...s, children: insert(s.children, pid) };
      }
      return s;
    });
  };
  state = { suites: state.suites.map((su) => (su.id === suiteId ? { ...su, steps: insert(rest, parentId) } : su)) };
  emit();
  return true;
}

/** 复制步骤（深拷贝，重新生成子树 id），插到原步骤后面 */
export function duplicateStep(suiteId: string, stepId: string): boolean {
  const loc = locateStep(suiteId, stepId);
  const node = findStep(suiteId, stepId);
  if (!loc || !node) return false;
  const regen = (s: Step): Step => {
    const copy = structuredClone(s);
    const walkId = (x: Step): Step => {
      const n = { ...x, id: newId("st") } as Step;
      if (n.kind === "group") n.children = n.children.map(walkId);
      return n;
    };
    return walkId(copy);
  };
  const dup = regen(node);
  // 命中目标即插到其后；仅沿该路径重建，其余子树引用保持稳定
  const insertAfter = (list: Step[], id: string): Step[] =>
    list.flatMap((s): Step[] => {
      if (s.id === id) return [s, dup];
      if (s.kind === "group") return [{ ...s, children: insertAfter(s.children, id) }];
      return [s];
    });
  state = {
    suites: state.suites.map((su) => (su.id === suiteId ? { ...su, steps: insertAfter(su.steps, stepId) } : su)),
  };
  emit();
  return true;
}

/** 导入：接受单个 Suite 或数组；返回成功条数 */
export function importSuites(json: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 0;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const suites = list.flatMap((x) => normalizeSuite(x) ?? []);
  if (!suites.length) return 0;
  // id 冲突让位给现有（重新生成）
  const existing = new Set(state.suites.map((s) => s.id));
  for (const s of suites) {
    if (existing.has(s.id)) s.id = newId("sq");
  }
  state = { suites: [...state.suites, ...suites] };
  emit();
  return suites.length;
}

/** 导出单个 Suite 的 JSON 字符串（落盘/剪贴板由 UI 层处理） */
export function exportSuite(id: string): string | null {
  const s = getSuite(id);
  return s ? JSON.stringify(s, null, 2) : null;
}

load();
// 关窗前把编辑落盘（防抖窗口内的改动会丢）
// 守卫：单测跑在 node 环境下没有 window
if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
