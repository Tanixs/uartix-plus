import { listen } from "@tauri-apps/api/event";
import type { FramesEventPayload } from "../../ipc/types";
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
  /** 双游标测量模式 */
  cursors: boolean;
  /** 游标方向：x=竖线测 Δt，y=横线测 ΔV */
  cursorMode: "x" | "y";
}

export interface PlotSnapshot {
  channels: Channel[];
  settings: PlotSettings;
}

export const MAX_POINTS = 30000;

let channels: Channel[] = [];
let settings: PlotSettings = {
  yMode: "auto",
  grid: true,
  xSource: "time",
  plotMode: "line",
  lineWidth: 2,
  lineStyle: "linear",
  stack: false,
  cursors: false,
  cursorMode: "x",
};
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

export function getChanData(id: string): ChanData {
  let d = dataMap.get(id);
  if (!d) {
    d = { t: [], v: [] };
    dataMap.set(id, d);
  }
  return d;
}

function appendPoint(chId: string, t: number, v: number) {
  const d = getChanData(chId);
  d.t.push(t);
  d.v.push(v);
  dirty = true;
  if (d.t.length > MAX_POINTS) {
    const keep = d.t.length - Math.floor(d.t.length / 2);
    d.t = d.t.slice(d.t.length - keep);
    d.v = d.v.slice(d.v.length - keep);
    dataMap.set(chId, d);
  }
}

export function buildAligned(maxPoints = 0): {
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
  const xsrc = settings.xSource;
  let outX = x;
  if (xsrc === "index") {
    outX = x.map((_, i) => i);
  } else if (xsrc === "time") {
    outX = x.map((v) => v / 1000);
  } else if (xsrc.startsWith("ch:")) {
    const ci = chans.findIndex((c) => c.id === xsrc.slice(3));
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
      outX = xs;
    }
  }
  return { x: outX, cols };
}

export async function init() {
  if (initialized) return;
  initialized = true;
  await listen<FramesEventPayload>("parser:frames", (e) => {
    if (channels.length === 0) return;
    for (const row of e.payload.rows) {
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
  emit();
}

export function nextColor(): string {
  return PALETTE[channels.length % PALETTE.length];
}

export function setSetting(patch: Partial<PlotSettings>) {
  settings = { ...settings, ...patch };
  emit();
}

/** 图例点击聚焦：solo 该通道或恢复全部 */
export function toggleSolo(id: string) {
  const vis = channels.filter((c) => c.visible);
  const isSolo = vis.length === 1 && vis[0].id === id;
  channels = channels.map((c) => ({ ...c, visible: isSolo ? true : c.id === id }));
  dirty = true;
  emit();
}

export function sampleRate(id: string): number {
  const d = dataMap.get(id);
  if (!d || d.t.length < 2) return 0;
  const span = d.t[d.t.length - 1] - d.t[0];
  if (span <= 0) return 0;
  return ((d.t.length - 1) / span) * 1000;
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
