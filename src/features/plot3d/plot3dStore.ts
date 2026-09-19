/**
 * P69 3D 轨迹面板数据泵（plot3dStore）· P87a 三组轨迹升级。
 *
 * 职责边界：
 * - 通道与数据完全复用 plotStore（共享图例通道；采集门控见 plotStore.init 的 plot3d 分支）
 * - 本模块是「消费泵」：定时取各绑定通道的**原始序列**（getChanData，未经联合
 *   对齐），交给 pairTriples.buildPairedTriples 做三轴时间戳配对（P75 B2），
 *   按组/按点密度抽稀推给 scene（sink）。不持有大缓冲——双层 LOD 在 scene 侧。
 * - P87a：轨迹从「一条」升级为「三组独立轨迹」（g1 惯导 / g2 实际 / g3 目标）。
 *   每组独立 绑定/显示模式/配对/着色/密度/撤销；组间共享通道自动去重（同通道
 *   两组件只消费一次）。校准（P71/P73）源固定 = 组1 三通道（详设 R1 O7）。
 * - 源裁剪/重建（下标语义失效）用「时间水位 lastT」逐组续传：只消费时间戳
 *   > lastT 的锚点，绝不重灌、绝不重复。
 * - 面板关闭 = setSink(null) = 停泵（用户红线：关闭了的面板绝不允许后台运行）；
 *   后台页签（浏览器把 interval 节流到 ~1Hz）仍继续喂数，切回不丢段。
 * - P87a A7：组配置撤销/重做栈（50 层，独立于模板撤销栈）；视图类
 *   （相机/跟随/网格/可见性）不入栈；清空不可撤销（数据已丢弃，如实处理）。
 */
import * as panelActivity from "../../panels/panelActivity";
import {
  timeOrigin,
  getChanData,
  getSnapshot as getPlotSnapshot,
  type Channel,
} from "../plot/plotStore";
import * as sessionStore from "../session/sessionStore";
import { guardLocked } from "../operator/lock";
import { octantCoverage, correctedRadius, fitAccelSix, ACCEL6_MIN_SAMPLES, type Accel6Face, type Accel6Result, type FitOk } from "./ellipsoidFit";
import { buildPairedTriples, ffillAt, sampleAt, type PairMode, type Series } from "./pairTriples";
import {
  IDENTITY_TRANSFORM,
  makeTransform,
  normalizeTransform,
  smoothSub as clampSub,
  smoothTension as clampTension,
  type GroupTransform,
} from "./smoothing";

// ---------- 弹性组数模型（P87e） ----------

/** P87e：组 ID 放开为字符串——旧 g1/g2/g3 保留，新组用 UUID */
export type GroupId = string;
/** 旧固定三组 ID（迁移与默认三组身份保留用；不再是类型约束） */
export const GROUP_IDS: readonly GroupId[] = ["g1", "g2", "g3"];

/** 每组显示模式：point=实时定位（只刷最新点）/ points=点集 / line=连线（详设 §7） */
export type TrajMode = "point" | "points" | "line";
/** 连线平滑：none=折线 / movingAvg=1:1 滑窗（收缩边界）/ catmullRom=向心 CR 细分（曲线过数据点）/
 *  spline=natural 三次样条（整窗 Thomas）。贝塞尔/自定义 expr 按 R3.1 延后。 */
export type TrajSmooth = "none" | "movingAvg" | "catmullRom" | "spline";

/** P87b 头部朝向源：xAxis=模型默认朝 +X；ch=航向角通道（度）；quat=四通道四元数；velocity=轨迹差分 */
export interface GroupHeading {
  src: "xAxis" | "ch" | "quat" | "velocity";
  chYaw: string;
  qX: string;
  qY: string;
  qZ: string;
  qW: string;
  /** 安装/参考系修正（度）与航向符号（北=+1 顺时针约定可翻） */
  yawOff: number;
  pitchOff: number;
  rollOff: number;
  yawSign: 1 | -1;
}

/** P87b 显示模型：内置程序化几何（X=车头约定）+ 本地 GLTF/GLB */
export interface GroupModel {
  kind: "point" | "sphere" | "arrow" | "car" | "cone" | "axes" | "gltf";
  /** gltf 文件绝对路径（本地；失效回退箭头+提示——P87b 不做远程 URL） */
  src: string;
  scale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  /** 高度偏移（真实单位，沿世界 Y） */
  heightOff: number;
}

export interface TrajGroup {
  id: GroupId;
  name: string;
  /** 组色（fixed 着色/全景/标记/图例共用同一身份色） */
  color: string;
  /** 可见性 = 视图类（Operator 放行、不入撤销栈） */
  visible: boolean;
  /** 三轴绑定通道 id；"" = 未绑定（X/Y 绑齐该组才消费；Z="" = 平面轨迹，P87b） */
  chX: string;
  chY: string;
  chZ: string;
  mode: TrajMode;
  /** 点径（gl_PointSize px；points/point 模式与 line.showDots 用） */
  pointSize: number;
  /** 透明度（作用于渐隐混合权重：0.05~1） */
  opacity: number;
  /** 连线模式叠画顶点（旧 style="line+points" 的迁移归宿） */
  showDots: boolean;
  /** 保留点数上限（0 = 不限，走 LOD 内建 22 万）；超限从最老端丢弃 */
  maxPoints: number;
  /** 着色：time=turbo 按会话时间 / ch=turbo 按指定通道值域 / fixed=组色实色 */
  colorBy: "time" | "ch" | "fixed";
  colorCh: string;
  /** 渐隐窗口（秒）；0 = 全程渐变 */
  fade: 10 | 60 | 300 | 0;
  /** 点密度：追加期 stride 抽稀（高=1:1 / 中=1:2 / 低=1:4）；变更触发该组重灌 */
  density: "high" | "mid" | "low";
  smooth: TrajSmooth;
  /** 滑动平均窗口（奇数 3~51；movingAvg 用） */
  smoothWin: number;
  /** 细分段顶点数（2~10；catmullRom/spline 用） */
  smoothSub: number;
  /** CR 张力（0=直线 1=全曲率） */
  smoothTension: number;
  /** 方向箭头：每 N 个尾窗点一支（0=关；line 模式） */
  arrowEvery: number;
  /** 起点标记（line/points） */
  showStartEnd: boolean;
  heading: GroupHeading;
  model: GroupModel;
  transform: GroupTransform;
  pairMode: PairMode;
  pairTolMs: number;
  /** AI 结论/人工备注回填处（P87c 分析包 meta.json 收录） */
  notes: string;
}

export interface Plot3DSettings {
  v: 3;
  groups: TrajGroup[];
  /** 校准采样源（P87e：不再绑死 g1；null = 未选源——校准禁用，不自动换源） */
  calibSrc: GroupId | null;
  /** 展示用自动旋转 */
  autoRotate: boolean;
  /** 跟随模式：target 平滑锁定最新点（与 autoRotate 互斥，开关联动） */
  follow: boolean;
  /** 网格与坐标轴 */
  showGrid: boolean;
  /** 网格密度：fine=步长×0.5（更密）/ std=自适应 / coarse=步长×2（更疏） */
  gridDensity: "fine" | "std" | "coarse";
  /** 键盘飞行（P72）：WASD 平移 / QE 升降 / 方向键旋转 / F 跟随 / R 重置（悬停画布时生效） */
  keyFlight: boolean;
  /** 滚轮缩放到光标（P72）：关闭时绕视线中心缩放（OrbitControls 默认） */
  zoomToCursor: boolean;
  /** 椭球校准模式（P71，操作态）：轨迹隐藏，切换为点云采样+拟合；与 autoRotate/follow 互斥。
   *  **操作态**（P74c B4）：不落盘、不进 Operator 包、面板关闭即退出。采样源=组1。 */
  calibMode: boolean;
  /** 三轴缩放（scene 归一化）：uniform=等比（真实比例，默认）/ perAxis=逐轴撑满视锥（扁平数据查看用） */
  axisScale: "uniform" | "perAxis";
}

const SETTINGS_KEY = "vs.plot3d.settings";
const UNDO_CAP = 50;

function defaultGroup(idx: number, id?: GroupId): TrajGroup {
  const color = ["#4e9cef", "#4caf50", "#e8a13c"][idx] ?? "#4e9cef";
  return {
    id: id ?? GROUP_IDS[idx] ?? "g1",
    name: `G${idx + 1}`,
    color,
    visible: true,
    chX: "",
    chY: "",
    chZ: "",
    mode: "line",
    pointSize: 3,
    opacity: 1,
    showDots: true,
    maxPoints: 0,
    colorBy: "time",
    colorCh: "",
    fade: 60,
    density: "high",
    smooth: "none",
    smoothWin: 5,
    smoothSub: 4,
    smoothTension: 0.5,
    arrowEvery: 0,
    showStartEnd: false,
    heading: { src: "xAxis", chYaw: "", qX: "", qY: "", qZ: "", qW: "", yawOff: 0, pitchOff: 0, rollOff: 0, yawSign: 1 },
    model: { kind: "point", src: "", scale: 1, rotX: 0, rotY: 0, rotZ: 0, heightOff: 0 },
    transform: { ...IDENTITY_TRANSFORM },
    pairMode: "interp",
    pairTolMs: 0,
    notes: "",
  };
}

export const DEFAULT_PLOT3D_SETTINGS: Plot3DSettings = {
  v: 3,
  groups: [defaultGroup(0), defaultGroup(1), defaultGroup(2)],
  calibSrc: "g1",
  autoRotate: false,
  follow: false,
  showGrid: true,
  gridDensity: "std",
  keyFlight: false,
  zoomToCursor: false,
  calibMode: false,
  axisScale: "uniform",
};

const clampNum = (v: unknown, lo: number, hi: number, fb: number): number =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;

const fin = (v: unknown, fb: number) =>
  typeof v === "number" && isFinite(v) ? v : fb;

function normalizeHeading(q: unknown): GroupHeading {
  const p = (typeof q === "object" && q !== null ? q : {}) as Partial<GroupHeading>;
  return {
    src:
      p.src === "ch" || p.src === "quat" || p.src === "velocity" || p.src === "xAxis"
        ? p.src
        : "xAxis",
    chYaw: typeof p.chYaw === "string" ? p.chYaw : "",
    qX: typeof p.qX === "string" ? p.qX : "",
    qY: typeof p.qY === "string" ? p.qY : "",
    qZ: typeof p.qZ === "string" ? p.qZ : "",
    qW: typeof p.qW === "string" ? p.qW : "",
    yawOff: fin(p.yawOff, 0) % 360,
    pitchOff: Math.max(-90, Math.min(90, fin(p.pitchOff, 0))),
    rollOff: Math.max(-180, Math.min(180, fin(p.rollOff, 0))),
    yawSign: p.yawSign === -1 ? -1 : 1,
  };
}

function normalizeModel(q: unknown): GroupModel {
  const p = (typeof q === "object" && q !== null ? q : {}) as Partial<GroupModel>;
  return {
    kind:
      p.kind === "sphere" || p.kind === "arrow" || p.kind === "car" || p.kind === "cone" ||
      p.kind === "axes" || p.kind === "gltf" || p.kind === "point"
        ? p.kind
        : "point",
    src: typeof p.src === "string" ? p.src.slice(0, 500) : "",
    scale: clampNum(p.scale, 0.02, 100, 1),
    rotX: fin(p.rotX, 0) % 360,
    rotY: fin(p.rotY, 0) % 360,
    rotZ: fin(p.rotZ, 0) % 360,
    heightOff: clampNum(p.heightOff, -1e9, 1e9, 0),
  };
}

/** 单组归一化（字段级容错，非法回退默认）；v3 输入的合法字符串 ID 原样保留 */
const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function normalizeGroup(q: unknown, idx: number, keepId = false): TrajGroup {
  const d = defaultGroup(idx);
  if (typeof q !== "object" || q === null) return d;
  const p = q as Partial<TrajGroup>;
  const g: TrajGroup = {
    ...d,
    // P87e：v3 输入携带合法 ID 则保留（UUID 身份）；v2 时代输入一律按位置分配
    id: keepId && typeof p.id === "string" && GROUP_ID_RE.test(p.id) ? p.id : d.id,
    name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 40) : d.name,
    color: typeof p.color === "string" && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : d.color,
    visible: p.visible !== false,
    chX: typeof p.chX === "string" ? p.chX : "",
    chY: typeof p.chY === "string" ? p.chY : "",
    chZ: typeof p.chZ === "string" ? p.chZ : "",
    mode: p.mode === "point" || p.mode === "points" || p.mode === "line" ? p.mode : d.mode,
    pointSize: clampNum(p.pointSize, 1, 32, d.pointSize),
    opacity: clampNum(p.opacity, 0.05, 1, d.opacity),
    showDots: p.showDots !== false,
    maxPoints:
      typeof p.maxPoints === "number" && isFinite(p.maxPoints) && p.maxPoints > 0
        ? Math.min(2_000_000, Math.round(p.maxPoints))
        : 0,
    colorBy: p.colorBy === "ch" ? "ch" : p.colorBy === "fixed" ? "fixed" : "time",
    colorCh: typeof p.colorCh === "string" ? p.colorCh : "",
    fade: (p.fade === 10 || p.fade === 60 || p.fade === 300 || p.fade === 0
      ? p.fade
      : d.fade) as TrajGroup["fade"],
    density: p.density === "mid" || p.density === "low" ? p.density : "high",
    smooth:
      p.smooth === "movingAvg" || p.smooth === "catmullRom" || p.smooth === "spline"
        ? p.smooth
        : "none",
    smoothWin: (() => {
      const w = Math.round(clampNum(p.smoothWin, 3, 51, d.smoothWin));
      return w % 2 === 0 ? Math.min(51, w + 1) : w;
    })(),
    smoothSub: clampSub(p.smoothSub),
    smoothTension: clampTension(p.smoothTension),
    arrowEvery:
      typeof p.arrowEvery === "number" && isFinite(p.arrowEvery) && p.arrowEvery >= 10
        ? Math.min(5000, Math.round(p.arrowEvery))
        : 0,
    showStartEnd: p.showStartEnd === true,
    heading: normalizeHeading(p.heading),
    model: normalizeModel(p.model),
    transform: normalizeTransform(p.transform),
    pairMode:
      p.pairMode === "nearest" || p.pairMode === "union" || p.pairMode === "interp"
        ? p.pairMode
        : "interp",
    pairTolMs: typeof p.pairTolMs === "number" && isFinite(p.pairTolMs) && p.pairTolMs > 0 ? p.pairTolMs : 0,
    notes: typeof p.notes === "string" ? p.notes.slice(0, 2000) : "",
  };
  return g;
}

/** v1（单轨迹时代）→ v3 组1 迁移：三轴绑定/样式/着色/渐隐/密度/配对整体入组1，
 *  G2/G3 走默认空组（迁移=默认三组）；视图全局字段原位保留。style:"line+points" → line + showDots。 */
function migrateV1(q: Record<string, unknown>): Plot3DSettings {
  const g1 = defaultGroup(0);
  if (typeof q.axisX === "string") g1.chX = q.axisX;
  if (typeof q.axisY === "string") g1.chY = q.axisY;
  if (typeof q.axisZ === "string") g1.chZ = q.axisZ;
  g1.colorBy = q.colorBy === "ch" ? "ch" : "time";
  if (typeof q.colorCh === "string") g1.colorCh = q.colorCh;
  g1.fade = (q.fade === 10 || q.fade === 300 || q.fade === 0 ? q.fade : 60) as TrajGroup["fade"];
  g1.density = q.density === "mid" || q.density === "low" ? q.density : "high";
  g1.mode = q.style === "points" ? "points" : "line";
  g1.showDots = q.style !== "line" && q.style !== "points";
  if (q.pairMode === "nearest" || q.pairMode === "union" || q.pairMode === "interp")
    g1.pairMode = q.pairMode as PairMode;
  if (typeof q.pairTolMs === "number" && isFinite(q.pairTolMs) && q.pairTolMs > 0)
    g1.pairTolMs = q.pairTolMs;
  const base = normalizeSettings({ v: 3, groups: [g1, defaultGroup(1), defaultGroup(2)] });
  return {
    ...base,
    autoRotate: q.autoRotate === true,
    follow: q.follow === true,
    showGrid: q.showGrid !== false,
    gridDensity: q.gridDensity === "fine" || q.gridDensity === "coarse" ? (q.gridDensity as "fine" | "coarse") : "std",
    keyFlight: q.keyFlight === true,
    zoomToCursor: q.zoomToCursor === true,
    axisScale: q.axisScale === "perAxis" ? "perAxis" : "uniform",
  };
}

/** 部分输入 → 全量设置（容错归一化）；loadSettings 与 Operator 包导入共用。
 *  接受 v3/v2 对象与 v1 旧对象（自动迁移）；calibMode 恒 false（操作态永不恢复，P74c B4）。
 *  P87e：v3 groups 为合法数组——**不补三、不截三，显式空数组保持零组**；
 *  重复/非法组 ID 在写入前报错（不静默丢组）。 */
function normalizeSettings(p: Partial<Plot3DSettings> | Record<string, unknown> | null | undefined): Plot3DSettings {
  const q = (p ?? {}) as Record<string, unknown>;
  if (!Array.isArray(q.groups)) {
    // v2/v3 缺 groups = 视为 v1 时代输入（旧 localStorage / 旧 Operator 包）
    if ((q.v === 2 || q.v === 3) && typeof q.axisX !== "string") {
      // 显式 v2/v3 但数组缺失：仅归一化全局，组走默认三组
      const g = normalizeGroup(undefined, 0);
      return {
        v: 3,
        groups: [g, defaultGroup(1), defaultGroup(2)],
        calibSrc: "g1",
        autoRotate: q.autoRotate === true,
        follow: q.follow === true,
        showGrid: q.showGrid !== false,
        gridDensity: q.gridDensity === "fine" || q.gridDensity === "coarse" ? (q.gridDensity as "fine" | "coarse") : "std",
        keyFlight: q.keyFlight === true,
        zoomToCursor: q.zoomToCursor === true,
        calibMode: false,
        axisScale: q.axisScale === "perAxis" ? "perAxis" : "uniform",
      };
    }
    return migrateV1(q);
  }
  // P87e：v3 数组保 ID 原样（UUID 身份）；v2 时代（v=2 或组缺 id）按旧语义补齐三组
  const rawList = q.groups as unknown[];
  const rawIds = rawList.map((g) =>
    typeof g === "object" && g !== null && typeof (g as { id?: unknown }).id === "string"
      ? (g as { id: unknown }).id : null);
  const isV3 = q.v === 3;
  if (!isV3) {
    // v2 输入：不校验 ID（旧包按位置命名），截三补三保持迁移等价
    const gs2 = rawList.slice(0, 3).map((g, i) => normalizeGroup(g, i));
    while (gs2.length < 3) gs2.push(defaultGroup(gs2.length));
    const view2 = (q.follow === true) && (q.autoRotate === false);
    return {
      v: 3,
      groups: gs2,
      calibSrc: "g1",
      autoRotate: view2 ? false : q.autoRotate === true,
      follow: view2,
      showGrid: q.showGrid !== false,
      gridDensity: q.gridDensity === "fine" || q.gridDensity === "coarse" ? (q.gridDensity as "fine" | "coarse") : "std",
      keyFlight: q.keyFlight === true,
      zoomToCursor: q.zoomToCursor === true,
      calibMode: false,
      axisScale: q.axisScale === "perAxis" ? "perAxis" : "uniform",
    };
  }
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string" || !GROUP_ID_RE.test(id)) throw new Error("plot3d: invalid group id");
    if (seen.has(id)) throw new Error(`plot3d: duplicate group id ${JSON.stringify(id)}`);
    seen.add(id);
  }
  const gs = rawList.map((g, i) => normalizeGroup(g, i, true));
  const view = (q.follow === true) && (q.autoRotate === false);
  // 校准源：组内 ID 生效；显式 null = 已取消选择（不回退）；字段缺失（v2 旧包）→ 默认 g1（若组内存在）
  const calibGiven = "calibSrc" in q;
  const calibSrcIn = typeof q.calibSrc === "string" ? q.calibSrc : null;
  const calibSrc = calibSrcIn !== null
    ? gs.some((g) => g.id === calibSrcIn) ? calibSrcIn : null
    : calibGiven
      ? null
      : gs.some((g) => g.id === "g1") ? "g1" : null;
  return {
    v: 3,
    groups: gs,
    calibSrc,
    autoRotate: view ? false : q.autoRotate === true,
    follow: view,
    showGrid: q.showGrid !== false,
    gridDensity: q.gridDensity === "fine" || q.gridDensity === "coarse" ? (q.gridDensity as "fine" | "coarse") : "std",
    keyFlight: q.keyFlight === true,
    zoomToCursor: q.zoomToCursor === true,
    // 操作态：永不从存储/Operator 包恢复（P74c B4）。进入校准必须由用户显式动作触发。
    calibMode: false,
    axisScale: q.axisScale === "perAxis" ? "perAxis" : "uniform",
  };
}

function loadSettings(): Plot3DSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return normalizeSettings(null);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Preserve the exact legacy payload before any later persist upgrades it to v3.
    if (parsed?.v !== 3 && localStorage.getItem(`${SETTINGS_KEY}.pre-v3`) === null)
      localStorage.setItem(`${SETTINGS_KEY}.pre-v3`, raw);
    return normalizeSettings(parsed);
  } catch {
    // P87e：损坏存储（含 v3 非法组 ID）→ 不静默丢数据，落默认并保留原串排障
    try { localStorage.setItem(`${SETTINGS_KEY}.corrupt`, localStorage.getItem(SETTINGS_KEY) ?? ""); } catch { /* ignore */ }
    return normalizeSettings(null);
  }
}

let settings: Plot3DSettings = loadSettings();
const listeners = new Set<() => void>();
let snapshot: { settings: Plot3DSettings; canUndo: boolean; canRedo: boolean } = {
  settings,
  canUndo: false,
  canRedo: false,
};

/** 组配置快照（撤销栈单元）：groups + axisScale + calibSrc（数据口径类）；视图/操作态不入栈 */
type CfgSnap = { groups: TrajGroup[]; axisScale: "uniform" | "perAxis"; calibSrc: GroupId | null };
const cloneCfg = (): CfgSnap => ({
  // 深拷贝嵌套对象（heading/model/transform），P87e 数组化后撤销恢复原 ID 必须独立于当前引用
  groups: settings.groups.map((g) => ({
    ...g,
    heading: { ...g.heading },
    model: { ...g.model },
    transform: { ...g.transform },
  })),
  axisScale: settings.axisScale,
  calibSrc: settings.calibSrc,
});
let undoStack: CfgSnap[] = [];
let redoStack: CfgSnap[] = [];

function pushHistory() {
  undoStack.push(cloneCfg());
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack.length = 0;
}

function persist() {
  try {
    // P74c B4：calibMode 是「操作态」不是「设置」——不进 localStorage，
    // 否则重启/重开面板回来会直接落在空点云的校准模式里（与 exportSettingsForPkg 的剥离口径一致）
    const { calibMode: _operational, ...rest } = settings;
    void _operational;
    const old = localStorage.getItem(SETTINGS_KEY);
    if (old && localStorage.getItem(`${SETTINGS_KEY}.pre-v3`) === null) {
      try {
        if (JSON.parse(old)?.v !== 3) localStorage.setItem(`${SETTINGS_KEY}.pre-v3`, old);
      } catch { /* Invalid old storage is handled by loadSettings. */ }
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  } catch {
    /* 存储不可用时仅内存生效 */
  }
}

/** 面板关闭 = 退出校准模式（操作态随会话结束；导出包/落盘同样不含它） */
export function endCalibSession() {
  if (!settings.calibMode) return;
  settings = { ...settings, calibMode: false };
  emit();
}

// One reconciliation path for edits, import, undo/redo, and reset (also while closed).
const usedGroupIds = new Set(settings.groups.map((g) => g.id));
let reconciledSettings = settings;
function sourceSignature(g: TrajGroup | undefined): string {
  return g ? JSON.stringify([g.chX, g.chY, g.chZ, g.pairMode, g.pairTolMs]) : "";
}
function calibrationSignature(s: Plot3DSettings): string {
  return JSON.stringify([s.calibSrc, sourceSignature(s.groups.find((g) => g.id === s.calibSrc))]);
}
function emit() {
  const ids = new Set(settings.groups.map((g) => g.id));
  for (const id of ids) usedGroupIds.add(id);
  for (const id of gst.keys()) if (!ids.has(id)) gst.delete(id);
  for (const id of pairStats.keys()) if (!ids.has(id)) pairStats.delete(id);
  for (const g of settings.groups) {
    const prev = reconciledSettings.groups.find((old) => old.id === g.id);
    if (prev && sourceSignature(prev) !== sourceSignature(g)) {
      pairStats.delete(g.id);
      const gs = gst.get(g.id);
      if (gs) {
        gs.clearT = -Infinity;
        gs.sampledT = -Infinity;
        gs.sourceSig = sourceSignature(g);
        gs.replay = true;
      }
    }
  }
  if (clearReq) clearReq = clearReq.filter((id) => ids.has(id));
  if (calibrationSignature(reconciledSettings) !== calibrationSignature(settings)) clearCalibAll();
  reconciledSettings = settings;
  snapshot = { settings, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
  listeners.forEach((l) => l());
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

/** 撤销/重做（P87a A7）：仅组配置/三轴缩放/校准源；P87e：过 Operator 锁（锁定态撤销=越界写入）。成功返回 true */
export function undo(): boolean {
  if (guardLocked()) return false;
  const s = undoStack.pop();
  if (!s) return false;
  redoStack.push(cloneCfg());
  settings = { ...settings, ...s };
  emit();
  persist();
  return true;
}
export function redo(): boolean {
  if (guardLocked()) return false;
  const s = redoStack.pop();
  if (!s) return false;
  undoStack.push(cloneCfg());
  settings = { ...settings, ...s };
  emit();
  persist();
  return true;
}

/**
 * Operator 只读模式下仍放行的「视图 / 操作态」全局字段（P74c C1）。
 * 判定依据：只影响「怎么看 / 怎么测」，不改变部署包承诺的数据口径；
 * 其余字段属配置，锁定时拒绝改动。组级放行项只有 visible（setGroupVisible）。
 */
const VIEW_KEYS: readonly (keyof Plot3DSettings)[] = ["autoRotate", "follow", "calibMode"];

export function setSetting(patch: Partial<Plot3DSettings>) {
  // C1：配置类改动过 Operator 只读锁；视图类（自动旋转/跟随/校准）放行。
  // P87a：patch 只允许全局字段——组配置一律走 updateGroup（撤销语义集中在组层）
  const touchesConfig = Object.keys(patch).some(
    (k) => k !== "groups" && k !== "v" && !VIEW_KEYS.includes(k as keyof Plot3DSettings),
  );
  if (touchesConfig && guardLocked()) return;
  // Same validation/history/reconciliation path as setCalibSrc, including mixed patches.
  if (patch.calibSrc !== undefined && !validCalibSrc(patch.calibSrc)) return;
  const { groups: _ng, v: _nv, ...rest } = patch;
  void _ng;
  void _nv;
  let p: Partial<Plot3DSettings> = rest;
  if (p.follow === true) p = { ...p, autoRotate: false };
  if (p.autoRotate === true) p = { ...p, follow: false };
  if (p.calibMode === true) {
    // 校准模式锁定视角无意义：强制全关（详设 §5）
    p = { ...p, autoRotate: false, follow: false };
  }
  // 三轴缩放影响归一化口径 → 入撤销栈（组层数据口径类）
  if ((p.axisScale !== undefined && p.axisScale !== settings.axisScale) ||
      (p.calibSrc !== undefined && p.calibSrc !== settings.calibSrc)) pushHistory();
  settings = { ...settings, ...p };
  emit();
  persist();
}

// ---------- 组配置（P87a） ----------

/** 可见性 = 视图类：不过锁、不入栈、不触签名（scene 侧只翻 visible） */
export function setGroupVisible(gid: GroupId, visible: boolean) {
  if (!getGroup(gid)) return;
  const groups = settings.groups.map((g) => (g.id === gid ? { ...g, visible } : g));
  settings = { ...settings, groups: groups as Plot3DSettings["groups"] };
  emit();
  persist();
}

/**
 * 组配置更新（绑定/模式/显示/配对/备注）：配置类 → 过只读锁 + 一步可撤销。
 * 绑定/密度/配对/模式/平滑变化 → 泵签名变 → 该组自动重灌（plotStore 源缓冲内可回看历史）。
 */
export function updateGroup(gid: GroupId, patch: Partial<TrajGroup>) {
  if (guardLocked()) return;
  const prev = settings.groups.find((g) => g.id === gid);
  if (!prev) return; // P87e：未知/已删组直接拒绝，不回退第一组
  const idx = settings.groups.indexOf(prev);
  const clean = normalizeGroup({ ...prev, ...patch, visible: undefined }, idx);
  clean.visible = prev.visible;
  clean.id = gid;
  if (JSON.stringify(prev) === JSON.stringify(clean)) return;
  pushHistory();
  settings = { ...settings, groups: settings.groups.map((g) => (g.id === gid ? clean : g)) };
  emit();
  persist();
}

/** 拖放/下拉绑定入口：axis="color" 绑着色通道并同时把 colorBy 切到 "ch" */
export function bindGroup(
  gid: GroupId,
  axis: "x" | "y" | "z" | "color",
  chanId: string,
) {
  if (axis === "color") {
    updateGroup(gid, chanId ? { colorCh: chanId, colorBy: "ch" } : { colorBy: "fixed" });
    return;
  }
  updateGroup(gid, axis === "x" ? { chX: chanId } : axis === "y" ? { chY: chanId } : { chZ: chanId });
}

/**
 * 智能落点绑定（拖 vs-field 到组行）：优先填 X→Y→Z 空槽；三轴已齐时落点
 * 由 UI 传入 axis 精确覆盖——本函数只在「无落点列信息」时用。返回命中的轴。
 */
export function bindGroupFirstFree(gid: GroupId, chanId: string): "x" | "y" | "z" | null {
  if (guardLocked()) return null;
  const g = settings.groups.find((x) => x.id === gid);
  if (!g) return null;
  if (!g.chX) return (bindGroup(gid, "x", chanId), "x");
  if (!g.chY) return (bindGroup(gid, "y", chanId), "y");
  if (!g.chZ) return (bindGroup(gid, "z", chanId), "z");
  return null;
}

/** 恢复默认（配置类 → 过只读锁；P87a：入撤销栈，误点可一步回退） */
export function resetSettings() {
  if (guardLocked()) return;
  pushHistory();
  settings = normalizeSettings(null);
  clearCalibAll();
  clearReq = null;
  emit();
  persist();
}

// ---------- 弹性组数生命周期（P87e） ----------

const freshGroupId = (): GroupId =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });

/** 新增组（配置类 → 过锁 + 一步撤销）：追加数组尾，默认未绑定；返回稳定 gid（UUID，不复用已删 ID） */
export function addGroup(): GroupId {
  if (guardLocked()) return "";
  let gid = freshGroupId();
  // P87e：ID 永不复用（含撤销栈里已删组与历史上出现过的所有 ID）
  while (usedGroupIds.has(gid) || settings.groups.some((g) => g.id === gid)) gid = freshGroupId();
  pushHistory();
  const g = defaultGroup(settings.groups.length, gid);
  // 新组颜色避开已有组色（取默认盘未用色，用尽则回退默认盘首色）
  const used = new Set(settings.groups.map((x) => x.color));
  const free = ["#4e9cef", "#4caf50", "#e8a13c", "#b56cd6", "#42b0c8"].find((c) => !used.has(c));
  settings = { ...settings, groups: [...settings.groups, free ? { ...g, color: free } : g] };
  emit();
  persist();
  return gid;
}

/** 删除组（配置类 → 过锁 + 一步撤销；撤销恢复原 ID 与配置）。不删源通道、不回收共享虚拟通道 */
export function removeGroup(gid: GroupId): boolean {
  if (guardLocked()) return false;
  if (!settings.groups.some((g) => g.id === gid)) return false;
  pushHistory();
  const groups = settings.groups.filter((g) => g.id !== gid);
  // 校准源被删 → 置 null（不自动换源），并清采样/拟合/预览/六面全部临时态
  const srcRemoved = settings.calibSrc === gid;
  settings = { ...settings, groups, calibSrc: srcRemoved ? null : settings.calibSrc };
  // 泵状态/配对统计/待清请求由 emit() 统一清，撤销恢复配置但不恢复临时态
  emit();
  persist();
  return true;
}

/** 显式设置校准源（配置类 → 过锁 + 一步撤销）；切源清采样/拟合/预览/六面临时态 */
function validCalibSrc(gid: GroupId | null): boolean {
  return gid === null || settings.groups.some((g) => g.id === gid);
}
export function setCalibSrc(gid: GroupId | null): boolean {
  if (guardLocked() || !validCalibSrc(gid)) return false;
  if (settings.calibSrc !== gid) setSetting({ calibSrc: gid });
  return true;
}

/** 绑定通道被删除时自动解绑（同 2D 的 X 源悬空纠正语义；跨三组扫描） */
function sanitizeBinds(chans: Channel[]): boolean {
  const ok = (id: string) => id === "" || chans.some((c) => c.id === id);
  let dirty = false;
  const groups = settings.groups.map((g) => {
    let patch: Partial<TrajGroup> | null = null;
    if (!ok(g.chX)) patch = { ...(patch ?? {}), chX: "" };
    if (!ok(g.chY)) patch = { ...(patch ?? {}), chY: "" };
    if (!ok(g.chZ)) patch = { ...(patch ?? {}), chZ: "" };
    if (g.colorBy === "ch" && !ok(g.colorCh))
      patch = { ...(patch ?? {}), colorBy: "time", colorCh: "" };
    if (!patch) return g;
    dirty = true;
    return { ...g, ...patch };
  });
  if (!dirty) return false;
  settings = { ...settings, groups: groups as Plot3DSettings["groups"] };
  emit();
  persist();
  return true;
}

/** 单帧增量批次：真实工程值（已组变换、未归一化）。t 为相对秒（timeOrigin 起）。 */
export interface Plot3DBatch {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  /** 着色值（colorBy=ch 时为该通道原始值；其余模式无意义） */
  val: number[];
  /** P87b 最新点（模型标记/朝向用）：hd=航向角通道原始值(度)；q=四元数 [x,y,z,w]；
   *  pv=上一变换点（velocity 朝向差分源）。仅 point 模式携带 hd/q。 */
  latest?: {
    t: number;
    x: number;
    y: number;
    z: number;
    pv?: [number, number, number];
    hd?: number;
    q?: number[];
  };
}

/** P87a：批次按组分发；reloaded=true 时 scene 清空该组缓冲重灌 */
export interface GroupBatch {
  gid: GroupId;
  b: Plot3DBatch;
  reloaded: boolean;
}

type Sink = (entries: GroupBatch[], cursorSec: number | null) => void;
let sink: Sink | null = null;
let pumpTimer: number | null = null;

/**
 * 时间游标（P70 T2）：null = 跟随最新；数值 = 截断显示到该相对秒。全局共享
 * （三组同一条时间轴）。来源优先级（泵每 tick 裁决，单入口下发）：
 * 显式 scrub（含共享预览）> 回放时钟 > null。
 */
let scrubSec: number | null = null;

/** 显式时间预览/定位；null = 释放覆盖，恢复回放时钟或最新数据。 */
export function setScrub(sec: number | null) {
  scrubSec = sec;
}

/** 最近一次下发的游标（UI 低频读取显示用；非实时） */
export function lastCursorSec(): number | null {
  return st.lastCursor;
}

/**
 * 场景重建后强制下一拍重发游标（P74c A5）。
 * 正常情况下 pump 只在「有新数据 / 游标变化」时下发，所以静态或回放暂停时
 * 重建后的新场景拿不到游标，时间游标线会凭空消失直到有新帧。
 */
export function invalidateCursor(): void {
  st.lastCursor = null;
}

// ---------- 椭球校准采样（P71；P87a：采样源=组1）----------
// 采样缓冲与泵同源（时间水位续传）；面板关闭随 setSink(null) 丢弃（红线：关了不后台跑）

export const CALIB_CAP = 20000;

export interface CalibSnapshot {
  capturing: boolean;
  count: number;
  /** 八象限覆盖（0-8，以当前点云质心为原点） */
  coverage: number;
}

const calib = {
  capturing: false,
  pts: { x: [] as number[], y: [] as number[], z: [] as number[] },
};

export function startCalibCapture() {
  if (!calibSourceReady()) return;
  accel6Abort(); // 椭球采样与六面采集互斥（六面侧让路）
  calib.capturing = true;
}
export function stopCalibCapture() {
  calib.capturing = false;
}
/** 清空椭球采样与拟合（拟合清空连带预览缓冲失效） */
export function clearCalib() {
  calib.capturing = false;
  calib.pts.x.length = 0;
  calib.pts.y.length = 0;
  calib.pts.z.length = 0;
  setCalibFit(null);
}
/** 全清（组1 签名/面板关闭）：椭球采样+拟合+预览+六面全部复位 */
function clearCalibAll() {
  clearCalib();
  accel6Reset();
}

/** 拟合数据源（UI 直调 fitEllipsoid；只读约定，勿改写） */
export function calibPoints(): { x: number[]; y: number[]; z: number[] } {
  return calib.pts;
}

export function calibSnapshot(): CalibSnapshot {
  return {
    capturing: calib.capturing,
    count: calib.pts.x.length,
    coverage: octantCoverage(calib.pts),
  };
}

// ---------- 在线补偿预览（P73）：拟合后逐点校正幅值环形缓冲 ----------
// 预览不要求正在采样：日常姿态下 r=|W(x−offset)| 的实时平稳度即校准效果
export const PREVIEW_CAP = 1200;

const preview = {
  r: new Float32Array(PREVIEW_CAP),
  t: new Float64Array(PREVIEW_CAP),
  head: 0,
  len: 0,
};

let calibFit: FitOk | null = null;

/** 拟合结果下沉（UI 拟合成功后调；换绑定/清空/面板关闭置 null）——泵预览与 scene 显示切换共用 */
export function setCalibFit(fit: FitOk | null) {
  calibFit = fit;
  preview.head = 0; // 新基准 → 预览缓冲重来
  preview.len = 0;
}
export function getCalibFit(): FitOk | null {
  return calibFit;
}

/** 预览快照（UI 10Hz 直绘读；内部引用只读约定）；null = 无拟合 */
export function previewSnapshot(): {
  r: Float32Array;
  t: Float64Array;
  head: number;
  len: number;
  meanR: number;
} | null {
  if (!calibFit) return null;
  return { r: preview.r, t: preview.t, head: preview.head, len: preview.len, meanR: calibFit.meanR };
}

// ---------- 加计六面校准（P73）：2s 时间窗状态机（窗锚定源时间，免受系统时钟跳变影响） ----------
export const ACCEL6_WINDOW_MS = 2000;
/** 采集停滞门（C9）：collecting 期间连续 4s 没等到任何数据点 → 判 stalled 并退出，
 *  不再永久卡在「采集中」。收到样本即顺延（慢数据流只靠数据时间窗结算，不受影响） */
const ACCEL6_STALL_GRACE_MS = 4000;

const accel6 = {
  collecting: false,
  /** 正在采集的面（0..5 = +X,−X,+Y,−Y,+Z,−Z）；-1 = 空闲 */
  idx: -1,
  /** 窗起点（源 ms 域；首个累积点确定） */
  t0Src: 0,
  sum: [0, 0, 0],
  sumSq: [0, 0, 0],
  n: 0,
  faces: [null, null, null, null, null, null] as (Accel6Face | null)[],
  result: null as Accel6Result | null,
  /** 停滞判定截止（墙钟；每收到样本顺延） */
  deadline: 0,
  /** 数据流中断导致采集超时（UI 显示原因而非永久卡死） */
  stalled: false,
};

/** 开始采集某面（2s 窗自动停）；与椭球连续采样互斥（椭球侧让路） */
export function accel6StartFace(idx: number) {
  if (!Number.isInteger(idx) || idx < 0 || idx > 5 || !calibSourceReady()) return;
  calib.capturing = false;
  accel6.collecting = true;
  accel6.idx = idx;
  accel6.t0Src = 0;
  accel6.sum = [0, 0, 0];
  accel6.sumSq = [0, 0, 0];
  accel6.n = 0;
  accel6.result = null;
  accel6.stalled = false;
  accel6.deadline = Date.now() + ACCEL6_STALL_GRACE_MS;
}
export function accel6Abort() {
  accel6.collecting = false;
  accel6.idx = -1;
  accel6.stalled = false;
}
export function accel6Reset() {
  accel6Abort();
  accel6.t0Src = 0;
  accel6.sum = [0, 0, 0];
  accel6.sumSq = [0, 0, 0];
  accel6.n = 0;
  accel6.deadline = 0;
  accel6.faces = [null, null, null, null, null, null];
  accel6.result = null;
}

/** 六面齐后解算（gRef 仅影响 scale/gain 换算，offset 恒 raw 单位）；存结果并返回 */
export function accel6Solve(gRef = 1): Accel6Result {
  if (accel6.faces.some((f) => f === null)) {
    return {
      ok: false,
      reason: "六面数据不完整（需要 +X/-X/+Y/-Y/+Z/-Z 六面各采一次）",
      code: "facesIncomplete",
    };
  }
  const r = fitAccelSix(accel6.faces as Accel6Face[], gRef);
  accel6.result = r;
  return r;
}

export interface Accel6Snapshot {
  collecting: boolean;
  idx: number;
  n: number;
  faces: (Accel6Face | null)[];
  result: Accel6Result | null;
  /** 每面最少样本门（UI 提示用） */
  minSamples: number;
  /** 采集停滞超时（数据流中断，本轮作废） */
  stalled: boolean;
}

export function accel6Snapshot(): Accel6Snapshot {
  return {
    collecting: accel6.collecting,
    idx: accel6.idx,
    n: accel6.n,
    faces: accel6.faces,
    result: accel6.result,
    minSamples: ACCEL6_MIN_SAMPLES,
    stalled: accel6.stalled,
  };
}

/** 单面 2s 窗结算：mean/std → faces[idx]；n 不足交给 fitAccelSix 拒绝（单一路径） */
function finalizeAccel6Face() {
  const n = Math.max(accel6.n, 1);
  const mean: [number, number, number] = [
    accel6.sum[0] / n,
    accel6.sum[1] / n,
    accel6.sum[2] / n,
  ];
  const std: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    std[a] = Math.sqrt(Math.max(0, accel6.sumSq[a] / n - mean[a] * mean[a]));
  }
  accel6.faces[accel6.idx] = { mean, std, n: accel6.n };
  accel6.collecting = false;
  accel6.idx = -1;
}

/** 回放态探针：默认镜像 sessionStore；测试注入解耦 */
type SessionProbe = { playing: boolean; replayTsMs: number };
const defaultSessionProbe = (): SessionProbe => {
  const s = sessionStore.getSnapshot();
  return {
    playing: s.state === "playing" || s.state === "paused",
    replayTsMs: s.firstTs > 0 ? s.firstTs + s.posMs : 0,
  };
};
let sessionProbe: () => SessionProbe = defaultSessionProbe;
export function _setSessionForTest(p: (() => SessionProbe) | null) {
  sessionProbe = p ?? defaultSessionProbe;
}

/** scene 挂载时注册；卸载时传 null → 停泵（面板关闭零开销）；校准缓冲随关闭丢弃。
 *  opts.keepCalib：WebGL 重建（context lost）路径用——停泵到旧场景但保留校准
 *  采样/拟合（那是几分钟的工作量），新场景挂上后经重放标记恢复显示 */
export function setSink(cb: Sink | null, opts?: { keepCalib?: boolean }) {
  if (cb !== null && cb !== sink) {
    for (const gs of gst.values()) gs.replay = true;
    invalidateCursor();
  }
  sink = cb;
  if (cb !== null && pumpTimer === null) {
    // 与 2D/频谱同节奏：120ms 消费一次；后台页签浏览器节流到 ~1Hz 仍不丢段
    pumpTimer = setInterval(pumpOnce, 120) as unknown as number;
  } else if (cb === null && pumpTimer !== null) {
    clearInterval(pumpTimer as unknown as ReturnType<typeof setInterval>);
    pumpTimer = null;
  }
  // 清理必须独立于 timer 分支：WebGL 重建已 keepCalib 停过泵（timer=null），
  // 真关面板的第二次 setSink(null) 若只在 timer 分支里清，校准数据会跨会话残留
  if (cb === null && !opts?.keepCalib) clearCalibAll();
}

/** 全局消费状态：lastCursor = 上次下发的游标（游标去抖，变动 ≤5ms 不重复下发） */
const st = {
  lastCursor: null as number | null,
};

/** 逐组消费状态（不进 snapshot）：sig = 该组绑定/通道/密度/模式/平滑签名；
 *  lastT = 已消费时间水位（原始 ms）；ever = 该组曾有过数据（首次挂载时
 *  从未消费的组不发空 reloaded 批次——场景无物可清，纯噪声） */
interface GroupPumpState {
  sig: string;
  lastT: number;
  valCarry: number;
  ever: boolean;
  /** User clear boundary is independent of the scene's consumed watermark. */
  clearT: number;
  /** Raw source watermark: rebuilding geometry must not resample calibration. */
  sampledT: number;
  sourceSig: string;
  replay: boolean;
}
const mkPumpState = (): GroupPumpState => ({ sig: "", lastT: -Infinity, valCarry: 0, ever: false, clearT: -Infinity, sampledT: -Infinity, sourceSig: "", replay: false });
/** P87e：随组数组懒建（不在固定三上预建）；删除组即移除 */
const gst = new Map<GroupId, GroupPumpState>();
/** 幂等取组泵状态（新增组首拍/重置后懒建） */
function pumpState(gid: GroupId): GroupPumpState {
  let s = gst.get(gid);
  if (!s) {
    s = mkPumpState();
    gst.set(gid, s);
  }
  return s;
}

/**
 * 数据源注入口（P75 B2 改版）：按通道 id 取「原始序列」（各通道自己的时间戳，
 * 未做联合对齐/前向填充）。默认 plotStore.getChanData。
 */
let provider: (id: string) => Series = (id) => getChanData(id);
export function _setProviderForTest(p: (id: string) => Series) {
  provider = p;
}

/**
 * 配对诊断统计（P75 B2，P87a 逐组）：自上次重灌以来累计的配对成功/跳过数、
 * 生效容差、三轴值域。HUD 低频读取（内部引用只读约定，同 previewSnapshot）。
 */
export interface PairStatSnapshot {
  paired: number;
  skipped: number;
  /** 生效容差（毫秒；union 恒 0；无消费时 0） */
  tolMs: number;
  /** 三轴值域 [min,max]（无数据轴 = Infinity/-Infinity） */
  min: [number, number, number];
  max: [number, number, number];
}

const pairStats = new Map<GroupId, PairStatSnapshot>();
/** 幂等取组配对统计（懒建，P87e） */
function statOf(gid: GroupId): PairStatSnapshot {
  let p = pairStats.get(gid);
  if (!p) {
    p = {
      paired: 0,
      skipped: 0,
      tolMs: 0,
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    pairStats.set(gid, p);
  }
  return p;
}

export function pairSnapshot(gid: GroupId): PairStatSnapshot {
  // 已删除/未知组：返回零值快照，不复活状态（HUD 缺失统计按零显示）
  return pairStats.get(gid) ?? {
    paired: 0, skipped: 0, tolMs: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function resetPairStat(gid?: GroupId) {
  for (const [id, p] of pairStats) {
    if (gid && id !== gid) continue;
    p.paired = 0;
    p.skipped = 0;
    p.tolMs = 0;
    p.min = [Infinity, Infinity, Infinity];
    p.max = [-Infinity, -Infinity, -Infinity];
  }
}

function accumulatePairStat(
  gid: GroupId,
  r: { t: number[]; x: number[]; y: number[]; z: number[]; skipped: number; tolMs: number },
) {
  const p = statOf(gid);
  p.paired += r.t.length;
  p.skipped += r.skipped;
  if (r.tolMs > 0) p.tolMs = r.tolMs;
  const mins = [p.min[0], p.min[1], p.min[2]];
  const maxs = [p.max[0], p.max[1], p.max[2]];
  for (let i = 0; i < r.t.length; i++) {
    const vs = [r.x[i], r.y[i], r.z[i]];
    for (let a = 0; a < 3; a++) {
      if (vs[a] < mins[a]) mins[a] = vs[a];
      if (vs[a] > maxs[a]) maxs[a] = vs[a];
    }
  }
  p.min = [mins[0], mins[1], mins[2]];
  p.max = [maxs[0], maxs[1], maxs[2]];
}

export function _resetForTest() {
  gst.clear();
  pairStats.clear();
  st.lastCursor = null;
  scrubSec = null;
  sessionProbe = defaultSessionProbe;
  settings = normalizeSettings(null);
  undoStack = [];
  redoStack = [];
  usedGroupIds.clear();
  for (const g of settings.groups) usedGroupIds.add(g.id);
  reconciledSettings = settings;
  clearReq = null;
  snapshot = { settings, canUndo: false, canRedo: false };
  resetPairStat();
  clearCalibAll();
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(`${SETTINGS_KEY}.corrupt`);
    localStorage.removeItem(`${SETTINGS_KEY}.pre-v3`);
  } catch {
    /* 测试环境存储异常忽略 */
  }
}

/**
 * 清空轨迹数据（P82② → P87a 组化）：时间水位推到当前最新点——历史全部跳过、
 * 新数据从零画起；绑定与显示设置不动；校准采样/拟合/预览缓冲**不受影响**
 * （独立缓冲，校准 HUD 有自己的「清空重来」）。不传 gid = 全组。
 * 属运行类操作：不过只读锁、不入撤销栈（数据已丢弃，不可撤销——如实处理）。
 * 只推水位不清场景缓冲——调用方（UI）负责 scene.clearTrajectory；
 * 无 UI 直连的通路（AI/MCP）用 requestClearData。
 */
export function clearData(gid?: GroupId) {
  if (gid !== undefined && !getGroup(gid)) return;
  for (const g of settings.groups) {
    if (gid !== undefined && g.id !== gid) continue;
    let maxT = -Infinity;
    for (const id of [g.chX, g.chY, g.chZ]) {
      if (!id) continue;
      const s = provider(id);
      const last = s.t[s.t.length - 1];
      if (last !== undefined && last > maxT) maxT = last;
    }
    // P87e 修复：清空推水位，但**不低于**现水位——绑定通道无数据（全 -Infinity）时
    // 保持原水位，不再把 -Infinity 写回（那会让刚清掉的历史被重灌）
    const gs = pumpState(g.id);
    gs.clearT = Math.max(gs.clearT, gs.lastT, maxT);
    gs.lastT = gs.clearT;
    gs.valCarry = 0;
    resetPairStat(g.id);
  }
  emit();
}

/** AI/MCP 清空通路：下一拍泵以 reloaded 空批次下发（驱动 scene 清组缓冲），
 *  与 UI 路径同一语义（水位推进 + 场景清零 + 不可撤销）。
 *  P87e：按请求对象累积（并发多次 clear 不互相覆盖）；随组数组取当前组集 */
let clearReq: GroupId[] | null = null;
export function requestClearData(gid?: GroupId) {
  if (gid !== undefined && !getGroup(gid)) return;
  clearData(gid);
  const ids = gid ? [gid] : settings.groups.map((g) => g.id);
  clearReq = clearReq === null ? ids : [...new Set([...clearReq, ...ids])];
}

/** 全量配对（导出/对齐共用，sinceT=-Infinity 与泵严格同口径）；未绑/无源 → null */
function pairFull(g: TrajGroup) {
  if (!g.chX || !g.chY) return null;
  const xs = provider(g.chX);
  const ys = provider(g.chY);
  if (xs.t.length === 0) return null;
  const zs = g.chZ ? provider(g.chZ) : { t: xs.t, v: new Array<number>(xs.t.length).fill(0) };
  return buildPairedTriples(xs, ys, zs, {
    mode: g.pairMode,
    tolMs: g.pairTolMs,
    sinceT: -Infinity,
  });
}

/**
 * 导出一组的完整轨迹（t=相对秒；x/y/z=**经组变换**——与显示严格同源，P87b）。
 * UI 组级 CSV 导出与分析包（P87c）共用此单点真相。
 */
export function exportTriples(
  gid: GroupId,
): { t: number[]; x: number[]; y: number[]; z: number[] } | null {
  const g = getGroup(gid);
  if (!g) return null;
  const pair = pairFull(g);
  if (!pair) return null;
  const org = timeOrigin();
  const xf = makeTransform(g.transform);
  const tp: [number, number, number] = [0, 0, 0];
  const out = { t: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
  for (let i = 0; i < pair.t.length; i++) {
    xf(pair.x[i], pair.y[i], pair.z[i], tp);
    out.t.push((pair.t[i] - org) / 1000);
    out.x.push(tp[0]);
    out.y.push(tp[1]);
    out.z.push(tp[2]);
  }
  return out;
}

/**
 * 「以各组首点为共同原点」（P87b 坐标对齐快捷键）：把每组 transform 的平移量
 * 设为 −R·(scale·first)，使全部已绑组的第一个轨迹点落回世界原点——惯导
 * 「推算 vs 实际 vs 目标」起点不同的对比场景一键对齐。配置写入：单事务一步撤销。
 */
export function alignToOrigin(): boolean {
  if (guardLocked()) return false;
  pushHistory();
  const groups = settings.groups.map((g) => {
    const pair = pairFull(g);
    if (!pair || pair.t.length === 0) return g;
    const xfNoOff = makeTransform({ ...g.transform, offX: 0, offY: 0, offZ: 0 });
    const p: [number, number, number] = [0, 0, 0];
    xfNoOff(pair.x[0], pair.y[0], pair.z[0], p);
    return { ...g, transform: { ...g.transform, offX: -p[0], offY: -p[1], offZ: -p[2] } };
  });
  settings = { ...settings, groups: groups as Plot3DSettings["groups"] };
  emit();
  persist();
  return true;
}

const emptyBatch = (): Plot3DBatch => ({ t: [], x: [], y: [], z: [], val: [] });

/** 组是否可绘制（X/Y 绑齐即可；Z="" = 平面轨迹，P87b） */
export function groupBound(gid: GroupId): boolean {
  const g = settings.groups.find((x) => x.id === gid);
  return !!g && !!g.chX && !!g.chY;
}

/** 校准源三轴绑齐才就绪；平面轨迹不能作为校准点云。 */
export function calibSourceReady(): boolean {
  const g = settings.groups.find((g) => g.id === settings.calibSrc);
  return !!g && !!g.chX && !!g.chY && !!g.chZ;
}

function pumpOnce() {
  if (!sink || !panelActivity.isOpen("plot3d")) return;
  const chans = getPlotSnapshot().channels;
  sanitizeBinds(chans);
  const s = settings;

  // 六面采集停滞门（C9）：数据流中断时退出采集，UI 显示原因而不是永久「采集中」。
  // 必须排在各组消费之前——采集途中解绑组1 任一轴时该门是唯一出口
  if (accel6.collecting && Date.now() > accel6.deadline) {
    accel6.collecting = false;
    accel6.idx = -1;
    accel6.stalled = true;
  }

  const t0 = timeOrigin();
  const entries: GroupBatch[] = [];
  let endSrc = -Infinity;
  const req = clearReq;
  clearReq = null;


  for (const g of s.groups) {
    const gs = pumpState(g.id);
    const tf = g.transform;
    const sig = `${g.chX}|${g.chY}|${g.chZ}|${g.colorBy}|${g.colorCh}|${g.density}|${g.pairMode}|${g.pairTolMs}|${g.mode}|${g.smooth}|${g.smoothWin}|${tf.rotX}|${tf.rotY}|${tf.rotZ}|${tf.offX}|${tf.offY}|${tf.offZ}|${tf.scale}|${chans.map((c) => c.id).join(",")}`;
    const signatureChanged = sig !== gs.sig;
    const reloaded = signatureChanged || gs.replay || (req !== null && req.includes(g.id));
    const sourceSig = sourceSignature(g);
    if (gs.sourceSig && sourceSig !== gs.sourceSig) {
      gs.clearT = -Infinity;
      gs.sampledT = -Infinity;
    }
    gs.sourceSig = sourceSig;
    // Reconstruction replays only retained source history after the user-clear boundary.
    // A clear request alone must NOT reset the consumed watermark.
    if (signatureChanged || gs.replay) {
      gs.sig = sig;
      gs.lastT = gs.clearT;
      gs.valCarry = 0;
      resetPairStat(g.id);
    }
    gs.replay = false;
    if (!g.chX || !g.chY) {
      // X/Y 未绑齐 → 该组不消费（HUD 提示；Z 可空=平面）；曾有数据的组签名变化时通知场景清空旧轨迹
      if (reloaded && gs.ever) {
        gs.ever = false;
        entries.push({ gid: g.id, b: emptyBatch(), reloaded: true });
      }
      continue;
    }
    const xs = provider(g.chX);
    const ys = provider(g.chY);
    // P87b 平面轨迹：Z 未绑 = 恒 0 合成序列（与 X 同锚，配对恒命中）
    const zs = g.chZ ? provider(g.chZ) : { t: xs.t, v: new Array<number>(xs.t.length).fill(0) };
    if (xs.t.length === 0) {
      if (reloaded && gs.ever) {
        gs.ever = false;
        entries.push({ gid: g.id, b: emptyBatch(), reloaded: true });
      }
      continue;
    }
    const vi = g.colorBy === "ch" ? chans.findIndex((c) => c.id === g.colorCh) : -1;
    const vs = vi >= 0 ? provider(g.colorCh) : null;

    // 三轴配对（P75 B2）：X 原始时间轴为锚，Y/Z 按容差插值/最近邻；
    // union 模式 = 旧版联合前向填充逃生舱。水位 sinceT 在函数内按原始 ts 过滤。
    const pair = buildPairedTriples(xs, ys, zs, {
      mode: g.pairMode,
      tolMs: g.pairTolMs,
      sinceT: gs.lastT,
    });
    // 时间水位续传：interp/nearest 消费到 X 末锚点；union 消费到三序列原始末点。
    // 永不回退（源重建缩小防御；重灌时已置 -Infinity）。
    const sampledBefore = gs.sampledT;
    if (pair.endT > gs.lastT) gs.lastT = pair.endT;
    gs.sampledT = Math.max(gs.sampledT, pair.endT);
    accumulatePairStat(g.id, pair);

    // 源末端（游标/时间条覆盖的数据整体范围）：各组绑定通道原始末点最大值
    if (xs.t.length > 0 && xs.t[xs.t.length - 1] > endSrc) endSrc = xs.t[xs.t.length - 1];
    if (ys.t.length > 0 && ys.t[ys.t.length - 1] > endSrc) endSrc = ys.t[ys.t.length - 1];
    if (zs.t.length > 0 && zs.t[zs.t.length - 1] > endSrc) endSrc = zs.t[zs.t.length - 1];

    const stride = g.density === "high" ? 1 : g.density === "mid" ? 2 : 4;
    const sampleMode = g.pairMode === "union" ? null : g.pairMode;
    const b: Plot3DBatch = { t: [], x: [], y: [], z: [], val: [] };
    // 组坐标变换（P87b 单点真相）：泵内应用 → 轨迹/场景/导出全同（校准旁路原始值）
    const xf = makeTransform(g.transform);
    const tp: [number, number, number] = [0, 0, 0];
    let lastMs = -Infinity;

    // 校准（P71/P73）：仅校准源组；stride=1 不抽稀（与轨迹密度无关）；采满 CAP 自动停止；
    // **旁路组变换**——校准的对象是传感器本身，点云必须是原始值
    const g1src = g.id === s.calibSrc && calibSourceReady();
    const wantCalib = s.calibMode && g1src && calib.capturing;
    const wantPreview = s.calibMode && g1src && calibFit !== null;
    const wantA6 = s.calibMode && g1src && accel6.collecting;
    let calibFull = false;

    for (let i = 0; i < pair.t.length; i++) {
      const tMs = pair.t[i];
      if (vs) {
        // 着色值与轨迹同一配对口径；不可信时刻保持上一有效值（valCarry 前向填充）
        const v = sampleMode
          ? sampleAt(vs, tMs, sampleMode, pair.tolMs)
          : ffillAt(vs, tMs);
        if (v != null) gs.valCarry = v;
      }
      if (i % stride === 0) {
        xf(pair.x[i], pair.y[i], pair.z[i], tp);
        b.t.push((tMs - t0) / 1000);
        b.x.push(tp[0]);
        b.y.push(tp[1]);
        b.z.push(tp[2]);
        b.val.push(gs.valCarry);
        lastMs = tMs;
      }
      if (tMs > sampledBefore && (wantCalib || wantPreview || wantA6) && !calibFull) {
        const vx = pair.x[i];
        const vy = pair.y[i];
        const vz = pair.z[i];
        if (wantCalib) {
          calib.pts.x.push(vx);
          calib.pts.y.push(vy);
          calib.pts.z.push(vz);
          if (calib.pts.x.length >= CALIB_CAP) {
            calib.capturing = false; // 自动停止；UI 读 calibSnapshot().capturing 感知
            calibFull = true;
          }
        }
        if (calibFit) {
          const r = correctedRadius(vx, vy, vz, calibFit);
          preview.r[preview.head] = r;
          preview.t[preview.head] = (tMs - t0) / 1000;
          preview.head = (preview.head + 1) % PREVIEW_CAP;
          if (preview.len < PREVIEW_CAP) preview.len++;
        }
        if (accel6.collecting) {
          accel6.deadline = Date.now() + ACCEL6_STALL_GRACE_MS; // 有样本顺延停滞门
          if (accel6.n === 0) accel6.t0Src = tMs; // 窗锚定源时间
          if (tMs - accel6.t0Src <= ACCEL6_WINDOW_MS) {
            accel6.sum[0] += vx;
            accel6.sum[1] += vy;
            accel6.sum[2] += vz;
            accel6.sumSq[0] += vx * vx;
            accel6.sumSq[1] += vy * vy;
            accel6.sumSq[2] += vz * vz;
            accel6.n++;
          } else {
            finalizeAccel6Face(); // 2s 窗到 → 自动结算（后续点不再累积）
          }
        }
      }
    }
    // P87b：latest 标记与朝向源采样（仅 point 模式需要 hd/q——零缓冲模式没有尾窗可差分）
    if (b.t.length > 0) {
      const li = b.t.length - 1;
      const latest: NonNullable<Plot3DBatch["latest"]> = {
        t: b.t[li],
        x: b.x[li],
        y: b.y[li],
        z: b.z[li],
      };
      if (li > 0) latest.pv = [b.x[li - 1], b.y[li - 1], b.z[li - 1]];
      if (g.mode === "point") {
        const h = g.heading;
        if (h.src === "ch" && h.chYaw) {
          const hs = provider(h.chYaw);
          const v = sampleMode
            ? sampleAt(hs, lastMs, sampleMode, pair.tolMs)
            : ffillAt(hs, lastMs);
          if (v != null) latest.hd = v;
        } else if (h.src === "quat" && h.qX && h.qY && h.qZ && h.qW) {
          const comps: (number | null)[] = [];
          for (const qid of [h.qX, h.qY, h.qZ, h.qW]) {
            const qs = provider(qid);
            comps.push(
              sampleMode ? sampleAt(qs, lastMs, sampleMode, pair.tolMs) : ffillAt(qs, lastMs),
            );
          }
          if (comps.every((v) => v != null)) latest.q = comps as number[];
        }
      }
      b.latest = latest;
    }
    if (b.t.length > 0 || reloaded) {
      if (b.t.length > 0) gs.ever = true;
      else gs.ever = false;
      entries.push({ gid: g.id, b, reloaded });
    }
  }

  // ---------- 游标裁决：显式预览 > 回放时钟 > 跟随最新 ----------
  let cursorSec: number | null = null;
  const sess = sessionProbe();
  const endRel = endSrc > -Infinity ? (endSrc - t0) / 1000 : 0;
  if (scrubSec !== null) {
    cursorSec = Math.min(Math.max(scrubSec, 0), endRel);
  } else if (sess.playing) {
    // 回放时钟 → 相对秒，clamp 到源范围（防御时钟错位）
    const rel = (sess.replayTsMs - t0) / 1000;
    cursorSec = Math.min(Math.max(rel, 0), endRel);
  }
  const cursorChanged =
    (cursorSec === null) !== (st.lastCursor === null) ||
    (cursorSec !== null &&
      Math.abs(cursorSec - (st.lastCursor ?? 0)) > 0.005);
  if (cursorChanged) st.lastCursor = cursorSec;
  // 游标变化时即使无新数据也要下发（如 seek 向后：重灌点全 ≤ 水位，批次为空）
  if (entries.length > 0 || cursorChanged) {
    sink(entries, cursorSec);
  }
}

// ---------- 旧 API 兼容出口（appActions/AI 提示词的 bind axisX 语义映射到组1） ----------

/** 读取某组（UI/AI 快照用） */
export function getGroup(gid: GroupId): TrajGroup | undefined {
  return settings.groups.find((g) => g.id === gid);
}

/**
 * Operator 包导出（P71 → P87a v2）：当前设置快照，剥离校准操作态
 * （校准模式是操作态，操作员端进包后默认轨迹模式）
 */
export function exportSettingsForPkg(): Plot3DSettings {
  return { ...settings, ...cloneCfg(), calibMode: false };
}

/** Operator 包导入（P71）：全量归一化（含 v1 旧包迁移）后应用+持久化；返回是否接受。
 *  C1：属配置写入 → 过只读锁；operatorStore.activate() 在**临时解锁窗口**内调用，故不受影响。 */
export function importSettingsFromPkg(raw: unknown): boolean {
  if (guardLocked()) return false;
  if (typeof raw !== "object" || raw === null) return false;
  const next = normalizeSettings(raw as Record<string, unknown>); // Validate before any mutation.
  settings = next;
  undoStack = [];
  redoStack = [];
  clearReq = null;
  clearCalibAll();
  pairStats.clear();
  for (const gs of gst.values()) gs.replay = true;
  emit();
  persist();
  return true;
}
