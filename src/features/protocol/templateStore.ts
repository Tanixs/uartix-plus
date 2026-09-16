import { invoke } from "@tauri-apps/api/core";
import { tx } from "../../i18n/strings";
import { guardLocked } from "../operator/lock";
import { dropFieldValues } from "./telemetryStore";
import { fieldSize } from "./fieldTypes";
import { checksumTail, effRange, footerTail } from "../framecanvas/frameLayout";
import type {
  ChecksumAlgo,
  FieldDef,
  FieldRole,
  FieldType,
  FrameTemplate,
  ParseRules,
} from "../../ipc/types";
export { FIELD_SIZES, fieldSize } from "./fieldTypes";

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
  revealReq: { tplId: string; fieldId: string; nonce: number } | null;
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

/** Okabe-Ito 色觉友好色板（P55）：红绿色盲等类型下仍可区分；末位黑改中性灰以兼容暗色主题 */
export const OKABE_PALETTE = [
  "#E69F00",
  "#56B4E9",
  "#009E73",
  "#F0E442",
  "#0072B2",
  "#D55E00",
  "#CC79A7",
  "#BBBBBB",
];

export interface ConflictInfo {
  overFrame?: string;
  overlapName?: string;
  overlapBytes?: number;
  overTail?: { kind: "checksum" | "footer"; bytes: number };
  overHeader?: number;
}

/** 字段/选区冲突统一检测（P85a）：按有效区间比较——负偏移按帧尾锚定解析、
 *  变长帧校验字段按引擎重锚定；帧头之后的 reservedTail 为保护区。
 *  frameLen：当前视图帧长（变长模式用于解析负偏移/尾部区；未知传 0 则跳过相应判定）。
 *  selfType：候选字段类型——双方都是 bits 的同字节重叠是位段分解的合法用法，免确认。 */
export function fieldConflictInfo(
  tplId: string,
  fieldId: string,
  nextOffset: number,
  nextSize: number,
  opts?: { frameLen?: number; selfType?: FieldType; selfRole?: FieldRole },
): ConflictInfo {
  const t = snapshot.rules.templates.find((x) => x.id === tplId);
  if (!t) return {};
  const b = t.boundary;
  const fl = b.mode === "fixedLength" ? (b.fixedLength ?? 0) : (opts?.frameLen ?? 0);
  const cap = b.mode === "fixedLength" ? (b.fixedLength ?? 0) : (b.maxLength ?? 512);
  const res: ConflictInfo = {};
  const cs = nextOffset < 0 && fl > 0 ? fl + nextOffset : nextOffset;
  const ce = cs + nextSize;
  if (cap > 0 && cs >= 0 && ce > cap) {
    res.overFrame = tx(
      `字段将延伸到 ${ce} B，超出帧长 ${cap} B`,
      `Field extends to ${ce} B, beyond frame length ${cap} B`,
    );
  }
  const hbLen = b.headerBytes.length;
  if (cs >= 0 && cs < ce && cs < hbLen) {
    let ovH = Math.min(ce, hbLen) - cs;
    const exH = t.fields.find((f) => f.id === fieldId);
    if (exH && exH.offset >= 0) {
      ovH = Math.max(0, ovH - Math.max(0, Math.min(exH.offset + fieldSize(exH), hbLen) - exH.offset));
    }
    if (ovH > 0) res.overHeader = ovH;
  }
  const hits: { name: string; start: number; end: number; bits: boolean }[] = [];
  for (const f of t.fields) {
    if (f.id === fieldId) continue;
    if (f.offset < 0 && fl <= 0) {
      if (nextOffset < 0) {
        const s = f.offset;
        const e = f.offset + fieldSize(f);
        if (Math.min(ce, e) > Math.max(cs, s))
          hits.push({ name: f.name, start: s, end: e, bits: f.type === "bits" });
      }
      continue;
    }
    const er = effRange(t, f, fl);
    if (!er || er.len <= 0) continue;
    const s = er.start;
    const e = er.start + er.len;
    if (Math.min(ce, e) > Math.max(cs, s))
      hits.push({ name: f.name, start: s, end: e, bits: f.type === "bits" });
  }
  const rt = checksumTail(t) + footerTail(t);
  const existing = t.fields.find((f) => f.id === fieldId);
  const selfIsTail =
    opts?.selfRole === "checksum" ||
    opts?.selfRole === "checksum2" ||
    opts?.selfRole === "footer" ||
    existing?.role === "checksum" ||
    existing?.role === "checksum2" ||
    existing?.role === "footer";
  if (rt > 0 && fl > 0 && cs < fl && !selfIsTail) {
    const ts = fl - rt;
    const ov = Math.min(ce, fl) - Math.max(cs, ts);
    let ovEx = 0;
    if (existing) {
      const er = effRange(t, existing, fl);
      if (er) ovEx = Math.max(0, Math.min(er.start + er.len, fl) - Math.max(er.start, ts));
    }
    if (ov > ovEx) {
      res.overTail = { kind: footerTail(t) > 0 ? "footer" : "checksum", bytes: ov };
    }
  }
  if (hits.length > 0 && !(opts?.selfType === "bits" && hits.every((x) => x.bits))) {
    const nf = [...hits].sort((a, x) => a.start - x.start)[0];
    res.overlapName = nf.name;
    res.overlapBytes = Math.min(ce, nf.end) - Math.max(cs, nf.start);
  }
  return res;
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
  revealReq: null,
};

const listeners = new Set<() => void>();
let initialized = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let locateNonce = 0;
let grpUid = 0;

function set(patch: Partial<ProtocolSnapshot>) {
  // Operator 只读（P67）：规则/分组属配置内容，锁定时拒绝变更；选择/悬停等视图态放行
  if ("rules" in patch && guardLocked()) return;
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

/** 结构发现「按簇建模板」（P56b）：每个帧型一条模板（帧头+定长+sum8 占位），归入同一簇 */
export function createClusterFromFrames(
  name: string,
  frames: { header: number[]; len: number }[],
): string {
  pushHistory();
  const grpKey = `usr-${Date.now().toString(36)}-${(grpUid++).toString(36)}`;
  setGroupMeta(grpKey, { name });
  const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
  const base = newName(name);
  const tpls: FrameTemplate[] = frames.map((f, i) => ({
    id: crypto.randomUUID(),
    name: `${base}·${f.header.map(hex2).join(" ")}`,
    color: PALETTE[(snapshot.rules.templates.length + i) % PALETTE.length],
    enabled: false,
    boundary: {
      mode: "fixedLength",
      headerBytes: f.header,
      fixedLength: f.len,
      maxLength: 512,
    },
    checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1, endian: "little" },
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

/** 向已有簇追加一条帧型（P56b：帧画布/模板面板的「添加帧型」入口），边界沿用簇内首条便于起步 */
export function addClusterFrame(grpKey: string): string {
  pushHistory();
  const inGrp = snapshot.rules.templates.filter((t) => t.groupKey === grpKey);
  const meta = grpMeta[grpKey];
  const base = inGrp[0];
  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name: meta ? `${newName(meta.name)}·帧型${inGrp.length + 1}` : `帧型${inGrp.length + 1}`,
    color: PALETTE[snapshot.rules.templates.length % PALETTE.length],
    enabled: false,
    boundary: base
      ? { ...base.boundary, headerBytes: [...base.boundary.headerBytes] }
      : { mode: "fixedLength", headerBytes: [], fixedLength: 8, maxLength: 256 },
    checksum: base?.checksum ? { ...base.checksum } : null,
    fields: [],
    groupKey: grpKey,
  };
  set({
    rules: { templates: [...snapshot.rules.templates, tpl] },
    selection: { kind: "template", templateId: tpl.id },
  });
  scheduleSync();
  return tpl.id;
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

function humanizeRulesError(raw: string): string {
  const s = raw.replace(/^invalid args `rules` for command `parser_set_rules`:\s*/, "")
    .replace(/^Error:\s*/, "");
  const map: [RegExp, string][] = [
    [/invalid type: null, expected a sequence/, "识别位列表为空值（旧版数据残留），请重新开关一次帧识别位"],
    [/missing field `(\w+)`/, "缺少必需字段 $1"],
    [/invalid type: [^,]+, expected/, "字段类型不匹配"],
  ];
  for (const [re, msg] of map) {
    if (re.test(s)) return s.replace(re, msg);
  }
  return s;
}

async function flushRules(): Promise<boolean> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  try {
    snapshot = { ...snapshot, rules: sanitizeRules(snapshot.rules) };
  } catch {
    /* noop */
  }
  localStorage.setItem("vs.rules", JSON.stringify(snapshot.rules));
  try {
    await invoke("parser_set_rules", { rules: snapshot.rules });
    set({ syncError: null });
    return true;
  } catch (e) {
    set({ syncError: humanizeRulesError(String(e)) });
    return false;
  }
}

export async function saveNow(): Promise<boolean> {
  const ok = await flushRules();
  return ok;
}

function sanitizeRules(rs: ParseRules): ParseRules {
  return {
    templates: (rs.templates ?? []).map((t) => ({
      ...t,
      boundary: {
        ...t.boundary,
        headerBytes: t.boundary.headerBytes ?? [],
        maxLength: t.boundary.maxLength ?? 512,
        discs: t.boundary.discs ?? [],
      },
      fields: dedupeTwinFields(t.fields ?? []).map((f) => ({ ...f })),
    })),
  };
}

function dedupeTwinFields(fs: FieldDef[]): FieldDef[] {
  const out: FieldDef[] = [];
  for (const f of fs) {
    const twin = out.some(
      (g) =>
        g.offset === f.offset &&
        g.name === f.name &&
        g.type === f.type &&
        (g.endian ?? null) === (f.endian ?? null) &&
        (g.scale ?? null) === (f.scale ?? null) &&
        (g.offsetValue ?? null) === (f.offsetValue ?? null),
    );
    if (!twin) out.push(f);
  }
  return out;
}

export async function init() {
  if (initialized) return;
  initialized = true;

  try {
    const saved = localStorage.getItem("vs.rules");
    if (saved) {
      snapshot = { ...snapshot, rules: sanitizeRules(JSON.parse(saved) as ParseRules) };
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

let revealNonce = 0;
/** 属性面板/表 → 画布反向定位请求（P85b 消费；单调 nonce 去重） */
export function revealField(tplId: string, fieldId: string) {
  revealNonce += 1;
  set({ revealReq: { tplId, fieldId, nonce: revealNonce } });
}

export function addTemplate(headerBytes: number[]): string {
  pushHistory();
  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name: `模板${snapshot.rules.templates.length + 1}`,
    color: PALETTE[snapshot.rules.templates.length % PALETTE.length],
    enabled: false,
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
  const t = snapshot.rules.templates.find((x) => x.id === id);
  dropFieldValues(t ? t.fields.map((f) => f.id) : [], id);
  set({
    rules: { templates: snapshot.rules.templates.filter((tpl) => tpl.id !== id) },
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
  const old = snapshot.rules.templates.find((t) => t.id === id);
  if (old && patch.name !== undefined && patch.name !== old.name) {
    plotRename(id, null, `${old.name}·`, `${patch.name}·`);
  }
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
                discs: [],
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

export function insertFrameCell(tplId: string, g: number): string | null {
  const t = snapshot.rules.templates.find((x) => x.id === tplId);
  if (!t) return tx("模板不存在", "Template not found");
  if (t.boundary.mode !== "fixedLength")
    return tx(
      "变长帧帧长由长度域/帧尾决定，请到属性面板改截帧配置",
      "Variable frames size by length field/footer — edit the framing config in properties",
    );
  const hb = t.boundary.headerBytes.length;
  const fl = t.boundary.fixedLength ?? 0;
  if (g < hb) return tx("不能插入到帧头内部", "Cannot insert inside the frame header");
  if (g > fl) return tx("插入位置超出帧长", "Insert position exceeds the frame length");
  for (const f of t.fields) {
    if (f.offset < 0) continue;
    const sz = fieldSize(f);
    if (g > f.offset && g < f.offset + sz) {
      return tx(
        `位置被字段「${f.name}」占用，请先取消该字段`,
        `Position is occupied by field "${f.name}" — undefine it first`,
      );
    }
  }
  const lk = t.fields.find((f) => f.locked && f.offset >= g);
  if (lk)
    return tx(
      `字段「${lk.name}」已锁定，插入会使其右移——请先解锁`,
      `Field "${lk.name}" is locked and would shift right — unlock it first`,
    );
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((x) =>
        x.id === tplId
          ? {
              ...x,
              boundary: { ...x.boundary, fixedLength: fl + 1 },
              fields: x.fields.map((f) =>
                f.offset >= g ? { ...f, offset: f.offset + 1 } : f,
              ),
            }
          : x,
      ),
    },
  });
  scheduleSync();
  return null;
}

export function deleteFrameCell(tplId: string, g: number): string | null {
  const t = snapshot.rules.templates.find((x) => x.id === tplId);
  if (!t) return tx("模板不存在", "Template not found");
  if (t.boundary.mode !== "fixedLength")
    return tx(
      "变长帧帧长由长度域/帧尾决定，请到属性面板改截帧配置",
      "Variable frames size by length field/footer — edit the framing config in properties",
    );
  const hb = t.boundary.headerBytes.length;
  const fl = t.boundary.fixedLength ?? 0;
  if (g < hb) return tx("不能删除帧头字节（请用帧头编辑）", "Cannot delete header bytes (use the header editor)");
  if (g >= fl) return tx("位置超出帧长", "Position exceeds the frame length");
  if (fl - 1 < hb + 1) return tx("删除后帧长不能小于帧头 + 1 字节", "Frame length cannot drop below header + 1 byte");
  const rt = checksumTail(t);
  if (rt > 0 && g >= fl - rt)
    return tx(
      "帧尾校验域不可删除——先停用校验，或删校验区之前的格",
      "The checksum tail is protected — disable the checksum first, or delete cells before it",
    );
  for (const f of t.fields) {
    if (f.offset < 0) continue;
    const sz = fieldSize(f);
    if (g >= f.offset && g < f.offset + sz) {
      return tx(
        `位置被字段「${f.name}」占用，请先取消该字段`,
        `Position is occupied by field "${f.name}" — undefine it first`,
      );
    }
  }
  const lk = t.fields.find((f) => f.locked && f.offset > g);
  if (lk)
    return tx(
      `字段「${lk.name}」已锁定，删除会使其左移——请先解锁`,
      `Field "${lk.name}" is locked and would shift left — unlock it first`,
    );
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((x) =>
        x.id === tplId
          ? {
              ...x,
              boundary: { ...x.boundary, fixedLength: fl - 1 },
              fields: x.fields.map((f) =>
                f.offset > g ? { ...f, offset: f.offset - 1 } : f,
              ),
            }
          : x,
      ),
    },
  });
  scheduleSync();
  return null;
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
  const tpl = snapshot.rules.templates.find((t) => t.id === templateId);
  const oldF = tpl?.fields.find((f) => f.id === fieldId);
  if (oldF && patch.name !== undefined && patch.name !== oldF.name) {
    plotRename(templateId, fieldId, `${tpl!.name}·${oldF.name}`, `${tpl!.name}·${patch.name}`);
  }
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

export const CHECKSUM_SIZES: Record<string, number> = {
  sum8: 1,
  xor8: 1,
  sumadd: 2,
  crc16_modbus: 2,
  crc16_ccitt: 2,
  crc32: 4,
};

export interface UpsertOpts {
  /** 高级：定长帧保留校验字段在选区位置（中间校验），coverageEnd 同步为绝对偏移（引擎按字段位置验证，语义自洽） */
  keepMiddle?: boolean;
  /** 单事务切截帧模式（P86a：帧尾/长度字段与模式联动，一步可撤销） */
  switchMode?: "footer" | "lengthField";
  footerBytes?: number[];
}

export function upsertFieldLinked(
  templateId: string,
  field: FieldDef,
  editId: string | null,
  ckAlgo?: string | null,
  opts?: UpsertOpts,
) {
  const tplOld = snapshot.rules.templates.find((t) => t.id === templateId);
  const oldF = editId ? tplOld?.fields.find((f) => f.id === editId) : null;
  if (tplOld && oldF && field.name && field.name !== oldF.name) {
    plotRename(templateId, editId, `${tplOld.name}·${oldF.name}`, `${tplOld.name}·${field.name}`);
  }
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) => {
        if (t.id !== templateId) return t;
        let f = { ...field };
        const fbOf = (b: FrameTemplate["boundary"]) =>
          b.mode === "footer" ? (b.footerBytes?.length ?? 0) : 0;
        if (f.role === "checksum" && ckAlgo && ckAlgo !== "none") {
          const size = CHECKSUM_SIZES[ckAlgo] ?? fieldSize(f);
          if (t.boundary.mode === "fixedLength") {
            const fl = t.boundary.fixedLength ?? 0;
            const target = fl - size;
            if (
              !opts?.keepMiddle &&
              fl > 0 &&
              f.offset >= 0 &&
              f.offset !== target &&
              target >= t.boundary.headerBytes.length
            ) {
              f = { ...f, offset: target };
            }
          } else if (f.offset >= 0) {
            f = { ...f, offset: -(size + fbOf(t.boundary)) };
          }
        }
        if (f.role === "footer" && opts?.switchMode === "footer" && f.offset >= 0) {
          const fr = opts.footerBytes?.length ?? fieldSize(f);
          f = { ...f, offset: -fr };
        }
        const fields = editId
          ? t.fields.map((x) => (x.id === editId ? { ...x, ...f, id: editId } : x))
          : [...t.fields, f];
        let boundary = t.boundary;
        if (opts?.switchMode === "footer") {
          boundary = {
            ...boundary,
            mode: "footer",
            footerBytes: opts.footerBytes?.length
              ? opts.footerBytes
              : boundary.footerBytes?.length
                ? boundary.footerBytes
                : [0x0d, 0x0a],
          };
        } else if (opts?.switchMode === "lengthField") {
          boundary = {
            ...boundary,
            mode: "lengthField",
            lengthOffset:
              f.offset >= 0 ? f.offset : boundary.lengthOffset ?? boundary.headerBytes.length,
            lengthSize: boundary.lengthSize ?? (f.type === "uint16" ? 2 : 1),
          };
        }
        const link =
          f.role === "length" &&
          f.offset >= 0 &&
          boundary.mode === "lengthField" &&
          (f.type === "uint8" || f.type === "uint16");
        if (link) {
          boundary = {
            ...boundary,
            lengthOffset: f.offset,
            lengthSize: f.type === "uint16" ? 2 : 1,
          };
        }
        let checksum = t.checksum;
        if (f.role === "checksum" && ckAlgo && ckAlgo !== "none") {
          const size = CHECKSUM_SIZES[ckAlgo] ?? fieldSize(f);
          const middle =
            boundary.mode === "fixedLength" &&
            opts?.keepMiddle &&
            f.offset >= 0 &&
            f.offset + size < (boundary.fixedLength ?? 0);
          checksum = {
            algo: ckAlgo as ChecksumAlgo,
            coverageStart: t.checksum?.coverageStart ?? 0,
            coverageEnd: middle ? f.offset : -(size + fbOf(boundary)),
            endian: (t.checksum?.endian ?? "little") as "little" | "big",
          };
        }
        return { ...t, fields, boundary, checksum };
      }),
    },
  });
  scheduleSync();
}

export function setChecksumAlgo(templateId: string, algo: ChecksumAlgo) {
  pushHistory();
  const size = CHECKSUM_SIZES[algo] ?? 1;
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) => {
        if (t.id !== templateId) return t;
        const oldSize = t.checksum ? (CHECKSUM_SIZES[t.checksum.algo] ?? 1) : 1;
        const oldEnd = t.checksum?.coverageEnd ?? -oldSize;
        const fb =
          t.boundary.mode === "footer" ? (t.boundary.footerBytes?.length ?? 0) : 0;
        const checksum: NonNullable<FrameTemplate["checksum"]> = {
          algo,
          coverageStart: t.checksum?.coverageStart ?? 0,
          coverageEnd: oldEnd === -oldSize ? -(size + fb) : oldEnd,
          endian: t.checksum?.endian ?? "little",
        };
        const fields =
          algo === "none"
            ? t.fields
            : t.fields.map((f) => {
                if (f.role !== "checksum") return f;
                const want: FieldType =
                  size === 1 ? "uint8" : size === 2 ? "uint16" : "uint32";
                let nf = f.type === want ? f : { ...f, type: want };
                // P86a：算法宽度变化时，原本贴尾的定长校验字段跟着贴尾
                if (
                  t.boundary.mode === "fixedLength" &&
                  oldEnd === -oldSize &&
                  nf.offset >= 0
                ) {
                  const target = (t.boundary.fixedLength ?? 0) - size;
                  if (
                    target >= t.boundary.headerBytes.length &&
                    target !== nf.offset
                  ) {
                    nf = { ...nf, offset: target };
                  }
                }
                return nf;
              });
        return { ...t, checksum, fields };
      }),
    },
  });
  scheduleSync();
}

export function setLengthDomain(
  templateId: string,
  patch: { lengthOffset?: number; lengthSize?: number },
) {
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) => {
        if (t.id !== templateId) return t;
        const boundary = { ...t.boundary, ...patch };
        const size = boundary.lengthSize ?? 1;
        const fields = t.fields.map((f) => {
          if (f.role !== "length") return f;
          const next = { ...f };
          if (patch.lengthOffset != null) next.offset = patch.lengthOffset;
          if (patch.lengthSize != null) {
            next.type = size === 2 ? "uint16" : "uint8";
            next.size = null;
          }
          return next;
        });
        return { ...t, boundary, fields };
      }),
    },
  });
  scheduleSync();
}

export function removeField(templateId: string, fieldId: string) {
  pushHistory();
  plotCleanup(templateId, fieldId);
  dropFieldValues([fieldId]);
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

/** 删除校验字段并同步停用校验（P85a：避免「无算法的 CK1 僵尸字段」与「无字段的启用校验」脱节） */
export function removeChecksumField(templateId: string, fieldId: string) {
  pushHistory();
  plotCleanup(templateId, fieldId);
  dropFieldValues([fieldId]);
  set({
    rules: {
      templates: snapshot.rules.templates.map((t) =>
        t.id === templateId
          ? {
              ...t,
              fields: t.fields.filter((f) => f.id !== fieldId),
              checksum: t.checksum
                ? { ...t.checksum, algo: "none" as ChecksumAlgo }
                : null,
            }
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

/** 帧头字节整体替换 + 联动平移（P85a：帧头 ±1 不再是「只改内容不动结构」的半吊子）：
 *  正偏移≥旧帧头长的字段、长度域偏移、识别位偏移全部按差值平移；负偏移字段天然锚尾不动。 */
export function setHeaderBytes(tplId: string, bytes: number[]): string | null {
  const t = snapshot.rules.templates.find((x) => x.id === tplId);
  if (!t) return tx("模板不存在", "Template not found");
  const oldHb = t.boundary.headerBytes.length;
  const newHb = bytes.length;
  if (newHb > 8)
    return tx("帧头最多 8 字节", "Header supports up to 8 bytes");
  const fl =
    t.boundary.mode === "fixedLength" ? (t.boundary.fixedLength ?? 0) : 0;
  if (fl > 0 && newHb + 1 > fl)
    return tx(
      "帧头过长：总帧长至少需为帧头 + 1 字节，请先调大总帧长",
      "Header too long: total frame length must be at least header + 1 byte — raise it first",
    );
  const delta = newHb - oldHb;
  pushHistory();
  set({
    rules: {
      templates: snapshot.rules.templates.map((x) => {
        if (x.id !== tplId) return x;
        const boundary = {
          ...x.boundary,
          headerBytes: bytes,
          lengthOffset:
            delta !== 0 && x.boundary.lengthOffset != null && x.boundary.lengthOffset >= oldHb
              ? x.boundary.lengthOffset + delta
              : x.boundary.lengthOffset,
          discOffset:
            delta !== 0 && x.boundary.discOffset != null && x.boundary.discOffset >= oldHb
              ? x.boundary.discOffset + delta
              : x.boundary.discOffset,
          discs: (x.boundary.discs ?? []).map((d) =>
            delta !== 0 && d.offset >= oldHb ? { ...d, offset: d.offset + delta } : d,
          ),
        };
        const fields =
          delta === 0
            ? x.fields
            : x.fields.map((f) =>
                f.offset >= 0 && f.offset >= oldHb
                  ? { ...f, offset: f.offset + delta }
                  : f,
              );
        return { ...x, boundary, fields };
      }),
    },
  });
  scheduleSync();
  return null;
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
}

function plotRename(
  tplId: string,
  fieldId: string | null,
  oldLabel: string,
  newLabel: string,
) {
  try {
    const plot = (
      window as unknown as {
        uartixPlot?: {
          renameChannels?: (a: string, b: string | null, c: string, d: string) => number;
        };
      }
    ).uartixPlot;
    plot?.renameChannels?.(tplId, fieldId, oldLabel, newLabel);
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
