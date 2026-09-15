/**
 * P69 3D 轨迹面板数据泵（plot3dStore）。
 *
 * 职责边界：
 * - 通道与数据完全复用 plotStore（共享图例通道；采集门控见 plotStore.init 的 plot3d 分支）
 * - 本模块是「消费泵」：定时取各绑定通道的**原始序列**（getChanData，未经联合
 *   对齐），交给 pairTriples.buildPairedTriples 做三轴时间戳配对（P75 B2，
 *   消除同帧三轴被联合轴拆行导致的 L 形阶梯），再按点密度抽稀推给 scene（sink）。
 *   不持有大缓冲——双层 LOD（全精度尾窗 + 抽稀全景）在 scene 侧。
 * - 源裁剪/重建（下标语义失效）用「时间水位 lastT」续传：只消费时间戳 > lastT
 *   的锚点/并集行，绝不重灌、绝不重复——这是尾窗精度不被源端抽稀污染的关键。
 * - 面板关闭 = setSink(null) = 停泵（用户红线：关闭了的面板绝不允许后台运行）；
 *   后台页签（浏览器把 interval 节流到 ~1Hz）仍继续喂数，切回不丢段。
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

export interface Plot3DSettings {
  /** 三轴绑定的通道 id；"" = 未绑定 */
  axisX: string;
  axisY: string;
  axisZ: string;
  /** 着色：time = turbo 色带按会话时间；ch = turbo 按指定通道值域 */
  colorBy: "time" | "ch";
  colorCh: string;
  /** 渐隐窗口（秒）：最近 N 秒内由亮到暗，窗外保持最暗；0 = 全程渐变 */
  fade: 10 | 60 | 300 | 0;
  /** 轨迹样式 */
  style: "line+points" | "line" | "points";
  /** 点密度：追加期 stride 抽稀（高=1:1 / 中=1:2 / 低=1:4）；变更触发重灌 */
  density: "high" | "mid" | "low";
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
  /** 椭球校准模式（P71）：轨迹隐藏，切换为点云采样+拟合；与 autoRotate/follow 互斥。
   *  **操作态**（P74c B4）：不落盘、不进 Operator 包、面板关闭即退出——重启回到轨迹模式。 */
  calibMode: boolean;
  /** 三轴时间戳配对方式（P75 B2）：interp=带容差插值（默认，消除阶梯）/
   *  nearest=带容差最近邻 / union=旧版联合前向填充（逃生舱，阶梯会回来） */
  pairMode: PairMode;
  /** 配对容差（毫秒）：Y/Z 样本距锚点超过该值视为不可信；0 = 自动（按三轴采样节奏推算） */
  pairTolMs: number;
  /** 三轴缩放（scene 归一化）：uniform=等比（真实比例，默认）/ perAxis=逐轴撑满视锥（扁平数据查看用） */
  axisScale: "uniform" | "perAxis";
}

const SETTINGS_KEY = "vs.plot3d.settings";

export const DEFAULT_PLOT3D_SETTINGS: Plot3DSettings = {
  axisX: "",
  axisY: "",
  axisZ: "",
  colorBy: "time",
  colorCh: "",
  fade: 60,
  style: "line+points",
  density: "high",
  autoRotate: false,
  follow: false,
  showGrid: true,
  gridDensity: "std",
  keyFlight: false,
  zoomToCursor: false,
  calibMode: false,
  pairMode: "interp",
  pairTolMs: 0,
  axisScale: "uniform",
};

/** 部分输入 → 全量设置（容错归一化）；loadSettings 与 Operator 包导入共用 */
function normalizeSettings(p: Partial<Plot3DSettings> | null | undefined): Plot3DSettings {
  const q = p ?? {};
  return {
    axisX: typeof q.axisX === "string" ? q.axisX : "",
    axisY: typeof q.axisY === "string" ? q.axisY : "",
    axisZ: typeof q.axisZ === "string" ? q.axisZ : "",
    colorBy: q.colorBy === "ch" ? "ch" : "time",
    colorCh: typeof q.colorCh === "string" ? q.colorCh : "",
    fade: (q.fade === 10 || q.fade === 60 || q.fade === 300 || q.fade === 0
      ? q.fade
      : 60) as Plot3DSettings["fade"],
    style:
      q.style === "line" || q.style === "points" || q.style === "line+points"
        ? q.style
        : "line+points",
    density: q.density === "mid" || q.density === "low" ? q.density : "high",
    autoRotate: q.autoRotate === true,
    follow: q.follow === true,
    showGrid: q.showGrid !== false,
    gridDensity: q.gridDensity === "fine" || q.gridDensity === "coarse" ? q.gridDensity : "std",
    keyFlight: q.keyFlight === true,
    zoomToCursor: q.zoomToCursor === true,
    pairMode:
      q.pairMode === "nearest" || q.pairMode === "union" || q.pairMode === "interp"
        ? q.pairMode
        : "interp",
    pairTolMs:
      typeof q.pairTolMs === "number" && isFinite(q.pairTolMs) && q.pairTolMs > 0
        ? q.pairTolMs
        : 0,
    axisScale: q.axisScale === "perAxis" ? "perAxis" : "uniform",
    // 操作态：永不从存储/Operator 包恢复（P74c B4）。进入校准必须由用户显式动作触发。
    calibMode: false,
  };
}

function loadSettings(): Plot3DSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_PLOT3D_SETTINGS };
    return normalizeSettings(JSON.parse(raw) as Partial<Plot3DSettings>);
  } catch {
    return { ...DEFAULT_PLOT3D_SETTINGS };
  }
}

let settings = loadSettings();
const listeners = new Set<() => void>();
let snapshot = { settings };

function persist() {
  try {
    // P74c B4：calibMode 是「操作态」不是「设置」——不进 localStorage，
    // 否则重启/重开面板回来会直接落在空点云的校准模式里（与 exportSettingsForPkg 的剥离口径一致）
    const { calibMode: _operational, ...rest } = settings;
    void _operational;
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

function emit() {
  snapshot = { settings };
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

/**
 * Operator 只读模式下仍放行的「视图 / 操作态」字段（P74c C1）。
 * 判定依据：只影响「怎么看 / 怎么测」，不改变部署包承诺的数据口径，
 * 操作员在现场必须能旋转、跟随、以及进入椭球校准；其余字段属配置，锁定时拒绝改动。
 */
const VIEW_KEYS: readonly (keyof Plot3DSettings)[] = ["autoRotate", "follow", "calibMode"];

export function setSetting(patch: Partial<Plot3DSettings>) {
  // C1：配置类改动过 Operator 只读锁；视图类（自动旋转/跟随/校准）放行
  const touchesConfig = Object.keys(patch).some(
    (k) => !VIEW_KEYS.includes(k as keyof Plot3DSettings),
  );
  if (touchesConfig && guardLocked()) return;
  if (patch.follow === true) patch = { ...patch, autoRotate: false };
  if (patch.autoRotate === true) patch = { ...patch, follow: false };
  if (patch.calibMode === true) {
    // 校准模式锁定视角无意义：强制全关（详设 §5）
    patch = { ...patch, autoRotate: false, follow: false };
  }
  settings = { ...settings, ...patch };
  emit();
  persist();
}

/**
 * Operator 包导出（P71）：当前设置快照，剥离校准操作态
 * （校准模式是操作态，操作员端进包后默认轨迹模式）
 */
export function exportSettingsForPkg(): Plot3DSettings {
  return { ...settings, calibMode: false };
}

/** Operator 包导入（P71）：全量归一化后应用+持久化；返回是否接受。
 *  C1：属配置写入 → 过只读锁；operatorStore.activate() 在**临时解锁窗口**内调用，故不受影响。 */
export function importSettingsFromPkg(raw: unknown): boolean {
  if (guardLocked()) return false;
  if (typeof raw !== "object" || raw === null) return false;
  settings = normalizeSettings(raw as Partial<Plot3DSettings>);
  emit();
  persist();
  return true;
}

/** 恢复默认（配置类 → 过只读锁） */
export function resetSettings() {
  if (guardLocked()) return;
  settings = { ...DEFAULT_PLOT3D_SETTINGS };
  emit();
  persist();
}

/** 绑定通道被删除时自动解绑（同 2D 的 X 源悬空纠正语义） */
function sanitizeBinds(chans: Channel[]): boolean {
  const ok = (id: string) => id === "" || chans.some((c) => c.id === id);
  const patch: Partial<Plot3DSettings> = {};
  if (!ok(settings.axisX)) patch.axisX = "";
  if (!ok(settings.axisY)) patch.axisY = "";
  if (!ok(settings.axisZ)) patch.axisZ = "";
  if (settings.colorBy === "ch" && !ok(settings.colorCh)) {
    patch.colorBy = "time";
    patch.colorCh = "";
  }
  if (Object.keys(patch).length === 0) return false;
  settings = { ...settings, ...patch };
  emit();
  persist();
  return true;
}

/** 单帧增量批次：真实工程值（未归一化）。t 为相对秒（timeOrigin 起）。 */
export interface Plot3DBatch {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  /** 着色值（colorBy=ch 时为该通道原始值；time 模式无意义） */
  val: number[];
}

type Sink = (b: Plot3DBatch, reloaded: boolean, cursorSec: number | null) => void;
let sink: Sink | null = null;
let pumpTimer: number | null = null;

/**
 * 时间游标（P70 T2）：null = 跟随最新；数值 = 截断显示到该相对秒。
 * 来源优先级（泵每 tick 裁决，单入口下发）：回放跟随 > 手动 scrub > null。
 * 回放联动零重建的关键：重灌点 ts ≤ 水位自动跳过，seek 向后只需场景侧
 * drawRange 截断（见详设 §1）。
 */
let scrubSec: number | null = null;

/** 手动拖时间条（非回放）：UI 拖动直调，松手保留游标；null = 回到最新 */
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

// ---------- 椭球校准采样（P71）----------
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
/** 全清（换签名/面板关闭）：椭球采样+拟合+预览+六面全部复位 */
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
  if (idx < 0 || idx > 5) return;
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

/** 消费状态（不进 snapshot）：sig = 绑定/通道/密度签名；lastT = 已消费时间水位（原始 ms）；
 *  lastCursor = 上次下发的游标（游标去抖，变动 ≤5ms 不重复下发） */
const st = {
  sig: "",
  lastT: -Infinity,
  valCarry: 0,
  lastCursor: null as number | null,
};

/**
 * 数据源注入口（P75 B2 改版）：按通道 id 取「原始序列」（各通道自己的时间戳，
 * 未做联合对齐/前向填充）。默认 plotStore.getChanData。
 * 配对在 pairTriples.buildPairedTriples 内完成——阶梯根因（同帧三轴被联合轴
 * 拆成 3 行）从源头绕开。
 */
let provider: (id: string) => Series = (id) => getChanData(id);
export function _setProviderForTest(p: (id: string) => Series) {
  provider = p;
}

/**
 * 配对诊断统计（P75 B2）：自上次重灌以来累计的配对成功/跳过数、生效容差、
 * 三轴值域。HUD 低频读取（内部引用只读约定，同 previewSnapshot）。
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

const pairStat: PairStatSnapshot = {
  paired: 0,
  skipped: 0,
  tolMs: 0,
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
};

export function pairSnapshot(): PairStatSnapshot {
  return pairStat;
}

function resetPairStat() {
  pairStat.paired = 0;
  pairStat.skipped = 0;
  pairStat.tolMs = 0;
  pairStat.min = [Infinity, Infinity, Infinity];
  pairStat.max = [-Infinity, -Infinity, -Infinity];
}

function accumulatePairStat(r: {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  skipped: number;
  tolMs: number;
}) {
  pairStat.paired += r.t.length;
  pairStat.skipped += r.skipped;
  if (r.tolMs > 0) pairStat.tolMs = r.tolMs;
  const mins = [pairStat.min[0], pairStat.min[1], pairStat.min[2]];
  const maxs = [pairStat.max[0], pairStat.max[1], pairStat.max[2]];
  for (let i = 0; i < r.t.length; i++) {
    const vs = [r.x[i], r.y[i], r.z[i]];
    for (let a = 0; a < 3; a++) {
      if (vs[a] < mins[a]) mins[a] = vs[a];
      if (vs[a] > maxs[a]) maxs[a] = vs[a];
    }
  }
  pairStat.min = [mins[0], mins[1], mins[2]];
  pairStat.max = [maxs[0], maxs[1], maxs[2]];
}

export function _resetForTest() {
  st.sig = "";
  st.lastT = -Infinity;
  st.valCarry = 0;
  st.lastCursor = null;
  scrubSec = null;
  sessionProbe = defaultSessionProbe;
  settings = { ...DEFAULT_PLOT3D_SETTINGS };
  snapshot = { settings };
  resetPairStat();
  clearCalibAll();
}

/**
 * 清空轨迹数据（P82② HUD 清空钮）：时间水位推到当前最新点——历史全部跳过、
 * 新数据从零画起；绑定与显示设置不动；校准采样/拟合/预览缓冲**不受影响**
 * （独立缓冲，校准 HUD 有自己的「清空重来」）。场景侧由 UI 调 clearTrajectory。
 */
export function clearData() {
  let maxT = -Infinity;
  for (const id of [settings.axisX, settings.axisY, settings.axisZ]) {
    if (!id) continue;
    const s = provider(id);
    const last = s.t[s.t.length - 1];
    if (last !== undefined && last > maxT) maxT = last;
  }
  st.lastT = maxT;
  st.valCarry = 0;
  resetPairStat();
  emit();
}

function pumpOnce() {
  if (!sink) return;
  if (!panelActivity.isOpen("plot3d")) return;
  const chans = getPlotSnapshot().channels;
  const rebind = sanitizeBinds(chans);
  const s = settings;
  const sig = `${s.axisX}|${s.axisY}|${s.axisZ}|${s.colorBy}|${s.colorCh}|${s.density}|${s.pairMode}|${s.pairTolMs}|${chans.map((c) => c.id).join(",")}`;
  const reloaded = sig !== st.sig || rebind;
  if (reloaded) {
    st.sig = sig;
    st.lastT = -Infinity;
    st.valCarry = 0;
    resetPairStat();
    if (calib.pts.x.length > 0 || calibFit || accel6.faces.some((f) => f !== null)) {
      // 数据源/绑定/密度/配对方式变化：混采无意义 → 校准全套清空重来（P71 §5 / P73 §6）
      clearCalibAll();
    }
  }

  // 六面采集停滞门（C9）：数据流中断时退出采集，UI 显示原因而不是永久「采集中」。
  // 必须排在三轴绑齐检查之前——采集途中解绑任一轴时该门是唯一出口
  if (accel6.collecting && Date.now() > accel6.deadline) {
    accel6.collecting = false;
    accel6.idx = -1;
    accel6.stalled = true;
  }
  if (!s.axisX || !s.axisY || !s.axisZ) return; // 三轴未绑齐 → 不消费（HUD 提示）
  const xi = chans.findIndex((c) => c.id === s.axisX);
  const yi = chans.findIndex((c) => c.id === s.axisY);
  const zi = chans.findIndex((c) => c.id === s.axisZ);
  const vi = s.colorBy === "ch" ? chans.findIndex((c) => c.id === s.colorCh) : -1;
  if (xi < 0 || yi < 0 || zi < 0) return;
  const xs = provider(s.axisX);
  const ys = provider(s.axisY);
  const zs = provider(s.axisZ);
  const vs = vi >= 0 ? provider(s.colorCh) : null;
  if (xs.t.length === 0) return;

  // 三轴配对（P75 B2）：X 原始时间轴为锚，Y/Z 按容差插值/最近邻；
  // union 模式 = 旧版联合前向填充逃生舱。水位 sinceT 在函数内按原始 ts 过滤。
  const pair = buildPairedTriples(xs, ys, zs, {
    mode: s.pairMode,
    tolMs: s.pairTolMs,
    sinceT: st.lastT,
  });
  // 时间水位续传：interp/nearest 消费到 X 末锚点；union 消费到三序列原始末点。
  // 永不回退（源重建缩小防御；重灌时已置 -Infinity）。
  if (pair.endT > st.lastT) st.lastT = pair.endT;
  accumulatePairStat(pair);

  const stride = s.density === "high" ? 1 : s.density === "mid" ? 2 : 4;
  const t0 = timeOrigin();
  const sampleMode = s.pairMode === "union" ? null : s.pairMode;
  const b: Plot3DBatch = { t: [], x: [], y: [], z: [], val: [] };

  // 校准（P71/P73）：stride=1 不抽稀（与轨迹密度无关）；采满 CAP 自动停止
  const wantCalib = s.calibMode && calib.capturing;
  const wantPreview = s.calibMode && calibFit !== null;
  const wantA6 = s.calibMode && accel6.collecting;
  let calibFull = false;

  for (let i = 0; i < pair.t.length; i++) {
    const tMs = pair.t[i];
    if (vs) {
      // 着色值与轨迹同一配对口径；不可信时刻保持上一有效值（valCarry 前向填充）
      const v = sampleMode
        ? sampleAt(vs, tMs, sampleMode, pair.tolMs)
        : ffillAt(vs, tMs);
      if (v != null) st.valCarry = v;
    }
    if (i % stride === 0) {
      b.t.push((tMs - t0) / 1000);
      b.x.push(pair.x[i]);
      b.y.push(pair.y[i]);
      b.z.push(pair.z[i]);
      b.val.push(st.valCarry);
    }
    if ((wantCalib || wantPreview || wantA6) && !calibFull) {
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

  // ---------- 游标裁决（P70 T2）：回放跟随 > 手动 scrub > 跟随最新 ----------
  let cursorSec: number | null = null;
  const sess = sessionProbe();
  // 源末端 = 三序列原始末点最大值（配对后轨迹时间轴由 X 锚定，但游标/
  // 时间条覆盖的是数据整体范围）
  let endSrc = xs.t[xs.t.length - 1];
  if (ys.t.length > 0 && ys.t[ys.t.length - 1] > endSrc) endSrc = ys.t[ys.t.length - 1];
  if (zs.t.length > 0 && zs.t[zs.t.length - 1] > endSrc) endSrc = zs.t[zs.t.length - 1];
  const endRel = (endSrc - t0) / 1000;
  if (sess.playing) {
    // 回放时钟 → 相对秒，clamp 到源范围（防御时钟错位）
    const rel = (sess.replayTsMs - t0) / 1000;
    cursorSec = Math.min(Math.max(rel, 0), endRel);
  } else if (scrubSec !== null) {
    cursorSec = Math.min(Math.max(scrubSec, 0), endRel);
  }
  const cursorChanged =
    (cursorSec === null) !== (st.lastCursor === null) ||
    (cursorSec !== null &&
      Math.abs(cursorSec - (st.lastCursor ?? 0)) > 0.005);
  if (cursorChanged) st.lastCursor = cursorSec;
  // 游标变化时即使无新数据也要下发（如 seek 向后：重灌点全 ≤ 水位，批次为空）
  if (b.t.length > 0 || reloaded || cursorChanged) {
    sink(b, reloaded, cursorSec);
  }
}
