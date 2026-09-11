/**
 * 视觉测试序列器（T1）数据模型。
 *
 * 设计基线：执行引擎（runner.ts）必须可在无 DOM / 无 Tauri 的 Node 环境跑
 * （T5 CLI 复用同一引擎），因此本文件与 runner 都不 import 任何 React / IPC 模块；
 * 与外部世界的接触面全部通过 runner 的依赖注入接口（SequencerDeps）表达。
 */

/** send 步骤的载荷：字面 hex / ASCII 文本（UTF-8 直发）/ 命令库条目 / 指令工厂组帧（factory 仅预留类型，v2 补执行） */
export type SendPayload =
  | { type: "hex"; text: string }
  | { type: "ascii"; text: string }
  | { type: "cmd"; cmdId: string }
  | { type: "factory"; spec: Record<string, unknown> };

/** 断言/字段匹配共用的比较运算符。changed = 与步骤开始前的值不同 */
export type CmpOp = "eq" | "ne" | "gt" | "lt" | "ge" | "le" | "changed" | "approx";

/** 期望值：字面量，或引用另一个变量（"$" 语义由 runner 解析） */
export type ExpectVal = number | { var: string };

/** 帧匹配三要素：模板 / 模板+字段 / 原始字节含 hex 子串。
 *  CLI（T5）只支持 raw；tpl/field 需要协议引擎解码，标记 UI-only。 */
export type FrameMatch =
  | { by: "tpl"; tplId: string }
  | { by: "field"; tplId: string; fieldName: string; op: CmpOp; expected: ExpectVal }
  | { by: "raw"; hex: string };

/* ================= 步骤 ================= */

interface StepBase {
  id: string;
  /** 行内备注（进报告） */
  note?: string;
  /** 禁用步骤跳过执行但在报告保留占位 */
  enabled: boolean;
}

export interface SendStep extends StepBase {
  kind: "send";
  payload: SendPayload;
}

export interface WaitStep extends StepBase {
  kind: "wait";
  /** 1ms ~ 60000ms */
  ms: number;
}

export interface WaitForFrameStep extends StepBase {
  kind: "waitForFrame";
  match: FrameMatch;
  /** 0 = 无限等待（UI 侧警示），默认 3000 */
  timeoutMs: number;
}

export interface AssertVarStep extends StepBase {
  kind: "assertVar";
  varName: string;
  op: CmpOp;
  expected?: ExpectVal;
  /** approx 的容差 */
  tolerance?: number;
}

export interface GroupStep extends StepBase {
  kind: "group";
  name: string;
  /** 1~9999，不做无限循环 */
  repeats: number;
  /** 该组内失败后的行为：abort = 整个组短路（按 Suite 失败策略继续向上），continue = 记录后跑下一轮 */
  onFailure: "abort" | "continue";
  children: Step[];
}

export interface NoteStep extends StepBase {
  kind: "note";
  text: string;
}

export type Step = SendStep | WaitStep | WaitForFrameStep | AssertVarStep | GroupStep | NoteStep;

export type StepKind = Step["kind"];

/* ================= 序列 ================= */

export type SuiteTrigger =
  | { mode: "manual" }
  | { mode: "onFrame"; match: FrameMatch; /** 防重入冷却 */ cooldownMs: number };

export interface Suite {
  id: string;
  name: string;
  steps: Step[];
  trigger: SuiteTrigger;
  /** 顶层失败策略：true = 首个失败即停（默认），false = 记录失败继续跑完 */
  failFast: boolean;
}

/* ================= 运行结果 ================= */

export type StepStatus = "pass" | "fail" | "timeout" | "skipped" | "aborted";

export interface StepResult {
  stepId: string;
  kind: StepKind;
  /** group 的行内名字，报告展示用 */
  label: string;
  status: StepStatus;
  startedAt: number;
  durationMs: number;
  /** 人读的结论/错误文字（截断由 runner 控制） */
  detail: string;
  /** group：按执行顺序扁平汇总每一轮的子结果 */
  children?: StepResult[];
  /** group：实际执行的轮数 */
  attempts?: number;
}

export type RunStatus = "done" | "failed" | "aborted";

export interface RunResult {
  suiteId: string;
  suiteName: string;
  startedAt: number;
  finishedAt: number;
  status: RunStatus;
  /** 顶层步骤结果树（group 含 children） */
  steps: StepResult[];
}

/** 引擎运行期的进度快照（UI 订阅用，T3 接 store） */
export interface RunProgress {
  status: "running" | "awaitingStep" | "finished";
  suiteId: string;
  /** 当前步骤 id（awaitingStep 时为刚完成的那步） */
  currentStepId: string | null;
  /** 已完成的结果（含树），引用语义：UI 不要就地改 */
  results: StepResult[];
  result: RunResult | null;
}

/* ================= 常量 ================= */

export const STEP_KINDS: readonly StepKind[] = [
  "send",
  "wait",
  "waitForFrame",
  "assertVar",
  "group",
  "note",
] as const;

export const LIMITS = {
  waitMinMs: 1,
  waitMaxMs: 60_000,
  /** 0 = 无限；否则 UI 建议区间 100~60000 */
  frameTimeoutMaxMs: 600_000,
  groupRepeatsMax: 9999,
  groupDepthMax: 4,
  /** 帧到达缓冲上限：超出丢弃最旧（性能红线：等待缓冲不许无界） */
  frameBufCap: 200,
  /** 结果树节点上限：超出只记占位（性能红线） */
  resultCap: 5000,
  /** 单条结果 detail 上限字符数 */
  detailCap: 2000,
} as const;
