import type { FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";
import { PALETTE } from "../protocol/templateStore";

export interface Channel {
  id: string;
  tplId: string;
  fieldId: string;
  name: string;
  color: string;
  visible: boolean;
}

export interface PlotSettings {
  yMode: "auto" | "zero";
  grid: boolean;
  xSource: string;
  plotMode: "line" | "points";
  lineWidth: number;
  lineStyle: "linear" | "step" | "smooth";
  /** 多通道示波器：每通道独立归一化并垂直均分面板 */
  stack: boolean;
  /**
   * 游标（示波器式，X/Y 两套独立开关，可同时开）：
   * cursorX=时间游标（垂直标尺，测 Δt 与各通道 V@A/V@B/ΔV）；
   * cursorY=幅值游标（水平标尺，测 ΔV；堆叠模式按聚焦通道原始值显示）
   */
  cursorX: boolean;
  cursorY: boolean;
  /** Y 轴随视野自动缩放（关闭后 Y 范围固定，需手动 Auto Y 或滚轮调整） */
  yAuto: boolean;
}

export interface PlotSnapshot {
  channels: Channel[];
  settings: PlotSettings;
}

export const MAX_POINTS = 30000;

const SETTINGS_KEY = "vs.plotSettings";

/** 默认 yAuto=false：视野稳定优先（VOFA+ 式），需要时用户可手动开启自动缩放 */
const DEFAULT_SETTINGS: PlotSettings = {
  yMode: "auto",
  grid: true,
  xSource: "time",
  plotMode: "line",
  lineWidth: 2,
  lineStyle: "linear",
  stack: false,
  cursorX: false,
  cursorY: false,
  yAuto: false,
};

/** 读取持久化设置（仅恢复视图偏好；通道数据不持久化），异常时回退默认 */
function loadSettings(): PlotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<PlotSettings> & { cursors?: boolean };
    return {
      yMode: p.yMode === "zero" ? "zero" : "auto",
      grid: typeof p.grid === "boolean" ? p.grid : true,
      xSource: typeof p.xSource === "string" ? p.xSource : "time",
      plotMode: p.plotMode === "points" ? "points" : "line",
      lineWidth: [1, 2, 3].includes(Number(p.lineWidth)) ? Number(p.lineWidth) : 2,
      lineStyle:
        p.lineStyle === "step" || p.lineStyle === "smooth" ? p.lineStyle : "linear",
      stack: typeof p.stack === "boolean" ? p.stack : false,
      // 旧版十字游标 cursors:true → 迁移为两套都开
      cursorX:
        typeof p.cursorX === "boolean"
          ? p.cursorX
          : p.cursors === true,
      cursorY:
        typeof p.cursorY === "boolean"
          ? p.cursorY
          : p.cursors === true,
      yAuto: typeof p.yAuto === "boolean" ? p.yAuto : false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let channels: Channel[] = [];
let settings: PlotSettings = loadSettings();
let snapshot: PlotSnapshot = { channels, settings };
const listeners = new Set<() => void>();
let initialized = false;
let dirty = false;


function emit() {
  snapshot = { channels, settings };
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

export function isDirty() {
  return dirty;
}

export function clearDirty() {
  dirty = false;
}

export interface ChanData {
  t: number[];
  v: number[];
}

const dataMap = new Map<string, ChanData>();

/** 时间轴原点（毫秒）：本会话第一个数据点，X 轴按「相对秒」显示；清空全部通道后重置 */
let timeOriginMs: number | null = null;
export function timeOrigin(): number {
  return timeOriginMs ?? 0;
}

export function getChanData(id: string): ChanData {
  let d = dataMap.get(id);
  if (!d) {
    d = { t: [], v: [] };
    dataMap.set(id, d);
  }
  return d;
}

function appendPoint(chId: string, t: number, v: number) {
  if (timeOriginMs === null) timeOriginMs = t;
  const d = getChanData(chId);
  d.t.push(t);
  d.v.push(v);
  dirty = true;
  if (d.t.length > MAX_POINTS) {
    const keep = d.t.length - Math.floor(d.t.length / 2);
    d.t = d.t.slice(d.t.length - keep);
    d.v = d.v.slice(d.v.length - keep);
    dataMap.set(chId, d);
    // 裁剪会移动数据起点，令增量对齐缓存失效
    alignedCache = null;
  }
}

/**
 * 增量对齐缓存：实时跟随每 120ms 触发一次 buildAligned，若每次都对全部历史
 * 做多路归并 + 降采样，高频数据下会形成 GC/重绘风暴（“画一段就卡”的主因之一）。
 * 新点的时间戳恒大于已缓存末尾，故只需把「上次之后新增的点」归并到尾部即可，
 * 成本从 O(全部历史) 降到 O(新增)；显示 X 轴（proj）同样增量维护。
 * 当缓存规模超出上限、或发生裁剪/换通道/改 X 源时回退一次全量重建（顺带降采样），
 * 把重建频率摊薄到「每数千个新点一次」而非「每 tick 一次」。
 */
interface AlignedCache {
  /** 原始时间轴（毫秒，严格递增） */
  x: number[];
  /** 显示 X 轴（xSource 投影结果，与 x 等长，增量维护） */
  proj: number[];
  cols: (number | null)[][];
  lastLen: number[];
  lastV: (number | null)[];
  chanSig: string;
}
let alignedCache: AlignedCache | null = null;

function chanSigOf(): string {
  return `${settings.xSource}|${channels.map((c) => c.id).join(",")}`;
}

/** 回退全量重建的阈值：留 2.5 倍余量，避免刚重建完下一 tick 又触发重建 */
function cacheLimit(maxPoints: number): number {
  return Math.max(4000, Math.round(maxPoints * 2.5));
}

function buildAlignedFull(maxPoints: number): {
  x: number[];
  cols: (number | null)[][];
} {
  const chans = channels;
  // 显示降采样：通道数据总量远超 maxPoints 时，逐通道做 min/max 抽稀（保留波形峰谷），
  // 再对抽稀后的流做多路归并。限制了对齐输出的规模，避免多通道大数据量的分配与重绘风暴。
  const streams = chans.map((ch) => {
    const d = getChanData(ch.id);
    return { t: d.t, v: d.v, i: 0 };
  });
  if (maxPoints > 0) {
    const total = streams.reduce((s, c) => s + c.t.length, 0);
    if (total > maxPoints * 2) {
      for (const c of streams) {
        const n = c.t.length;
        if (n < 4) continue;
        const buckets = Math.max(1, Math.round((maxPoints * n) / total));
        const bucket = Math.ceil(n / buckets);
        if (bucket <= 2) continue;
        const dt: number[] = [];
        const dv: number[] = [];
        for (let s = 0; s < n; s += bucket) {
          const e = Math.min(n, s + bucket);
          let mi = s;
          let ma = s;
          for (let j = s + 1; j < e; j++) {
            if (c.v[j] < c.v[mi]) mi = j;
            if (c.v[j] > c.v[ma]) ma = j;
          }
          const first = mi <= ma ? mi : ma;
          const second = mi <= ma ? ma : mi;
          dt.push(c.t[first], c.t[second]);
          dv.push(c.v[first], c.v[second]);
        }
        c.t = dt;
        c.v = dv;
      }
    }
  }
  const x: number[] = [];
  const cols: (number | null)[][] = chans.map(() => []);
  const lastV: (number | null)[] = chans.map(() => null);
  let last = -Infinity;
  for (;;) {
    let best = -1;
    let bt = Infinity;
    for (let ci = 0; ci < streams.length; ci++) {
      const c = streams[ci];
      if (c.i < c.t.length && c.t[c.i] < bt) {
        bt = c.t[c.i];
        best = ci;
      }
    }
    if (best < 0) break;
    const c = streams[best];
    let t = c.t[c.i];
    const v = c.v[c.i];
    c.i += 1;
    if (t <= last) t = last + 0.001;
    last = t;
    lastV[best] = v;
    x.push(t);
    for (let j = 0; j < chans.length; j++) {
      cols[j].push(lastV[j]);
    }
  }
  return { x, cols };
}

/** X 源指向的通道被删除/清空后会悬空：投影退回裸毫秒 epoch 时间轴（X 轴变成
 *  13 位数字），且 projMonotonic() 判定失效 → 视窗裁剪喂数整体失效（越画越卡）、
 *  「最新」线锚定到合并轴末点持续漂移。统一在这里纠正为 time 源。 */
function sanitizeXSrc() {
  if (
    settings.xSource.startsWith("ch:") &&
    !channels.some((c) => c.id === settings.xSource.slice(3))
  ) {
    settings.xSource = "time";
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* 存储不可用时仅内存生效 */
    }
  }
}

/** 全量投影：原始时间轴 → 显示 X 轴（index/time/通道源），仅重建时调用 */
function projectX(x: number[], cols: (number | null)[][]): number[] {
  const xsrc = settings.xSource;
  if (xsrc === "index") return x.map((_, i) => i);
  if (xsrc === "time") {
    const t0 = timeOriginMs ?? 0;
    return x.map((v) => (v - t0) / 1000);
  }
  if (xsrc.startsWith("ch:")) {
    const ci = channels.findIndex((c) => c.id === xsrc.slice(3));
    if (ci >= 0) {
      const col = cols[ci];
      const xs: number[] = [];
      let prev = 0;
      for (let i = 0; i < col.length; i++) {
        const v = col[i];
        if (v === null) {
          xs.push(prev);
        } else {
          prev = v;
          xs.push(v);
        }
      }
      return xs;
    }
  }
  // 悬空 ch: 源兜底：按时间轴投影（绝不能退回裸毫秒）
  const t0 = timeOriginMs ?? 0;
  return x.map((v) => (v - t0) / 1000);
}

export function buildAligned(maxPoints = 0): {
  x: number[];
  cols: (number | null)[][];
} {
  const chans = channels;
  const sig = chanSigOf();
  const lens = chans.map((c) => getChanData(c.id).t.length);
  const cache = alignedCache;
  const canAppend =
    !!cache &&
    cache.chanSig === sig &&
    // 任一通道变短 = 发生过裁剪，缓存起点已失效
    lens.every((n, i) => n >= cache.lastLen[i]) &&
    // 缓存超出上限则回退全量（触发降采样），避免无界增长
    cache.x.length <= cacheLimit(maxPoints);

  if (canAppend && cache) {
    const xsrc = settings.xSource;
    const chSrcIdx = xsrc.startsWith("ch:")
      ? chans.findIndex((c) => c.id === xsrc.slice(3))
      : -1;
    // 归并各通道「上次之后新增」的点：时间戳单调递增，尾部多路归并
    const newStreams = chans.map((ch, i) => {
      const d = getChanData(ch.id);
      return { t: d.t, v: d.v, i: cache.lastLen[i] };
    });
    let last = cache.x.length
      ? cache.x[cache.x.length - 1] + 0.0001
      : -Infinity;
    const lastV = cache.lastV;
    for (;;) {
      let best = -1;
      let bt = Infinity;
      for (let ci = 0; ci < newStreams.length; ci++) {
        const c = newStreams[ci];
        if (c.i < c.t.length && c.t[c.i] < bt) {
          bt = c.t[c.i];
          best = ci;
        }
      }
      if (best < 0) break;
      const c = newStreams[best];
      let t = c.t[c.i];
      const v = c.v[c.i];
      c.i += 1;
      if (t <= last) t = last + 0.001;
      last = t;
      lastV[best] = v;
      cache.x.push(t);
      for (let j = 0; j < chans.length; j++) cache.cols[j].push(lastV[j]);
      // 增量投影显示 X
      if (xsrc === "index") {
        cache.proj.push(cache.x.length - 1);
      } else if (xsrc === "time") {
        cache.proj.push((t - (timeOriginMs ?? 0)) / 1000);
      } else if (chSrcIdx >= 0) {
        const pv = lastV[chSrcIdx];
        cache.proj.push(
          pv != null ? pv : cache.proj.length ? cache.proj[cache.proj.length - 1] : 0,
        );
      } else {
        // 悬空 ch: 源兜底：按时间轴投影（绝不能退回裸毫秒）
        cache.proj.push((t - (timeOriginMs ?? 0)) / 1000);
      }
    }
    cache.lastLen = lens;
    return { x: cache.proj, cols: cache.cols };
  }

  const full = buildAlignedFull(maxPoints);
  alignedCache = {
    x: full.x,
    proj: projectX(full.x, full.cols),
    cols: full.cols,
    lastLen: lens,
    lastV: chans.map((_, i) => {
      const col = full.cols[i];
      return col.length ? col[col.length - 1] : null;
    }),
    chanSig: sig,
  };
  return { x: alignedCache.proj, cols: full.cols };
}

/** proj 数组是否严格递增（time/index 源是；ch: 源可能非单调，不能二分） */
function projMonotonic(): boolean {
  return settings.xSource === "time" || settings.xSource === "index";
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 对齐缓存的全量重建阈值（合并轴点数）：远低于浏览器重绘极限，仅防内存失控 */
const FED_CAP_STORE = 40000;

/**
 * 视窗裁剪喂数（性能核心）：只把当前视野 ±5% 窗宽范围内的点交给 uPlot，
 * 重绘成本从 O(全部历史) 降到 O(视野内点数)——这是「画久了越来越卡 /
 * 少量数据也卡」的根治手段。窗口外历史仍完整保留在缓存里（游标测量、
 * 缩放回看都取得到）。窗口点数仍超上限时做 min/max 抽稀保峰谷。
 * ch: 源（X=某通道值）可能非单调，无法二分 → 退化为全量。
 */
export function buildAlignedWindow(
  xLo: number,
  xHi: number,
  maxPoints: number,
): { x: number[]; cols: (number | null)[][] } {
  const full = buildAligned(FED_CAP_STORE);
  if (!projMonotonic() || full.x.length === 0) return full;
  const span = Math.max(xHi - xLo, 1e-9);
  const lo = lowerBound(full.x, xLo - span * 0.05);
  const hi = lowerBound(full.x, xHi + span * 0.05);
  const n = Math.max(0, hi - lo);
  if (n === full.x.length) return full;
  const xs = full.x.slice(lo, hi);
  const cols = full.cols.map((c) => c.slice(lo, hi));
  if (maxPoints > 0 && xs.length > maxPoints) {
    return decimate(xs, cols, maxPoints);
  }
  return { x: xs, cols };
}

/** min/max 分桶抽稀（保留波形峰谷），输入按 x 升序。
 *  峰谷候选必须覆盖**所有通道**：只按第一条通道选点时，若该通道平坦/隐藏，
 *  每桶只保留 1 个点 → 其余通道被混叠采样（表现为“温度曲线变锯齿”）。
 *  同时保留每桶首末点维持连续性，并强制包含序列最后一点——
 *  喂数曲线的末端必须抵达真实最新数据（「最新」线才能与之重合）。 */
function decimate(
  xs: number[],
  cols: (number | null)[][],
  maxPoints: number,
): { x: number[]; cols: (number | null)[][] } {
  const n = xs.length;
  const k = cols.length;
  if (n === 0) return { x: [], cols: cols.map(() => []) };
  const perBucket = 2 + 2 * k;
  const buckets = Math.max(1, Math.floor(maxPoints / perBucket));
  const bucket = Math.ceil(n / buckets);
  if (bucket <= 1) return { x: xs, cols };
  const outX: number[] = [];
  const outCols: (number | null)[][] = cols.map(() => []);
  const cand: number[] = [];
  for (let s = 0; s < n; s += bucket) {
    const e = Math.min(n, s + bucket);
    cand.length = 0;
    cand.push(s, e - 1);
    for (let c = 0; c < k; c++) {
      const col = cols[c];
      let mi = s;
      let ma = s;
      for (let j = s + 1; j < e; j++) {
        const v = col[j];
        if (v == null) continue;
        const vmin = col[mi];
        const vmax = col[ma];
        if (vmin == null || v < vmin) mi = j;
        if (vmax == null || v > vmax) ma = j;
      }
      cand.push(mi, ma);
    }
    cand.sort((a, b) => a - b);
    let prev = -1;
    for (const j of cand) {
      if (j === prev) continue;
      prev = j;
      outX.push(xs[j]);
      for (let c = 0; c < k; c++) outCols[c].push(cols[c][j]);
    }
  }
  // 强制保留最后一个点：跟随窗/「最新」线锚定在真实末点，不能被抽稀丢掉
  if (outX.length === 0 || outX[outX.length - 1] !== xs[n - 1]) {
    outX.push(xs[n - 1]);
    for (let c = 0; c < k; c++) outCols[c].push(cols[c][n - 1]);
  }
  return { x: outX, cols: outCols };
}

/** 可见通道中最新的原始时间戳（毫秒）；无数据返回 null。
 *  合并轴末尾可能被隐藏通道拉长 → 「最新」线与跟随窗必须锚定可见数据 */
export function lastVisibleTs(): number | null {
  let m: number | null = null;
  for (const ch of channels) {
    if (!ch.visible) continue;
    const d = dataMap.get(ch.id);
    if (!d || d.t.length === 0) continue;
    const last = d.t[d.t.length - 1];
    if (m === null || last > m) m = last;
  }
  return m;
}

/** 可见通道在「显示 X 轴」上的最新值；无数据返回 null。
 *  跟随窗/「最新」线的统一锚点：合并轴（喂数）末点会被仍在到货的隐藏通道
 *  拉长（如 0x51 持续到货而可见的 0x52 已停止 → 末点在可见曲线前方很远），
 *  只有可见末点才能保证曲线末端、「最新」线、跟随窗三者重合。
 *  time 源由 lastVisibleTs 直接投影；index/ch: 源从对齐缓存尾部反向找
 *  第一个可见通道有值的点（通常就在末尾，代价可忽略）。 */
export function lastVisibleX(): number | null {
  if (settings.xSource === "time") {
    const m = lastVisibleTs();
    return m === null ? null : (m - timeOrigin()) / 1000;
  }
  const full = buildAligned(FED_CAP_STORE);
  for (let i = full.x.length - 1; i >= 0; i--) {
    for (let ci = 0; ci < channels.length; ci++) {
      if (channels[ci].visible && full.cols[ci][i] !== null) return full.x[i];
    }
  }
  return null;
}

/** 显示 X 值 → 原始毫秒（time 源的逆投影；其他源返回 null） */
export function displayToMs(v: number): number | null {
  if (settings.xSource !== "time") return null;
  return v * 1000 + (timeOriginMs ?? 0);
}

/** 全量对齐缓存（引用返回，O(1)）：游标测量/backlog 统计等需要完整历史的场合 */
export function fullAligned(): { x: number[]; cols: (number | null)[][] } {
  return buildAligned(FED_CAP_STORE);
}

/** 显示 X 轴上 v 之后还有多少个点（浏览态 backlog；基于全量缓存二分） */
export function countAfterDisplay(v: number): number {
  const full = buildAligned(FED_CAP_STORE);
  if (!projMonotonic()) {
    let c = 0;
    for (let i = full.x.length - 1; i >= 0 && full.x[i] > v; i--) c++;
    return c;
  }
  return full.x.length - lowerBound(full.x, v + 1e-12);
}

export async function init() {
  if (initialized) return;
  initialized = true;
  // 启动时通道列表为空，历史遗留的 ch: X 源必然悬空 → 纠正
  sanitizeXSrc();
  onFrames((p: FramesEventPayload) => {
    // 面板关闭 → 完全停止采集（用户要求：关闭了的面板绝不允许后台运行）；
    // 重新打开后从当前时刻的新数据继续，已有缓存保留
    if (!panelActivity.isOpen("plot2d")) return;
    if (channels.length === 0) return;
    for (const row of p.rows) {
      if (!row.valid) continue;
      for (const ch of channels) {
        if (ch.tplId !== row.tplId) continue;
        const f = row.fields.find((x) => x.id === ch.fieldId);
        if (f && f.text === null) {
          appendPoint(ch.id, row.tsMs, f.value);
        }
      }
    }
  });
}

export function addChannel(ch: Omit<Channel, "id" | "visible">): boolean {
  if (channels.some((c) => c.tplId === ch.tplId && c.fieldId === ch.fieldId)) {
    return false;
  }
  const channel: Channel = { ...ch, id: crypto.randomUUID(), visible: true };
  channels = [...channels, channel];
  emit();
  return true;
}

export function removeChannel(id: string) {
  channels = channels.filter((c) => c.id !== id);
  dataMap.delete(id);
  sanitizeXSrc();
  emit();
}

export function removeByTpl(tplId: string, fieldId: string | null) {
  const doomed = channels.filter(
    (c) => c.tplId === tplId && (!fieldId || c.fieldId === fieldId),
  );
  for (const ch of doomed) removeChannel(ch.id);
}

export function toggleVisible(id: string) {
  channels = channels.map((c) =>
    c.id === id ? { ...c, visible: !c.visible } : c,
  );
  emit();
}

export function setColor(id: string, color: string) {
  channels = channels.map((c) => (c.id === id ? { ...c, color } : c));
  emit();
}

export function clearChannels() {
  channels = [];
  dataMap.clear();
  timeOriginMs = null;
  sanitizeXSrc();
  emit();
}

export function nextColor(): string {
  return PALETTE[channels.length % PALETTE.length];
}

export function setSetting(patch: Partial<PlotSettings>) {
  settings = { ...settings, ...patch };
  emit();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 存储不可用时仅内存生效 */
  }
}

/** 图例点击聚焦：solo 该通道或恢复全部 */
export function toggleSolo(id: string) {
  const vis = channels.filter((c) => c.visible);
  const isSolo = vis.length === 1 && vis[0].id === id;
  channels = channels.map((c) => ({ ...c, visible: isSolo ? true : c.id === id }));
  dirty = true;
  emit();
}

/** 实际输出率：按最近 5s 滑窗统计。全量跨度平均在设备突发输出（如一次 200 帧
 *  后停 200s）下会把速率拉平到失真值（图例显示 1Hz 实际 200Hz 的根因） */
export function sampleRate(id: string): number {
  const d = dataMap.get(id);
  if (!d || d.t.length < 2) return 0;
  const n = d.t.length;
  const cutoff = d.t[n - 1] - 5000;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d.t[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  const cnt = n - lo;
  if (cnt < 2) return 0;
  const span = d.t[n - 1] - d.t[lo];
  if (span <= 0) return 0;
  return ((cnt - 1) / span) * 1000;
}

export function hasChannel(tplId: string, fieldId: string): boolean {
  return channels.some((c) => c.tplId === tplId && c.fieldId === fieldId);
}

export function channelState(tplId: string, fieldId: string): "off" | "hidden" | "on" {
  const ch = channels.find((c) => c.tplId === tplId && c.fieldId === fieldId);
  if (!ch) return "off";
  return ch.visible ? "on" : "hidden";
}

(() => {
  try {
    (window as unknown as { uartixPlot: { removeByTpl: (a: string, b: string | null) => void } }).uartixPlot = {
      removeByTpl,
    };
  } catch {
    return;
  }
})();
