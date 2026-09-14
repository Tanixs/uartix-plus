/**
 * B4a：编排块/事件块的单一注册表（P75-B4 详设 §3）。
 *
 * 职责（且仅此几件）：
 * 1. 每个块/事件类型的**元数据**（菜单分组、视觉色类、容器标记、中英文案、AI 参数说明）；
 * 2. `NewBlockKind` / `NewEventKind` 类型：由 registry 键集派生（keyof typeof），
 *    satisfies Record<types 联合> 提供双向编译期守卫——types.ts 新增 kind 而这里
 *    忘登记（或多登记）都会直接 tsc 报错；
 * 3. `makeBlock` / `makeEvent` 工厂（从 store 迁入）+ `newId`。
 *
 * 为什么单独成文件：加一个块原来要同步 8 处（types/store/engine/Panel/Inspector/
 * bind/aiBuild/prompts），其中菜单、AI 清单、说明文本是三份平行宇宙，漏登记不报错。
 * 收敛后 = 4 处：types 联合 → registry 一行 → engine 执行 case → Inspector 编辑器 case；
 * 面板菜单 / AI 工具清单 / 错误消息全部自动生效。
 *
 * 依赖红线：本文件零 React / IPC / localStorage，只 type-only import types.ts，
 * Node 环境可测（与 engine 同一基线）。
 */

import type { EventBlock, ExecBlock, FlowNode, LogicBlock } from "./types";

/* ================= id 生成（从 store 迁入） ================= */

let idSeq = 0;

export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36).padStart(2, "0")}${Math.floor(
    Math.random() * 36 * 36,
  )
    .toString(36)
    .padStart(2, "0")}`;
}

/* ================= 元数据 ================= */

export interface BlockMeta {
  /** 「+ 添加块」抽屉的分组（原 Panel BlockGrp） */
  cat: "exec" | "logic" | "org";
  /** 视觉色类（原 KIND_CLS 值：send/wait/frame/assert/note/logic/group） */
  cls: string;
  /** 容器块（group/if/loop）：拖拽落点判定、子流槽渲染 */
  container: boolean;
  label: { zh: string; en: string };
  tip: { zh: string; en: string };
  /** AI/帮助用的一行参数说明（消除 prompts 手写漂移源） */
  ai: string;
}

/** types.ts 执行/逻辑联合的全部 kind（+ 组织用 group）；新增 kind 在此自动收编 */
type BlockKindUnion = ExecBlock["kind"] | LogicBlock["kind"] | "group";

/**
 * 块注册表。**声明顺序 = 「+ 添加块」抽屉与 AI 工具清单的展示顺序**。
 * 漏登记/多登记：satisfies 双向守卫直接 tsc 报错。
 */
export const BLOCK_REGISTRY = {
  send: {
    cat: "exec", cls: "send", container: false,
    label: { zh: "发送", en: "Send" },
    tip: { zh: "发送 HEX/ASCII/命令库条目，支持 {var} 取编排变量", en: "Send HEX/ASCII/command entry; {var} pulls flow vars" },
    ai: "sendMode(hex|ascii)+text，或 cmdId 选命令库条目",
  },
  wait: {
    cat: "exec", cls: "wait", container: false,
    label: { zh: "等待", en: "Wait" },
    tip: { zh: "暂停一段时间再继续（10ms~60s）", en: "Pause before continuing (10ms~60s)" },
    ai: "ms(10~60000)",
  },
  waitFrame: {
    cat: "exec", cls: "frame", container: false,
    label: { zh: "等待帧", en: "WaitFrame" },
    tip: { zh: "等到匹配帧才继续，可设超时与忽略失败", en: "Wait for a matching frame with optional timeout" },
    ai: "hex/tplId+fieldName+op+expected(或 expectedVar)+timeoutMs+ignoreFail",
  },
  runSuite: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "序列", en: "Suite" },
    tip: { zh: "调用测试序列器里的套件（可等待完成）", en: "Run a sequencer suite (optionally await)" },
    ai: "suiteId + wait(bool)",
  },
  runGroup: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "调用组", en: "CallGrp" },
    tip: { zh: "调用另一个编排组（子程序），可等待完成", en: "Invoke another group as a subroutine" },
    ai: "groupId + wait(bool)",
  },
  setVar: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "设变量", en: "SetVar" },
    tip: { zh: "写编排变量：常量/通道值/表达式/事件字段", en: "Write a flow var from const/channel/expr/event" },
    ai: "name + value(常量；表达式/通道来源请走面板)",
  },
  toast: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "通知", en: "Toast" },
    tip: { zh: "弹一条提示（支持 ${表达式} 插值）", en: "Show a toast (${expr} interpolation)" },
    ai: "level(info|warn|crit) + text",
  },
  sound: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "提示音", en: "Sound" },
    tip: { zh: "播报警示音（warn 单音 / crit 三连音）", en: "Play alert tone (warn/crit)" },
    ai: "level(warn|crit)",
  },
  if: {
    cat: "logic", cls: "logic", container: true,
    label: { zh: "如果", en: "If" },
    tip: { zh: "条件分支：条件全成立走「那么」，否则走「否则」", en: "Branch: all AND-conditions true → then" },
    ai: "只造骨架（条件与分支体请在面板里编）",
  },
  loop: {
    cat: "logic", cls: "logic", container: true,
    label: { zh: "循环", en: "Loop" },
    tip: { zh: "按次数或条件反复执行子流（≤1000 轮）", en: "Repeat body by count or while-condition" },
    ai: "loopMode(count|while)+count(1~1000)+intervalMs(0~600000)；while 条件请在面板编",
  },
  break: {
    cat: "logic", cls: "logic", container: false,
    label: { zh: "跳出", en: "Break" },
    tip: { zh: "跳出最近一层循环", en: "Break out of the nearest loop" },
    ai: "无参数",
  },
  abort: {
    cat: "logic", cls: "logic", container: false,
    label: { zh: "中止", en: "Abort" },
    tip: { zh: "立即中止本组实例", en: "Abort this group instance" },
    ai: "无参数",
  },
  group: {
    cat: "org", cls: "group", container: true,
    label: { zh: "子组", en: "Grp" },
    tip: { zh: "仅用于分组收纳（嵌套组无触发语义）", en: "Organizational grouping (no trigger semantics)" },
    ai: "groupName",
  },
  /* ---------- B4c 新增动作块（详设 §5） ---------- */
  setControl: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "写画布变量", en: "SetCtlVar" },
    tip: { zh: "写控制画布的变量（滑条/监视器等读它）", en: "Write a control-canvas variable" },
    ai: "varName + value(常量；表达式/通道来源请走面板)",
  },
  setSwitch: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "拨开关", en: "Switch" },
    tip: { zh: "按名字拨控制页开关卡（on/off/toggle）", en: "Flip a control-page switch card by name" },
    ai: "swName(卡片名) + state(on|off|toggle)",
  },
  modbusWrite: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "Modbus写", en: "MbWrite" },
    tip: { zh: "Modbus 单点写：FC05 线圈 / FC06 寄存器（RTU 帧走当前连接）", en: "Modbus single write: FC05 coil / FC06 register" },
    ai: "slave(1~247) + fn(5|6) + addr(0~65535) + value(0/1 或寄存器值)",
  },
  log: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "写日志", en: "Log" },
    tip: { zh: "写一条运行日志（crit 级同步弹通知；支持 ${表达式} 插值）", en: "Write a run-log line (crit also toasts)" },
    ai: "level(info|warn|crit) + text",
  },
  snapshot: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "图表截图", en: "Snapshot" },
    tip: { zh: "抓取曲线/3D/频谱面板画面存入图片库", en: "Capture a chart panel into the image library" },
    ai: "panel(plot2d|plot3d|spectrum) + note(备注可空)",
  },
  exportCsv: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "导出CSV", en: "Csv" },
    tip: { zh: "把曲线通道数据导出为 CSV 文件（弹保存对话框）", en: "Export channel data to CSV (save dialog)" },
    ai: "chanId + lastN(最近点数，≤30000)",
  },
  stopSuite: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "停止序列", en: "StopSuite" },
    tip: { zh: "停止正在运行的测试序列（未在跑也按成功）", en: "Stop the running test suite (ok if idle)" },
    ai: "无参数",
  },
  emitFlow: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "发事件", en: "Emit" },
    tip: { zh: "派发自定义事件，别的组挂「自定义事件」块即可接收（跨组解耦）", en: "Emit a custom event other groups can listen to" },
    ai: "name(事件名) + data(可选 k=表达式 对，≤4 个)",
  },
  clip: {
    cat: "exec", cls: "note", container: false,
    label: { zh: "剪贴板", en: "Clip" },
    tip: { zh: "把文本写入系统剪贴板（支持 ${表达式} 插值）", en: "Copy text to the system clipboard" },
    ai: "text(支持 ${表达式} 插值)",
  },
  resetVars: {
    cat: "exec", cls: "assert", container: false,
    label: { zh: "复位变量", en: "ResetVar" },
    tip: { zh: "把编排变量复位到默认值（不触发变量变更事件）", en: "Reset flow vars to defaults (no varChanged storm)" },
    ai: "scope(all|one) + name(scope=one 时的变量名)",
  },
} as const satisfies Record<BlockKindUnion, BlockMeta>;

export type NewBlockKind = keyof typeof BLOCK_REGISTRY;

export interface EventMeta {
  label: { zh: string; en: string };
  tip: { zh: string; en: string };
  /** AI/帮助用的一行参数说明 */
  ai: string;
}

/**
 * 事件块注册表。**声明顺序 = 事件槽「+」菜单与 AI 事件清单的展示顺序**。
 */
export const EVENT_REGISTRY = {
  manual: {
    label: { zh: "手动", en: "Manual" },
    tip: {
      zh: "手动触发源：挂上后本组才会响应 ▶（摘掉即不可手动跑）；仅手动组（事件槽为空）无需挂",
      en: "Manual trigger source: the group answers ▶ only while this block is attached",
    },
    ai: "无参数",
  },
  frame: {
    label: { zh: "帧命中", en: "Frame" },
    tip: { zh: "解码帧命中模板/字段/字节时触发", en: "Fires when a decoded frame matches" },
    ai: "hex/tplId(+fieldName+op+expected) + stride(1~10000)",
  },
  threshold: {
    label: { zh: "阈值穿越", en: "Threshold" },
    tip: { zh: "2D 曲线通道穿越阈值（进入/回落，可去抖）", en: "Channel crosses a threshold (enter/exit)" },
    ai: "chId + op(above|below) + value + edge(enter|exit) + debounceMs(0~60000)",
  },
  timer: {
    label: { zh: "定时器", en: "Timer" },
    tip: { zh: "按固定间隔触发（≥50ms）", en: "Fires on a fixed interval (≥50ms)" },
    ai: "intervalMs(50~3600000)",
  },
  session: {
    label: { zh: "会话", en: "Session" },
    tip: { zh: "连接打开/断开时触发", en: "Fires on connect/disconnect" },
    ai: "phase(start|stop)",
  },
  sentinel: {
    label: { zh: "哨兵告警", en: "Sentinel" },
    tip: { zh: "哨兵产生 warn/crit 告警时触发（哨兵需在运行）", en: "Fires on sentinel warn/crit alerts" },
    ai: "level(warn|crit)",
  },
  varChanged: {
    label: { zh: "变量变更", en: "VarChanged" },
    tip: { zh: "指定编排变量的值实际变化时触发", en: "Fires when a flow var actually changes" },
    ai: "varName",
  },
  /* ---------- B4d 新增事件块（详设 §6） ---------- */
  frameError: {
    label: { zh: "坏帧", en: "BadFrame" },
    tip: { zh: "收到校验失败的帧时触发（stride 抽样防洪泛）", en: "Fires on checksum-failed frames (stride sampled)" },
    ai: "stride(1~10000，每 N 个坏帧取样 1 个)",
  },
  chanChanged: {
    label: { zh: "通道变化", en: "ChanChg" },
    tip: { zh: "曲线通道数值变化超过容差时触发（节流防抖）", en: "Fires when a channel changes beyond tolerance" },
    ai: "chId + tol(≥0) + minIntervalMs(50~3600000)",
  },
  newTpl: {
    label: { zh: "新帧型", en: "NewTpl" },
    tip: { zh: "会话里首次出现某帧型时触发（tplId 留空 = 任意新帧型）", en: "Fires on first sight of a frame type (empty = any)" },
    ai: "tplId(留空=任意新帧型)",
  },
  flowEvt: {
    label: { zh: "自定义事件", en: "FlowEvt" },
    tip: { zh: "接收别的组「发事件」块派发的同名事件（跨组解耦）", en: "Receives flow events emitted by other groups" },
    ai: "name(事件名，与 emitFlow 对应)",
  },
  idle: {
    label: { zh: "会话空闲", en: "Idle" },
    tip: { zh: "连接中超过 idleMs 没收到任何帧时触发一次；再来帧才重新武装", en: "Fires once after idleMs without frames; re-arms on next frame" },
    ai: "idleMs(1000~3600000)",
  },
} as const satisfies Record<EventBlock["kind"], EventMeta>;

export type NewEventKind = keyof typeof EVENT_REGISTRY;

/* ================= 工厂（从 store 迁入，B4a） ================= */

export function makeBlock(kind: NewBlockKind): FlowNode {
  const base = { id: newId("b"), enabled: true, onFail: "abort" as const };
  switch (kind) {
    case "send": return { ...base, kind: "send", payload: { type: "hex", text: "" } };
    case "wait": return { ...base, kind: "wait", ms: 1000 };
    case "waitFrame": return { ...base, kind: "waitFrame", match: { by: "raw", hex: "" }, timeoutMs: 3000, ignoreFail: false };
    case "runSuite": return { ...base, kind: "runSuite", suiteId: "", wait: true };
    case "runGroup": return { ...base, kind: "runGroup", groupId: "", wait: true };
    case "setVar": return { ...base, kind: "setVar", name: "", from: { k: "const", value: 0 } };
    case "toast": return { ...base, kind: "toast", level: "info" as const, text: "" };
    case "sound": return { ...base, kind: "sound", level: "warn" as const };
    case "if": return { id: newId("b"), enabled: true, kind: "if", conds: [], then: [], els: [] };
    case "loop": return { id: newId("b"), enabled: true, kind: "loop", mode: "count" as const, count: 3, intervalMs: 100, body: [] };
    case "break": return { id: newId("b"), enabled: true, kind: "break" };
    case "abort": return { id: newId("b"), enabled: true, kind: "abort" };
    case "group":
      return { kind: "group", id: newId("g"), name: "子组", enabled: true, events: [], children: [] };
    /* ---------- B4c 新增 ---------- */
    case "setControl": return { ...base, kind: "setControl", varName: "", from: { k: "const", value: 0 } };
    case "setSwitch": return { ...base, kind: "setSwitch", swName: "", state: "toggle" as const };
    case "modbusWrite": return { ...base, kind: "modbusWrite", slave: 1, fn: 6 as const, addr: 0, value: 0 };
    case "log": return { ...base, kind: "log", level: "info" as const, text: "" };
    case "snapshot": return { ...base, kind: "snapshot", panel: "plot2d" as const, note: "" };
    case "exportCsv": return { ...base, kind: "exportCsv", chanId: "", lastN: 1000 };
    case "stopSuite": return { ...base, kind: "stopSuite" };
    case "emitFlow": return { ...base, kind: "emitFlow", name: "", data: [] };
    case "clip": return { ...base, kind: "clip", text: "" };
    case "resetVars": return { ...base, kind: "resetVars", scope: "all" as const, name: "" };
  }
}

export function makeEvent(kind: NewEventKind): EventBlock {
  switch (kind) {
    case "manual": return { id: newId("ev"), kind: "manual" };
    case "session": return { id: newId("ev"), kind: "session", phase: "start" };
    case "frame": return { id: newId("ev"), kind: "frame", match: { by: "raw", hex: "" }, stride: 1 };
    case "threshold":
      return { id: newId("ev"), kind: "threshold", chId: "", op: "above", value: 0, edge: "enter", debounceMs: 300 };
    case "timer": return { id: newId("ev"), kind: "timer", intervalMs: 5000 };
    case "sentinel": return { id: newId("ev"), kind: "sentinel", level: "warn" };
    case "varChanged": return { id: newId("ev"), kind: "varChanged", varName: "" };
    /* ---------- B4d 新增 ---------- */
    case "frameError": return { id: newId("ev"), kind: "frameError", stride: 1 };
    case "chanChanged":
      return { id: newId("ev"), kind: "chanChanged", chId: "", tol: 0, minIntervalMs: 1000 };
    case "newTpl": return { id: newId("ev"), kind: "newTpl", tplId: "" };
    case "flowEvt": return { id: newId("ev"), kind: "flowEvt", name: "" };
    case "idle": return { id: newId("ev"), kind: "idle", idleMs: 10000 };
  }
}
