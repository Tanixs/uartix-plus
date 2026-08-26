import { listen } from "@tauri-apps/api/event";
import * as templateStore from "../protocol/templateStore";
import type { FramesEventPayload } from "../../ipc/types";

export interface VarDef {
  name: string;
  tplId: string;
  fieldId: string;
  kind: "num" | "str";
}

let registry: VarDef[] = [];
const values = new Map<string, number | string>();
const listeners = new Set<() => void>();
let initialized = false;
let version = 0;

function notify() {
  version++;
  listeners.forEach((l) => l());
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

function rebuild() {
  const used = new Set<string>();
  registry = [];
  values.clear();
  const templates = templateStore
    .getSnapshot()
    .rules.templates.filter((t) => t.enabled);
  for (const t of templates) {
    for (const f of t.fields) {
      let name = f.name.trim() || f.id;
      const base = name;
      let i = 1;
      while (used.has(name)) {
        name = `${base}_${i++}`;
      }
      used.add(name);
      registry.push({
        name,
        tplId: t.id,
        fieldId: f.id,
        kind: f.type === "ascii" ? "str" : "num",
      });
    }
  }
  notify();
}

export async function init() {
  if (initialized) return;
  initialized = true;
  templateStore.subscribe(rebuild);
  rebuild();
  await listen<FramesEventPayload>("parser:frames", (e) => {
    if (registry.length === 0) return;
    let changed = false;
    for (const row of e.payload.rows) {
      if (!row.valid) continue;
      for (const f of row.fields) {
        const def = registry.find((v) => v.fieldId === f.id);
        if (!def) continue;
        const val = def.kind === "str" ? (f.text ?? "") : f.value;
        if (values.get(def.name) !== val) {
          values.set(def.name, val);
          changed = true;
        }
      }
    }
    if (changed) notify();
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
