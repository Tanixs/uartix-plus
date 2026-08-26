import { listen } from "@tauri-apps/api/event";
import type { FieldDef, FramesEventPayload } from "../../ipc/types";

export type EulerOrder = "XYZ" | "XZY" | "YXZ" | "YZX" | "ZXY" | "ZYX";

export interface AttitudeConfig {
  templateId: string;
  mode: "euler" | "quaternion";
  roll: string;
  pitch: string;
  yaw: string;
  qw: string;
  qx: string;
  qy: string;
  qz: string;
  order: EulerOrder;
  invertX: boolean;
  invertY: boolean;
  invertZ: boolean;
  model: "cube" | "uav";
}

export interface AttitudeValues {
  roll: number;
  pitch: number;
  yaw: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  ts: number;
  has: boolean;
}

export const values: AttitudeValues = {
  roll: 0,
  pitch: 0,
  yaw: 0,
  qw: 1,
  qx: 0,
  qy: 0,
  qz: 0,
  ts: 0,
  has: false,
};

const DEFAULT_CONFIG: AttitudeConfig = {
  templateId: "",
  mode: "euler",
  roll: "",
  pitch: "",
  yaw: "",
  qw: "",
  qx: "",
  qy: "",
  qz: "",
  order: "ZYX",
  invertX: false,
  invertY: false,
  invertZ: false,
  model: "uav",
};

function loadConfig(): AttitudeConfig {
  try {
    const saved = localStorage.getItem("vs.attitude");
    if (saved) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
  } catch {
    localStorage.removeItem("vs.attitude");
  }
  return { ...DEFAULT_CONFIG };
}

let snapshot: { config: AttitudeConfig } = { config: loadConfig() };
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  snapshot = { config: snapshot.config };
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

export function setConfig(patch: Partial<AttitudeConfig>) {
  snapshot = { config: { ...snapshot.config, ...patch } };
  localStorage.setItem("vs.attitude", JSON.stringify(snapshot.config));
  emit();
}

export async function init() {
  if (initialized) return;
  initialized = true;
  await listen<FramesEventPayload>("parser:frames", (e) => {
    const cfg = snapshot.config;
    if (!cfg.templateId) return;
    for (const row of e.payload.rows) {
      if (!row.valid || row.tplId !== cfg.templateId) continue;
      const get = (id: string): number | null => {
        const f = row.fields.find((x) => x.id === id);
        return f ? f.value : null;
      };
      if (cfg.mode === "euler") {
        const r = get(cfg.roll);
        const p = get(cfg.pitch);
        const y = get(cfg.yaw);
        if (r !== null) values.roll = r;
        if (p !== null) values.pitch = p;
        if (y !== null) values.yaw = y;
      } else {
        const w = get(cfg.qw);
        const x = get(cfg.qx);
        const y = get(cfg.qy);
        const z = get(cfg.qz);
        if (w !== null) values.qw = w;
        if (x !== null) values.qx = x;
        if (y !== null) values.qy = y;
        if (z !== null) values.qz = z;
      }
      values.ts = row.tsMs;
      values.has = true;
    }
  });
}

export function autoMatch(fields: FieldDef[]): Partial<AttitudeConfig> {
  const find = (...kws: string[]): string =>
    fields.find((f) =>
      kws.some((k) => f.name.toLowerCase().includes(k.toLowerCase())),
    )?.id ?? "";
  return {
    roll: find("roll", "横滚"),
    pitch: find("pitch", "俯仰"),
    yaw: find("yaw", "航向", "偏航", "heading"),
    qw: find("qw", "q0"),
    qx: find("qx", "q1"),
    qy: find("qy", "q2"),
    qz: find("qz", "q3"),
  };
}
