import type {
  Boundary,
  ChecksumAlgo,
  CrcParams,
  DiscSpec,
  Endian,
  FieldDef,
  FieldRole,
  FieldType,
  FrameTemplate,
  ValueLabel,
} from "../../ipc/types";
import { checksumWidth, crcParamError } from "../../shared/checksums";
import * as templateStore from "../protocol/templateStore";
import * as sendStore from "../send/sendStore";
import { encodeSend, SendEncodeError } from "../send/encodeSend";
import {
  SEND_FIELD_ROLES,
  paramTypeOf,
  type SendField,
  type SendParam,
  type SendTemplate,
} from "../send/sendTypes";
import { guardLocked } from "../operator/lock";
import * as commandStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";
import { validateUserCodec, buildUserFrame, type UserSeg } from "../console/commandFactory";
import * as ucStore from "../console/userCodecStore";
import { requestOpenPanel } from "./appBus";

const BOUNDARY_MODES = ["fixedLength", "lengthField", "footer"];
const CHECKSUM_ALGOS: ChecksumAlgo[] = [
  "none",
  "sum8",
  "sumadd",
  "sum16",
  "xor8",
  "crc16_modbus",
  "crc16_ccitt",
  "crc16_x25",
  "crc_custom",
  "crc32",
];

/**
 * AI 写的 crc_custom 参数：六个字段缺一个、位数不合法就整条拒收 —— 猜一组默认值会造出
 * "看着配上了、算出来谁也不认"的模板，那比拒收更坏。
 */
function parseCrcParams(raw: unknown): CrcParams | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const w = toInt(r.width);
  const poly = toInt(r.poly);
  const init = toInt(r.init);
  const xorout = toInt(r.xorout);
  if (w !== 8 && w !== 16 && w !== 32) return null;
  if (poly === null || init === null || xorout === null) return null;
  if (typeof r.refin !== "boolean" || typeof r.refout !== "boolean") return null;
  const p: CrcParams = { width: w, poly, init, refin: r.refin, refout: r.refout, xorout };
  return crcParamError(p) ? null : p;
}

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

/** 值标签数组清洗：[{v,t}] 保留合法条目（上限 64 条），非法输入按"无标签"处理 */
function normLabels(v: unknown): ValueLabel[] | null {
  if (!Array.isArray(v)) return null;
  const out: ValueLabel[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const val = toInt(o.v);
    const text = typeof o.t === "string" ? o.t.trim() : "";
    if (val === null || !text) continue;
    out.push({ v: val, t: text });
    if (out.length >= 64) break;
  }
  return out.length > 0 ? out : null;
}

export interface WriteResult {
  ok: boolean;
  msg: string;
  tplId?: string;
}

/** 单模板 JSON → FrameTemplate（字段清洗 + 默认值兜底），非法返回错误信息 */
function parseOneTemplate(o: Record<string, unknown>): { tpl?: FrameTemplate; err?: string } {
  const name =
    typeof o.name === "string" && o.name.trim() ? o.name.trim() : "AI 识别协议";
  const b = (o.boundary ?? {}) as Record<string, unknown>;
  const mode = BOUNDARY_MODES.includes(String(b.mode)) ? String(b.mode) : "fixedLength";
  const headerBytes = toBytes(b.headerBytes) ?? [];
  if (headerBytes.length === 0 && mode !== "footer") {
    return { err: `模板「${name}」：帧头 headerBytes 缺失或非法` };
  }

  // 字节序：四档全部合法（旧代码只认 big/little，会把新字序静默降级成小端）
  const normEndian = (v: unknown): Endian =>
    v === "big" || v === "big-word-swap" || v === "little-word-swap" || v === "little"
      ? (v as Endian)
      : "little";
  // 掩码：全 0xFF 视为无掩码（与"旧模板不带掩码"的语义一致）
  const normMask = (v: unknown): number[] | null => {
    const m = toBytes(v);
    if (!m || m.length === 0) return null;
    return m.every((x) => x === 0xff) ? null : m;
  };
  const headerMask = normMask(b.headerMask);

  // 识别位：帧内某偏移处的固定字节（可带位掩码），用于同帧头家族内区分帧型
  const toDisc = (v: unknown): DiscSpec | null => {
    if (!v || typeof v !== "object") return null;
    const d = v as Record<string, unknown>;
    const off = toInt(d.offset);
    const val = toBytes(d.value);
    if (off === null || off < 0 || !val || val.length === 0) return null;
    return { offset: off, value: val, mask: normMask(d.mask) };
  };
  const discList: DiscSpec[] = [];
  if (Array.isArray(b.discs)) {
    for (const d of b.discs) {
      const one = toDisc(d);
      if (one) discList.push(one);
    }
  }
  const single = toDisc({ offset: b.discOffset, value: b.discValue, mask: b.discMask });
  if (single) discList.unshift(single);
  const discs = discList.length > 0 ? discList : null;

  let boundary: Boundary;
  if (mode === "fixedLength") {
    boundary = {
      mode: "fixedLength",
      headerBytes,
      headerMask,
      fixedLength: toInt(b.fixedLength) ?? headerBytes.length + 8,
      maxLength: toInt(b.maxLength) ?? 512,
      discs,
    };
  } else if (mode === "lengthField") {
    boundary = {
      mode: "lengthField",
      headerBytes,
      headerMask,
      lengthOffset: toInt(b.lengthOffset) ?? headerBytes.length,
      lengthSize: toInt(b.lengthSize) ?? 1,
      lengthEndian: normEndian(b.lengthEndian),
      lengthAdjust: toInt(b.lengthAdjust) ?? 0,
      lengthScale:
        typeof b.lengthScale === "number" && Number.isFinite(b.lengthScale) && b.lengthScale > 0
          ? b.lengthScale
          : null,
      maxLength: toInt(b.maxLength) ?? 512,
      discs,
    };
  } else {
    boundary = {
      mode: "footer",
      headerBytes,
      headerMask,
      footerBytes: toBytes(b.footerBytes) ?? [0x0d, 0x0a],
      maxLength: toInt(b.maxLength) ?? 512,
      discs,
    };
  }

  let checksum: FrameTemplate["checksum"] = null;
  const c = o.checksum as Record<string, unknown> | null | undefined;
  if (c && typeof c === "object") {
    const algo = CHECKSUM_ALGOS.includes(c.algo as ChecksumAlgo)
      ? (c.algo as ChecksumAlgo)
      : null;
    if (algo && algo !== "none") {
      // custom 的参数不合法就当这条校验没写：留下一个"选了 custom 却没参数"的模板，
      // 引擎只会算出 0，症状比拒收难查得多
      const crc = algo === "crc_custom" ? parseCrcParams(c.crc) : null;
      if (algo === "crc_custom" && !crc) {
        checksum = null;
      } else {
        checksum = {
          algo,
          coverageStart: toInt(c.coverageStart) ?? 0,
          coverageEnd: toInt(c.coverageEnd) ?? -1,
          endian: (c.endian === "big" ? "big" : "little") as Endian,
          crc,
        };
      }
    }
  }

  const rawFields = Array.isArray(o.fields) ? (o.fields as Record<string, unknown>[]) : [];
  const fields: FieldDef[] = [];
  for (const f of rawFields) {
    const type = FIELD_TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : null;
    const role = FIELD_ROLES.includes(f.role as FieldRole) ? (f.role as FieldRole) : "data";
    const offset = toInt(f.offset);
    if (!type || offset === null || offset < 0) continue;
    const br = (f.bits ?? {}) as Record<string, unknown>;
    const bitIndex = toInt(br.index);
    const bitCount = toInt(br.count);
    fields.push({
      id: crypto.randomUUID(),
      name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : `字段${fields.length + 1}`,
      role,
      offset,
      type,
      endian: normEndian(f.endian),
      size: toInt(f.size),
      scale: typeof f.scale === "number" && Number.isFinite(f.scale) ? f.scale : null,
      offsetValue:
        typeof f.offsetValue === "number" && Number.isFinite(f.offsetValue) ? f.offsetValue : null,
      unit: typeof f.unit === "string" ? f.unit : null,
      // 值标签（枚举注解）：AI 读协议手册里的"1=非法功能码"这类表就落到这里
      labels: normLabels(f.labels),
      // bits 型取字段内的 bit 段；csv 型拆分文本区为多通道（两者缺省由引擎兜底）
      bits:
        bitIndex !== null && bitCount !== null && bitCount > 0
          ? { index: bitIndex, count: bitCount }
          : null,
      csvDelim: typeof f.csvDelim === "string" && f.csvDelim ? f.csvDelim : null,
      csvType: FIELD_TYPES.includes(f.csvType as FieldType) ? String(f.csvType) : null,
      // 数值数组（Modbus 寄存器区等）：跨到帧尾（扣除校验域）按元素步长展开
      spanTail: f.spanTail === true ? true : null,
      spanElem:
        typeof f.spanElem === "string" &&
        (f.spanElem === "bit" || FIELD_TYPES.includes(f.spanElem as FieldType))
          ? (f.spanElem as string)
          : null,
      color: templateStore.PALETTE[fields.length % templateStore.PALETTE.length],
    });
  }

  return {
    tpl: {
      id: crypto.randomUUID(),
      name,
      color: templateStore.PALETTE[Math.floor(Math.random() * templateStore.PALETTE.length)],
      enabled: false,
      boundary,
      checksum,
      fields,
      presetKey: null,
    },
  };
}

/**
 * AI → 协议模板写入。兼容三种形态：
 * - 单模板对象（旧格式）：{"name","boundary","checksum","fields"}
 * - 批量：{"templates":[...]} 或 {"group":"簇名","templates":[...]}
 * 带 group 时自动创建协议簇并把全部模板归入该组（写入后默认停用）
 */
export function writeTemplateFromAiJson(raw: string): WriteResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }

  const groupName =
    typeof obj.group === "string" && obj.group.trim() ? obj.group.trim() : null;
  const rawList = Array.isArray(obj.templates) ? (obj.templates as unknown[]) : [obj];
  if (rawList.length === 0) return { ok: false, msg: "templates 数组为空" };
  if (rawList.length > 64) rawList.length = 64;

  const tpls: FrameTemplate[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const r = parseOneTemplate(item as Record<string, unknown>);
    if (r.err || !r.tpl) return { ok: false, msg: r.err ?? "模板解析失败" };
    tpls.push(r.tpl);
  }
  if (tpls.length === 0) return { ok: false, msg: "没有可写入的模板" };

  if (groupName && tpls.length > 0) {
    const grpKey = `usr-${Date.now().toString(36)}-ai`;
    templateStore.setGroupMeta(grpKey, { name: groupName });
    for (const t of tpls) t.groupKey = grpKey;
  }
  templateStore.importTemplates(tpls);
  requestOpenPanel("framecanvas");
  return {
    ok: true,
    msg: groupName
      ? `协议簇「${groupName}」已写入（${tpls.length} 个模板，默认停用，在帧画布点灰色页签即可启用）`
      : `模板「${tpls[0].name}」已写入（默认停用，在帧画布点灰色页签即可启用）`,
    tplId: tpls[0].id,
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
  "group",
  "custom",
];

/** 单个控制页 custom 沙箱卡片上限（iframe 性能保护） */
const MAX_CUSTOM_PER_PAGE = 8;

export function writeCommandFromAiJson(raw: string): WriteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  // 兼容三种形态：{"commands":[...]}、纯数组、单对象
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { commands?: unknown }).commands)
  ) {
    list = (parsed as { commands: unknown[] }).commands;
  }
  if (!list) return writeOneCommand(parsed as Record<string, unknown>);
  if (list.length === 0) return { ok: false, msg: "commands 数组为空" };
  if (list.length > 32) list = list.slice(0, 32);
  const results: string[] = [];
  let okCount = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = writeOneCommand(item as Record<string, unknown>);
    if (r.ok) {
      okCount++;
      results.push(String((item as Record<string, unknown>).name ?? "指令"));
    }
  }
  if (okCount === 0) return { ok: false, msg: "没有可写入的命令（template 与 script 均缺失或非法）" };
  return { ok: true, msg: `${okCount} 条命令已写入命令库「AI 生成」分组：${results.join("、")}` };
}

function writeOneCommand(obj: Record<string, unknown>): WriteResult {
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

/** uartix-codec：AI 生成指令工厂自定义协议 */
export function writeCodecFromAiJson(raw: string): WriteResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "";
  if (!name) return { ok: false, msg: "缺少协议名 name" };
  if (!Array.isArray(obj.segs) || obj.segs.length < 2) {
    return { ok: false, msg: "segs 缺失或不足 2 段（至少帧头 + 校验）" };
  }
  // 段合法性清洗：kind 校验 + 数值/布尔规范化
  const CHECK_ALGOS = ["sum8", "xor8", "sum16", "crc16-modbus", "crc16-ccitt", "crc16-x25", "ano-scac"];
  const VAR_TYPES = ["u8", "u16", "u32", "s16", "s32", "f32", "ascii"];
  const segs: UserSeg[] = [];
  for (const rawSeg of obj.segs) {
    if (!rawSeg || typeof rawSeg !== "object") continue;
    const s = rawSeg as Record<string, unknown>;
    if (s.kind === "fixed") {
      segs.push({
        kind: "fixed",
        label: typeof s.label === "string" ? s.label : "固定",
        bytes: typeof s.bytes === "string" ? s.bytes : "",
      });
    } else if (s.kind === "var") {
      if (!VAR_TYPES.includes(String(s.type))) continue;
      segs.push({
        kind: "var",
        name: typeof s.name === "string" ? s.name : `字段${segs.length}`,
        type: s.type as Extract<UserSeg, { kind: "var" }>["type"],
        le: s.le !== false,
        def: typeof s.def === "string" ? s.def : undefined,
      });
    } else if (s.kind === "len") {
      segs.push({ kind: "len" });
    } else if (s.kind === "check") {
      if (!CHECK_ALGOS.includes(String(s.algo))) continue;
      segs.push({
        kind: "check",
        algo: s.algo as Extract<UserSeg, { kind: "check" }>["algo"],
        be: s.be === true,
      });
    }
  }
  const def = { name, note: typeof obj.note === "string" ? obj.note : "由 AI 助手生成", segs };
  const vErr = validateUserCodec({ name, segs });
  if (vErr) return { ok: false, msg: `协议校验失败：${vErr}` };
  // 试组一帧，确保模板可运行（用变量默认值）
  try {
    const sample: Record<string, string> = {};
    for (const s of segs) {
      if (s.kind === "var") {
        sample[`f_${s.name}`] = s.def || (s.type === "ascii" ? "ABC" : "1");
      }
    }
    buildUserFrame(
      { id: "tmp", name, note: def.note, segs, createdAt: 0 },
      sample,
    );
  } catch (e) {
    return {
      ok: false,
      msg: `试组帧失败（默认参数无法组出合法帧）：${String(e).replace(/^Error:\s*/, "")}`,
    };
  }
  ucStore.add({ name, note: def.note, segs });
  return {
    ok: true,
    msg: `自定义协议「${name}」已加入指令工厂（打开控制台 → 指令工厂 → 我的协议 即可使用）`,
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
  if (type === "custom" && !String(obj.html ?? "").trim()) {
    return { ok: false, msg: "custom 卡片缺少 html 字段" };
  }
  if (
    type === "custom" &&
    page.cards.filter((c) => c.type === "custom").length >= MAX_CUSTOM_PER_PAGE
  ) {
    return {
      ok: false,
      msg: `当前控制页自定义卡片已达上限（${MAX_CUSTOM_PER_PAGE} 个），请换页或先删除部分`,
    };
  }

  const before = new Set(page.cards.map((c) => c.id));
  const cardId = controlsStore.addCard(page.id, type);
  if (!cardId || before.has(cardId)) {
    return { ok: false, msg: "卡片写入失败" };
  }
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "min", "max", "step", "template", "script", "unit", "html"] as const) {
    const v = obj[k];
    if (typeof v === "string" || typeof v === "number") patch[k] = v;
  }
  if (obj.sendMode === "hex" || obj.sendMode === "ascii") {
    patch.sendMode = obj.sendMode;
  }
  if (Array.isArray(obj.children)) {
    patch.children = obj.children;
    // 子控件数量决定卡片高度：每 2 个子项 1 格，至少 2 格
    const n = Math.min(8, obj.children.length);
    if (!patch.h) patch.h = Math.max(2, Math.ceil(n / 2) + 1);
    if (!patch.w) patch.w = 2;
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

/* ================= P121-E · AI 写发送谱 ================= */

const SEND_ENDIANS: Endian[] = ["big", "little", "big-word-swap", "little-word-swap"];
const SEND_COVERS = ["self", "after", "body"];
let sendUid = 0;
const snid = (p: string) => `${p}-ai-${Date.now().toString(36)}-${(sendUid++).toString(36)}`;

/**
 * AI 产谱（P121-E 的另一半）。三条不让步的规矩：
 *
 *  1. **整张谱试编得出来才写入**：编不出就把编码器的原话回给模型，不写半张进去。
 *     这一步顺带替模型验了它最容易写错的三处：校验段的宽度与算法是否自洽、
 *     参数块引用了谁、选了算法却忘了放校验段。
 *  2. 参数写在**块上**（`source.param` 给个名字），id 由这里统一铸 —— 让模型自己管 id
 *     只会造出悬空引用，而那正是这批一直在消的症状。同名参数复用同一个 id：
 *     两块吃同一个参数是合法配置（高字节/低字节那一类）。
 *  3. 只新增：落库走 `sendStore.importTemplates`（重名加序号），所以它是新建草稿那一档，
 *     不是覆盖用户的东西。
 *
 * 锁着的时候 `importTemplates` 会静默返回 0，那样模型收到一次"成功"。所以这里先问锁并把
 * 原因回给它 —— 假成功比失败难查得多（`writeTemplate` 现在就有这个毛病，另账处理）。
 */
export function writeSendSpecFromAiJson(raw: string): WriteResult {
  if (guardLocked()) {
    return { ok: false, msg: "Operator 只读锁开着：可以读谱与命令，但不能新建/改写发送谱" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, msg: "JSON 解析失败：代码块内容不是合法 JSON" };
  }
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { templates?: unknown }).templates)) {
    list = (parsed as { templates: unknown[] }).templates;
  }
  if (!list) {
    if (!parsed || typeof parsed !== "object") return { ok: false, msg: "JSON 顶层既不是谱对象也不是 templates 数组" };
    list = [parsed];
  }
  if (!list.length) return { ok: false, msg: "templates 数组是空的" };
  if (list.length > 16) list = list.slice(0, 16);

  const made: SendTemplate[] = [];
  const errs: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      errs.push("有一项不是对象");
      continue;
    }
    const r = parseOneSendSpec(item as Record<string, unknown>);
    if (r.err) errs.push(r.err);
    else if (r.tpl) made.push(r.tpl);
  }
  if (!made.length) {
    return { ok: false, msg: `没有一张谱能写入：${errs.slice(0, 3).join("；") || "未知原因"}` };
  }
  const beforeIds = new Set(sendStore.getSnapshot().map((t) => t.id));
  const n = sendStore.importTemplates(made);
  if (!n) return { ok: false, msg: "写入返回 0 —— 谱没有落进面板，请把这一步反馈给用户" };
  // 面板要显示的是刚写进来那一张，不是用户上一刻正在编的别张谱（与「预设」载入同一行为）。
  // `importTemplates` 会重铸 id，所以只能前后对表找出新增的那些。
  const added = sendStore.getSnapshot().filter((t) => !beforeIds.has(t.id));
  if (added.length) sendStore.requestSelect(added[added.length - 1].id);
  requestOpenPanel("sendbuild");
  const names = made.slice(0, n).map((t) => t.name).join("、");
  return {
    ok: true,
    msg:
      `${n} 张发送谱已写入 TX组帧台：${names}` +
      (errs.length ? `；另有 ${errs.length} 张被拒绝：${errs.slice(0, 2).join("；")}` : "") +
      "（每张都试编过一遍才写入）",
  };
}

function parseOneSendSpec(o: Record<string, unknown>): { tpl?: SendTemplate; err?: string } {
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "AI 发送谱";
  const rawFields = Array.isArray(o.fields) ? o.fields : null;
  if (!rawFields || !rawFields.length) return { err: `谱「${name}」没有 fields（要发的字节按块描述）` };
  if (rawFields.length > 64) return { err: `谱「${name}」有 ${rawFields.length} 块，上限 64` };

  const params: SendParam[] = [];
  const pidOf = new Map<string, string>();
  const fields: SendField[] = [];

  for (let i = 0; i < rawFields.length; i++) {
    const fo = rawFields[i] as Record<string, unknown>;
    if (!fo || typeof fo !== "object") return { err: `谱「${name}」第 ${i + 1} 块不是对象` };
    const fname = typeof fo.name === "string" && fo.name.trim() ? fo.name.trim() : `块${i + 1}`;
    if (!FIELD_TYPES.includes(String(fo.type) as FieldType)) {
      return { err: `块「${fname}」的类型「${String(fo.type)}」不在允许集里：${FIELD_TYPES.join("/")}` };
    }
    const type = fo.type as FieldType;
    if (type === "csv") return { err: `块「${fname}」是 csv —— 那是解析侧的显示类型，发不出去（改用 ascii）` };
    const endian = SEND_ENDIANS.includes(fo.endian as Endian) ? (fo.endian as Endian) : "big";
    // 发送侧的校验只有一段：编码器第三趟 `find` 到第一个校验段就 splice 完事，
    // 第二个校验块会留在 0x00。所以这里明拒，而不是悄悄降成 data 让它"看着对"。
    if (fo.role === "checksum2") {
      return { err: `块「${fname}」标成 checksum2 —— 发送谱目前只算一段校验（第二段的字节没人填），要两段校验先改用一段或到面板里手改` };
    }
    const role = SEND_FIELD_ROLES.includes(fo.role as FieldRole) ? (fo.role as FieldRole) : "data";
    const size = toInt(fo.size);
    const src = (fo.source ?? {}) as Record<string, unknown>;
    const kind = typeof src.kind === "string" ? src.kind : "const";

    let source: SendField["source"];
    if (kind === "const") {
      const b = toBytes(src.bytes);
      if (!b) return { err: `块「${fname}」的 const 需要 bytes：0~255 的整数数组` };
      source = { kind: "const", bytes: b };
    } else if (kind === "param") {
      const pname = typeof src.param === "string" && src.param.trim() ? src.param.trim() : "";
      if (!pname) return { err: `块「${fname}」要绑参数却没给名字（source.param）` };
      let pid = pidOf.get(pname);
      if (!pid) {
        pid = snid("sp");
        pidOf.set(pname, pid);
        const mn = toInt(src.min);
        const mx = toInt(src.max);
        params.push({
          id: pid,
          name: pname,
          type: paramTypeOf(type),
          def: String(src.def ?? "0"),
          ...(mn === null ? {} : { min: mn }),
          ...(mx === null ? {} : { max: mx }),
        });
      }
      source = { kind: "param", paramId: pid };
    } else if (kind === "var") {
      const v = typeof src.name === "string" ? src.name.trim() : "";
      if (!v) return { err: `块「${fname}」要取解析变量却没给变量名（source.name）` };
      source = { kind: "var", name: v };
    } else if (kind === "seq") {
      const st = toInt(src.step);
      const wr = toInt(src.wrap);
      source = { kind: "seq", ...(st ? { step: st } : {}), ...(wr ? { wrap: wr } : {}) };
    } else if (kind === "len") {
      const covers = SEND_COVERS.includes(String(src.covers)) ? (src.covers as "self" | "after" | "body") : "after";
      const adj = toInt(src.adjust);
      source = { kind: "len", covers, ...(adj === null ? {} : { adjust: adj }) };
    } else {
      return { err: `块「${fname}」的来源「${kind}」不认识（const / param / var / seq / len）` };
    }

    const bt = fo.bits as Record<string, unknown> | undefined;
    const bi = toInt(bt?.index);
    const bc = toInt(bt?.count);
    fields.push({
      id: snid("sf"),
      name: fname,
      type,
      endian,
      role,
      ...(size === null ? {} : { size }),
      ...(type === "bits" && bc !== null ? { bits: { index: bi ?? 0, count: bc } } : {}),
      source,
    });
  }

  let checksum: SendTemplate["checksum"] = null;
  const ck = o.checksum as Record<string, unknown> | undefined;
  const algo = typeof ck?.algo === "string" ? ck.algo : "";
  if (algo && algo !== "none") {
    if (!CHECKSUM_ALGOS.includes(algo as ChecksumAlgo)) return { err: `谱「${name}」的校验算法「${algo}」不认识` };
    let crc: CrcParams | null = null;
    if (algo === "crc_custom") {
      const parsedCrc = parseCrcParams(ck?.crc);
      if (!parsedCrc) return { err: `谱「${name}」的 crc_custom 要给全 width/poly/init/refin/refout/xorout（位数 8/16/32）` };
      crc = parsedCrc;
    }
    const cs = toInt(ck?.coverageStart);
    const ce = toInt(ck?.coverageEnd);
    checksum = {
      algo: algo as ChecksumAlgo,
      coverageStart: cs ?? 0,
      coverageEnd: ce ?? -checksumWidth(algo, crc),
      ...(crc ? { crc } : {}),
    };
  }

  const draft: SendTemplate = {
    id: snid("st"),
    name,
    note: typeof o.note === "string" ? o.note : "由 AI 助手生成",
    fields,
    params,
    checksum,
    nextSeq: 0,
    createdAt: Date.now(),
  };
  // 这道闸替代了"看起来配上了"：编不出帧就整张拒收，编码器点名是哪一块。
  // 变量块给 "0" 占位——它此刻没有值是**正常的**（要等解析到那一帧才有值），
  // 试编问的只是结构（宽度、校验自不自洽、参数引没引到），不是值。
  const probeVars: Record<string, number | string> = {};
  for (const f of fields) if (f.source.kind === "var") probeVars[f.source.name] = "0";
  try {
    encodeSend(draft, { seq: 0, vars: probeVars });
  } catch (e) {
    return { err: `谱「${name}」编不出帧：${e instanceof SendEncodeError ? e.message : String(e)}` };
  }
  return { tpl: draft };
}
