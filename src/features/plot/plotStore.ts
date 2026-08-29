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

export function buildAligned(): {
  x: number[];
  cols: (number | null)[][];
} {
  const chans = channels;
  const events: { t: number; ci: number; v: number; seq: number }[] = [];
  for (let ci = 0; ci < chans.length; ci++) {
    const d = getChanData(chans[ci].id);
    for (let i = 0; i < d.t.length; i++) {
      events.push({ t: d.t[i], ci, v: d.v[i], seq: i });
    }
  }
  events.sort((a, b) => a.t - b.t || a.ci - b.ci || a.seq - b.seq);
  const x: number[] = [];
  const cols: (number | null)[][] = chans.map(() => []);
  const lastV: (number | null)[] = chans.map(() => null);
  let last = -Infinity;
  for (const ev of events) {
    let t = ev.t;
    if (t <= last) t = last + 0.001;
    last = t;
    lastV[ev.ci] = ev.v;
    x.push(t);
    for (let j = 0; j < chans.length; j++) {
      cols[j].push(lastV[j]);
    }
  }
  const xsrc = settings.xSource;
  let outX = x;
  if (xsrc === "index") {
    outX = x.map((_, i) => i);
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
