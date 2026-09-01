import type { FieldDef, FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";

export type EulerOrder = "XYZ" | "XZY" | "YXZ" | "YZX" | "ZXY" | "ZYX";

/** 变量引用：指向某个模板下的某个字段（7 个选择器可各自跨模板绑定） */
export interface FieldRef {
  tplId: string;
  fieldId: string;
}

export type BindKey = "roll" | "pitch" | "yaw" | "qw" | "qx" | "qy" | "qz";

export interface AttitudeConfig {
  /** 默认模板：自动匹配来源，也是旧版单 fieldId 配置的迁移目标 */
  templateId: string;
  mode: "euler" | "quaternion";
  roll: FieldRef | null;
  pitch: FieldRef | null;
  yaw: FieldRef | null;
  qw: FieldRef | null;
  qx: FieldRef | null;
  qy: FieldRef | null;
  qz: FieldRef | null;
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
  roll: null,
  pitch: null,
  yaw: null,
  qw: null,
  qx: null,
  qy: null,
  qz: null,
  order: "ZYX",
  invertX: false,
  invertY: false,
  invertZ: false,
  model: "uav",
};

/** 旧配置（roll 等为单 fieldId 字符串）迁移为 {tplId, fieldId}，映射到当时的默认模板 */
function migrateRef(v: unknown, tplId: string): FieldRef | null {
  if (typeof v === "string") {
    return v && tplId ? { tplId, fieldId: v } : null;
  }
  if (v && typeof v === "object") {
    const r = v as Partial<FieldRef>;
    if (typeof r.tplId === "string" && r.tplId && typeof r.fieldId === "string" && r.fieldId) {
      return { tplId: r.tplId, fieldId: r.fieldId };
    }
  }
  return null;
}

function loadConfig(): AttitudeConfig {
  try {
    const saved = localStorage.getItem("vs.attitude");
    if (saved) {
      const raw = JSON.parse(saved) as Record<string, unknown>;
      const tplId = typeof raw.templateId === "string" ? raw.templateId : "";
      const cfg: AttitudeConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        templateId: tplId,
        roll: migrateRef(raw.roll, tplId),
        pitch: migrateRef(raw.pitch, tplId),
        yaw: migrateRef(raw.yaw, tplId),
        qw: migrateRef(raw.qw, tplId),
        qx: migrateRef(raw.qx, tplId),
        qy: migrateRef(raw.qy, tplId),
        qz: migrateRef(raw.qz, tplId),
      };
      localStorage.setItem("vs.attitude", JSON.stringify(cfg));
      return cfg;
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
  onFrames((ev: FramesEventPayload) => {
    // 面板关闭 → 完全停止解析绑定变量（关闭了的面板绝不允许后台运行）
    if (!panelActivity.isOpen("view3d")) return;
    const cfg = snapshot.config;
    const refs =
      cfg.mode === "euler"
        ? [cfg.roll, cfg.pitch, cfg.yaw]
        : [cfg.qw, cfg.qx, cfg.qy, cfg.qz];
    const tplIds = new Set<string>();
    for (const r of refs) if (r) tplIds.add(r.tplId);
    if (tplIds.size === 0) return;
    for (const row of ev.rows) {
      if (!row.valid || !tplIds.has(row.tplId)) continue;
      const get = (ref: FieldRef | null): number | null => {
        if (!ref || ref.tplId !== row.tplId) return null;
        const f = row.fields.find((x) => x.id === ref.fieldId);
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

export function autoMatch(tplId: string, fields: FieldDef[]): Partial<AttitudeConfig> {
  const find = (...kws: string[]): FieldRef | null => {
    const f = fields.find((x) =>
      kws.some((k) => x.name.toLowerCase().includes(k.toLowerCase())),
    );
    return f ? { tplId, fieldId: f.id } : null;
  };
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
