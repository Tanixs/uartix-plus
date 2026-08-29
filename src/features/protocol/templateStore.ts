import { invoke } from "@tauri-apps/api/core";
import type {
  FieldDef,
  FieldType,
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

export interface ProtocolSnapshot {
  rules: ParseRules;
  selection: Selection;
  hexSelection: HexSelection | null;
  locateReq: { seq: number; nonce: number } | null;
  syncError: string | null;
  demoRunning: boolean;
  undoStack: string[];
  redoStack: string[];
  grpRev: number;
}

export interface GroupMeta {
  name: string;
  color?: string;
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
  csv: null,
};

export function fieldSize(f: FieldDef): number {
  if (f.type === "csv") return 1;
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
      presetKey: "demo",
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
      presetKey: "demo",
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
  locateReq: null,
  syncError: null,
  demoRunning: false,
  undoStack: [],
  redoStack: [],
  grpRev: 0,
};

const listeners = new Set<() => void>();
let initialized = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let locateNonce = 0;
let grpUid = 0;

function set(patch: Partial<ProtocolSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

function pushHistory() {
  const rs = JSON.stringify(snapshot.rules);
  const stack = snapshot.undoStack;
  if (stack[stack.length - 1] === rs) return;
  set({
    undoStack: [...stack, rs].slice(-50),
    redoStack: [],
  });
}

export function undo() {
  const { undoStack, redoStack } = snapshot;
  if (undoStack.length === 0) return;
  const last = undoStack[undoStack.length - 1];
  const cur = JSON.stringify(snapshot.rules);
  if (last === cur) {
    set({ undoStack: undoStack.slice(0, -1) });
    return;
  }
  set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, cur] });
  set({ rules: JSON.parse(last) });
  scheduleSync();
}

export function redo() {
  const { undoStack, redoStack } = snapshot;
  const next = redoStack[redoStack.length - 1];
  if (!next) return;
  const cur = JSON.stringify(snapshot.rules);
  set({
    redoStack: redoStack.slice(0, -1),
    undoStack: [...undoStack, cur],
  });
  set({ rules: JSON.parse(next) });
  scheduleSync();
}

const GRPS_KEY = "vs.grps";
let grpMeta: Record<string, GroupMeta> = (() => {
  try {
    return JSON.parse(localStorage.getItem(GRPS_KEY) ?? "{}") as Record<string, GroupMeta>;
  } catch {
    return {};
  }
})();

export function setGroupMeta(key: string, meta: Partial<GroupMeta>) {
  const cur = grpMeta[key] ?? { name: key };
  grpMeta = { ...grpMeta, [key]: { ...cur, ...meta } };
  try {
    localStorage.setItem(GRPS_KEY, JSON.stringify(grpMeta));
  } catch {
    return;
  }
  set({ grpRev: snapshot.grpRev + 1 });
}

export function getGroupMeta(key: string): GroupMeta | null {
  return grpMeta[key] ?? null;
}

export function exportTemplatesWithMeta(): {
  templates: FrameTemplate[];
  groups: Record<string, GroupMeta>;
} {
  return {
    templates: structuredClone(snapshot.rules.templates),
    groups: structuredClone(grpMeta),
  };
}

export function importGroupsMeta(meta: Record<string, GroupMeta>) {
  for (const [k, v] of Object.entries(meta)) {
    if (!grpMeta[k]) setGroupMeta(k, v);
  }
}

let tplClip: FrameTemplate | null = null;

export function canPaste(): boolean {
  return tplClip !== null;
}

export function copyTpl(tplId: string): boolean {
  const t = snapshot.rules.templates.find((x) => x.id === tplId);
  if (!t) return false;
  tplClip = structuredClone(t);
  return true;
}

export function pasteTpl(groupKey: string): string | null {
  if (!tplClip) return null;
  pushHistory();
  const dup = structuredClone(tplClip);
  dup.id = crypto.randomUUID();
  dup.name = `${dup.name.replace(/\s*\(副本\)\s*$/, "")} (副本)`;
  dup.groupKey = groupKey;
  set({
    rules: { templates: [...snapshot.rules.templates, dup] },
    selection: { kind: "template", templateId: dup.id },
  });
  scheduleSync();
  return dup.id;
}

function stripClusterSuffix(n: string): string {
  return n.replace(/\s*·帧型\d+\s*$/, "");
}

export function createCluster(name: string, count: number, len: number): string {
  pushHistory();
  const grpKey = `usr-${Date.now().toString(36)}-${(grpUid++).toString(36)}`;
  setGroupMeta(grpKey, { name });
  const tpls: FrameTemplate[] = Array.from({ length: Math.max(1, Math.min(64, count)) }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `${newName(name)}·帧型${i + 1}`,
    color: PALETTE[(snapshot.rules.templates.length + i) % PALETTE.length],
    enabled: false,
    boundary: {
      mode: "fixedLength",
      headerBytes: [],
      fixedLength: len,
      maxLength: 256,
    },
    checksum: null,
    fields: [],
    groupKey: grpKey,
  }));
  set({
    rules: { templates: [...snapshot.rules.templates, ...tpls] },
    selection: { kind: "template", templateId: tpls[0].id },
  });
  scheduleSync();
  return tpls[0].id;
}

function newName(base: string): string {
  const taken = new Set(snapshot.rules.templates.map((t) => stripClusterSuffix(t.name)));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

export function createCsvTemplate(delim: string, elemType: string, lineEnd: string): string {
  pushHistory();
  const footer =
    lineEnd === "CRLF" ? [0x0d, 0x0a] : lineEnd === "CR" ? [0x0d] : lineEnd === "TAB" ? [0x09] : [0x0a];
  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name: newName("自适应文本帧"),
    color: "#39c5cf",
    enabled: true,
    boundary: {
      mode: "footer",
      headerBytes: [],
      footerBytes: footer,
      maxLength: 512,
    },
    checksum: null,
    fields: [
      {
        id: crypto.randomUUID(),
        name: "通道",
        role: "data",
        offset: 0,
        type: "csv",
        endian: "little",
        color: "#3fb950",
        csvDelim: delim,
        csvType: elemType,
      },
    ],
    presetKey: null,
  };
  set({
    rules: { templates: [...snapshot.rules.templates, tpl] },
    selection: { kind: "template", templateId: tpl.id },
  });
  scheduleSync();
  return tpl.id;
}

export function renameGroup(key: string, name: string) {
  const tpls = snapshot.rules.templates.filter((t) => (t.presetKey ?? t.groupKey) === key);
  if (tpls.length === 0) {
    setGroupMeta(key, { name });
    return;
  }
  pushHistory();
  setGroupMeta(key, { name });
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) => {
        if ((t.presetKey ?? t.groupKey) !== key) return t;
        if (t.presetKey) return t;
        const m = t.name.match(/^(.*?)·帧型(\d+)$/);
        if (!m) return t;
        return { ...t, name: `${name}·帧型${m[2]}` };
      }),
    },
  });
  scheduleSync();
}

export function setGroupEnabled(key: string, enabled: boolean, keyOf: (t: FrameTemplate) => string) {
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        keyOf(t) === key ? { ...t, enabled } : t,
      ),
    },
  });
  scheduleSync();
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
  syncTimer = setTimeout(flushRules, 250);
}

async function flushRules(): Promise<boolean> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  localStorage.setItem("vs.rules", JSON.stringify(snapshot.rules));
  try {
    await invoke("parser_set_rules", { rules: snapshot.rules });
    set({ syncError: null });
    return true;
  } catch (e) {
    set({ syncError: String(e) });
    return false;
  }
}

export async function saveNow(): Promise<boolean> {
  const ok = await flushRules();
  return ok;
}

export async function init() {
  if (initialized) return;
  initialized = true;

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
  pushHistory();
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

export function createBlankTemplate(len: number): string {
  pushHistory();
  const n = snapshot.rules.templates.filter((t) => t.presetKey === null || t.presetKey === undefined).length + 1;
  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name: `协议 ${n}`,
    color: PALETTE[snapshot.rules.templates.length % PALETTE.length],
    enabled: false,
    boundary: {
      mode: "fixedLength",
      headerBytes: [],
      fixedLength: len,
      maxLength: 256,
    },
    checksum: null,
    fields: [],
    presetKey: null,
  };
  set({
    rules: { templates: [...snapshot.rules.templates, tpl] },
    selection: { kind: "template", templateId: tpl.id },
  });
  scheduleSync();
  return tpl.id;
}

export function importTemplates(tpls: FrameTemplate[], presetKey?: string | null) {
  if (tpls.length === 0) return;
  pushHistory();
  const names = new Set(snapshot.rules.templates.map((t) => t.name));
  const renamed = tpls.map((t) => {
    let base = t;
    if (presetKey !== undefined) {
      base = { ...t, presetKey: presetKey ?? null };
    }
    if (!names.has(base.name)) return base;
    let i = 2;
    while (names.has(`${base.name} (${i})`)) i++;
    return { ...base, name: `${base.name} (${i})` };
  });
  set({
    rules: { templates: [...snapshot.rules.templates, ...renamed] },
    selection: { kind: "template", templateId: renamed[renamed.length - 1].id },
  });
  scheduleSync();
}

export function removeTemplate(id: string) {
  pushHistory();
  plotCleanup(id, null);
  set({
    rules: { templates: snapshot.rules.templates.filter((t) => t.id !== id) },
    selection: null,
  });
  scheduleSync();
}

export function replaceRules(templates: FrameTemplate[]) {
  pushHistory();
  set({ rules: { templates } });
  scheduleSync();
}

export function patchTemplate(id: string, patch: Partial<FrameTemplate>) {
  pushHistory();
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
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === id ? { ...t, boundary: { ...t.boundary, ...patch } } : t,
      ),
    },
  });
  scheduleSync();
}

export function setFieldDisc(
  tplId: string,
  fieldId: string,
  bytes: number[] | null,
) {
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === tplId
          ? {
              ...t,
              boundary: {
                ...t.boundary,
                discOffset: null,
                discValue: null,
                discs: null,
              },
              fields: t.fields.map((f) =>
                f.id === fieldId ? { ...f, disc: bytes } : f,
              ),
            }
          : t,
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
  pushHistory();
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
  pushHistory();
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
  pushHistory();
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
  pushHistory();
  plotCleanup(templateId, fieldId);
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
  pushHistory();
  const rules = JSON.parse(JSON.stringify(DEMO_RULES)) as ParseRules;
  set({ rules, selection: null });
  scheduleSync();
}

function plotCleanup(tplId: string, fieldId: string | null) {
  try {
    const plot = (window as unknown as { uartixPlot?: { removeByTpl: (a: string, b: string | null) => void } }).uartixPlot;
    plot?.removeByTpl(tplId, fieldId);
  } catch {
    return;
  }
}export async function toggleDemo(): Promise<void> {
  if (snapshot.demoRunning) {
    await invoke("demo_stop");
    set({ demoRunning: false });
  } else {
    await invoke("demo_start");
    set({ demoRunning: true });
  }
}
