import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  FieldDef,
  FieldType,
  FramesEventPayload,
  FrameTemplate,
  ParseRules,
} from "../../ipc/types";

export interface HexSelection {
  start: number;
  end: number;
  bytes: number[];
}

export type Selection =
  | { kind: "template"; templateId: string }
  | { kind: "field"; templateId: string; fieldId: string }
  | null;

export interface LatestValue {
  value: number;
  text: string | null;
  ts: number;
  seq: number;
  valid: boolean;
}

export interface ProtocolSnapshot {
  rules: ParseRules;
  selection: Selection;
  hexSelection: HexSelection | null;
  stats: { total: number; errors: number };
  tplStats: Record<string, { ok: number; err: number }>;
  latest: Record<string, LatestValue>;
  locateReq: { seq: number; nonce: number } | null;
  syncError: string | null;
  demoRunning: boolean;
}

export const PALETTE = [
  "#4e9cef",
  "#3fb950",
  "#d29922",
  "#bc8cff",
  "#e5534b",
  "#39c5cf",
  "#f0883e",
  "#db61a2",
];

export const FIELD_SIZES: Record<FieldType, number | null> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
  ascii: null,
  bcd: null,
  bits: 1,
};

export function fieldSize(f: FieldDef): number {
  const fixed = FIELD_SIZES[f.type];
  if (fixed !== null) return fixed;
  return f.size ?? (f.type === "bcd" ? 2 : 4);
}

export const DEMO_RULES: ParseRules = {
  templates: [
    {
      id: "demo-a",
      name: "演示-环境帧",
      color: "#4e9cef",
      enabled: true,
      boundary: {
        mode: "lengthField",
        headerBytes: [0xaa, 0x55],
        lengthOffset: 2,
        lengthSize: 1,
        lengthEndian: "little",
        lengthAdjust: 3,
        maxLength: 512,
      },
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
      fields: [
        { id: "a-seq", name: "序号", role: "seq", offset: 3, type: "uint16", endian: "little", color: "#8ab4f8" },
        { id: "a-temp", name: "温度", role: "data", offset: 5, type: "float32", endian: "little", unit: "°C", color: "#3fb950" },
        { id: "a-hum", name: "湿度", role: "data", offset: 9, type: "float32", endian: "little", unit: "%RH", color: "#d29922" },
      ],
    },
    {
      id: "demo-b",
      name: "演示-姿态帧",
      color: "#e5534b",
      enabled: true,
      boundary: {
        mode: "fixedLength",
        headerBytes: [0xbb, 0x66],
        fixedLength: 12,
        maxLength: 512,
      },
      checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2, endian: "little" },
      fields: [
        { id: "b-seq", name: "序号", role: "seq", offset: 2, type: "uint16", endian: "big", color: "#8ab4f8" },
        { id: "b-roll", name: "Roll", role: "data", offset: 4, type: "int16", endian: "big", scale: 0.1, unit: "°", color: "#3fb950" },
        { id: "b-pitch", name: "Pitch", role: "data", offset: 6, type: "int16", endian: "big", scale: 0.1, unit: "°", color: "#d29922" },
        { id: "b-yaw", name: "Yaw", role: "data", offset: 8, type: "int16", endian: "big", scale: 0.1, unit: "°", color: "#bc8cff" },
      ],
    },
  ],
};

let snapshot: ProtocolSnapshot = {
  rules: { templates: [] },
  selection: null,
  hexSelection: null,
  stats: { total: 0, errors: 0 },
  tplStats: {},
  latest: {},
  locateReq: null,
  syncError: null,
  demoRunning: false,
};

const listeners = new Set<() => void>();
let initialized = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let locateNonce = 0;

function set(patch: Partial<ProtocolSnapshot>) {
  snapshot = { ...snapshot, ...patch };
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

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    localStorage.setItem("vs.rules", JSON.stringify(snapshot.rules));
    try {
      await invoke("parser_set_rules", { rules: snapshot.rules });
      set({ syncError: null });
    } catch (e) {
      set({ syncError: String(e) });
    }
  }, 250);
}

export async function init() {
  if (initialized) return;
  initialized = true;

  await listen<FramesEventPayload>("parser:frames", (e) => {
    const tplStats = { ...snapshot.tplStats };
    const latest = { ...snapshot.latest };
    for (const row of e.payload.rows) {
      const cur = tplStats[row.tplId] ?? { ok: 0, err: 0 };
      tplStats[row.tplId] = row.valid
        ? { ...cur, ok: cur.ok + 1 }
        : { ...cur, err: cur.err + 1 };
      if (row.valid) {
        for (const f of row.fields) {
          latest[f.id] = {
            value: f.value,
            text: f.text,
            ts: row.tsMs,
            seq: row.seq,
            valid: row.valid,
          };
        }
      }
    }
    set({
      stats: { total: e.payload.total, errors: e.payload.errors },
      tplStats,
      latest,
    });
  });

  try {
    const saved = localStorage.getItem("vs.rules");
    if (saved) {
      snapshot = { ...snapshot, rules: JSON.parse(saved) as ParseRules };
    }
  } catch {
    localStorage.removeItem("vs.rules");
  }

  try {
    set({ demoRunning: await invoke<boolean>("demo_running") });
  } catch {
    set({ demoRunning: false });
  }

  scheduleSync();
  set({ rules: snapshot.rules });
}

export function setSelection(sel: Selection) {
  set({ selection: sel });
}

export function setHexSelection(sel: HexSelection | null) {
  set({ hexSelection: sel });
}

export function locate(seq: number) {
  locateNonce += 1;
  set({ locateReq: { seq, nonce: locateNonce } });
}

export function addTemplate(headerBytes: number[]): string {
  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name: `模板${snapshot.rules.templates.length + 1}`,
    color: PALETTE[snapshot.rules.templates.length % PALETTE.length],
    enabled: true,
    boundary: {
      mode: "fixedLength",
      headerBytes,
      fixedLength: headerBytes.length + 8,
      maxLength: 512,
    },
    checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
    fields: [],
  };
  set({
    rules: { templates: [...snapshot.rules.templates, tpl] },
    selection: { kind: "template", templateId: tpl.id },
  });
  scheduleSync();
  return tpl.id;
}

export function removeTemplate(id: string) {
  set({
    rules: { templates: snapshot.rules.templates.filter((t) => t.id !== id) },
    selection: null,
  });
  scheduleSync();
}

export function patchTemplate(id: string, patch: Partial<FrameTemplate>) {
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    },
  });
  scheduleSync();
}

export function patchBoundary(
  id: string,
  patch: Partial<FrameTemplate["boundary"]>,
) {
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === id ? { ...t, boundary: { ...t.boundary, ...patch } } : t,
      ),
    },
  });
  scheduleSync();
}

export function patchChecksum(
  id: string,
  patch: Partial<NonNullable<FrameTemplate["checksum"]>>,
) {
  const tpl = snapshot.rules.templates.find((t) => t.id === id);
  if (!tpl) return;
  const checksum = { ...(tpl.checksum ?? { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" }), ...patch };
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === id ? { ...t, checksum } : t,
      ),
    },
  });
  scheduleSync();
}

export function addField(templateId: string, field: FieldDef) {
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === templateId ? { ...t, fields: [...t.fields, field] } : t,
      ),
    },
    selection: { kind: "field", templateId, fieldId: field.id },
  });
  scheduleSync();
}

export function patchField(
  templateId: string,
  fieldId: string,
  patch: Partial<FieldDef>,
) {
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === templateId
          ? {
              ...t,
              fields: t.fields.map((f) =>
                f.id === fieldId ? { ...f, ...patch } : f,
              ),
            }
          : t,
      ),
    },
  });
  scheduleSync();
}

export function removeField(templateId: string, fieldId: string) {
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === templateId
          ? { ...t, fields: t.fields.filter((f) => f.id !== fieldId) }
          : t,
      ),
    },
    selection:
      snapshot.selection?.kind === "field" &&
      snapshot.selection.fieldId === fieldId
        ? { kind: "template", templateId }
        : snapshot.selection,
  });
  scheduleSync();
}

export function loadDemoRules() {
  const rules = JSON.parse(JSON.stringify(DEMO_RULES)) as ParseRules;
  set({ rules, selection: null });
  scheduleSync();
}

export async function toggleDemo(): Promise<void> {
  if (snapshot.demoRunning) {
    await invoke("demo_stop");
    set({ demoRunning: false });
  } else {
    await invoke("demo_start");
    set({ demoRunning: true });
  }
}
