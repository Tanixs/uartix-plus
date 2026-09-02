import type {
  Boundary,
  ChecksumAlgo,
  Endian,
  FieldDef,
  FieldRole,
  FieldType,
  FrameTemplate,
} from "../../ipc/types";
import * as templateStore from "../protocol/templateStore";
import * as commandStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";

const BOUNDARY_MODES = ["fixedLength", "lengthField", "footer"];
const CHECKSUM_ALGOS: ChecksumAlgo[] = [
  "none",
  "sum8",
  "sumadd",
  "xor8",
  "crc16_modbus",
  "crc16_ccitt",
  "crc32",
];
const FIELD_TYPES: FieldType[] = [
  "uint8",
  "int8",
  "uint16",
  "int16",
  "uint32",
  "int32",
  "float32",
  "float64",
  "ascii",
  "bcd",
  "bits",
  "csv",
];
const FIELD_ROLES: FieldRole[] = [
  "header",
  "addr",
  "id",
  "seq",
  "length",
  "data",
  "payload",
  "checksum",
  "checksum2",
  "footer",
];

function toBytes(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export interface WriteResult {
  ok: boolean;
  msg: string;
  tplId?: string;
}

export function writeTemplateFromAiJson(raw: string): WriteResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }

  const name =
    typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "AI 识别协议";
  const b = (obj.boundary ?? {}) as Record<string, unknown>;
  const mode = BOUNDARY_MODES.includes(String(b.mode)) ? String(b.mode) : "fixedLength";
  const headerBytes = toBytes(b.headerBytes) ?? [];
  if (headerBytes.length === 0 && mode !== "footer") {
    return { ok: false, msg: "帧头 headerBytes 缺失或非法，无法写入模板" };
  }

  let boundary: Boundary;
  if (mode === "fixedLength") {
    boundary = {
      mode: "fixedLength",
      headerBytes,
      fixedLength: toInt(b.fixedLength) ?? headerBytes.length + 8,
      maxLength: toInt(b.maxLength) ?? 512,
    };
  } else if (mode === "lengthField") {
    boundary = {
      mode: "lengthField",
      headerBytes,
      lengthOffset: toInt(b.lengthOffset) ?? headerBytes.length,
      lengthSize: toInt(b.lengthSize) ?? 1,
      lengthEndian: (b.lengthEndian === "big" ? "big" : "little") as Endian,
      lengthAdjust: toInt(b.lengthAdjust) ?? 0,
      maxLength: toInt(b.maxLength) ?? 512,
    };
  } else {
    boundary = {
      mode: "footer",
      headerBytes,
      footerBytes: toBytes(b.footerBytes) ?? [0x0d, 0x0a],
      maxLength: toInt(b.maxLength) ?? 512,
    };
  }

  let checksum: FrameTemplate["checksum"] = null;
  const c = obj.checksum as Record<string, unknown> | null | undefined;
  if (c && typeof c === "object") {
    const algo = CHECKSUM_ALGOS.includes(c.algo as ChecksumAlgo)
      ? (c.algo as ChecksumAlgo)
      : null;
    if (algo && algo !== "none") {
      checksum = {
        algo,
        coverageStart: toInt(c.coverageStart) ?? 0,
        coverageEnd: toInt(c.coverageEnd) ?? -1,
        endian: (c.endian === "big" ? "big" : "little") as Endian,
      };
    }
  }

  const rawFields = Array.isArray(obj.fields) ? (obj.fields as Record<string, unknown>[]) : [];
  const fields: FieldDef[] = [];
  for (const f of rawFields) {
    const type = FIELD_TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : null;
    const role = FIELD_ROLES.includes(f.role as FieldRole) ? (f.role as FieldRole) : "data";
    const offset = toInt(f.offset);
    if (!type || offset === null || offset < 0) continue;
    fields.push({
      id: crypto.randomUUID(),
      name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : `字段${fields.length + 1}`,
      role,
      offset,
      type,
      endian: (f.endian === "big" ? "big" : "little") as Endian,
      size: toInt(f.size),
      scale: typeof f.scale === "number" && Number.isFinite(f.scale) ? f.scale : null,
      unit: typeof f.unit === "string" ? f.unit : null,
      color: templateStore.PALETTE[fields.length % templateStore.PALETTE.length],
    });
  }

  const tpl: FrameTemplate = {
    id: crypto.randomUUID(),
    name,
    color: templateStore.PALETTE[Math.floor(Math.random() * templateStore.PALETTE.length)],
    enabled: false,
    boundary,
    checksum,
    fields,
    presetKey: null,
  };

  templateStore.importTemplates([tpl]);
  return {
    ok: true,
    msg: `模板「${name}」已写入协议模板（默认停用，请在协议模板面板启用）`,
    tplId: tpl.id,
  };
}

const CARD_TYPES = [
  "slider",
  "button",
  "switch",
  "led",
  "buzzer",
  "monitor",
  "joystick",
  "keypad",
  "keymon",
];

export function writeCommandFromAiJson(raw: string): WriteResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  const template =
    typeof obj.template === "string" && obj.template.trim()
      ? obj.template.trim()
      : "";
  const script = typeof obj.script === "string" ? obj.script : "";
  if (!template && !script) {
    return { ok: false, msg: "命令内容为空（template 与 script 均缺失）" };
  }
  const sendMode = obj.sendMode === "hex" ? "hex" : "ascii";
  const name =
    typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "AI 指令";

  const groups = commandStore.getSnapshot().groups;
  let grp = groups.filter((g) => g.name === "AI 生成").pop();
  if (!grp) {
    commandStore.addGroup("AI 生成");
    grp = commandStore.getSnapshot().groups
      .filter((g) => g.name === "AI 生成")
      .pop();
  }
  if (!grp) return { ok: false, msg: "命令库分组创建失败" };

  const collectIds = (nodes: commandStore.CommandNode[], acc: Set<string>) => {
    for (const n of nodes) {
      acc.add(n.id);
      if (commandStore.isGroup(n)) collectIds(n.items, acc);
    }
  };
  const before = new Set<string>();
  collectIds(grp.items, before);
  commandStore.addCommand(grp.id);
  const grp2 = commandStore
    .getSnapshot()
    .groups.filter((g) => g.id === grp!.id)
    .pop();
  if (!grp2) return { ok: false, msg: "命令写入失败" };
  const after: string[] = [];
  const collectIds2 = (nodes: commandStore.CommandNode[]) => {
    for (const n of nodes) {
      if (!commandStore.isGroup(n)) after.push(n.id);
      else collectIds2(n.items);
    }
  };
  collectIds2(grp2.items);
  const cmdId = after.filter((id) => !before.has(id)).pop();
  if (!cmdId) return { ok: false, msg: "命令写入失败" };

  commandStore.patchCommand(cmdId, {
    name,
    template,
    sendMode,
    script,
    scriptEnabled: Boolean(obj.scriptEnabled) && script.length > 0,
    note: "由 AI 助手生成",
  });
  return {
    ok: true,
    msg: `命令「${name}」已加入命令库的「AI 生成」分组`,
  };
}

export function writeCardFromAiJson(raw: string): WriteResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  if (Array.isArray((obj as { cards?: unknown }).cards)) {
    return writeCardsFromAiJson(raw);
  }
  if (Array.isArray(obj)) {
    return writeCardsFromAiJson(raw);
  }
  return writeOneCard(obj);
}

function writeOneCard(obj: Record<string, unknown>): WriteResult {
  const type = CARD_TYPES.includes(String(obj.type))
    ? (obj.type as controlsStore.ControlType)
    : "slider";
  let page = controlsStore.activePage();
  if (!page) {
    controlsStore.addPage();
    page = controlsStore.activePage();
  }
  if (!page) return { ok: false, msg: "控制页不存在且创建失败" };

  const before = new Set(page.cards.map((c) => c.id));
  const cardId = controlsStore.addCard(page.id, type);
  if (!cardId || before.has(cardId)) {
    return { ok: false, msg: "卡片写入失败" };
  }
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "min", "max", "step", "template", "script", "unit"] as const) {
    const v = obj[k];
    if (typeof v === "string" || typeof v === "number") patch[k] = v;
  }
  for (const k of ["x", "y", "w", "h"] as const) {
    const n = Number(obj[k]);
    if (Number.isFinite(n)) patch[k] = Math.round(n);
  }
  controlsStore.patchCard(page.id, cardId, patch);
  return {
    ok: true,
    msg: `卡片「${String(patch.name ?? type)}」已写入控制页「${page.name}」（位置已按网格校正）`,
  };
}

export function writeCardsFromAiJson(raw: string): WriteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  let list: unknown[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cards?: unknown }).cards)) {
    list = (parsed as { cards: unknown[] }).cards;
  } else {
    return writeOneCard(parsed as Record<string, unknown>);
  }
  if (list.length === 0) return { ok: false, msg: "cards 数组为空" };
  if (list.length > 64) list = list.slice(0, 64);

  let page = controlsStore.activePage();
  if (!page) {
    controlsStore.addPage();
    page = controlsStore.activePage();
  }
  if (!page) return { ok: false, msg: "控制页不存在且创建失败" };

  const pageName = page.name;
  let okCount = 0;
  const names: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = writeOneCard(item as Record<string, unknown>);
    if (r.ok) {
      okCount++;
      names.push(String((item as Record<string, unknown>).name ?? "卡片"));
    }
  }
  if (okCount === 0) return { ok: false, msg: "没有可写入的卡片（类型或字段不合法）" };
  return {
    ok: true,
    msg: `${okCount} 张卡片已写入控制页「${pageName}」（自动流式排布）：${names.join("、")}`,
  };
}
