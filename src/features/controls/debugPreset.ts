import type { ControlCard } from "./controlsStore";

export const DEBUG_SCHEMA = "vs-control-debug/v1";
export type DebugRole = "parameter" | "readback" | "mode" | "record.start" | "record.stop" | "annotate" | "emergency" | "calibrate" | "blocked";
export interface ManagedControl {
  schema: typeof DEBUG_SCHEMA;
  role: DebugRole;
  paramId: string;
}
export interface DebugProfile {
  schema: typeof DEBUG_SCHEMA;
  version: 1;
}
/** 页面级标记的防御性清洗：形状不对就当普通页，卡片级 managed 已各自 fail-closed。 */
export function sanitizeDebugProfile(raw: unknown): DebugProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return r.schema === DEBUG_SCHEMA && r.version === 1
    ? { schema: DEBUG_SCHEMA, version: 1 }
    : undefined;
}
export interface DebugParameter {
  id: string;
  name: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
}
export const DEBUG_ROLES: DebugRole[] = ["parameter", "readback", "mode", "record.start", "record.stop", "annotate", "emergency", "calibrate", "blocked"];

export function sanitizeManaged(raw: unknown): ManagedControl | undefined {
  if (raw === undefined) return undefined;
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  // Invalid imported management metadata must not fall back to an ordinary sending card.
  if (r.schema !== DEBUG_SCHEMA || !DEBUG_ROLES.includes(r.role as DebugRole) || typeof r.paramId !== "string" || r.paramId.length > 64)
    return { schema: DEBUG_SCHEMA, role: "blocked", paramId: "" };
  return { schema: DEBUG_SCHEMA, role: r.role as DebugRole, paramId: r.paramId };
}

export function validateDebugParameters(parameters: DebugParameter[]): void {
  if (!parameters.length || parameters.length > 32) throw new Error("参数数量必须为 1–32 / Select 1–32 parameters");
  const ids = new Set<string>();
  for (const p of parameters) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.id) || ids.has(p.id) || !p.name.trim() || p.name.length > 64)
      throw new Error("参数标识或名称无效 / Invalid parameter ID or name");
    ids.add(p.id);
    if (![p.min, p.max, p.step, p.value].every(Number.isFinite) || p.min >= p.max || p.step <= 0 || p.step > p.max - p.min || p.value < p.min || p.value > p.max)
      throw new Error(`${p.name}: 范围/步进/初值无效 / Invalid range, step or initial value`);
    const ticks = (p.value - p.min) / p.step;
    if (Math.abs(ticks - Math.round(ticks)) > 1e-7 * Math.max(1, Math.abs(ticks)))
      throw new Error(`${p.name}: 初值不符合步进 / Initial value is off step`);
  }
}

export function buildDebugPreset(name: string, parameters: DebugParameter[], uuid = () => crypto.randomUUID()) {
  validateDebugParameters(parameters);
  if (!name.trim() || name.trim().length > 24) throw new Error("页面名称须为 1–24 字符 / Page name must have 1–24 characters");
  if (parameters.length > 12) throw new Error("预设页面最多 12 个参数 / Up to 12 parameters per preset page");
  const cards: ControlCard[] = [];
  const managed = (role: DebugRole, paramId = ""): ManagedControl => ({ schema: DEBUG_SCHEMA, role, paramId });
  for (const [i, p] of parameters.entries()) {
    cards.push({ id: uuid(), type: "slider", name: p.name, x: 0, y: i * 3, w: 8, h: 3,
      template: "", sendMode: "ascii", min: p.min, max: p.max, step: p.step, defaultValue: p.value,
      sendTrigger: "onRelease", minIntervalMs: 200, useScript: false, script: "", managed: managed("parameter", p.id) });
    cards.push({ id: uuid(), type: "monitor", name: `${p.name} · ${p.unit || "raw"}`, x: 8, y: i * 3, w: 4, h: 3,
      varName: "", unit: p.unit, decimals: 3, managed: managed("readback", p.id) });
  }
  const y = parameters.length * 3;
  const actions: { role: DebugRole; name: string }[] = [
    { role: "mode", name: "模式 / Mode" }, { role: "record.start", name: "开始录制 / Record" },
    { role: "record.stop", name: "停止录制 / Stop record" }, { role: "annotate", name: "打点 / Annotate" },
    { role: "emergency", name: "急停未配置 / Stop unconfigured" }, { role: "calibrate", name: "校准未配置 / Calibration unconfigured" },
  ];
  actions.forEach((a, i) => cards.push({ id: uuid(), type: "button", name: a.name,
    x: (i % 3) * 4, y: y + Math.floor(i / 3) * 2, w: 4, h: 2, template: "", sendMode: "ascii",
    holdRepeat: false, minIntervalMs: 200, useScript: false, script: "", managed: managed(a.role) }));
  return { name: name.trim(), cols: 12, rows: y + 4, cards, debugProfile: { schema: DEBUG_SCHEMA, version: 1 } as DebugProfile };
}
