/**
 * P91 C1：3D 面板"什么都不显示"的归因器（纯函数）。
 *
 * 为什么要它：P87b/P88/P90-D 六次修复都靠静态推断，全部命中在几何层而症状零变化——
 * 因为真因在**可见性门控**（游标截断、模式、上限、校准接管、绑定缺失），而这些路径
 * 一个日志都不出。用户当时的原话是"什么都不显示且无日志"。
 * 从此以后：画面为空必须当场说清是哪一条、并给一键补救。
 */

export const REMEDY_ACTIONS = [
  "clear-cursor", "bind-channel", "raise-max-points", "show-group", "exit-calib", "start-data",
] as const;
export type RemedyAction = (typeof REMEDY_ACTIONS)[number];

/** 补救按钮文案的唯一来源（中英成对，避免渲染侧再写一条回退三元链——那条链正是"组设置"标签的出处） */
export const REMEDY_LABEL: Record<RemedyAction, [zh: string, en: string]> = {
  "clear-cursor": ["回到最新", "To latest"],
  "show-group": ["全部显示", "Show all"],
  "exit-calib": ["退出校准", "Exit calibration"],
  "raise-max-points": ["放开点数上限", "Remove point cap"],
  "bind-channel": ["选通道", "Bind channels"],
  "start-data": ["启动演示源", "Start demo source"],
};

/** 需要"哪一组"才能执行的动作（缺 gid 时必须出声，不能静默什么都不做） */
const REMEDY_NEEDS_GID: readonly RemedyAction[] = ["raise-max-points", "bind-channel"];

/**
 * 提示阶段：`start` = 还没开始画（画布中央给引导卡）；`blocked` = 已经在画但被什么挡住
 * （底部一行条）。**引导与诊断从此同源**：旧实现中央卡看 `anyBound`（只查 X/Y）、底部条看
 * `whyEmpty`（还查 Z/数据/游标），两个条件不等价 ⇒ 未绑齐时两张卡说同一句话。
 */
export type DiagStage = "none" | "start" | "blocked";
const DIAG_STAGE: Record<EmptyDiagnosis["code"], DiagStage> = {
  ok: "none",
  "no-binding": "start",
  "no-source": "start",
  "panel-hidden": "blocked",
  "calib-takeover": "blocked",
  "pairing-skipped": "blocked",
  "cursor-before-window": "blocked",
  "max-points-trimmed": "blocked",
  "point-mode-no-latest": "blocked",
  "all-groups-hidden": "blocked",
};
export function diagStage(code: EmptyDiagnosis["code"]): DiagStage {
  return DIAG_STAGE[code] ?? "blocked";
}

export interface GroupDiag {
  id: string;
  name: string;
  visible: boolean;
  mode: "line" | "points" | "point";
  /** 缺哪根轴绑定（null=三轴齐） */
  missingAxis: "x" | "y" | "z" | null;
  /** 绑定的通道里有没有数据 */
  hasSource: boolean;
  /** 配对统计（泵侧真实计数） */
  paired: number;
  skipped: number;
  /** 尾缓冲点数与游标截断后可见点数 */
  tailCount: number;
  tailVisible: number;
  /** 尾缓冲起点（秒，相对时间原点）；无点为 null */
  windowStartSec: number | null;
  overviewCount: number;
  cursorSec: number | null;
  maxPoints: number;
  markerKind: string;
  hasLatest: boolean;
}

export interface DiagnoseInput {
  groups: GroupDiag[];
  calibOn: boolean;
  /** 面板是否在视口内（IntersectionObserver 关掉渲染时画面本就空） */
  panelVisible: boolean;
}

export interface EmptyDiagnosis {
  code:
    | "ok"
    | "panel-hidden"
    | "calib-takeover"
    | "no-binding"
    | "no-source"
    | "pairing-skipped"
    | "cursor-before-window"
    | "max-points-trimmed"
    | "point-mode-no-latest"
    | "all-groups-hidden";
  /** 直接进画布的一句话（中文，带具体数字） */
  text: string;
  /** 补救动作；null = 无需（画面正常）或只能等数据。按钮文案一律从 `REMEDY_LABEL` 取 */
  action: RemedyAction | null;
  /** 命中的组名（多组时指明是哪一组） */
  group?: string;
  /** 命中组的 id（补救按钮直接按 id 下发，不靠名字反查） */
  gid?: string;
}

const fmt = (n: number) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? Math.round(n).toString() : n.toFixed(1)) : "—");

/**
 * 归因优先级 = 用户下一步能做什么：先说"面板没在前台"和"校准接管"这类环境态，
 * 再说"没绑通道/没数据"（要用户去操作），最后才是"游标把画面截空了"（一键可回）。
 */
export function whyEmpty(input: DiagnoseInput): EmptyDiagnosis {
  const gs = input.groups;
  if (!input.panelVisible) {
    return { code: "panel-hidden", text: "面板当前不在前台，已暂停渲染以省电；滚回画面即恢复", action: null };
  }
  if (input.calibOn) {
    return { code: "calib-takeover", text: "椭球校准模式接管了画面（只显示校准点云），退出校准即恢复轨迹", action: "exit-calib" };
  }
  const shown = gs.filter((g) => g.visible);
  if (!shown.length) {
    return { code: "all-groups-hidden", text: "三个轨迹组都被隐藏了（组托盘里点亮即可）", action: "show-group" };
  }
  // 逐组找第一条可归因的阻塞
  for (const g of shown) {
    if (g.missingAxis) {
      const label = g.missingAxis === "x" ? "X" : g.missingAxis === "y" ? "Y" : "Z";
      return {
        code: "no-binding",
        group: g.name,
        gid: g.id,
        text: `组「${g.name}」还缺 ${label} 轴绑定 —— 把字段拖到左上的组行，或点下方「选通道」`,
        action: "bind-channel",
      };
    }
    if (!g.hasSource) {
      return { code: "no-source", group: g.name, gid: g.id, text: `组「${g.name}」绑定的通道还没有数据 —— 点下方「启动演示源」，或连上设备开始采集/回放`, action: "start-data" };
    }
    if (g.paired === 0 && g.skipped > 0) {
      return {
        code: "pairing-skipped",
        group: g.name,
        gid: g.id,
        text: `组「${g.name}」${g.skipped} 个采样点因通道时间对不齐被配对跳过（组设置里换配对模式或放宽容差）`,
        action: null,
      };
    }
  }
  for (const g of shown) {
    if (g.tailVisible > 0 || g.overviewCount > 0) return { code: "ok", text: "", action: null };
  }
  for (const g of shown) {
    if (g.cursorSec !== null && g.windowStartSec !== null && g.cursorSec < g.windowStartSec) {
      return {
        code: "cursor-before-window",
        group: g.name,
        gid: g.id,
        text: `预览游标 t=${fmt(g.cursorSec)}s 早于当前保留窗口起点 t=${fmt(g.windowStartSec)}s，缓冲里 ${g.tailCount} 个点被截到 0（不是没数据）`,
        action: "clear-cursor",
      };
    }
    if (g.mode === "point") {
      if (!g.hasLatest) {
        return { code: "point-mode-no-latest", group: g.name, gid: g.id, text: `组「${g.name}」是「实时定位」模式，还没有最新点可显示`, action: null };
      }
      continue;
    }
    if (g.maxPoints > 0 && g.tailCount === 0 && g.paired > 0) {
      return {
        code: "max-points-trimmed",
        group: g.name,
        gid: g.id,
        text: `组「${g.name}」的「最大点数」=${g.maxPoints} 把缓冲挤空了（放宽或置 0 不限量）`,
        action: "raise-max-points",
      };
    }
    if (g.tailCount > 0) {
      return {
        code: "cursor-before-window",
        group: g.name,
        gid: g.id,
        text: `组「${g.name}」缓冲里有 ${g.tailCount} 个点，但游标截断后一个都不显示（当前预览位置在数据之前）`,
        action: "clear-cursor",
      };
    }
  }
  return { code: "no-source", text: "还没有可绘制的轨迹数据：绑定通道并开始采集/回放", action: "start-data" };
}

/** 补救动作的落地依赖（渲染侧注入，保持本模块是纯函数、可单测、不碰 React） */
export interface RemedyDeps {
  clearScrub: () => void;
  showAllGroups: () => void;
  exitCalib: () => void;
  raiseMaxPoints: (gid: string) => void;
  /** 打开该组的设置弹层（=「选通道」的落点） */
  openGroupDialog: (gid: string) => void;
  startDemo: () => void;
  /** 走到这里就是"有动作却没人接"——必须出声（本仓红线：静默 return 当轮补埋点） */
  unknown: (what: string) => void;
}

/**
 * 动作 → 落地。写成 `Record<RemedyAction, …>` 是刻意的：**新增动作码忘了接分支会直接编译不过**。
 * 「组设置按了没反应」的根因正是这个：action 联合扩到 6 个，而渲染侧的分发函数只写了 4 个 if 分支，
 * `bind-channel` / `start-data` 落到函数末尾静默返回。
 */
const REMEDY_HANDLERS: Record<RemedyAction, (d: RemedyDeps, gid: string) => void> = {
  "clear-cursor": (d) => d.clearScrub(),
  "show-group": (d) => d.showAllGroups(),
  "exit-calib": (d) => d.exitCalib(),
  "raise-max-points": (d, gid) => d.raiseMaxPoints(gid),
  "bind-channel": (d, gid) => d.openGroupDialog(gid),
  "start-data": (d) => d.startDemo(),
};

export function dispatchRemedy(e: EmptyDiagnosis, d: RemedyDeps): boolean {
  const a = e.action;
  if (!a) return false;
  const h = REMEDY_HANDLERS[a];
  if (!h) { d.unknown(a); return false; }
  const gid = e.gid ?? "";
  if (REMEDY_NEEDS_GID.includes(a) && !gid) { d.unknown(`${a}（缺组 id）`); return false; }
  h(d, gid);
  return true;
}
