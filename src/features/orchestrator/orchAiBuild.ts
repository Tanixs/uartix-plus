/**
 * P74c C2：AI / MCP 侧的编排结构构造器（**纯函数**，不碰 store、无副作用）。
 *
 * 为什么单独成文件：
 *  1. appActions 只能**延迟**加载编排模块（`orchestratorBind` 在模块求值期就订阅事件源，
 *     静态塞进 appActions 会叠加求值顺序依赖 —— P74 TDZ 白屏现场）。所以这个文件
 *     也走 `import()`，不进启动图。
 *  2. 「把 AI 传来的松散 JSON 变成合法 FlowNode / EventBlock」有真实的校验逻辑
 *     （枚举白名单、数值钳位、按 kind 收窄可覆盖字段），值得单测覆盖 —— 放 appActions
 *     里就没法测（该文件拖全 store 家族 + DOM）。
 *
 * 职责边界：本文件只**造节点**；落盘一律由调用方走 `orchestratorStore.addBlock/addEvent`
 * （二者已过 `guardLocked()`，Operator 只读边界仍然生效）。
 */

import { BLOCK_REGISTRY, EVENT_REGISTRY, makeBlock, makeEvent, type NewBlockKind, type NewEventKind } from "./blockRegistry";
import type { EventBlock, FlowNode } from "./types";
import type { ExpectVal, FrameMatch } from "../sequencer/types";

/* ================= 可造类型（B4a：从 registry 键集派生，声明顺序 = 展示顺序） =================
 * 完整性守卫不再需要本文件背书：blockRegistry 的 `satisfies Record<联合, Meta>`
 * 已在类型层保证「types 新增 kind 而未登记 → tsc 报错」，这里自动跟进。 */

export const AI_BLOCK_KINDS: readonly NewBlockKind[] = Object.keys(BLOCK_REGISTRY) as NewBlockKind[];

export const AI_EVENT_KINDS: readonly NewEventKind[] = Object.keys(EVENT_REGISTRY) as NewEventKind[];

/* ================= 小工具 ================= */

export interface Built<T> {
  node: T;
  /** 实际被写入的字段名（回话给 AI，让它知道哪些参数被采纳/钳位） */
  applied: string[];
}

const asRec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** 枚举白名单取值：非法值静默忽略（不报错，让其余合法字段仍然生效） */
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(n)));

/** 变量常量值：只收 number / string / boolean（对象、数组一律拒绝） */
function constValue(v: unknown): number | string | boolean | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return undefined;
}

/* ================= 事件构造 ================= */

/**
 * 由 AI 参数造事件块。kind 非法 → 抛错；参数非法/越界 → 钳位或忽略并在 applied 里如实反馈。
 */
export function buildAiEvent(kindRaw: unknown, specRaw: unknown): Built<EventBlock> {
  const kind = String(kindRaw ?? "").trim() as NewEventKind;
  if (!(AI_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `未知事件类型：${kind || "（空）"}（可选：${AI_EVENT_KINDS.join(" / ")}）`,
    );
  }
  const spec = asRec(specRaw);
  const ev = makeEvent(kind);
  const applied: string[] = [];

  switch (ev.kind) {
    case "session": {
      const ph = pick(spec.phase, ["start", "stop"] as const);
      if (ph) {
        ev.phase = ph;
        applied.push("phase");
      }
      break;
    }
    case "frame": {
      const match = buildFrameMatch(spec);
      if (match) {
        ev.match = match;
        applied.push(match.by === "raw" ? "hex" : "match");
      }
      const stride = num(spec.stride);
      if (stride !== undefined) {
        ev.stride = clampInt(stride, 1, 1000);
        applied.push("stride");
      }
      break;
    }
    case "threshold": {
      const chId = str(spec.chId);
      if (chId) {
        ev.chId = chId;
        applied.push("chId");
      }
      const op = pick(spec.op, ["above", "below"] as const);
      if (op) {
        ev.op = op;
        applied.push("op");
      }
      const edge = pick(spec.edge, ["enter", "exit"] as const);
      if (edge) {
        ev.edge = edge;
        applied.push("edge");
      }
      const value = num(spec.value);
      if (value !== undefined) {
        ev.value = value;
        applied.push("value");
      }
      const deb = num(spec.debounceMs);
      if (deb !== undefined) {
        ev.debounceMs = clampInt(deb, 0, 60_000);
        applied.push("debounceMs");
      }
      break;
    }
    case "timer": {
      const iv = num(spec.intervalMs);
      if (iv !== undefined) {
        ev.intervalMs = clampInt(iv, 50, 3_600_000);
        applied.push("intervalMs");
      }
      break;
    }
    case "sentinel": {
      const lv = pick(spec.level, ["warn", "crit"] as const);
      if (lv) {
        ev.level = lv;
        applied.push("level");
      }
      break;
    }
    case "varChanged": {
      const n = str(spec.varName);
      if (n) {
        ev.varName = n;
        applied.push("varName");
      }
      break;
    }
    /* ---------- B4d 新增 ---------- */
    case "frameError": {
      const stride = num(spec.stride);
      if (stride !== undefined) {
        ev.stride = clampInt(stride, 1, 10000);
        applied.push("stride");
      }
      break;
    }
    case "chanChanged": {
      const chId = str(spec.chId);
      if (chId) {
        ev.chId = chId;
        applied.push("chId");
      }
      const tol = num(spec.tol);
      if (tol !== undefined) {
        ev.tol = Math.max(0, tol);
        applied.push("tol");
      }
      const iv = num(spec.minIntervalMs);
      if (iv !== undefined) {
        ev.minIntervalMs = clampInt(iv, 50, 3_600_000);
        applied.push("minIntervalMs");
      }
      break;
    }
    case "newTpl": {
      const t = str(spec.tplId);
      if (t !== undefined) {
        ev.tplId = t;
        applied.push("tplId");
      }
      break;
    }
    case "flowEvt": {
      const n = str(spec.name) ?? str(spec.eventName);
      if (n) {
        ev.name = n;
        applied.push("name");
      }
      break;
    }
    case "idle": {
      const iv = num(spec.idleMs);
      if (iv !== undefined) {
        ev.idleMs = clampInt(iv, 1000, 3_600_000);
        applied.push("idleMs");
      }
      break;
    }
    case "manual":
      break;
  }
  return { node: ev, applied };
}

/** 帧匹配：优先 tplId+fieldName（字段匹配），否则 raw hex；都没有则返回 null（保留工厂默认） */
function buildFrameMatch(spec: Record<string, unknown>): FrameMatch | null {
  const tplId = str(spec.tplId);
  const fieldName = str(spec.fieldName);
  if (tplId && fieldName) {
    const op = pick(spec.op, ["eq", "ne", "gt", "lt", "ge", "le", "approx"] as const) ?? "eq";
    // ExpectVal = number | { var }：给 expectedVar 则按变量比，否则按字面值
    const expVar = str(spec.expectedVar);
    const expNum = num(spec.expected);
    const expected: ExpectVal = expVar ? { var: expVar } : (expNum ?? 0);
    return { by: "field", tplId, fieldName, op, expected };
  }
  if (tplId) return { by: "tpl", tplId };
  const hex = str(spec.hex);
  if (hex !== undefined) return { by: "raw", hex };
  return null;
}

/* ================= 块构造 ================= */

/**
 * 由 AI 参数造执行/逻辑块。`if / loop / break / abort / group` 只造默认骨架
 * （条件列表与循环体交给 UI 编辑——AI 侧表达条件树的收益低于出错面）。
 */
export function buildAiBlock(kindRaw: unknown, specRaw: unknown): Built<FlowNode> {
  const kind = String(kindRaw ?? "").trim() as NewBlockKind;
  if (!(AI_BLOCK_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `未知块类型：${kind || "（空）"}（可选：${AI_BLOCK_KINDS.join(" / ")}）`,
    );
  }
  const spec = asRec(specRaw);
  const node = makeBlock(kind);
  const applied: string[] = [];

  switch (node.kind) {
    case "send": {
      const mode = pick(spec.sendMode ?? spec.mode, ["hex", "ascii"] as const);
      const text = str(spec.text);
      if (mode === "ascii") {
        node.payload = { type: "ascii", text: text ?? "" };
        applied.push("text");
      } else if (mode === "hex" || text !== undefined) {
        node.payload = { type: "hex", text: text ?? "" };
        applied.push("text");
      }
      break;
    }
    case "wait": {
      const ms = num(spec.ms);
      if (ms !== undefined) {
        node.ms = clampInt(ms, 10, 60_000);
        applied.push("ms");
      }
      break;
    }
    case "waitFrame": {
      const match = buildFrameMatch(spec);
      if (match) {
        node.match = match;
        applied.push(match.by === "raw" ? "hex" : "match");
      }
      const t = num(spec.timeoutMs);
      if (t !== undefined) {
        node.timeoutMs = clampInt(t, 0, 600_000);
        applied.push("timeoutMs");
      }
      const ig = bool(spec.ignoreFail);
      if (ig !== undefined) {
        node.ignoreFail = ig;
        applied.push("ignoreFail");
      }
      break;
    }
    case "runSuite": {
      const id = str(spec.suiteId);
      if (id) {
        node.suiteId = id;
        applied.push("suiteId");
      }
      const w = bool(spec.wait);
      if (w !== undefined) {
        node.wait = w;
        applied.push("wait");
      }
      break;
    }
    case "runGroup": {
      const id = str(spec.groupId);
      if (id) {
        node.groupId = id;
        applied.push("groupId");
      }
      const w = bool(spec.wait);
      if (w !== undefined) {
        node.wait = w;
        applied.push("wait");
      }
      break;
    }
    case "setVar": {
      const n = str(spec.name);
      if (n) {
        node.name = n;
        applied.push("name");
      }
      const v = constValue(spec.value);
      if (v !== undefined) {
        node.from = { k: "const", value: v };
        applied.push("value");
      }
      break;
    }
    case "toast": {
      const lv = pick(spec.level, ["info", "warn", "crit"] as const);
      if (lv) {
        node.level = lv;
        applied.push("level");
      }
      const t = str(spec.text);
      if (t !== undefined) {
        node.text = t;
        applied.push("text");
      }
      break;
    }
    case "sound": {
      const lv = pick(spec.level, ["warn", "crit"] as const);
      if (lv) {
        node.level = lv;
        applied.push("level");
      }
      break;
    }
    case "loop": {
      // 只收次数/间隔这类标量；while 条件留给 UI
      const mode = pick(spec.loopMode, ["count", "while"] as const);
      if (mode === "count") {
        const c = num(spec.count);
        if (c !== undefined) {
          node.mode = "count";
          node.count = clampInt(c, 1, 1000);
          applied.push("count");
        }
      }
      const iv = num(spec.intervalMs);
      if (iv !== undefined) {
        node.intervalMs = clampInt(iv, 0, 600_000);
        applied.push("intervalMs");
      }
      break;
    }
    case "group": {
      const n = str(spec.groupName);
      if (n) {
        node.name = n;
        applied.push("groupName");
      }
      break;
    }
    /* ---------- B4c 新增（全部收标量；下拉引用类留 UI） ---------- */
    case "setControl": {
      const n = str(spec.varName) ?? str(spec.name);
      if (n) {
        node.varName = n;
        applied.push("varName");
      }
      const v = constValue(spec.value);
      if (v !== undefined) {
        node.from = { k: "const", value: v };
        applied.push("value");
      }
      break;
    }
    case "setSwitch": {
      const n = str(spec.swName) ?? str(spec.name);
      if (n) {
        node.swName = n;
        applied.push("swName");
      }
      const st = pick(spec.state, ["on", "off", "toggle"] as const);
      if (st) {
        node.state = st;
        applied.push("state");
      }
      break;
    }
    case "modbusWrite": {
      const s = num(spec.slave);
      if (s !== undefined) {
        node.slave = clampInt(s, 1, 247);
        applied.push("slave");
      }
      const fn = num(spec.fn);
      if (fn === 5 || fn === 6) {
        node.fn = fn;
        applied.push("fn");
      }
      const a = num(spec.addr);
      if (a !== undefined) {
        node.addr = clampInt(a, 0, 0xffff);
        applied.push("addr");
      }
      const v = num(spec.value);
      if (v !== undefined) {
        node.value = clampInt(v, -0x8000, 0xffff);
        applied.push("value");
      }
      break;
    }
    case "log": {
      const lv = pick(spec.level, ["info", "warn", "crit"] as const);
      if (lv) {
        node.level = lv;
        applied.push("level");
      }
      const t = str(spec.text);
      if (t !== undefined) {
        node.text = t;
        applied.push("text");
      }
      break;
    }
    case "snapshot": {
      const p = pick(spec.panel, ["plot2d", "plot3d", "spectrum"] as const);
      if (p) {
        node.panel = p;
        applied.push("panel");
      }
      const nt = str(spec.note);
      if (nt !== undefined) {
        node.note = nt;
        applied.push("note");
      }
      break;
    }
    case "exportCsv": {
      const c = str(spec.chanId);
      if (c) {
        node.chanId = c;
        applied.push("chanId");
      }
      const n = num(spec.lastN);
      if (n !== undefined) {
        node.lastN = clampInt(n, 1, 30_000);
        applied.push("lastN");
      }
      break;
    }
    case "stopSuite":
      break;
    case "emitFlow": {
      const n = str(spec.name) ?? str(spec.eventName);
      if (n) {
        node.name = n;
        applied.push("name");
      }
      const dataRaw = spec.data;
      if (dataRaw && typeof dataRaw === "object" && !Array.isArray(dataRaw)) {
        const pairs = Object.entries(dataRaw as Record<string, unknown>)
          .slice(0, 4)
          .map(([k, v]) => ({ k, src: String(v) }));
        node.data = pairs;
        applied.push("data");
      }
      break;
    }
    case "clip": {
      const t = str(spec.text);
      if (t !== undefined) {
        node.text = t;
        applied.push("text");
      }
      break;
    }
    case "resetVars": {
      const sc = pick(spec.scope, ["all", "one"] as const);
      if (sc) {
        node.scope = sc;
        applied.push("scope");
      }
      const n = str(spec.name) ?? str(spec.varName);
      if (n) {
        node.name = n;
        applied.push("name");
      }
      break;
    }
    case "if":
    case "break":
    case "abort":
      break;
  }

  const onFail = pick(spec.onFail, ["abort", "continue"] as const);
  if (onFail && "onFail" in node) {
    node.onFail = onFail;
    applied.push("onFail");
  }
  const note = str(spec.note);
  if (note) {
    node.note = note;
    applied.push("note");
  }
  return { node, applied };
}

/**
 * 造完节点后的「还需人工补齐什么」提示（AI 回话用）。
 * 空字段在 UI 里是合法的半成品，但对自动化来说是死路 —— 说出来比让用户踩坑好。
 */
export function pendingHints(node: FlowNode | EventBlock): string[] {
  const out: string[] = [];
  if (node.kind === "send") {
    const p = node.payload;
    const txt = p.type === "hex" || p.type === "ascii" ? p.text : "";
    if (!txt.trim()) out.push("发送内容为空");
  }
  if (node.kind === "waitFrame" && node.match.by === "raw" && !node.match.hex.trim()) {
    out.push("等帧未设帧头");
  }
  if (node.kind === "runSuite" && !node.suiteId) out.push("未选序列套件");
  if (node.kind === "runGroup" && !node.groupId) out.push("未选被调用组");
  if (node.kind === "setVar" && !node.name) out.push("未选目标变量");
  if (node.kind === "frame" && node.match.by === "raw" && !node.match.hex.trim()) {
    out.push("帧命中事件无匹配条件（会命中所有帧）");
  }
  if (node.kind === "threshold" && !node.chId) out.push("阈值事件未选通道");
  if (node.kind === "varChanged" && !node.varName) out.push("变量事件未选变量");
  /* ---------- B4c 新增 ---------- */
  if (node.kind === "setControl" && !node.varName) out.push("未写目标画布变量名");
  if (node.kind === "setSwitch" && !node.swName) out.push("未写开关卡名");
  if (node.kind === "emitFlow" && !node.name.trim()) out.push("未写事件名");
  if (node.kind === "exportCsv" && !node.chanId) out.push("未选通道");
  if (node.kind === "resetVars" && node.scope === "one" && !node.name.trim()) out.push("scope=one 需要写变量名");
  if (node.kind === "chanChanged" && !node.chId) out.push("通道变化事件未选通道");
  if (node.kind === "flowEvt" && !node.name.trim()) out.push("自定义事件未写事件名（需与「发事件」块的名称一致）");
  return out;
}
