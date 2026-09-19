import * as templateStore from "../protocol/templateStore";
import type { FramesEventPayload } from "../../ipc/types";
import { onFrames } from "../../ipc/framesBus";

export interface VarDef {
  name: string;
  tplId: string;
  fieldId: string;
  kind: "num" | "str";
}

export interface VariableObservation {
  tplId: string;
  fieldId: string;
  value: number;
  /** Local arrival order, independent of parser sequence resets. */
  sequence: number;
  /** Monotonic acquisition time in the performance.now() clock domain. */
  receivedAt: number;
  generation: number;
}

const observationListeners = new Set<(event: VariableObservation) => void>();
let observationSequence = 0;
let observationGeneration = 0;

/** Fresh frame arrivals only: no cached replay and no manual setVar writes. */
export function subscribeObservations(cb: (event: VariableObservation) => void) {
  observationListeners.add(cb);
  return () => {
    observationListeners.delete(cb);
  };
}

export function getObservationGeneration(): number {
  return observationGeneration;
}

let registry: VarDef[] = [];
const byField = new Map<string, Map<string, VarDef>>();
const values = new Map<string, number | string>();
const listeners = new Set<() => void>();
let initialized = false;
let version = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let notifyPending = false;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

function scheduleNotify() {
  if (notifyTimer) {
    notifyPending = true;
    return;
  }
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (notifyPending) {
      notifyPending = false;
      scheduleNotify();
    }
    notify();
  }, 100);
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return version;
}

export function listVars(): VarDef[] {
  return registry;
}

export function getVar(name: string): number | string | undefined {
  return values.get(name);
}

/** 脚本 set(name, v)：手动写入变量（供模板 {name} 插值发送；同名解析帧到达时会被覆盖） */
export function setVar(name: string, value: number | string): void {
  values.set(name, value);
  scheduleNotify();
}

function rebuild() {
  observationGeneration++;
  const used = new Set<string>();
  registry = [];
  byField.clear();
  values.clear();
  const templates = templateStore
    .getSnapshot()
    .rules.templates.filter((t) => t.enabled);
  for (const t of templates) {
    for (const f of t.fields) {
      if (f.role === "header") continue;
      let name = f.name.trim() || f.id;
      const base = name;
      let i = 1;
      while (used.has(name)) {
        name = `${base}_${i++}`;
      }
      used.add(name);
      const def: VarDef = {
        name,
        tplId: t.id,
        fieldId: f.id,
        kind: f.type === "ascii" ? "str" : "num",
      };
      registry.push(def);
      let fields = byField.get(t.id);
      if (!fields) {
        fields = new Map<string, VarDef>();
        byField.set(t.id, fields);
      }
      fields.set(f.id, def);
    }
  }
  notify();
}

export async function init() {
  if (initialized) return;
  initialized = true;
  templateStore.subscribe(rebuild);
  rebuild();
  onFrames((p: FramesEventPayload) => {
    if (byField.size === 0) return;
    let changed = false;
    for (const row of p.rows) {
      if (!row.valid) continue;
      const fields = byField.get(row.tplId);
      if (!fields) continue;
      const receivedAt = performance.now();
      const generation = observationGeneration;
      for (const f of row.fields) {
        let def = fields.get(f.id);
        if (!def && f.id.includes("#") && f.text === null) {
          const baseId = f.id.split("#")[0];
          const base = fields.get(baseId);
          if (base) {
            def = { ...base, fieldId: f.id, name: f.name, kind: "num" };
            fields.set(f.id, def);
            registry.push(def);
            changed = true;
          }
        }
        if (!def) continue;
        const val = def.kind === "str" ? (f.text ?? "") : f.value;
        if (values.get(def.name) !== val) {
          values.set(def.name, val);
          changed = true;
        }
        if (def.kind === "num" && Number.isFinite(f.value)) {
          const event: VariableObservation = {
            tplId: row.tplId,
            fieldId: f.id,
            value: f.value,
            sequence: ++observationSequence,
            receivedAt,
            generation,
          };
          for (const listener of Array.from(observationListeners)) {
            try {
              listener(event);
            } catch {
              // A consumer failure must not interrupt acquisition or other listeners.
            }
          }
        }
      }
    }
    if (changed) scheduleNotify();
  });
}

export function resolveVars(tpl: string): string {
  if (!tpl.includes("{")) return tpl;
  return tpl.replace(/\{([^{}]+)\}/g, (marker: string, expr: string) => {
    const parts = expr.split(":").map((s) => s.trim());
    const name = parts[0];
    const fmt = parts[1] ?? "";
    const v = values.get(name);
    if (v === undefined) return marker;
    if (fmt === "str" || typeof v === "string") return String(v);
    const num = Number(v);
    if (fmt === "d") return String(Math.round(num));
    if (/^\.\d+f$/.test(fmt)) return num.toFixed(parseInt(fmt.slice(1), 10));
    if (/^\d+$/.test(fmt)) return num.toFixed(parseInt(fmt, 10));
    return String(Number(num.toFixed(6)));
  });
}
