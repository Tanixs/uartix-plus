export type SendMode = "ascii" | "hex";

import { getLocale } from "../../i18n/strings";
import { guardLocked } from "../operator/lock";
  import { DEBUG_SCHEMA, sanitizeManaged, sanitizeDebugProfile, buildDebugPreset, type ManagedControl, type DebugProfile, type DebugParameter } from "./debugPreset";
import {
  embedAspectOf,
  embedMinOf,
  embedName,
  isEmbedTargetId,
  sanitizeEmbedViewState,
  type EmbedPanelViewState,
  type EmbedTargetId,
} from "./embedPanels";

/**
 * 控制画布存档 schema 版本。v2 = 引入 `type:"embed"` 内嵌面板卡片；
 * v3 = 卡片可挂载命令（`commandId`，引用式，见 `commandMount.ts`）。
 * 旧版没有版本字段，按 v1 读入并就地升级；高于当前版本的导入文件必须拒绝，
 * 否则新版本的卡片会被旧代码静默丢成空白画布。
 */
export const CONTROLS_SCHEMA_VERSION = 3;

/**
 * 控件类型的**唯一运行时真相**（P97-I5）：以前只有 TS 联合，于是 ControlCanvas 的调色板
 * 自己手抄了一份 `WIDGET_TYPES`，加一种控件就会静默漏一项；`ui_inventory` 也需要能运行时枚举的清单。
 */
export const CONTROL_TYPES = [
  "slider",
  "button",
  "switch",
  "led",
  "buzzer",
  "monitor",
  "joystick",
  "keypad",
  "keymon",
  "group",
  "custom",
] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];
/**
 * 控件库与 AI 面板清单里**还能新建**的类型。
 * `custom` 只剩读取能力：旧存档里的空壳卡照常渲染（`CustomCardView`），
 * 但不再提供新建入口——AI 造物统一走插件小部件之后，拖出来也只是一张永远空的卡。
 */
export const CREATABLE_CONTROL_TYPES = CONTROL_TYPES.filter((t) => t !== "custom");
/**
 * 卡片类型 = 可拖入的控件类型 + `embed`（画布内嵌面板）。
 * `embed` 故意不进 CONTROL_TYPES：那是控件库的清单，内嵌面板从「面板」分组另走一条入口，
 * 免得用户以为任意面板都能拖进画布。
 */
export type CardType = ControlType | "embed";

export interface BaseCard {
  managed?: ManagedControl;
  id: string;
  type: CardType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * P121-D3：这张卡**引用**一张发送谱（`SendTemplate`）。带着它时 `template` 不参与发送——
   * 卡片今天是从命令**拷**一份字节过来的（`mountCommand`），改命令不会回头改卡片；
   * 引用式让"改谱 ⇒ 命令 / 序列器 / 卡片三处跟着变"成立（详设 §7 P121-D 的验收句）。
   */
  sendTemplateId?: string;
  /**
   * 这张卡挂载的命令 id（引用式，schema v3）。带着它时模板/脚本/谱引用都由命令决定，
   * 卡片上的 `template` 等字段不再参与发送——命令是唯一真相（命令 → 谱 → 卡片）。
   * 没有它 = 旧卡的拷贝语义，行为与 v2 完全一致。
   */
  commandId?: string;
  /**
   * 这张卡的控制值灌进谱的哪个参数（滑条 value / 开关 state）。
   * 必须显式存：不存就得靠"参数叫什么名字"去猜，而猜参数名是这条仓库明令禁止的。
   */
  paramId?: string;
}

export interface SliderCard extends BaseCard {
  type: "slider";
  template: string;
  sendMode: SendMode;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  sendTrigger: "onRelease" | "continuous";
  minIntervalMs: number;
  useScript: boolean;
  script: string;
}

export interface ButtonCard extends BaseCard {
  type: "button";
  template: string;
  sendMode: SendMode;
  holdRepeat: boolean;
  minIntervalMs: number;
  useScript: boolean;
  script: string;
}

export type LedOp = "gt" | "ge" | "lt" | "le" | "eq" | "ne";

export interface SwitchCard extends BaseCard {
  type: "switch";
  positions: 2 | 3;
  templates: string[];
  labels: string[];
  sendMode: SendMode;
  state: number;
  useScript: boolean;
  script: string;
}

export interface LedCard extends BaseCard {
  type: "led";
  varName: string;
  op: LedOp;
  value: number;
  strValue: string;
  onColor: string;
}

export interface BuzzerCard extends BaseCard {
  type: "buzzer";
  varName: string;
  op: LedOp;
  value: number;
  strValue: string;
  onColor: string;
  freq: number;
  volume: number;
  durationMs: number;
  /** 循环鸣叫时两次鸣叫的间隔（ms） */
  gapMs: number;
  repeat: boolean;
}

/** 键盘遥控：四方向键位触发（按下/松开可各发一条指令） */
export interface KeypadCard extends BaseCard {
  type: "keypad";
  sendMode: SendMode;
  /** 上/下/左/右 的键盘键位（KeyboardEvent.key） */
  keys: string[];
  labels: string[];
  /** 按下时发送的模板（按方向索引） */
  templates: string[];
  /** 松开时发送的模板（空 = 不发送） */
  releaseTemplates: string[];
  useScript: boolean;
  script: string;
}

/** 单键监控：单个键位触发 */
export interface KeymonCard extends BaseCard {
  type: "keymon";
  sendMode: SendMode;
  key: string;
  /** 按下时发送的模板 */
  template: string;
  /** 松开时发送的模板（空 = 不发送） */
  releaseTemplate: string;
  useScript: boolean;
  script: string;
}

export interface MonitorCard extends BaseCard {
  type: "monitor";
  varName: string;
  unit: string;
  decimals: number;
}

export interface JoystickCard extends BaseCard {
  type: "joystick";
  template: string;
  sendMode: SendMode;
  range: number;
  minIntervalMs: number;
  springBack: boolean;
  useScript: boolean;
  script: string;
}

/** 组合控件子项类型（v1 支持五种：滑条/按钮/开关/监视/LED） */
export type GroupChildKind = "slider" | "button" | "switch" | "monitor" | "led";

export interface GroupChild {
  id: string;
  kind: GroupChildKind;
  label: string;
  /** slider 参数 */
  min: number;
  max: number;
  step: number;
  /** slider / button 发送模板 */
  template: string;
  /** switch 两档指令：[关, 开] */
  templates: string[];
  /** switch 档位标签 */
  labels: string[];
  /** monitor / led 绑定变量 */
  varName: string;
  unit: string;
  /** led 触发条件 */
  op: LedOp;
  value: number;
  strValue: string;
  onColor: string;
}

/** 组合控件：一张卡片内集成多个子控件，共享 sendMode */
export interface GroupCard extends BaseCard {
  type: "group";
  sendMode: SendMode;
  children: GroupChild[];
}

/** 自定义卡片：保留的卡片类型，但不再承载 HTML（AI 造物统一走 v3 插件小部件）。 */
export interface CustomCard extends BaseCard {
  type: "custom";
}

/**
 * 内嵌面板卡片（schema v2）：把 2D 曲线 / Hex 数据流 / 姿态 3D 模型当控件放进画布。
 *
 * - `panelId`：内嵌目标 id（`embedPanels.ts` 的白名单）。两种形态共用这个字段：
 *   整板（plot2d/hexview）有停靠对应物，视图（attitude3d）只存在于画布。导入时未知 id 整卡丢弃；
 * - `viewState`：停靠↔内嵌切换时搬运的视图态，不参与发送（视图形态没有可搬的视野）；
 * - `minW/minH`：语义最小格数（落盘冗余存一份，便于旧版本提示与导出阅读）；
 * - `aspectLock`：拖角缩放时是否锁长宽比（视图形态默认锁，2D/Hex 默认不锁）。
 */
export interface EmbedCard extends BaseCard {
  type: "embed";
  panelId: EmbedTargetId;
  viewState?: EmbedPanelViewState;
  minW: number;
  minH: number;
  aspectLock: boolean;
}

export type ControlCard =
  | SliderCard
  | ButtonCard
  | SwitchCard
  | LedCard
  | BuzzerCard
  | MonitorCard
  | JoystickCard
  | KeypadCard
  | KeymonCard
  | GroupCard
  | CustomCard
  | EmbedCard;

export const PANEL_TYPE_NAMES: Record<ControlType, string> = {
  slider: "滑条",
  button: "按钮",
  switch: "开关",
  led: "LED 灯",
  buzzer: "蜂鸣器",
  monitor: "数值监视",
  joystick: "摇杆",
  keypad: "键盘遥控",
  keymon: "单键监控",
  group: "组合控件",
  custom: "自定义卡片",
};

const PANEL_TYPE_NAMES_EN: Record<ControlType, string> = {
  slider: "Slider",
  button: "Button",
  switch: "Switch",
  led: "LED",
  buzzer: "Buzzer",
  monitor: "Monitor",
  joystick: "Joystick",
  keypad: "Keypad",
  keymon: "Key Monitor",
  group: "Group Control",
  custom: "Custom Card",
};

export interface ControlPage {
  debugProfile?: DebugProfile;
  id: string;
  name: string;
  cols: number;
  rows: number;
  cards: ControlCard[];
  locked: boolean;
}

export interface ControlsSnapshot {
  /** 存档 schema 版本；v1 存档无此字段，读入时补成当前版本。 */
  version: number;
  pages: ControlPage[];
  activePageId: string;
}

const GROUP_KINDS: GroupChildKind[] = ["slider", "button", "switch", "monitor", "led"];

export type SliderParamField = "min" | "max" | "step" | "defaultValue";
export type SliderParamReason = "non-finite" | "step" | "order" | "range" | "grid";

/** 一次参数写入被修正了什么：UI 用它给出可见反馈，而不是静默改值。 */
export interface SliderParamFix {
  field: SliderParamField;
  from: number;
  value: number;
  reason: SliderParamReason;
  /** 组合控件子项才有 */
  childId?: string;
  childLabel?: string;
}

interface NormalizedSlider {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  fixes: SliderParamFix[];
}

const finiteNumber = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 去掉浮点尾灰：0.1 步进对齐后别出现 60.000000000000014 */
const tidy = (n: number): number => Number(n.toPrecision(12));

/**
 * 滑条参数的唯一校验出口（卡片与组合子项共用）。
 *
 * 先修步进、再修区间、最后把默认值收敛进区间并对齐到步进网格。
 * `keep` 告诉它 min/max 冲突时保留哪一侧：编辑 min 时保留 max（min 让位），
 * 编辑 max 时保留 min；导入/加载没有编辑者，按保留 max 处理。
 */
export function normalizeSliderParams(
  raw: {
    min: unknown;
    max: unknown;
    step: unknown;
    defaultValue?: unknown;
  },
  keep?: "min" | "max",
): NormalizedSlider {
  const fixes: SliderParamFix[] = [];
  let min = finiteNumber(raw.min, 0);
  let max = finiteNumber(raw.max, 100);
  let step = finiteNumber(raw.step, 1);

  if (raw.min !== undefined && !Number.isFinite(Number(raw.min)))
    fixes.push({ field: "min", from: Number(raw.min), value: min, reason: "non-finite" });
  if (raw.max !== undefined && !Number.isFinite(Number(raw.max)))
    fixes.push({ field: "max", from: Number(raw.max), value: max, reason: "non-finite" });
  if (raw.step !== undefined && !Number.isFinite(Number(raw.step)))
    fixes.push({ field: "step", from: Number(raw.step), value: step, reason: "non-finite" });

  if (step <= 0) {
    const from = step;
    step = 1;
    fixes.push({ field: "step", from, value: step, reason: "step" });
  }

  if (min > max) {
    if (keep === "min") {
      // 保留 min（用户刚编辑了 max）：把 max 抬到 min
      const from = max;
      max = min;
      fixes.push({ field: "max", from, value: max, reason: "order" });
    } else {
      // 保留 max（用户刚编辑了 min / 导入数据）：把 min 压到 max
      const from = min;
      min = max;
      fixes.push({ field: "min", from, value: min, reason: "order" });
    }
  }

  let defaultValue = min;
  if (raw.defaultValue !== undefined) {
    const rawDef = finiteNumber(raw.defaultValue, min);
    if (!Number.isFinite(Number(raw.defaultValue)))
      fixes.push({ field: "defaultValue", from: Number(raw.defaultValue), value: defaultValue, reason: "non-finite" });
    defaultValue = Math.min(max, Math.max(min, rawDef));
    if (defaultValue !== rawDef)
      fixes.push({ field: "defaultValue", from: rawDef, value: defaultValue, reason: "range" });
    const snapped = tidy(Math.min(max, Math.max(min, min + Math.round((defaultValue - min) / step) * step)));
    if (snapped !== defaultValue)
      fixes.push({ field: "defaultValue", from: defaultValue, value: snapped, reason: "grid" });
    defaultValue = snapped;
  }

  return { min, max, step, defaultValue, fixes };
}

/** 校验并规范化组合控件子项：非法 kind 丢弃、数值收敛、最多 8 个 */
export function sanitizeChildren(raw: unknown): GroupChild[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupChild[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const kind = String(r.kind ?? "") as GroupChildKind;
    if (!GROUP_KINDS.includes(kind)) continue;
    const slider = normalizeSliderParams({ min: r.min, max: r.max, step: r.step });
    out.push({
      id: String(r.id ?? crypto.randomUUID()),
      kind,
      label: String(r.label ?? GROUP_KIND_LABEL[kind]),
      min: slider.min,
      max: slider.max,
      step: slider.step,
      template: String(r.template ?? ""),
      templates: Array.isArray(r.templates)
        ? [0, 1].map((i) => String((r.templates as unknown[])[i] ?? ""))
        : ["", ""],
      labels: Array.isArray(r.labels)
        ? [0, 1].map((i) => String((r.labels as unknown[])[i] ?? ""))
        : ["", ""],
      varName: String(r.varName ?? ""),
      unit: String(r.unit ?? ""),
      op: (GROUP_OPS as string[]).includes(String(r.op)) ? (String(r.op) as LedOp) : "gt",
      value: Number(r.value ?? 0),
      strValue: String(r.strValue ?? ""),
      onColor: String(r.onColor ?? "#3fb950"),
    });
  }
  return out;
}


const GROUP_OPS: LedOp[] = ["gt", "ge", "lt", "le", "eq", "ne"];

export const GROUP_KIND_LABEL: Record<GroupChildKind, string> = {
  slider: "滑条",
  button: "按钮",
  switch: "开关",
  monitor: "监视",
  led: "LED",
};

const GROUP_KIND_LABEL_EN: Record<GroupChildKind, string> = {
  slider: "Slider",
  button: "Button",
  switch: "Switch",
  monitor: "Monitor",
  led: "LED",
};

/** 语言感知的控件类型名（UI 展示用；存储默认 label 仍走 zh 保证分享包一致） */
export function panelTypeName(t: ControlType): string {
  return getLocale() === "en" ? PANEL_TYPE_NAMES_EN[t] : PANEL_TYPE_NAMES[t];
}
export function groupKindLabel(k: GroupChildKind): string {
  return getLocale() === "en" ? GROUP_KIND_LABEL_EN[k] : GROUP_KIND_LABEL[k];
}

/** 新建一个带默认值的组合控件子项 */
export function newGroupChild(kind: GroupChildKind): GroupChild {
  return sanitizeChildren([
    {
      kind,
      label: GROUP_KIND_LABEL[kind],
      template:
        kind === "slider" ? "CMD:%.2f!" : kind === "button" ? "CMD!" : "",
      templates: kind === "switch" ? ["SW:0!", "SW:1!"] : [],
      min: 0,
      max: 100,
      step: 1,
    },
  ])[0];
}

function migrateCard(raw: Record<string, unknown>): ControlCard | null {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : undefined;
  const base = {
    managed: sanitizeManaged(raw.managed),
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? "卡片"),
    x: Math.max(0, Math.round(Number(raw.x) || 0)),
    y: Math.max(0, Math.round(Number(raw.y) || 0)),
    w: Math.max(1, Math.min(64, Math.round(Number(raw.w) || 1))),
    h: Math.max(1, Math.min(64, Math.round(Number(raw.h) || 1))),
    // 空串一律当"没有引用"：清掉引用不该留下一根指向空 id 的线
    sendTemplateId: str(raw.sendTemplateId),
    paramId: str(raw.paramId),
    // 空串/非字符串一律当"没挂命令"：不能留一根指向空 id 的失效引用
    commandId: str(raw.commandId),
  };
  const type = (raw.type ?? "slider") as CardType;
  if (type === "embed") {
    // 未知目标 id 整卡丢弃（由调用方计数告警）：不能留一张指向不存在组件的空卡。
    // 插件面板也在白名单内，id 形如 `plugin-view-<插件>:<面板>`。
    if (!isEmbedTargetId(raw.panelId)) return null;
    const panelId = raw.panelId;
    const min = embedMinOf(panelId);
    return {
      ...base,
      type: "embed",
      name: String(raw.name ?? embedName(panelId)),
      panelId,
      viewState: sanitizeEmbedViewState(panelId, raw.viewState) ?? undefined,
      minW: Math.max(min.w, Math.round(Number(raw.minW) || 0)),
      minH: Math.max(min.h, Math.round(Number(raw.minH) || 0)),
      aspectLock:
        typeof raw.aspectLock === "boolean"
          ? raw.aspectLock
          : embedAspectOf(panelId) !== undefined,
    };
  }
  switch (type) {
    case "button":
      return {
        ...base,
        type,
        template: String(raw.template ?? "CMD!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        holdRepeat: Boolean(raw.holdRepeat),
        minIntervalMs: Number(raw.minIntervalMs ?? 100),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "switch":
      return {
        ...base,
        type,
        positions: (Number(raw.positions) === 3 ? 3 : 2) as 2 | 3,
        templates: (raw.templates as string[]) ?? ["SW:1!", "SW:0!"],
        labels: (raw.labels as string[]) ?? ["开", "关"],
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        state: Number(raw.state ?? 0),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "led":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        op: (raw.op as LedOp) ?? "gt",
        value: Number(raw.value ?? 0),
        strValue: String(raw.strValue ?? ""),
        onColor: String(raw.onColor ?? "#3fb950"),
      };
    case "buzzer":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        op: (raw.op as LedOp) ?? "gt",
        value: Number(raw.value ?? 0),
        strValue: String(raw.strValue ?? ""),
        onColor: String(raw.onColor ?? "#d29922"),
        freq: Math.max(20, Math.min(20000, Number(raw.freq ?? 2000))),
        volume: Math.max(0, Math.min(100, Number(raw.volume ?? 50))),
        durationMs: Math.max(30, Math.min(5000, Number(raw.durationMs ?? 200))),
        gapMs: Math.max(30, Math.min(10000, Number(raw.gapMs ?? 300))),
        repeat: Boolean(raw.repeat),
      };
    case "keypad": {
      // 强制正方形（n×n），历史数据里被拉成长条的自动还原
      const side = Math.max(base.w, base.h);
      const sq = { ...base, w: side, h: side };
      const keys = (raw.keys as string[]) ?? [];
      const labels = (raw.labels as string[]) ?? [];
      const templates = (raw.templates as string[]) ?? [];
      const releaseTemplates = (raw.releaseTemplates as string[]) ?? [];
      const fix = (arr: string[], dflt: string[]) =>
        [0, 1, 2, 3].map((i) => String(arr[i] ?? dflt[i]));
      return {
        ...sq,
        type: "keypad",
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        keys: fix(keys, ["w", "s", "a", "d"]),
        labels: fix(labels, ["上", "下", "左", "右"]),
        templates: fix(templates, ["KEY:U!", "KEY:D!", "KEY:L!", "KEY:R!"]),
        releaseTemplates: fix(releaseTemplates, ["", "", "", ""]),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    }
    case "keymon":
      return {
        ...base,
        type,
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        key: String(raw.key ?? "b"),
        template: String(raw.template ?? "SHOT!"),
        releaseTemplate: String(raw.releaseTemplate ?? ""),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "monitor":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        unit: String(raw.unit ?? ""),
        decimals: Number(raw.decimals ?? 2),
      };
    case "joystick": {
      const side = Math.max(base.w, base.h);
      return {
        ...base,
        w: side,
        h: side,
        type,
        template: String(raw.template ?? "J:%x,%y!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        range: Number(raw.range ?? 100),
        minIntervalMs: Number(raw.minIntervalMs ?? 50),
        springBack: raw.springBack === undefined ? true : Boolean(raw.springBack),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    }
    case "group":
      return {
        ...base,
        type,
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        children: sanitizeChildren(raw.children),
      };
    case "custom":
      return { ...base, type };
    default: {
      // 滑条参数走唯一校验出口：非法值在这里被钳制，运行时只会看到合法区间。
      const slider = normalizeSliderParams({
        min: raw.min,
        max: raw.max,
        step: raw.step,
        defaultValue: raw.defaultValue ?? 50,
      });
      return {
        ...base,
        type: "slider",
        template: String(raw.template ?? "CMD:%.2f!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        min: slider.min,
        max: slider.max,
        step: slider.step,
        defaultValue: slider.defaultValue,
        sendTrigger:
          (raw.sendTrigger as "onRelease" | "continuous") ?? "onRelease",
        minIntervalMs: Number(raw.minIntervalMs ?? 50),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    }
  }
}

function migrateLegacyScript(raw: Record<string, unknown>): ControlCard | null {
  return migrateCard({
    ...raw,
    type: "button",
    useScript: true,
    script: String(raw.code ?? ""),
    template: "",
  });
}

/** 统一几何出口：类型形状约束 + 整数化 + 页边界钳制（只动位置不动形状，页缩小时才缩尺寸） */
export function normalizeGeometry(
  card: ControlCard,
  cols: number,
  rows: number,
): ControlCard {
  const c = { ...card };
  // 全字段数值防护：NaN/Infinity/负数/小数一律收敛到合法格尺寸。
  // 任何非法值穿透都会让渲染层算出 sub-cell 宽度（卡片被压成不足一格的扁条）。
  const qw = Math.round(Number(c.w));
  const qh = Math.round(Number(c.h ?? 1));
  c.w = Number.isFinite(qw) && qw >= 1 ? qw : 1;
  c.h = Number.isFinite(qh) && qh >= 1 ? qh : 1;
  if (c.type === "keypad" || c.type === "joystick") {
    const side = Math.max(c.w, c.h);
    c.w = side;
    c.h = side;
  }
  const maxW = Math.max(1, Math.round(Number(cols)) || 1);
  const maxH = Math.max(1, Math.round(Number(rows)) || 1);
  // 内嵌卡片有语义最小尺寸（2D/姿态 4×3、Hex 3×2）：保存/导入/拖角都要抬到下限，
  // 但页面本身比下限还小时只能取页面尺寸，避免卡片溢出画布。
  if (c.type === "embed") {
    const min = embedMinOf(c.panelId);
    if (min) {
      c.w = Math.max(c.w, Math.min(min.w, maxW));
      c.h = Math.max(c.h, Math.min(min.h, maxH));
    }
    // 视图形态锁宽高比：以宽度为准算高度，再按高度回推宽度。
    // 只钳一次而不是循环收敛——两次都夹在同一组上下限里，再迭代也不会变。
    const aspect = embedAspectOf(c.panelId);
    if (aspect) {
      const hFromW = Math.round(c.w / aspect);
      c.h = Math.min(Math.max(hFromW, Math.min(min.h, maxH)), maxH);
      const wFromH = Math.round(c.h * aspect);
      c.w = Math.min(Math.max(wFromH, Math.min(min.w, maxW)), maxW);
    }
  }
  if (c.w > maxW || c.h > maxH) {
    if (c.type === "keypad" || c.type === "joystick") {
      const side = Math.min(c.w, c.h, maxW, maxH);
      c.w = side;
      c.h = side;
    } else {
      c.w = Math.min(c.w, maxW);
      c.h = Math.min(c.h, maxH);
    }
  }
  const qx = Math.round(Number(c.x));
  const qy = Math.round(Number(c.y));
  c.x = Number.isFinite(qx) ? Math.max(0, Math.min(qx, maxW - c.w)) : 0;
  c.y = Number.isFinite(qy) ? Math.max(0, Math.min(qy, maxH - c.h)) : 0;
  return c;
}

function declumpCards(cards: ControlCard[], cols: number, rows: number): ControlCard[] {
  const placed: ControlCard[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some(
      (c) => !(x + w <= c.x || c.x + c.w <= x || y + h <= c.y || c.y + (c.h || 1) <= y),
    );
  const sorted = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of sorted) {
    const n = normalizeGeometry(c, cols, rows);
    const w = n.w;
    const h = n.h;
    let x = n.x;
    let y = n.y;
    let guard = 0;
    while (!free(x, y, w, h) && guard < rows * 2) {
      y++;
      if (y > rows - h) {
        y = 0;
        x = x + w > cols - w ? 0 : x + w;
      }
      guard++;
    }
    placed.push({ ...c, w, h, x: Math.max(0, x), y: Math.max(0, y) });
  }
  return placed;
}

function load(): ControlsSnapshot {
  try {
    const saved = localStorage.getItem("vs.controls");
    if (saved) {
      const parsed = JSON.parse(saved) as ControlsSnapshot;
      if (parsed.pages && parsed.pages.length) {
        return {
          version: CONTROLS_SCHEMA_VERSION,
          activePageId: parsed.activePageId,
          pages: parsed.pages.map((p) => {
            const cols = Math.max(2, Math.min(24, Math.round(Number(p.cols) || 8)));
            const rows = Math.max(2, Math.min(48, Math.round(Number((p as ControlPage).rows) || 8)));
            // 未知内嵌 panelId 在本地恢复时静默丢弃：模块求值期没有 UI 可弹告警，
            // 留一张空卡比丢卡更糟；导入路径会通过 report 把丢弃数报给用户。
            const cards = (p.cards as unknown as Record<string, unknown>[])
              .map((r) => (r.type === "script" ? migrateLegacyScript(r) : migrateCard(r)))
              .filter((c): c is ControlCard => c !== null);
            return {
              ...p,
              cols,
              rows,
              locked: Boolean(p.locked),
              debugProfile: sanitizeDebugProfile((p as ControlPage).debugProfile),
              cards: declumpCards(cards, cols, rows),
            };
          }),
        };
      }
    }
  } catch {
    localStorage.removeItem("vs.controls");
  }
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: "控制页 1",
    cols: 8,
    rows: 8,
    cards: [],
    locked: false,
  };
  return { version: CONTROLS_SCHEMA_VERSION, pages: [page], activePageId: page.id };
}

let snapshot: ControlsSnapshot = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem("vs.controls", JSON.stringify(snapshot));
  }, 250);
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snapshot;
}

export function activePage(): ControlPage | undefined {
  return (
    snapshot.pages.find((p) => p.id === snapshot.activePageId) ??
    snapshot.pages[0]
  );
}

export function setActivePage(id: string) {
  snapshot = { ...snapshot, activePageId: id };
  emit();
}

export function createDebugPage(name: string, parameters: DebugParameter[]): string {
  if (guardLocked()) throw new Error("Operator 配置已锁定 / Operator configuration is locked");
  const preset = buildDebugPreset(name, parameters);
  const names = new Set(snapshot.pages.map(p => p.name));
  let pageName = preset.name;
  for (let n = 2; names.has(pageName); n++) {
    const suffix = ` (${n})`;
    pageName = preset.name.slice(0, 24 - suffix.length) + suffix;
  }
  const page: ControlPage = {
    ...preset, id: crypto.randomUUID(), name: pageName, locked: false,
    debugProfile: { schema: DEBUG_SCHEMA, version: 1 },
  };
  const next = {
    version: CONTROLS_SCHEMA_VERSION,
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };
  // Persist before publishing so a failed write never exposes a partial creation.
  localStorage.setItem("vs.controls", JSON.stringify(next));
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  snapshot = next;
  for (const listener of listeners) {
    try { listener(); } catch { /* A committed page must still reach other subscribers. */ }
  }
  return page.id;
}

export function addPage() {
  // 与 `removePage` 对称：那条早就拦了，这条漏着
  if (guardLocked()) return;
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: `控制页 ${snapshot.pages.length + 1}`,
    cols: 12,
    rows: 12,
    cards: [],
    locked: false,
  };
  snapshot = {
    version: CONTROLS_SCHEMA_VERSION,
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };
  emit();
}

export function removePage(id: string) {
  if (guardLocked()) return;
  const pages = snapshot.pages.filter((p) => p.id !== id);
  if (!pages.length) return;
  snapshot = {
    version: CONTROLS_SCHEMA_VERSION,
    pages,
    activePageId:
      snapshot.activePageId === id ? pages[0].id : snapshot.activePageId,
  };
  emit();
}

export function importPage(
  raw: {
    name?: string;
    cols?: number;
    rows?: number;
    cards?: Record<string, unknown>[];
  },
  report?: { droppedPanels: string[] },
): string {
  if (guardLocked()) throw new Error("Operator 配置已锁定 / Operator configuration is locked");
  pushHistoryLike();
  const cards: ControlCard[] = [];
  for (const r of raw.cards ?? []) {
    const card = r.type === "script" ? migrateLegacyScript(r) : migrateCard(r);
    if (!card) {
      // 未知/越界的内嵌 panelId：丢弃并交给调用方计数，不能留空卡占位。
      report?.droppedPanels.push(String(r.panelId ?? r.type ?? "unknown"));
      continue;
    }
    cards.push(card);
  }
  const cols = clampGrid(raw.cols ?? 8, 24);
  const rows = clampGrid(raw.rows ?? 8, 48);
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: String(raw.name ?? "导入控制页").slice(0, 24),
    cols,
    rows,
    locked: false,
    debugProfile: sanitizeDebugProfile((raw as { debugProfile?: unknown }).debugProfile),
    cards: declumpCards(cards, cols, rows),
  };
  snapshot = {
    version: CONTROLS_SCHEMA_VERSION,
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };
  emit();
  return page.id;
}

export function exportPages(): ControlPage[] {
  return structuredClone(snapshot.pages);
}

function pushHistoryLike() {
  localStorage.setItem("vs.controls", JSON.stringify(snapshot));
}

export function renamePage(id: string, name: string) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, name } : p)),
  };
  emit();
}

export function setPageCols(id: string, cols: number) {
  if (guardLocked()) return;
  const nc = clampGrid(cols, 24);
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === id
        ? {
            ...p,
            cols: nc,
            cards: p.cards.map((c) => normalizeGeometry(c, nc, p.rows || 48)),
          }
        : p,
    ),
  };
  emit();
}

export function setPageRows(id: string, rows: number) {
  const nr = clampGrid(rows, 48);
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === id
        ? {
            ...p,
            rows: nr,
            cards: p.cards.map((c) => normalizeGeometry(c, p.cols, nr)),
          }
        : p,
    ),
  };
  emit();
}

function clampGrid(v: number, max: number): number {
  return Math.max(2, Math.min(max, Math.round(Number(v) || 2)));
}

export function setPageLocked(id: string, locked: boolean) {
  if (guardLocked()) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, locked } : p)),
  };
  emit();
}

export function defaultCardSize(type: ControlType): { w: number; h: number } {
  return type === "joystick"
    ? { w: 2, h: 2 }
    : type === "keypad"
      ? { w: 3, h: 3 }
      : type === "monitor"
        ? { w: 2, h: 2 }
        : type === "group"
          ? { w: 2, h: 3 }
          : type === "custom"
            ? { w: 3, h: 3 }
            : type === "slider"
              // P155-X：滑条卡内容自然高约 85px（值 19 + 滑杆 24 + 脚注 24 + 气口），
              // 2×1（60px）装不下——新卡默认 2×2；已存的 2×1 卡由 .ctl-card 的
              // container 条件收掉脚注（theme.css「滑条卡矮档」）。
              ? { w: 2, h: 2 }
              : { w: 1, h: 1 };
}

function defaultCard(type: ControlType, name: string): ControlCard {
  // 尺寸表只有一处出处（`defaultCardSize`）：P155 之前这里是同一张表抄了两份，
  // 改一处漏一处就会长出"新卡一种尺寸、拖入另一种"。
  // monitor 默认 2×2（应用图标式正方，此前 2×1 拖入即扁）；slider 2×2 见上面那条注释。
  const size = defaultCardSize(type);
  const base = {
    id: crypto.randomUUID(),
    type,
    name,
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
  };
  switch (type) {
    case "button":
      return {
        ...base,
        type,
        template: "CMD!",
        sendMode: "ascii",
        holdRepeat: false,
        minIntervalMs: 100,
        useScript: false,
        script: "",
      };
    case "switch":
      return {
        ...base,
        type,
        positions: 2,
        templates: ["SW:1!", "SW:0!"],
        labels: ["开", "关"],
        sendMode: "ascii",
        state: 0,
        useScript: false,
        script: "",
      };
    case "led":
      return {
        ...base,
        type,
        varName: "",
        op: "gt",
        value: 0,
        strValue: "",
        onColor: "#3fb950",
      };
    case "buzzer":
      return {
        ...base,
        type,
        varName: "",
        op: "gt",
        value: 0,
        strValue: "",
        onColor: "#d29922",
        freq: 2000,
        volume: 50,
        durationMs: 200,
        gapMs: 300,
        repeat: false,
      };
    case "keypad":
      return {
        ...base,
        type,
        sendMode: "ascii",
        keys: ["w", "s", "a", "d"],
        labels: ["上", "下", "左", "右"],
        templates: ["KEY:U!", "KEY:D!", "KEY:L!", "KEY:R!"],
        releaseTemplates: ["", "", "", ""],
        useScript: false,
        script: "",
      };
    case "keymon":
      return {
        ...base,
        type,
        sendMode: "ascii",
        key: "b",
        template: "SHOT!",
        releaseTemplate: "",
        useScript: false,
        script: "",
      };
    case "monitor":
      return { ...base, type, varName: "", unit: "", decimals: 2 };
    case "joystick":
      return {
        ...base,
        type,
        template: "J:%x,%y!",
        sendMode: "ascii",
        range: 100,
        minIntervalMs: 50,
        springBack: true,
        useScript: false,
        script: "",
      };
    case "group":
      return {
        ...base,
        type,
        sendMode: "ascii",
        children: [
          {
            id: crypto.randomUUID(),
            kind: "slider",
            label: "滑条",
            min: 0,
            max: 100,
            step: 1,
            template: "CMD:%.2f!",
            templates: ["", ""],
            labels: ["", ""],
            varName: "",
            unit: "",
            op: "gt",
            value: 0,
            strValue: "",
            onColor: "#3fb950",
          },
          {
            id: crypto.randomUUID(),
            kind: "button",
            label: "按钮",
            min: 0,
            max: 100,
            step: 1,
            template: "CMD!",
            templates: ["", ""],
            labels: ["", ""],
            varName: "",
            unit: "",
            op: "gt",
            value: 0,
            strValue: "",
            onColor: "#3fb950",
          },
        ],
      };
    case "custom":
      return { ...base, type };
    default:
      return {
        ...base,
        type: "slider",
        template: "CMD:%.2f!",
        sendMode: "ascii",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 50,
        sendTrigger: "onRelease",
        minIntervalMs: 50,
        useScript: false,
        script: "",
      };
  }
}

export function addCard(pageId: string, type: ControlType = "slider"): string {
  // 加一张卡就是加一条能上线的字节：只读包里不放行（返回空串，调用方据此不往下写）
  if (guardLocked()) return "";
  // 内嵌面板走 addEmbedCard（需要 panelId / 最小格数 / 互斥校验），不接受这条通用入口。
  if ((type as string) === "embed") return "";
  const page = snapshot.pages.find((p) => p.id === pageId);
  const card = defaultCard(type, `${type}_${(page?.cards.length ?? 0) + 1}`);
  if (page) {
    const pos = findFlowPos(page, card.w, card.h);
    card.x = pos.x;
    card.y = pos.y;
  }
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId ? { ...p, cards: [...p.cards, card] } : p,
    ),
  };
  emit();
  return card.id;
}

export type EmbedAddResult =
  | { ok: true; cardId: string }
  | {
      ok: false;
      reason:
        | "locked"
        | "unknown-panel"
        | "page-missing"
        | "duplicate"
        | "page-too-small"
        | "no-space";
    };

/**
 * 画布自身约束的干跑：白名单、重复、最小格数、空位，均不写状态。
 * `addEmbedCard` 与 `canAddEmbedCard` 共用同一份判断，避免"预览能放、落下却说没空位"。
 *
 * 这里只校验画布自身约束；"是否已停靠在 dock" 属于跨形态互斥，
 * 放在 panelPlacement.ts，避免 store 反向依赖面板层。
 */
function checkEmbedPlacement(
  pageId: string,
  panelId: string,
):
  | { ok: true; pos: { x: number; y: number }; min: { w: number; h: number } }
  | { ok: false; reason: Exclude<EmbedAddResult, { ok: true }>["reason"] } {
  if (!isEmbedTargetId(panelId)) return { ok: false, reason: "unknown-panel" };
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, reason: "page-missing" };
  if (findEmbedCard(panelId)) return { ok: false, reason: "duplicate" };
  const min = embedMinOf(panelId);
  const rows = page.rows || 48;
  if (page.cols < min.w || rows < min.h) return { ok: false, reason: "page-too-small" };
  const pos = findFlowPos(page, min.w, min.h);
  // findFlowPos 在排不下时返回 y=rows；用它判定"超额"，不引入第二套扫描。
  if (pos.y + min.h > rows) return { ok: false, reason: "no-space" };
  return { ok: true, pos, min };
}

/** 只校验不落库：双向切换先干跑，避免"关了停靠才发现画布放不下"。 */
export function canAddEmbedCard(pageId: string, panelId: string): EmbedAddResult {
  if (guardLocked()) return { ok: false, reason: "locked" };
  const r = checkEmbedPlacement(pageId, panelId);
  return r.ok ? { ok: true, cardId: "" } : r;
}

/**
 * 往画布放一张内嵌面板卡。返回结构化原因而不是空串——调用方要据此给用户
 * "已停靠/已在画布/画布装不下"的具体提示，不能只在控制台里静默失败。
 */
export function addEmbedCard(
  pageId: string,
  panelId: string,
  viewState?: EmbedPanelViewState | null,
  /** 卡片默认名。插件面板传面板标题；静态白名单缺省用 `embedName()`。 */
  name?: string,
): EmbedAddResult {
  if (guardLocked()) return { ok: false, reason: "locked" };
  const checked = checkEmbedPlacement(pageId, panelId);
  if (!checked.ok) return checked;
  const { pos, min } = checked;
  // 旧存档/坏数据不进卡：宁可回到默认视野，也不让 NaN 把 uPlot 弄白。
  const view = sanitizeEmbedViewState(panelId as EmbedTargetId, viewState);
  const card: EmbedCard = {
    id: crypto.randomUUID(),
    type: "embed",
    name: name?.trim() || embedName(panelId as EmbedTargetId),
    x: pos.x,
    y: pos.y,
    w: min.w,
    h: min.h,
    panelId: panelId as EmbedTargetId,
    minW: min.w,
    minH: min.h,
    aspectLock: embedAspectOf(panelId as EmbedTargetId) !== undefined,
    ...(view ? { viewState: view } : {}),
  };
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId ? { ...p, cards: [...p.cards, card] } : p,
    ),
  };
  emit();
  return { ok: true, cardId: card.id };
}

/** 跨页查找内嵌实例：单实例互斥要求同一面板全局只有一张卡。 */
export function findEmbedCard(
  panelId: string,
): { pageId: string; card: EmbedCard } | null {
  for (const page of snapshot.pages) {
    for (const card of page.cards) {
      if (card.type === "embed" && card.panelId === panelId) {
        return { pageId: page.id, card };
      }
    }
  }
  return null;
}

/**
 * 全应用该内嵌目标出现过几张卡。
 * 视图形态靠它钉同屏上限（整板有停靠互斥，通常也只会有一张）。
 */
export function countEmbedCards(panelId: string): number {
  let n = 0;
  for (const page of snapshot.pages) {
    for (const card of page.cards) {
      if (card.type === "embed" && card.panelId === panelId) n++;
    }
  }
  return n;
}

/** 导入文件版本检查；返回用户可读错误，null = 可导入（含无版本字段的 v1）。 */
export function checkControlsVersion(version: unknown): string | null {
  const v = Number(version);
  if (!Number.isFinite(v)) return null;
  if (v <= CONTROLS_SCHEMA_VERSION) return null;
  return getLocale() === "en"
    ? `This canvas file uses schema v${v}, but this app supports up to v${CONTROLS_SCHEMA_VERSION}. Update the app before importing.`
    : `控制画布文件版本为 v${v}，当前应用最高支持 v${CONTROLS_SCHEMA_VERSION}，请更新应用后再导入。`;
}

/** 流式排布：从左上角起按行扫描（行优先），返回第一个能容纳 w×h 的空位 */
export function findFlowPos(
  page: Pick<ControlPage, "cards" | "cols" | "rows">,
  w: number,
  h: number,
): { x: number; y: number } {
  const rows = page.rows || 48;
  const cols = page.cols;
  const occupied = (x: number, y: number) =>
    page.cards.some(
      (c) =>
        !(
          x + w <= c.x ||
          c.x + (c.w || 1) <= x ||
          y + h <= c.y ||
          c.y + (c.h || 1) <= y
        ),
    );
  for (let y = 0; y <= rows - h; y++) {
    for (let x = 0; x <= cols - w; x++) {
      if (!occupied(x, y)) return { x, y };
    }
  }
  // 画布放不下：追加到底部（用户可扩行或手动调整）
  return { x: 0, y: rows };
}

/**
 * 只读锁下仍然允许写的字段：**卡片自己的运行态**。
 *
 * `state` 是开关卡当前拨到哪一档——操作员在只读包里翻开关是他的本职，
 * 与 `sendStore.reserveSeq` 同一个判断（锁拦"改配置"，不拦"用"）。
 * 整函数一把加锁的症状很具体：只读发行包里的开关卡点不动。
 *
 * `defaultValue` 故意**不在**这张名单里：它是"下次开机滑条停在哪"的配置；
 * 操作员拖动滑条的即时值住在 ControlCanvas 的 valuesRef 里，不经过 store，
 * 所以拦掉它不影响发送，只影响"记住上次位置"——那本来就该是编辑态的事。
 */
const RUNTIME_CARD_KEYS = new Set(["state"]);

export interface PatchCardResult {
  /** 本次写入被校验钳制的滑条参数（卡片与组合子项），空数组表示原样落库。 */
  sliderFixes: SliderParamFix[];
}

/** 对比"想写的参数"与"规范化后的结果"，把修正项捞出来给 UI 提示。 */
function collectSliderFixes(
  before: ControlCard,
  after: ControlCard,
  patch: Record<string, unknown>,
  out: SliderParamFix[],
): void {
  if (
    before.type === "slider" &&
    after.type === "slider" &&
    ["min", "max", "step", "defaultValue"].some((k) => k in patch)
  ) {
    const editedMin = "min" in patch && !("max" in patch);
    const editedMax = "max" in patch && !("min" in patch);
    const n = normalizeSliderParams(
      {
        min: "min" in patch ? patch.min : before.min,
        max: "max" in patch ? patch.max : before.max,
        step: "step" in patch ? patch.step : before.step,
        defaultValue: "defaultValue" in patch ? patch.defaultValue : before.defaultValue,
      },
      editedMin ? "max" : editedMax ? "min" : undefined,
    );
    out.push(...n.fixes);
  }

  // 组合子项的 min/max/step 也走同一套规则：编辑子项范围时同样要看得见修正。
  if (before.type === "group" && after.type === "group" && Array.isArray(patch.children)) {
    const rawById = new Map<string, Record<string, unknown>>();
    for (const raw of patch.children) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id === "string") rawById.set(r.id, r);
    }
    for (const child of after.children) {
      const r = rawById.get(child.id);
      if (!r) continue;
      const editedMin = "min" in r && !("max" in r);
      const editedMax = "max" in r && !("min" in r);
      const n = normalizeSliderParams(
        { min: r.min, max: r.max, step: r.step },
        editedMin ? "max" : editedMax ? "min" : undefined,
      );
      out.push(...n.fixes.map((f) => ({ ...f, childId: child.id, childLabel: child.label })));
    }
  }
}

export function patchCard(
  pageId: string,
  cardId: string,
  patch: Record<string, unknown>,
): PatchCardResult {
  // P121-F：按字段拆。混进任何一个配置字段就整份拒绝（不做"半生效"——
  // 一半生效的写入比整份失败更难解释，也没法撤销）。
  if (guardLocked() && Object.keys(patch).some((k) => !RUNTIME_CARD_KEYS.has(k)))
    return { sliderFixes: [] };
  const sliderFixes: SliderParamFix[] = [];
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            cards: p.cards.map((c) => {
              if (c.id !== cardId) return c;
              // managed 元数据 fail-closed：现有标记不可被 patch 清除/伪造，
              // role/paramId/schema/type 一律锁定，防止被改成普通可执行控件。
              if (c.managed) {
                if ("managed" in patch) {
                  const raw = patch.managed as Record<string, unknown> | null | undefined;
                  const next = sanitizeManaged(patch.managed);
                  if (
                    !next ||
                    next.role !== c.managed.role ||
                    next.paramId !== c.managed.paramId ||
                    (raw && typeof raw === "object" ? raw.schema : DEBUG_SCHEMA) !== c.managed.schema
                  )
                    throw new Error("managed 元数据不可通过 patchCard 修改 / Managed metadata cannot be patched");
                }
                if ("type" in patch && patch.type !== c.type)
                  throw new Error("managed 卡片类型不可修改 / Managed card type cannot be changed");
              }
              const merged = migrateCard({ ...c, ...patch });
              // 非法的内嵌 panelId（patch 想改成白名单外）整卡保持原样，不落空卡。
              if (!merged) return c;
              collectSliderFixes(c, merged, patch, sliderFixes);
              return normalizeGeometry(merged, p.cols, p.rows || 48);
            }),
          }
        : p,
    ),
  };
  emit();
  return { sliderFixes };
}


export function removeCard(pageId: string, cardId: string) {
  if (guardLocked()) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? { ...p, cards: p.cards.filter((c) => c.id !== cardId) }
        : p,
    ),
  };
  emit();
}

export function declumpPage(pageId: string) {
  if (guardLocked()) return;
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? { ...p, cards: declumpCards(p.cards, p.cols, p.rows || 8) }
        : p,
    ),
  };
  emit();
}

/** 修复重叠：只挪动确实与其他卡片重叠的卡片（就近找空位），不动正常卡片 */
export function resolveOverlaps(pageId: string) {
  if (guardLocked()) return;
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  const cols = page.cols;
  const rows = page.rows || 8;
  const cards = page.cards.map((c) => ({ ...c }));
  const placed: ControlCard[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some(
      (c) => !(x + w <= c.x || c.x + c.w <= x || y + h <= c.y || c.y + (c.h || 1) <= y),
    );
  let changed = false;
  for (const c of cards) {
    const ch = c.h || 1;
    if (free(c.x, c.y, c.w, ch)) {
      placed.push(c);
      continue;
    }
    // 就近搜索空位（环形，半径最多撑满画布）
    let found: { x: number; y: number } | null = null;
    const maxR = Math.max(cols, rows);
    for (let r = 0; r <= maxR && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 0 || y < 0 || x + c.w > cols || y + ch > rows) continue;
          if (free(x, y, c.w, ch)) found = { x, y };
        }
      }
    }
    if (found) {
      c.x = found.x;
      c.y = found.y;
      changed = true;
    }
    placed.push(c);
  }
  if (!changed) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === pageId ? { ...p, cards } : p)),
  };
  emit();
}

export function moveCard(
  pageId: string,
  cardId: string,
  x: number,
  y: number,
) {
  if (guardLocked()) return;
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  const card = page.cards.find((c) => c.id === cardId);
  if (!card) return;
  const ch = card.h || 1;
  const maxX = Math.max(0, page.cols - card.w);
  const maxY = Math.max(0, (page.rows || 48) - ch);
  const cx = Math.max(0, Math.min(x, maxX));
  const cy = Math.max(0, Math.min(y, maxY));
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            cards: p.cards.map((c) =>
              c.id === cardId ? { ...c, x: cx, y: cy } : c,
            ),
          }
        : p,
    ),
  };
  emit();
}

export function findCardByName(
  name: string,
): { pageId: string; card: ControlCard } | null {
  for (const p of snapshot.pages) {
    const c = p.cards.find((x) => x.name === name);
    if (c) return { pageId: p.id, card: c };
  }
  return null;
}

let clipboard: ControlCard | null = null;

export function copyCard(pageId: string, cardId: string) {
  const page = snapshot.pages.find((p) => p.id === pageId);
  const card = page?.cards.find((c) => c.id === cardId);
  // 内嵌卡没有"再放一张"的语义：同一 panelId 全局单实例，复制出来的卡粘贴时必被拒。
  // 与其让「粘贴」亮着却永远失败，不如剪贴板里根本不装它。
  if (card && card.type !== "embed") clipboard = structuredClone(card);
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/** 粘贴卡片：全属性复制，新 id，名字自动 _1/_2；gx/gy 为期望左上格坐标，被占则就近找空位 */
export function pasteCard(
  pageId: string,
  gx?: number,
  gy?: number,
): string | null {
  // 只读包下不允许落卡；内嵌卡在 copyCard 已拦一次，这里再兜一层
  // （剪贴板可能来自旧版本会话或其它写入入口）。
  if (guardLocked() || !clipboard || clipboard.type === "embed") return null;
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const rows = page.rows || 48;
  const card = normalizeGeometry(
    structuredClone(clipboard),
    page.cols,
    rows,
  );
  card.id = crypto.randomUUID();
  const base = card.name.replace(/_\d+$/, "") || card.name;
  const used = new Set(page.cards.map((c) => c.name));
  let i = 1;
  while (used.has(`${base}_${i}`)) i++;
  card.name = `${base}_${i}`;
  const tx = Math.max(0, Math.min(Math.round(gx ?? 0), page.cols - card.w));
  const ty = Math.max(0, Math.min(Math.round(gy ?? 0), rows - card.h));
  const freeAt = (x: number, y: number) =>
    !page.cards.some(
      (c) =>
        !(
          x + card.w <= c.x ||
          c.x + c.w <= x ||
          y + card.h <= c.y ||
          c.y + c.h <= y
        ),
    );
  let pos = { x: tx, y: ty };
  if (!freeAt(tx, ty)) {
    let found: { x: number; y: number } | null = null;
    const maxR = Math.max(page.cols, rows);
    for (let r = 0; r <= maxR && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x + card.w > page.cols || y + card.h > rows)
            continue;
          if (freeAt(x, y)) found = { x, y };
        }
      }
    }
    if (found) pos = found;
  }
  card.x = pos.x;
  card.y = pos.y;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId ? { ...p, cards: [...p.cards, card] } : p,
    ),
  };
  emit();
  return card.id;
}

export function findCardById(
  cardId: string,
): { pageId: string; card: ControlCard } | null {
  for (const p of snapshot.pages) {
    const c = p.cards.find((x) => x.id === cardId);
    if (c) return { pageId: p.id, card: c };
  }
  return null;
}

export function formatTemplate(
  tpl: string,
  value: number,
  mode: SendMode,
): string {
  if (mode === "hex") {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
    return tpl.replace(/%%/g, hex);
  }
  return tpl
    .replace(
      /%(\d+)?(?:\.(\d+))?([fd])/g,
      (_m: string, _w: string, prec: string, type: string) => {
        if (type === "d") return String(Math.round(value));
        const p = prec === undefined ? 6 : parseInt(prec, 10);
        return value.toFixed(Math.min(p, 12));
      },
    )
    .replace(/%%/g, "%");
}

export function formatJoy(
  tpl: string,
  x: number,
  y: number,
  mode: SendMode,
): string {
  const f = (v: number) => String(Number(v.toFixed(2)));
  if (mode === "hex") {
    const enc = (v: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, v, true);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
    };
    return tpl.replace(/%x/g, enc(x)).replace(/%y/g, enc(y));
  }
  return tpl.replace(/%x/g, f(x)).replace(/%y/g, f(y));
}
