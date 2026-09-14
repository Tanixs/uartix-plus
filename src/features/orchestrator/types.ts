/**
 * P74 自动编排器数据模型。
 *
 * 定位：序列器（线性测试流）× 触发器（迷你世界式事件驱动）的融合体。
 * 组 = 编排单元：事件槽挂事件块（挂了=自动触发器，不挂=手动/被调用的子程序），
 * 组内块流线性执行（保留序列器拖拽/分组基因）。
 *
 * 设计基线与 runner.ts 相同：引擎（engine.ts）必须可在无 DOM / 无 Tauri 的
 * Node 环境跑，本文件与引擎都不 import 任何 React / IPC / localStorage 模块；
 * 与外部世界的接触面全部通过引擎的依赖注入接口（OrchDeps）表达。
 *
 * 与序列器共享类型（SendPayload / FrameMatch / CmpOp）直接复用，零分叉。
 */
import type { FrameMatch, SendPayload } from "../sequencer/types";

/* ================= 变量库 ================= */

export type FlowVarType = "number" | "string" | "bool";

export interface FlowVar {
  /** 全局唯一：^[A-Za-z_][A-Za-z0-9_]{0,31}$ */
  name: string;
  type: FlowVarType;
  def: number | string | boolean;
  /** 持久化（localStorage），重启恢复；否则会话停止/重载复位默认值 */
  persist: boolean;
}

/* ================= 条件（如果块 / while 循环共用，AND 关系） ================= */

/** 编排器条件运算符（序列器 CmpOp 的子集，去掉 changed/approx 由 tol 承担） */
export type OrchOp = "eq" | "ne" | "gt" | "lt" | "ge" | "le" | "approx";

export type Cond =
  | { k: "chan"; chId: string; op: OrchOp; value: number; tol?: number }
  | { k: "var"; name: string; op: OrchOp; value: number | string | boolean; tol?: number }
  | { k: "expr"; src: string }
  | { k: "evtField"; field: string; op: OrchOp; value: number | string; tol?: number }
  | { k: "session"; state: "open" | "streaming" | "idle" };

/* ================= 事件块（只能落在组头事件槽） ================= */

export type EventBlock =
  | { id: string; kind: "manual" }
  | { id: string; kind: "session"; phase: "start" | "stop" }
  /** 解码帧流命中；stride = 每 N 帧取样（1 = 全量），防 200Hz 洪泛 */
  | { id: string; kind: "frame"; match: FrameMatch; stride: number }
  /** 通道阈值穿越（边沿由数据侧差分检测器解析后投递，持续确认=去抖） */
  | {
      id: string;
      kind: "threshold";
      chId: string;
      op: "above" | "below";
      value: number;
      edge: "enter" | "exit";
      debounceMs: number;
    }
  | { id: string; kind: "timer"; intervalMs: number }
  /** 哨兵告警：warn = warn 及以上；crit = 仅 crit */
  | { id: string; kind: "sentinel"; level: "warn" | "crit" }
  /** 引擎内 setVar 实际改变值时同步触发；上下文注入 evt.old / evt.new */
  | { id: string; kind: "varChanged"; varName: string }
  /* ---------- B4d 新增事件块（详设 §6） ---------- */
  /** 坏帧：valid=false 的帧命中；stride 抽样防 200Hz 洪泛（复用 frame 事件流，零新分配） */
  | { id: string; kind: "frameError"; stride: number }
  /** 通道变化：bind 100ms tick 差分检测（自归属），变化量 > tol 且过节流才报 */
  | { id: string; kind: "chanChanged"; chId: string; tol: number; minIntervalMs: number }
  /** 新帧型：会话级首次出现的 tplId（空 = 任意新帧型）；session stop 清空记忆 */
  | { id: string; kind: "newTpl"; tplId: string }
  /** 自定义事件：接收 emitFlow 块 / 外部 orchEngine.emit 派发的同名事件 */
  | { id: string; kind: "flowEvt"; name: string }
  /** 会话空闲：超过 idleMs 无帧触发一次；再收帧才重新武装（电平语义，一次空闲只报一次） */
  | { id: string; kind: "idle"; idleMs: number };

/* ================= 执行块 ================= */

/** 赋值来源：常量 / 通道最新值 / 表达式 / 事件字段 */
export type VarFrom =
  | { k: "const"; value: number | string | boolean }
  | { k: "chan"; chId: string }
  | { k: "expr"; src: string }
  | { k: "evtField"; field: string };

interface ExecBase {
  id: string;
  note?: string;
  enabled: boolean;
  /** 本块失败时：abort = 中止本组实例（默认），continue = 记日志继续 */
  onFail: "abort" | "continue";
}

export type ExecBlock =
  | (ExecBase & { kind: "send"; payload: SendPayload })
  | (ExecBase & { kind: "wait"; ms: number })
  | (ExecBase & {
      kind: "waitFrame";
      match: FrameMatch;
      timeoutMs: number;
      /** 超时是否忽略失败继续（默认中止本组） */
      ignoreFail: boolean;
    })
  | (ExecBase & { kind: "runSuite"; suiteId: string; wait: boolean })
  | (ExecBase & { kind: "runGroup"; groupId: string; wait: boolean })
  | (ExecBase & { kind: "setVar"; name: string; from: VarFrom })
  | (ExecBase & { kind: "toast"; level: "info" | "warn" | "crit"; text: string })
  | (ExecBase & { kind: "sound"; level: "warn" | "crit" })
  /* ---------- B4c 新增动作块（详设 §5；modbusRead/setWidget 按探针结论砍/换） ---------- */
  /** 写控制画布变量（variableStore） */
  | (ExecBase & { kind: "setControl"; varName: string; from: VarFrom })
  /** 拨控制页开关卡（按卡片名查找；on/off/toggle 映射到卡位） */
  | (ExecBase & { kind: "setSwitch"; swName: string; state: "on" | "off" | "toggle" })
  /** Modbus 单点写：FC05 线圈（value 0/1）/ FC06 寄存器；编码成 RTU 帧走 send 通道 */
  | (ExecBase & { kind: "modbusWrite"; slave: number; fn: 5 | 6; addr: number; value: number })
  /** 写引擎运行日志；crit 级同步弹 toast */
  | (ExecBase & { kind: "log"; level: "info" | "warn" | "crit"; text: string })
  /** 面板截图 → 图片库（deps 钩子；UI 未接线或面板未开按 onFail） */
  | (ExecBase & { kind: "snapshot"; panel: "plot2d" | "plot3d" | "spectrum"; note: string })
  /** 通道数据导出 CSV（deps 钩子：dialog 保存） */
  | (ExecBase & { kind: "exportCsv"; chanId: string; lastN: number })
  /** 停止在跑的序列套件（未在跑按 ok） */
  | (ExecBase & { kind: "stopSuite" })
  /** 派发自定义事件（跨组解耦通信；监听方 = B4d flowEvt 事件块） */
  | (ExecBase & { kind: "emitFlow"; name: string; data: { k: string; src: string }[] })
  /** 写剪贴板（原 setWidget 降级：widget 侧无文本更新 API，详设 §5 备选） */
  | (ExecBase & { kind: "clip"; text: string })
  /** 变量复位到默认值（silent，不触发 varChanged 风暴） */
  | (ExecBase & { kind: "resetVars"; scope: "all" | "one"; name: string });

/* ================= 逻辑块（容器） ================= */

interface LogicBase {
  id: string;
  note?: string;
  enabled: boolean;
}

export type LogicBlock =
  | (LogicBase & { kind: "if"; conds: Cond[]; then: FlowNode[]; els: FlowNode[] })
  | (LogicBase & {
      kind: "loop";
      mode: "count" | "while";
      /** mode=count：次数（1~上限钳位） */
      count?: number;
      /** mode=while：每轮先验条件（AND） */
      cond?: Cond[];
      /** 轮间隔 ms（≥0） */
      intervalMs: number;
      body: FlowNode[];
    })
  | (LogicBase & { kind: "break" })
  | (LogicBase & { kind: "abort" });

/* ================= 组与文档 ================= */

export interface GroupNode {
  kind: "group";
  id: string;
  name: string;
  /** 备注（序列导入时继承） */
  note?: string;
  enabled: boolean;
  collapsed?: boolean;
  /** 触发冷却（静默期）：上次触发后 N ms 内的新事件直接丢弃（0 = 不冷却） */
  cooldownMs?: number;
  /**
   * 满队列策略（队列深度 = ORCH_LIMITS.queueCap，含在跑的 1 个，FIFO）：
   * - dropNew（默认）：队列满 → 丢弃**新**触发
   * - dropOld：队列满 → 挤掉**最旧的排队项**（在跑的实例不受影响）再入队
   * - stopOld：只要有实例在跑或排队 → 全部中止，新触发立即上位
   */
  queuePolicy?: "dropNew" | "dropOld" | "stopOld";
  /** 事件槽（仅顶层组有触发语义；嵌套组挂了只作展示并灰显） */
  events: EventBlock[];
  children: FlowNode[];
}

export type FlowNode = ExecBlock | LogicBlock | GroupNode;

export interface FlowDoc {
  version: 1;
  title: string;
  vars: FlowVar[];
  /** 仅顶层组 */
  groups: GroupNode[];
  settings: { masterOn: boolean };
}

/* ================= 运行期事件（投喂引擎） ================= */

/** FrameRow 的字段值投影（事件上下文注入用） */
export type EvtCtx = Record<string, number | string | boolean> & { kind: string };

export type FlowEvent =
  | { kind: "manual"; groupId: string }
  | { kind: "session"; phase: "start" | "stop" }
  /** 原始帧流：匹配与 stride 由引擎按块完成 */
  | { kind: "frame"; row: FrameRowLite }
  /** 阈值/定时器事件由各自数据侧检测器解析到块（带 groupId+blockId），引擎按身份匹配 */
  | { kind: "threshold"; groupId: string; blockId: string; chId: string; value: number; phase: "enter" | "exit" }
  | { kind: "timer"; groupId: string; blockId: string }
  | { kind: "sentinel"; level: "warn" | "crit" }
  | { kind: "varChanged"; name: string; old: number | string | boolean; new: number | string | boolean }
  /** emitFlow 块/外部派发的自定义事件（监听方 = B4d flowEvt 事件块） */
  | { kind: "flow"; name: string; data: Record<string, number | string | boolean> }
  /* ---------- B4d 新增运行期事件 ---------- */
  /** 新帧型首见（bind 维护会话级 seenTpl 集合后派发，低频） */
  | { kind: "newTpl"; tplId: string; tplName: string; len: number }
  /** 通道变化（bind tick 差分检测器解析到块，带 groupId+blockId 自归属） */
  | { kind: "chanChanged"; groupId: string; blockId: string; chId: string; old: number; new: number }
  /** 会话空闲（bind tick 检测，带 groupId+blockId 自归属；armed 电平语义） */
  | { kind: "idle"; groupId: string; blockId: string; idleMs: number; lastTs: number };

/** 帧轻量投影：引擎匹配只需要这些字段（与 ipc/types.FrameRow 对齐的子集） */
export interface FrameRowLite {
  tplId: string;
  tplName: string;
  valid: boolean;
  len: number;
  bytes?: Uint8Array | number[];
  fields: { id: string; name: string; value: number | string; text?: string | null }[];
}

/* ================= 运行日志 ================= */

export type LogPhase = "trigger" | "skip" | "block" | "fail" | "abort" | "fuse" | "done";

export interface LogEntry {
  ts: number;
  instId: number;
  groupId: string;
  phase: LogPhase;
  blockId?: string;
  detail: string;
  durMs?: number;
}

/* ================= 红线常量（全部可测） ================= */

export const ORCH_LIMITS = {
  waitMinMs: 10,
  waitMaxMs: 60_000,
  frameTimeoutMaxMs: 600_000,
  /** 顶层组数量上限 */
  groupCap: 32,
  /** 变量数量上限 */
  varCap: 64,
  /** 字符串变量值长度上限 */
  varStrCap: 1024,
  /** 每组实例队列上限（含在跑的 1 个） */
  queueCap: 8,
  /** 单循环块迭代上限 */
  loopIterCap: 1000,
  /** 单实例累计块执行上限 */
  instBlockCap: 10_000,
  /** 单实例总时长帽 */
  instDurCapMs: 300_000,
  /** runGroup 递归深度上限 */
  recursionDepthMax: 8,
  /** 容器/组总深度上限 */
  nodeDepthMax: 4,
  /** send 令牌桶：全局每秒 */
  sendBucketRate: 50,
  /** 全局触发熔断：滑动窗口 */
  fuseWindowMs: 1000,
  fuseTriggerMax: 100,
  fusePauseMs: 1000,
  /** 运行日志环形容量 */
  logCap: 800,
  /** 表达式求值 deadline */
  exprDeadlineMs: 50,
  /** 表达式解析/求值深度上限 */
  exprDepthMax: 64,
  /** 表达式节点访问上限（病态深嵌套保护） */
  exprNodeCap: 10_000,
  /* ---------- B4c 新增红线 ---------- */
  /** emitFlow 事件名长度上限 */
  flowEvtNameMax: 32,
  /** emitFlow data 键值对上限 */
  emitFlowDataMax: 4,
  /** exportCsv 导出点数上限（与曲线缓冲 MAX_POINTS 对齐） */
  csvLastNCap: 30_000,
  /** modbusWrite 从站地址/寄存器值上限 */
  mbAddrMax: 0xffff,
  mbSlaveMax: 247,
} as const;

/** 变量名合法性 */
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/**
 * 组是否可被手动触发（▶ / 外部调用）。
 *
 * 语义（P74c A2 定案）：
 * - 事件槽为空 → 组就是「手动/子程序」，恒可手动跑（向后兼容，也是空态引导的说法）；
 * - 事件槽非空 → 必须显式挂一块「手动」事件，▶ 才可用。
 *   这样事件块有真实语义：把「手动」块从自动组里摘掉，该组就只响应自动事件。
 */
export function isManuallyTriggerable(g: GroupNode): boolean {
  if (g.events.length === 0) return true;
  return g.events.some((b) => b.kind === "manual");
}
