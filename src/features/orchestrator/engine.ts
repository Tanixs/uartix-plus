/**
 * P74 自动编排器执行引擎（engine.ts）。
 *
 * 纯逻辑模块：不 import React / IPC / localStorage，与外部世界只通过
 * OrchDeps 注入（发送、序列调用、通道最新值、会话状态、通知、时钟）。
 * 事件源（P74-2）把会话/帧流/阈值/定时器/哨兵转成 emit(FlowEvent) 投喂。
 *
 * 核心模型：
 * - 组 = 编排单元：事件槽命中 → 组实例 Inst 入该组 FIFO 队列（每组串行）；
 *   无事件组靠「运行组」块或手动按钮调用。
 * - 栈帧执行：if/loop 容器 push 子流，break 弹到最近循环，abort 清实例。
 * - 事件上下文 evt.*：帧字段/阈值触值/变量旧新值全链注入（只读）。
 *
 * 红线（全部硬编码，可单测）：
 * 1. runGroup 递归深度 ≤8；禁自调（同组等待 = 死锁）。
 * 2. 每组实例队列深度 ≤8（含在跑的 1 个，FIFO）；循环迭代 ≤1000/块；
 *    实例累计块 ≤10000；实例时长 ≤5min。
 * 3. send 全局令牌桶 50/s，超限丢弃。
 * 4. 全局触发熔断：滑动 1s >100 次 → 停 1s（手动触发不受熔断/冷却限制）。
 * 5. 表达式沙箱（expr.ts）：无 eval、50ms deadline。
 * 6. 变量 ≤64、字符串 ≤1KB、类型收敛失败不静默放行。
 * 7. 顶层组 ≤32（写入侧由 orchestratorStore 拦截，读侧此处兜底截断）。
 */
import { testFrameMatch } from "../sequencer/runner";
import type { FrameMatch, ResolvedSend, SendPayload } from "../sequencer/types";
import { buildRtuRequest } from "../modbus/mb";
import { evalCondExpr, evalExpr, type ExprScope, type ExprVal } from "./expr";
import {
  ORCH_LIMITS,
  VAR_NAME_RE,
  isManuallyTriggerable,
  type Cond,
  type EvtCtx,
  type EventBlock,
  type ExecBlock,
  type FlowDoc,
  type FlowEvent,
  type FlowNode,
  type FlowVar,
  type FlowVarType,
  type FrameRowLite,
  type GroupNode,
  type LogEntry,
  type OrchOp,
  type VarFrom,
} from "./types";

/* ================= 依赖注入 ================= */

export interface OrchDeps {
  now(): number;
  /** 与 sequencerBind.resolveSend 同一实现（P74-3 接线；B4e：factory 可返回多帧） */
  resolveSend(payload: SendPayload): ResolvedSend | null;
  send(mode: "ascii" | "hex", text: string): void | Promise<void>;
  /** 运行现有序列套件；wait=true 时返回最终是否成功 */
  runSuite(suiteId: string, wait: boolean): boolean | Promise<boolean>;
  /** 等待匹配帧（bind 层用 onFrames 缓冲实现）；null = 超时 */
  waitFrame(match: FrameMatch, timeoutMs: number, fromTs: number): Promise<FrameRowLite | null>;
  chanLatest(chId: string): number | null | undefined;
  sessionState(): "open" | "streaming" | "idle";
  toast(text: string, level: "info" | "warn" | "crit"): void;
  sound(level: "warn" | "crit"): void;
  /**
   * 「持久」变量现值发生变化（P74c A1）：bind 用它做防抖落盘。
   * 仅在 persist=true 的变量值实际改变时触发，非持久变量不产生噪声。
   */
  onVarsChanged?(): void;
  /* ---------- B4c 新增可选钩子（全部由 bind 接线；未接线 = 块按 fail 处理） ---------- */
  /** 写控制画布变量（variableStore）；返回 false = 变量不存在 */
  writeControlVar?(name: string, value: number | string): boolean;
  /** 拨控制页开关卡（按卡片名查找）；返回 false = 卡片不存在 */
  setSwitchCard?(name: string, state: "on" | "off" | "toggle"): boolean;
  /** 面板截图 → 存入图片库；null/false = 面板未开或存储失败 */
  snapshotPanel?(panel: "plot2d" | "plot3d" | "spectrum", note: string): Promise<boolean>;
  /** 通道数据导出 CSV（含保存对话框）；false = 通道不存在或用户取消 */
  exportCsv?(chanId: string, lastN: number): Promise<boolean>;
  /** 停止在跑的序列套件 */
  stopSuite?(): void;
  /** 写系统剪贴板；false = 权限拒绝等 */
  clipWrite?(text: string): Promise<boolean>;
}

/* ================= 运行期结构 ================= */

type ExecRes = "ok" | "fail" | "break" | "abort";

interface VarSlot {
  type: FlowVarType;
  value: number | string | boolean;
  def: number | string | boolean;
  persist: boolean;
}

interface Inst {
  id: number;
  groupId: string;
  reason: string;
  evt: EvtCtx;
  depth: number;
  /** runGroup(wait) 等待链上的组 id（防 A→B→A 等待环死锁） */
  chain: string[];
  t0: number;
  blocks: number;
  aborting: boolean;
  status: "running" | "ok" | "fail" | "abort";
  done: Promise<"ok" | "fail" | "abort">;
  /** 挂起的 sleep（abort 时快速清理） */
  sleeps: { clear(): void }[];
}

export interface GroupStats {
  total: number;
  fail: number;
  lastTs: number;
  lastDetail: string;
}

export interface VarSnapshot {
  name: string;
  type: FlowVarType;
  value: number | string | boolean;
  def: number | string | boolean;
  persist: boolean;
}

/* ================= 引擎 ================= */

export class OrchEngine {
  private deps: OrchDeps;
  private doc: FlowDoc | null = null;
  /** 上次全量装载的运行语义签名（runSig）：store 原地修改 doc（引用不变），
   *  与 this.doc 直接比较恒相等——必须和缓存的上次签名比 */
  private lastRunSig = "";
  private vars = new Map<string, VarSlot>();
  /** 每组：index 0 = 在跑实例，其余 = 排队 */
  private queues = new Map<string, Inst[]>();
  private cooldown = new Map<string, number>();
  private strideCnt = new Map<string, number>();
  /** 全局熔断：触发时间窗 */
  private trigWin: number[] = [];
  private fuseUntil = 0;
  /** send 令牌桶 */
  private sendT0 = 0;
  private sendN = 0;
  /** 运行日志环形缓冲 */
  private logBuf: LogEntry[] = [];
  private logHead = 0;
  private logLen = 0;
  private stats = new Map<string, GroupStats>();
  private instSeq = 0;

  constructor(deps: OrchDeps) {
    this.deps = deps;
  }

  /* ---------- 文档与变量 ---------- */

  /** 返回 true = 运行语义真的变了（做了 stopAll/变量重建）；false = 仅视图差异（折叠等） */
  setDoc(doc: FlowDoc, seed?: Record<string, number | string | boolean>): boolean {
    // 仅视图差异（折叠等）不打断在跑实例：折叠组卡是纯视图操作，
    // 触发 store emit → setDoc，若一律 stopAll 会把正在跑的自动化静默杀掉。
    // 比较对象是缓存的 lastRunSig（store 原地改 doc，与 this.doc 比较恒等）
    const clipped = doc.groups.length > ORCH_LIMITS.groupCap ? { ...doc, groups: doc.groups.slice(0, ORCH_LIMITS.groupCap) } : doc;
    const sig = runSig(clipped);
    if (this.doc && sig === this.lastRunSig) {
      this.doc = clipped;
      return false;
    }
    this.lastRunSig = sig;
    this.stopAll();
    // 顶层组数量红线：超出静默截断（文档构建器也应校验，此处兜底）
    this.doc = clipped;
    this.strideCnt.clear();
    this.cooldown.clear();
    // 变量重建：同名同类型保留现值，其余落默认值；非法名跳过
    const next = new Map<string, VarSlot>();
    for (const v of doc.vars.slice(0, ORCH_LIMITS.varCap)) {
      if (!VAR_NAME_RE.test(v.name)) continue;
      const cur = this.vars.get(v.name);
      if (cur && cur.type === v.type) {
        // 现值保留，但 persist/默认值跟随最新声明（否则勾「持久」/改默认对运行时无效）
        cur.persist = v.persist;
        cur.def = v.def;
        next.set(v.name, cur);
        continue;
      }
      // 内存里没有同型现值 → 才允许用落盘持久值回填（P74c A1）。
      // 只在「首次装载」由 bind 传 seed；改类型不会把旧值复活。
      const slot = mkSlot(v);
      if (v.persist && seed && Object.prototype.hasOwnProperty.call(seed, v.name)) {
        const conv = converge(v.type, seed[v.name]);
        if (conv !== null) slot.value = conv;
      }
      next.set(v.name, slot);
    }
    this.vars = next;
    return true;
  }

  /**
   * 持久变量现值快照（P74c A1 的「写」半边）：bind/store 落盘用。
   * 返回的是全新对象，逐次调用即为全量，删掉的变量自然消失。
   */
  persistVars(): Record<string, number | string | boolean> {
    const out: Record<string, number | string | boolean> = {};
    for (const [name, s] of this.vars) if (s.persist) out[name] = s.value;
    return out;
  }

  getDoc(): FlowDoc | null {
    return this.doc;
  }

  listVars(): VarSnapshot[] {
    const out: VarSnapshot[] = [];
    for (const [name, s] of this.vars) {
      out.push({ name, type: s.type, value: s.value, def: s.def, persist: s.persist });
    }
    return out;
  }

  getVar(name: string): number | string | boolean | undefined {
    return this.vars.get(name)?.value;
  }

  /**
   * 写变量（块/监视面板/外部均走这里）。类型收敛失败返回 false 并留日志。
   * 值实际变化时同步派发 varChanged 事件（同值不触发——防 watch 自循环）。
   * silent = 复位等内部操作，不派发事件。
   */
  setVar(name: string, value: number | string | boolean, silent = false): boolean {
    const slot = this.vars.get(name);
    if (!slot) return false;
    const conv = converge(slot.type, value);
    if (conv === null) {
      this.log(0, "", "fail", undefined, `变量 ${name} 类型收敛失败（${String(value)} → ${slot.type}）`);
      return false;
    }
    const old = slot.value;
    if (sameVal(old, conv)) return true;
    slot.value = conv;
    // 持久变量变动 → 通知 bind 落盘（P74c A1；非持久变量零噪声）
    if (slot.persist) this.deps.onVarsChanged?.();
    if (!silent) {
      this.emit({
        kind: "varChanged",
        name,
        old,
        new: conv,
      });
    }
    return true;
  }

  /** 会话停止：中止全部实例 + 复位非持久变量（不触发 varChanged） */
  sessionStop(): void {
    this.stopAll();
    for (const slot of this.vars.values()) {
      if (!slot.persist) slot.value = slot.def;
    }
  }

  stopAll(): void {
    for (const [gid, q] of this.queues) {
      for (const inst of q) {
        if (inst.status === "running") this.log(inst.id, gid, "abort", undefined, "引擎停止");
        this.abortInst(inst);
      }
      this.queues.set(gid, []);
    }
  }

  /**
   * 单实例快速中止：置 aborting（结束等待循环/块流）、清挂起的 sleep、清队列等待。
   * 调用方负责日志（中止原因千差万别，引擎不猜）。
   */
  private abortInst(inst: Inst): void {
    inst.aborting = true;
    inst.status = "abort";
    inst.sleeps.forEach((s) => s.clear());
    inst.sleeps.length = 0;
  }

  /* ---------- 手动运行 ---------- */

  /**
   * UI ▶ 按钮 / 外部手动触发：与事件槽里的「手动」块走**同一条**判定路径
   * （matchGroup），但豁免熔断与组冷却（用户显式动作）。
   *
   * 返回 false = 未触发（总开关关 / 组禁用 / 组非空事件槽但没挂「手动」块 / 队列满）。
   * 用 canManual 可以在点之前就解释清楚为什么不能点。
   */
  runManual(groupId: string): boolean {
    return this.dispatch({ kind: "manual", groupId }, true) > 0;
  }

  /** ▶ 是否可用（总开关 + 组启用 + 手动触发达成条件）；UI 置灰与 tooltip 用 */
  canManual(groupId: string): boolean {
    if (!this.doc?.settings.masterOn) return false;
    const g = this.topGroup(groupId);
    return !!g && g.enabled && isManuallyTriggerable(g);
  }

  /* ---------- 事件入口 ---------- */

  /**
   * 事件入口。熔断按「实际组触发数」计数（命中组才算一次触发）：
   * 200Hz 帧流若不命中任何组不计数，避免帧源自熔断；命中风暴照常熔断。
   * 手动触发豁免熔断与冷却（用户显式动作）。
   */
  emit(evt: FlowEvent, fromGroup?: string): void {
    this.dispatch(evt, evt.kind === "manual", fromGroup);
  }

  /** 事件分发内核：返回实际入队的组数（runManual 用返回值判成功） */
  private dispatch(evt: FlowEvent, manual: boolean, fromGroup?: string): number {
    const doc = this.doc;
    if (!doc?.settings.masterOn) return 0;
    const now = this.deps.now();
    let hits = 0;

    for (const g of doc.groups) {
      if (!g.enabled) continue;
      // flow 事件自收自发守卫：同组既「发事件 X」又挂「自定义事件 X」会自触发
      // 成风暴直到熔断（跨组解耦不受影响；同组内需要串联请用块流顺序执行）
      if (fromGroup && evt.kind === "flow" && g.id === fromGroup) continue;
      const hit = this.matchGroup(g, evt);
      if (!hit) continue;
      if (!manual) {
        // 全局熔断
        if (now < this.fuseUntil) return hits;
        this.trigWin.push(now);
        while (this.trigWin.length > 0 && now - this.trigWin[0] > ORCH_LIMITS.fuseWindowMs) this.trigWin.shift();
        if (this.trigWin.length > ORCH_LIMITS.fuseTriggerMax) {
          this.fuseUntil = now + ORCH_LIMITS.fusePauseMs;
          this.trigWin.length = 0;
          this.log(0, "", "fuse", undefined, `触发风暴熔断 ${ORCH_LIMITS.fusePauseMs}ms（>${ORCH_LIMITS.fuseTriggerMax} 次/秒）`);
          this.deps.toast("触发器触发过于频繁，已暂停 1 秒", "warn");
          return hits;
        }
        // 组级静默期（冷却）
        const cd = g.cooldownMs ?? 0;
        const until = this.cooldown.get(g.id) ?? 0;
        if (cd > 0 && now < until) {
          this.log(0, g.id, "skip", undefined, `静默期中（冷却 ${cd}ms），事件丢弃`);
          continue;
        }
        if (cd > 0) this.cooldown.set(g.id, now + cd);
      }
      if (this.enqueue(g, hit, mkEvtCtx(evt), 0) !== null) hits++;
    }
    return hits;
  }

  /** 事件是否命中该组的事件槽；命中返回触发原因描述 */
  private matchGroup(g: GroupNode, evt: FlowEvent): string | null {
    // 手动/阈值/定时器事件自带组归属，别组不抢
    if ("groupId" in evt && evt.groupId !== g.id) return null;
    // 手动触发：空事件槽 = 手动/子程序组；非空槽必须显式挂「手动」块（P74c A2）
    if (evt.kind === "manual") return isManuallyTriggerable(g) ? "手动" : null;
    for (const b of g.events) {
      if (!evtMatches(b, evt)) continue;
      if (b.kind === "frame" || b.kind === "frameError") {
        const errOnly = b.kind === "frameError";
        const row = (evt as Extract<FlowEvent, { kind: "frame" }>).row;
        if (errOnly && row.valid) continue; // 坏帧块只吃 valid=false
        // stride：每 N 帧取样（坏帧块按坏帧计数，与 UI「每 N 个坏帧取样」一致——
        // 若好帧也计数，坏帧稀疏时几乎永远落不进取样点，事件形同虚设）
        const stride = Math.max(1, Math.round(b.stride));
        if (stride > 1) {
          const c = (this.strideCnt.get(b.id) ?? 0) + 1;
          this.strideCnt.set(b.id, c);
          if (c % stride !== 0) continue;
        }
        // 序列器 getVar 语义（number|string|undefined）：布尔变量折算 0/1
        const gv = (n: string): number | string | undefined => {
          const v = this.getVar(n);
          return typeof v === "boolean" ? (v ? 1 : 0) : v;
        };
        if (!errOnly && !testFrameMatch(row as never, b.match, gv)) continue;
        return errOnly ? `坏帧 [${row.tplName}] len=${row.len}` : `帧命中 [${row.tplName}]`;
      }
      return evtReason(evt);
    }
    return null;
  }

  /* ---------- 队列与实例 ---------- */

  /**
   * 入队。队列语义（P74c A6 定案，与 ORCH_LIMITS.queueCap 对齐）：
   * 每组 FIFO，深度上限 queueCap（含在跑的 1 个）→ 在跑 1 + 排队最多 7。
   *
   * - dropNew：队列满 → 丢弃新触发（自动化语义下宁可漏触发也不堆积）
   * - dropOld：队列满 → 挤掉**最旧的排队项**（在跑的实例不动，那是 stopOld 的职责）
   * - stopOld：只要有在跑/排队 → 全部中止，新触发立即上位
   *
   * 未满时三种策略行为一致：老实排队。返回 null = 新触发被丢弃。
   */
  private enqueue(g: GroupNode, reason: string, evt: EvtCtx, depth: number, chain: string[] = []): Inst | null {
    let q = this.queues.get(g.id);
    if (!q) {
      q = [];
      this.queues.set(g.id, q);
    }
    const policy = g.queuePolicy ?? "dropNew";
    const cap = ORCH_LIMITS.queueCap;

    if (policy === "stopOld" && q.length > 0) {
      const old = q.slice();
      q.length = 0;
      for (const o of old) this.abortInst(o);
      this.log(old[0]?.id ?? 0, g.id, "abort", undefined, `被新触发中止（stopOld，共 ${old.length} 个）`);
    } else if (q.length >= cap) {
      if (policy === "dropOld") {
        // 挤掉最旧的「排队」项（index 0 是在跑实例，不能动）
        const dropped = q.length > 1 ? q.splice(1, 1)[0] : null;
        if (dropped) {
          // 必须真正 abort：被挤出队列的实例永远等不到队头，只能靠 aborting 结束等待循环
          this.abortInst(dropped);
          this.log(dropped.id, g.id, "abort", undefined, `被新触发挤掉（dropOld，队列已满 ${cap}）`);
        } else {
          this.log(0, g.id, "skip", undefined, `队列已满（${cap}）且无排队项可挤，丢弃新触发：${reason}`);
          return null;
        }
      } else {
        this.log(0, g.id, "skip", undefined, `队列已满（${cap}），丢弃新触发：${reason}`);
        return null;
      }
    }

    const inst: Inst = {
      id: ++this.instSeq,
      groupId: g.id,
      reason,
      evt,
      depth,
      chain,
      t0: this.deps.now(),
      blocks: 0,
      aborting: false,
      status: "running",
      done: null as unknown as Inst["done"],
      sleeps: [],
    };
    // 先入队再启动：runInst 用 q[0]===inst 判断是否轮到自己（队头立即跑，队尾轮询等）
    q.push(inst);
    const p = this.runInst(g, inst);
    inst.done = p;
    void p;
    return inst;
  }

  private async runInst(g: GroupNode, inst: Inst): Promise<"ok" | "fail" | "abort"> {
    // 等待前面的实例（同组串行）
    const q = this.queues.get(g.id)!;
    while (q[0] !== inst) {
      if (inst.aborting) break;
      await sleep(15, inst);
      if (inst.aborting) break;
    }
    if (inst.aborting) inst.status = "abort";
    this.log(inst.id, g.id, "trigger", undefined, `${inst.reason}（深度 ${inst.depth}）`);
    let r: ExecRes = "abort";
    try {
      r = inst.aborting ? "abort" : await this.execNodes(g.children, inst, 1);
      if (r === "break") {
        this.log(inst.id, g.id, "skip", undefined, "跳出循环出现在循环外，按组结束处理");
        r = "ok";
      }
    } finally {
      inst.status = r === "fail" ? "fail" : r === "abort" ? "abort" : inst.aborting ? "abort" : "ok";
      const i = q.indexOf(inst);
      if (i >= 0) q.splice(i, 1);
      // 统计与日志
      const st = this.stats.get(g.id) ?? { total: 0, fail: 0, lastTs: 0, lastDetail: "" };
      st.total++;
      const dur = this.deps.now() - inst.t0;
      if (inst.status === "fail") {
        st.fail++;
        this.log(inst.id, g.id, "fail", undefined, "组运行失败", dur);
      } else if (inst.status === "abort") {
        this.log(inst.id, g.id, "abort", undefined, "组运行中止", dur);
      } else {
        this.log(inst.id, g.id, "done", undefined, "组运行完成", dur);
      }
      st.lastTs = this.deps.now();
      st.lastDetail = inst.status;
      this.stats.set(g.id, st);
    }
    return inst.status === "ok" ? "ok" : inst.status === "fail" ? "fail" : "abort";
  }

  /* ---------- 块流执行 ---------- */

  private async execNodes(nodes: FlowNode[], inst: Inst, depth: number): Promise<ExecRes> {
    for (const node of nodes) {
      if (inst.aborting) return "abort";
      // 红线：实例块数 / 时长帽
      if (++inst.blocks > ORCH_LIMITS.instBlockCap) {
        this.log(inst.id, inst.groupId, "fail", node.id, `实例块执行数超限（>${ORCH_LIMITS.instBlockCap}）`);
        return "fail";
      }
      if (this.deps.now() - inst.t0 > ORCH_LIMITS.instDurCapMs) {
        this.log(inst.id, inst.groupId, "fail", node.id, `实例时长超帽（>${ORCH_LIMITS.instDurCapMs / 1000}s）`);
        return "fail";
      }
      if (!node.enabled) continue;
      if (depth > ORCH_LIMITS.nodeDepthMax) {
        this.log(inst.id, inst.groupId, "fail", node.id, `嵌套深度超限（>${ORCH_LIMITS.nodeDepthMax}）`);
        return "fail";
      }
      const r = await this.execNode(node, inst, depth);
      if (r !== "ok") return r;
    }
    return "ok";
  }

  private async execNode(node: FlowNode, inst: Inst, depth: number): Promise<ExecRes> {
    if (node.kind === "group") {
      // 嵌套组：仅组织用，内联执行子流（事件槽只在顶层组有语义）
      return await this.execNodes(node.children, inst, depth + 1);
    }
    if (node.kind === "if") {
      const c = this.evalConds(node.conds, inst);
      if (!c.ok) {
        this.log(inst.id, inst.groupId, "skip", node.id, `条件不成立${c.err ? `：${c.err}` : ""}`);
        return await this.execNodes(node.els, inst, depth + 1);
      }
      return await this.execNodes(node.then, inst, depth + 1);
    }
    if (node.kind === "loop") return await this.execLoop(node, inst, depth);
    if (node.kind === "break") return "break";
    if (node.kind === "abort") {
      this.log(inst.id, inst.groupId, "abort", node.id, "块要求中止本组");
      return "abort";
    }
    return await this.execExec(node, inst);
  }

  private async execLoop(
    node: Extract<FlowNode, { kind: "loop" }>,
    inst: Inst,
    depth: number,
  ): Promise<ExecRes> {
    const cap = ORCH_LIMITS.loopIterCap;
    const total = node.mode === "count" ? Math.min(Math.max(Math.round(node.count ?? 1), 1), cap) : Infinity;
    const interval = Math.max(0, Math.round(node.intervalMs));
    let i = 0;
    for (;;) {
      if (inst.aborting) return "abort";
      if (i >= total) break;
      if (i >= cap) {
        this.log(inst.id, inst.groupId, "fail", node.id, `循环迭代超限（>${cap}）`);
        return "fail";
      }
      if (node.mode === "while") {
        const c = this.evalConds(node.cond ?? [], inst);
        if (!c.ok) {
          this.log(inst.id, inst.groupId, "skip", node.id, `循环条件不成立（第 ${i} 轮后退出）${c.err ? `：${c.err}` : ""}`);
          return "ok";
        }
      }
      if (i > 0 && interval > 0) await sleep(interval, inst);
      const r = await this.execNodes(node.body, inst, depth + 1);
      if (r === "break") return "ok";
      if (r !== "ok") return r;
      i++;
    }
    return "ok";
  }

  /** 条件求值（AND）；任何一项求不出来 = 不成立并带原因 */
  private evalConds(conds: Cond[], inst: Inst): { ok: boolean; err?: string } {
    for (const c of conds) {
      switch (c.k) {
        case "chan": {
          const v = this.deps.chanLatest(c.chId);
          if (v === null || v === undefined) return { ok: false, err: `通道 ${c.chId} 无数据` };
          if (!orchCompare(v, c.op, c.value, c.tol ?? 0)) return { ok: false, err: `${c.chId}=${v} 不满足 ${c.op} ${c.value}` };
          break;
        }
        case "var": {
          const v = this.getVar(c.name);
          if (v === undefined) return { ok: false, err: `变量 ${c.name} 未声明` };
          if (!orchCompare(v, c.op, c.value, c.tol ?? 0)) return { ok: false, err: `${c.name}=${String(v)} 不满足 ${c.op} ${String(c.value)}` };
          break;
        }
        case "expr": {
          const r = evalCondExpr(c.src, this.scope(inst));
          if (!r.ok) return { ok: false, err: r.err ?? "表达式求值失败" };
          break;
        }
        case "evtField": {
          const v = inst.evt[c.field];
          if (v === undefined) return { ok: false, err: `事件字段 ${c.field} 不存在` };
          if (!orchCompare(v, c.op, c.value, c.tol ?? 0)) return { ok: false, err: `evt.${c.field}=${String(v)} 不满足 ${c.op} ${String(c.value)}` };
          break;
        }
        case "session": {
          if (this.deps.sessionState() !== c.state) return { ok: false, err: `会话状态非 ${c.state}` };
          break;
        }
      }
    }
    return { ok: true };
  }

  private scope(inst: Inst): ExprScope {
    return {
      // now = 引擎时钟（ms）：测摆动周期/耗时类表达式的基石（如 PID 继电整定 Tu=now-tUp）
      get: (n) => (n === "now" ? this.deps.now() : this.getVar(n)),
      evt: inst.evt,
    };
  }

  /* ---------- 执行块 ---------- */

  private async execExec(node: ExecBlock, inst: Inst): Promise<ExecRes> {
    const gid = inst.groupId;
    const fail = (detail: string): ExecRes => {
      this.log(inst.id, gid, "fail", node.id, detail);
      return node.onFail === "continue" ? "ok" : "fail";
    };

    switch (node.kind) {
      case "send": {
        // 红线：send 全局令牌桶
        if (!this.takeSendToken()) {
          return fail(`发送速率超限（>${ORCH_LIMITS.sendBucketRate}/s），本条丢弃`);
        }
        const resolved = this.deps.resolveSend(node.payload);
        if (!resolved) return fail("发送内容解析失败（命令不存在或载荷无效）");
        try {
          if ("frames" in resolved) {
            // B4e：factory 多帧按序逐帧发送，每帧过令牌桶；单帧失败按 onFail
            const total = resolved.frames.length;
            let sent = 0;
            for (const f of resolved.frames) {
              if (!this.takeSendToken()) {
                return fail(`发送速率超限（>${ORCH_LIMITS.sendBucketRate}/s），${sent}/${total} 帧后中止`);
              }
              await this.deps.send("hex", f);
              sent++;
            }
            const bytes = resolved.frames.reduce((a, f) => a + Math.floor(f.replace(/\s+/g, "").length / 2), 0);
            this.log(inst.id, gid, "block", node.id, `HEX×${total} 共 ${bytes} 字节`);
            return "ok";
          }
          await this.deps.send(resolved.mode, resolved.text);
          this.log(inst.id, gid, "block", node.id, `${resolved.mode === "hex" ? "HEX" : "TXT"} ${resolved.text}`);
          return "ok";
        } catch (e) {
          return fail(`发送失败：${String(e)}`);
        }
      }
      case "wait": {
        const ms = Math.min(Math.max(Math.round(node.ms), ORCH_LIMITS.waitMinMs), ORCH_LIMITS.waitMaxMs);
        await sleep(ms, inst);
        this.log(inst.id, gid, "block", node.id, `等待 ${ms}ms`);
        return "ok";
      }
      case "waitFrame": {
        const timeout = Math.max(0, Math.min(Math.round(node.timeoutMs), ORCH_LIMITS.frameTimeoutMaxMs));
        const row = await this.waitFrameLoop(node.match, timeout, inst);
        if (inst.aborting) return "abort";
        if (!row) {
          return fail(timeout > 0 ? `${timeout}ms 内未等到匹配帧` : "无限等待被中止");
        }
        this.log(inst.id, gid, "block", node.id, `等到帧 [${row.tplName}] len=${row.len}`);
        return "ok";
      }
      case "runSuite": {
        try {
          const ok = await this.deps.runSuite(node.suiteId, node.wait);
          if (node.wait && !ok) return fail(`序列 ${node.suiteId} 运行失败`);
          this.log(inst.id, gid, "block", node.id, `运行序列 ${node.suiteId}${node.wait ? "（等待完成）" : ""}`);
          return "ok";
        } catch (e) {
          return fail(`序列调用失败：${String(e)}`);
        }
      }
      case "runGroup": {
        const tg = this.findGroup(node.groupId);
        if (!tg) return fail(`目标组 ${node.groupId} 不存在`);
        if (tg.id === inst.groupId) return fail("禁止调用自身（防死锁）");
        if (inst.depth + 1 > ORCH_LIMITS.recursionDepthMax) return fail(`递归深度超限（>${ORCH_LIMITS.recursionDepthMax}）`);
        if (node.wait && inst.chain.includes(tg.id)) return fail("等待环：被调组已在等待链中（A→B→A）");
        const chain = node.wait ? [...inst.chain, inst.groupId] : inst.chain;
        const child = this.enqueue(tg, `被组 ${inst.groupId} 调用`, inst.evt, inst.depth + 1, chain);
        if (!child) return fail("目标组队列已满，子调用被丢弃");
        if (node.wait) {
          const r = await child.done;
          if (r !== "ok") return fail(`被调组 ${tg.name} 结束（${r}）`);
        }
        this.log(inst.id, gid, "block", node.id, `调用组「${tg.name}」${node.wait ? "（等待完成）" : ""}`);
        return "ok";
      }
      case "setVar": {
        const r = this.resolveFrom(node.from, inst);
        if ("err" in r) return fail(r.err);
        if (!this.setVar(node.name, r.v)) return fail(`变量 ${node.name} 写入失败`);
        this.log(inst.id, gid, "block", node.id, `${node.name} = ${String(this.getVar(node.name))}`);
        return "ok";
      }
      case "toast": {
        this.deps.toast(interpolate(node.text, this.scope(inst)), node.level);
        this.log(inst.id, gid, "block", node.id, `通知[${node.level}] ${node.text}`);
        return "ok";
      }
      case "sound": {
        this.deps.sound(node.level);
        this.log(inst.id, gid, "block", node.id, `提示音[${node.level}]`);
        return "ok";
      }
      /* ---------- B4c 新增动作块 ---------- */
      case "setControl": {
        if (!this.deps.writeControlVar) return fail("画布变量钩子未接线");
        const r = this.resolveFrom(node.from, inst);
        if ("err" in r) return fail(r.err);
        const val = typeof r.v === "boolean" ? (r.v ? 1 : 0) : r.v;
        if (!node.varName) return fail("未写目标画布变量名");
        if (!this.deps.writeControlVar(node.varName, typeof val === "number" ? val : String(val))) {
          return fail(`画布变量 ${node.varName} 不存在`);
        }
        this.log(inst.id, gid, "block", node.id, `画布变量 ${node.varName} = ${String(val)}`);
        return "ok";
      }
      case "setSwitch": {
        if (!this.deps.setSwitchCard) return fail("开关卡钩子未接线");
        if (!node.swName) return fail("未写开关卡名");
        if (!this.deps.setSwitchCard(node.swName, node.state)) return fail(`开关卡「${node.swName}」不存在`);
        this.log(inst.id, gid, "block", node.id, `开关「${node.swName}」→ ${node.state}`);
        return "ok";
      }
      case "modbusWrite": {
        // 无主站写事务 API（探针结论）：FC05/06 编码成 RTU 帧走 send 通道（同一令牌桶）
        if (!this.takeSendToken()) return fail(`发送速率超限（>${ORCH_LIMITS.sendBucketRate}/s），本条丢弃`);
        const fn = node.fn === 5 ? 0x05 : 0x06;
        let bytes: number[];
        try {
          bytes = buildRtuRequest({
            slave: node.slave,
            fn,
            addr: node.addr,
            value: node.fn === 5 ? (node.value ? 1 : 0) : node.value,
          });
        } catch (e) {
          return fail(`Modbus 参数非法：${e instanceof Error ? e.message : String(e)}`);
        }
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        try {
          await this.deps.send("hex", hex);
          this.log(inst.id, gid, "block", node.id, `Modbus FC0${node.fn} 从站${node.slave} 地址${node.addr} ← ${node.value}（HEX ${hex}）`);
          return "ok";
        } catch (e) {
          return fail(`Modbus 写发送失败：${String(e)}`);
        }
      }
      case "log": {
        const text = interpolate(node.text, this.scope(inst));
        this.log(inst.id, gid, "block", node.id, `[${node.level}] ${text}`);
        if (node.level === "crit") this.deps.toast(text, "crit");
        return "ok";
      }
      case "snapshot": {
        if (!this.deps.snapshotPanel) return fail("截图钩子未接线");
        try {
          const ok = await this.deps.snapshotPanel(node.panel, node.note);
          if (!ok) return fail(`面板 ${node.panel} 截图失败（面板未开或存储失败）`);
          this.log(inst.id, gid, "block", node.id, `截图 ${node.panel}${node.note ? `（${node.note}）` : ""}`);
          return "ok";
        } catch (e) {
          return fail(`截图失败：${String(e)}`);
        }
      }
      case "exportCsv": {
        if (!this.deps.exportCsv) return fail("CSV 导出钩子未接线");
        if (!node.chanId) return fail("未选通道");
        try {
          const ok = await this.deps.exportCsv(node.chanId, Math.min(Math.max(Math.round(node.lastN), 1), ORCH_LIMITS.csvLastNCap));
          if (!ok) return fail(`通道 ${node.chanId} 导出失败（无数据或已取消）`);
          this.log(inst.id, gid, "block", node.id, `通道 ${node.chanId} 最近 ${node.lastN} 点已导出 CSV`);
          return "ok";
        } catch (e) {
          return fail(`CSV 导出失败：${String(e)}`);
        }
      }
      case "stopSuite": {
        this.deps.stopSuite?.();
        this.log(inst.id, gid, "block", node.id, "已请求停止测试序列");
        return "ok";
      }
      case "emitFlow": {
        const name = node.name.trim().slice(0, ORCH_LIMITS.flowEvtNameMax);
        if (!name) return fail("未写事件名");
        const data: Record<string, number | string | boolean> = {};
        for (const d of node.data.slice(0, ORCH_LIMITS.emitFlowDataMax)) {
          const k = d.k.trim().slice(0, ORCH_LIMITS.flowEvtNameMax);
          if (!k) continue;
          try {
            data[k] = evalExpr(d.src, this.scope(inst));
          } catch (e) {
            return fail(`事件字段 ${k} 表达式失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        this.emit({ kind: "flow", name, data }, gid);
        this.log(inst.id, gid, "block", node.id, `派发事件「${name}」${Object.keys(data).length ? `（${Object.keys(data).join("/")}）` : ""}`);
        return "ok";
      }
      case "clip": {
        if (!this.deps.clipWrite) return fail("剪贴板钩子未接线");
        try {
          const ok = await this.deps.clipWrite(interpolate(node.text, this.scope(inst)));
          if (!ok) return fail("剪贴板写入失败（权限拒绝）");
          this.log(inst.id, gid, "block", node.id, "已写剪贴板");
          return "ok";
        } catch (e) {
          return fail(`剪贴板写入失败：${String(e)}`);
        }
      }
      case "resetVars": {
        let n = 0;
        if (node.scope === "one") {
          const name = node.name.trim();
          const slot = this.vars.get(name);
          if (!slot) return fail(`变量 ${name || "（空）"} 不存在`);
          slot.value = slot.def;
          n = 1;
        } else {
          for (const slot of this.vars.values()) {
            if (slot.value !== slot.def) {
              slot.value = slot.def;
              n++;
            }
          }
        }
        // 持久变量被复位 → 通知落盘（silent：不派发 varChanged，防事件风暴）
        this.deps.onVarsChanged?.();
        this.log(inst.id, gid, "block", node.id, node.scope === "one" ? `变量 ${node.name} 已复位` : `已复位 ${n} 个变量`);
        return "ok";
      }
    }
  }

  /** waitFrame：timeout>0 单次等待；timeout=0 无限等（1s 切片轮询——abort ≤1s 响应、
   *  waiter 有界自清、切片间缓冲重扫不漏帧） */
  private async waitFrameLoop(match: FrameMatch, timeoutMs: number, inst: Inst): Promise<FrameRowLite | null> {
    if (timeoutMs > 0) return await this.deps.waitFrame(match, timeoutMs, inst.t0);
    for (;;) {
      if (inst.aborting) return null;
      const r = await this.deps.waitFrame(match, 1000, inst.t0);
      if (r) return r;
    }
  }

  /** send 全局令牌桶（send/modbusWrite 共用） */
  private takeSendToken(): boolean {
    const now = this.deps.now();
    if (now - this.sendT0 >= 1000) {
      this.sendT0 = now;
      this.sendN = 0;
    }
    return ++this.sendN <= ORCH_LIMITS.sendBucketRate;
  }

  /** VarFrom → 值（setVar / setControl 共用取值逻辑） */
  private resolveFrom(from: VarFrom, inst: Inst): { v: ExprVal } | { err: string } {
    switch (from.k) {
      case "const":
        return { v: from.value };
      case "chan": {
        const v = this.deps.chanLatest(from.chId);
        return v === null || v === undefined ? { err: `通道 ${from.chId} 无数据` } : { v: v };
      }
      case "expr": {
        try {
          return { v: evalExpr(from.src, this.scope(inst)) };
        } catch (e) {
          return { err: `表达式失败：${e instanceof Error ? e.message : String(e)}` };
        }
      }
      case "evtField": {
        const v = inst.evt[from.field];
        return v === undefined ? { err: `事件字段 ${from.field} 不存在` } : { v };
      }
    }
  }

  /* ---------- 组查找 / 统计 / 日志 ---------- */

  private topGroup(id: string): GroupNode | undefined {
    return this.doc?.groups.find((g) => g.id === id);
  }

  /** 全树查找（runGroup 可调用嵌套组） */
  private findGroup(id: string): GroupNode | undefined {
    const walk = (nodes: FlowNode[] | undefined): GroupNode | undefined => {
      for (const n of nodes ?? []) {
        if (n.kind === "group") {
          if (n.id === id) return n;
          const deep = walk(n.children);
          if (deep) return deep;
        } else if (n.kind === "if") {
          const deep = walk([...n.then, ...n.els]);
          if (deep) return deep;
        } else if (n.kind === "loop") {
          const deep = walk(n.body);
          if (deep) return deep;
        }
      }
      return undefined;
    };
    return this.topGroup(id) ?? walk(this.doc?.groups);
  }

  statsOf(groupId: string): GroupStats {
    return this.stats.get(groupId) ?? { total: 0, fail: 0, lastTs: 0, lastDetail: "" };
  }

  isRunning(): boolean {
    for (const q of this.queues.values()) if (q.length > 0) return true;
    return false;
  }

  /** 在跑 + 排队实例总数（面板徽标用：isRunning 布尔撑不起「运行中 N」文案） */
  runningCount(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private log(instId: number, groupId: string, phase: LogEntry["phase"], blockId: string | undefined, detail: string, durMs?: number): void {
    if (this.logLen === ORCH_LIMITS.logCap) {
      // 环形覆写最旧
      this.logBuf[this.logHead] = { ts: this.deps.now(), instId, groupId, phase, blockId, detail, durMs };
      this.logHead = (this.logHead + 1) % ORCH_LIMITS.logCap;
      return;
    }
    this.logBuf.push({ ts: this.deps.now(), instId, groupId, phase, blockId, detail, durMs });
    this.logLen++;
  }

  /** 按时间正序返回日志快照（UI 订阅用，不共享内部数组） */
  getLogs(): LogEntry[] {
    if (this.logLen < ORCH_LIMITS.logCap) return this.logBuf.slice();
    return [...this.logBuf.slice(this.logHead), ...this.logBuf.slice(0, this.logHead)];
  }

  /** 清空日志环形缓冲（面板「清空」按钮；不影响统计与运行状态） */
  clearLogs(): void {
    this.logBuf.length = 0;
    this.logHead = 0;
    this.logLen = 0;
  }
}

/* ================= 辅助 ================= */

/** 运行相关签名的规范化投影：剔除视图态字段（collapsed）。相等 = 引擎执行语义无变化 */
function runSig(doc: FlowDoc): string {
  return JSON.stringify({
    master: doc.settings.masterOn,
    vars: doc.vars,
    groups: doc.groups.map((g) => ({ ...g, collapsed: undefined })),
  });
}

function mkSlot(v: FlowVar): VarSlot {
  return { type: v.type, value: v.def, def: v.def, persist: v.persist };
}

function mkEvtCtx(evt: FlowEvent): EvtCtx {
  const ctx: EvtCtx = { kind: evt.kind };
  if (evt.kind === "frame") {
    for (const f of evt.row.fields) ctx[f.name] = f.value;
  } else if (evt.kind === "threshold") {
    ctx.chId = evt.chId;
    ctx.value = evt.value;
    ctx.phase = evt.phase;
  } else if (evt.kind === "varChanged") {
    ctx.old = evt.old;
    ctx.new = evt.new;
  } else if (evt.kind === "sentinel") {
    ctx.level = evt.level;
  } else if (evt.kind === "flow") {
    ctx.name = evt.name;
    for (const [k, v] of Object.entries(evt.data)) ctx[k] = v;
  } else if (evt.kind === "chanChanged") {
    ctx.chId = evt.chId;
    ctx.old = evt.old;
    ctx.new = evt.new;
  } else if (evt.kind === "newTpl") {
    ctx.tplId = evt.tplId;
    ctx.tplName = evt.tplName;
    ctx.len = evt.len;
  } else if (evt.kind === "idle") {
    ctx.idleMs = evt.idleMs;
    ctx.lastTs = evt.lastTs;
  }
  return ctx;
}

function evtReason(evt: FlowEvent): string {
  switch (evt.kind) {
    case "manual": return "手动";
    case "session": return `会话${evt.phase === "start" ? "开始" : "停止"}`;
    case "frame": return "帧命中";
    case "threshold": return `${evt.chId} 穿越${evt.phase === "enter" ? "进入" : "回落"}`;
    case "timer": return "定时器";
    case "sentinel": return `哨兵${evt.level}告警`;
    case "varChanged": return `变量 ${evt.name} 变更`;
    case "flow": return `自定义事件「${evt.name}」`;
    case "chanChanged": return `通道 ${evt.chId} 变化（${evt.old} → ${evt.new}）`;
    case "newTpl": return `新帧型 [${evt.tplName}]`;
    case "idle": return `会话空闲 ≥${evt.idleMs}ms`;
  }
}

function evtMatches(b: EventBlock, evt: FlowEvent): boolean {
  switch (b.kind) {
    case "manual":
      // 手动事件由 matchGroup 前置判定（需要区分「空槽=恒可手动」），此处仅防御性保留
      return evt.kind === "manual";
    case "session":
      return evt.kind === "session" && evt.phase === b.phase;
    case "frame":
      return evt.kind === "frame";
    case "threshold":
      return evt.kind === "threshold" && evt.groupId !== "" && evt.blockId === b.id;
    case "timer":
      return evt.kind === "timer" && evt.blockId === b.id;
    case "sentinel":
      return evt.kind === "sentinel" && (b.level === "warn" || evt.level === "crit");
    case "varChanged":
      return evt.kind === "varChanged" && evt.name === b.varName;
    /* ---------- B4d 新增 ---------- */
    case "frameError":
      // 复用 frame 帧流事件（valid 过滤在 matchGroup 做，配合 stride 计数）
      return evt.kind === "frame";
    case "chanChanged":
      return evt.kind === "chanChanged" && evt.groupId !== "" && evt.blockId === b.id;
    case "newTpl":
      return evt.kind === "newTpl" && (!b.tplId || b.tplId === evt.tplId);
    case "flowEvt":
      return evt.kind === "flow" && evt.name === b.name;
    case "idle":
      return evt.kind === "idle" && evt.groupId !== "" && evt.blockId === b.id;
  }
}

/** 类型收敛：失败返回 null（绝不静默把乱值塞进变量） */
function converge(type: FlowVarType, value: number | string | boolean): number | string | boolean | null {
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && !(typeof value === "string" && value.trim() === "") ? n : null;
  }
  if (type === "string") return String(value).slice(0, ORCH_LIMITS.varStrCap);
  // bool
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false" || value === "") return false;
  return null;
}

function sameVal(a: number | string | boolean, b: number | string | boolean): boolean {
  return a === b;
}

/** 序列器 compareValues 同语义：eq/ne 直比；数值运算符转数字，NaN 不成立 */
function orchCompare(v: number | string | boolean, op: OrchOp, e: number | string | boolean, tol: number): boolean {
  if (op === "eq") return sameVal(v, e) || (typeof v !== typeof e && toNumEq(v, e));
  if (op === "ne") return !(sameVal(v, e) || (typeof v !== typeof e && toNumEq(v, e)));
  const n = typeof v === "number" ? v : Number(v);
  const en = typeof e === "number" ? e : Number(e);
  if (Number.isNaN(n) || Number.isNaN(en)) return false;
  switch (op) {
    case "gt": return n > en;
    case "lt": return n < en;
    case "ge": return n >= en;
    case "le": return n <= en;
    default: return Math.abs(n - en) <= tol;
  }
}

function toNumEq(v: number | string | boolean, e: number | string | boolean): boolean {
  const a = Number(v);
  const b = Number(e);
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}

/** 可中止 sleep：注册到实例，abort 时立即唤醒并清理定时器 */
function sleep(ms: number, inst: Inst): Promise<void> {
  return new Promise((resolve) => {
    const h: { clear(): void; timer?: ReturnType<typeof setTimeout> } = {
      clear() {
        if (h.timer) clearTimeout(h.timer);
        resolve();
      },
    };
    h.timer = setTimeout(() => {
      h.timer = undefined;
      const arr = inst.sleeps;
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
      resolve();
    }, ms);
    inst.sleeps.push(h);
  });
}

/** toast 文案插值：${表达式} 求值，失败保留原文 */
function interpolate(text: string, scope: ExprScope): string {
  return text.replace(/\$\{([^}]*)\}/g, (m, src: string) => {
    try {
      return String(evalExpr(src, scope));
    } catch {
      return m;
    }
  });
}
