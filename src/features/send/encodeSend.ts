/**
 * P121-B · 发送谱的编码器：**纯函数**，无副作用、不碰 DOM、不碰 store。
 *
 * 它是这一批唯一的新真值层：预览与发送必须调同一个 `encodeSend`，
 * 否则又会长成今天这样——悬浮提示显示模板原文、点下去发的是另一份（详设 §1.5 d）。
 *
 * 三条硬规矩：
 *  1. **缺值就报错，不静默发原文**。今天 `resolveVars` 对不认识的名字"原样保留"
 *     （`variableStore.ts:192`），于是 `SPD:{speed}!` 会被逐字发给设备。发送谱这条路不继承这个行为。
 *  2. 数值一律按字段类型查范围，越界报错并点名是哪个字段。
 *  3. 长度域与校验都是**两趟**：第一趟按占位宽度铺字节，第二趟回填 —— 因为长度要等全帧定型、
 *     校验要等长度填完。
 */
import { checksumWidth, crc16, crc32, sum16, sum8, sumadd16, xor8 } from "../../shared/checksums";
import type { Endian, FieldType } from "../../ipc/types";
import { sendFieldWidth, type SendField, type SendParam, type SendTemplate } from "./sendTypes";

export interface EncodeInput {
  /** paramId → 用户填的字符串；缺省回落到 `SendParam.def` */
  values?: Record<string, string>;
  /** 变量表：`{ kind: "var" }` 从这里取值（发送侧不查全局，测试与预览都自带一份） */
  vars?: Record<string, number | string>;
  /** 自增帧序号的当前值（D9）。编码器不持有状态：下一帧的值由返回值给出 */
  seq?: number;
}

export interface EncodeResult {
  bytes: number[];
  /** 与 `serial.rs parse_hex` 同形：大写、空格分隔 */
  hex: string;
  notes: string[];
  /** 下一次该用的序号（调用方决定是否落盘） */
  seqAfter: number;
}

/** 面向人的错误：一律点名字段，不抛栈 */
export class SendEncodeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SendEncodeError";
  }
}

/** 整数类型的取值范围（`float*` / `ascii` / `bcd` / `bits` 不在表里，返回 undefined） */
export const intRangeOf = (t: FieldType): [number, number] | undefined => INT_RANGE[t];

const INT_RANGE: Partial<Record<FieldType, [number, number]>> = {
  uint8: [0, 0xff],
  int8: [-128, 127],
  uint16: [0, 0xffff],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
};

/** 十进制或 `0x` 十六进制；与 `commandFactory.parseIntInput` 同宽容度（详设 §11.3 第 10 条） */
export function parseNumber(text: string, label: string): number {
  const t = text.trim();
  if (!t) throw new SendEncodeError(`${label}：没有值`);
  const n = /^-?0x[0-9a-f]+$/i.test(t) ? Number.parseInt(t, 16) : Number(t);
  if (!Number.isFinite(n)) throw new SendEncodeError(`${label}：「${text}」不是数字（支持十进制或 0x 十六进制）`);
  return n;
}

/** 大端字节（含负数的补码表示） */
function beBytes(value: number, width: number): number[] {
  const out: number[] = [];
  let v = value;
  if (v < 0) v = Math.pow(2, width * 8) + v; // 补码
  for (let i = width - 1; i >= 0; i--) out.push(Math.floor(v / Math.pow(2, 8 * i)) & 0xff);
  return out;
}

/**
 * 字序倒置、字内序不动：`[AB][CD] → [CD][AB]`。
 * CDAB / BADC 这两档存在的理由就是 Modbus 那类"32 位量占两个 16 位寄存器"的协议 ——
 * 它们交换的是**寄存器（字）的先后**，不是寄存器内部的字节。
 */
function swapWords(bytes: number[]): number[] {
  const words: number[][] = [];
  for (let i = 0; i < bytes.length; i += 2) words.push(bytes.slice(i, i + 2));
  return words.reverse().flat();
}

/**
 * 四种字节序落到字节上（与 `parser.rs:812 endian_parts` 同一套语义）：
 * big = ABCD、little = DCBA、big-word-swap = CDAB、little-word-swap = BADC。
 * 16 位下两对等价（只有一个字），所以字序档只对 32/64 位起作用。
 */
export function applyEndian(valueBytes: number[], endian: Endian): number[] {
  const little = [...valueBytes].reverse();
  switch (endian) {
    case "big":
      return valueBytes;
    case "little":
      return little;
    case "big-word-swap":
      return swapWords(valueBytes);
    case "little-word-swap":
      return swapWords(little);
  }
}

function floatBytes(value: number, width: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  const all = new Uint8Array(buf);
  // float32：先按 f64 取整数值再截高位字节会错，必须真按 f32 编
  if (width === 4) {
    const b4 = new ArrayBuffer(4);
    new DataView(b4).setFloat32(0, value, false);
    return Array.from(new Uint8Array(b4));
  }
  return Array.from(all);
}

function bcdBytes(value: number, width: number, label: string): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new SendEncodeError(`${label}：BCD 只能编非负整数`);
  }
  const digits = String(value).split("").map(Number);
  const cap = width * 2;
  if (digits.length > cap) {
    throw new SendEncodeError(`${label}：BCD ${width} 字节最多 ${cap} 位十进制，当前 ${digits.length} 位`);
  }
  const padded = new Array<number>(cap - digits.length).fill(0).concat(digits);
  const out: number[] = [];
  for (let i = 0; i < cap; i += 2) out.push(((padded[i] << 4) | padded[i + 1]) & 0xff);
  return out;
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function coerceNumber(raw: string, field: SendField, param: SendParam | undefined, label: string): number {
  const n = parseNumber(raw, label);
  if (param?.min !== undefined && n < param.min) throw new SendEncodeError(`${label}：小于下限 ${param.min}`);
  if (param?.max !== undefined && n > param.max) throw new SendEncodeError(`${label}：大于上限 ${param.max}`);
  const r = INT_RANGE[field.type];
  if (r && (n < r[0] || n > r[1])) {
    throw new SendEncodeError(`${label}：${field.type} 的范围是 ${r[0]}~${r[1]}，当前 ${n}`);
  }
  if ((field.type === "float32" || field.type === "float64") && !Number.isFinite(n)) {
    throw new SendEncodeError(`${label}：不是有限小数`);
  }
  return n;
}

/** 一个字段 → 若干字节。`len` / `checksum` 在这里只占位，第二趟再回填 */
function fieldBytes(
  f: SendField,
  tpl: SendTemplate,
  inp: EncodeInput,
  seqNow: number,
): { bytes: number[]; note?: string } {
  const label = `字段「${f.name}」`;
  const src = f.source;
  const width = sendFieldWidth(f);

  if (src.kind === "const") {
    for (const b of src.bytes) {
      if (!Number.isInteger(b) || b < 0 || b > 255) {
        throw new SendEncodeError(`${label}：固定字节里有 ${b}，只接受 0~255`);
      }
    }
    return { bytes: [...src.bytes] };
  }
  if (src.kind === "len") return { bytes: new Array<number>(width).fill(0) };
  if (src.kind === "seq") {
    const wrap = src.wrap ?? Math.pow(2, 8 * width);
    const v = ((seqNow % wrap) + wrap) % wrap;
    return { bytes: applyEndian(beBytes(v, width), f.endian) };
  }

  let raw: string;
  if (src.kind === "param") {
    const param = tpl.params.find((p) => p.id === src.paramId);
    if (!param) throw new SendEncodeError(`${label}：引用了不存在的参数 ${src.paramId}`);
    const given = inp.values?.[param.id];
    raw = (given !== undefined && given !== "" ? given : param.def ?? "").trim();
    if (!raw) throw new SendEncodeError(`${label}：参数「${param.name}」没有值，也没有默认值`);
    if (param.type === "enum") {
      const hit = param.enumMap?.find((e) => e.label === raw || e.value === raw);
      if (!hit) throw new SendEncodeError(`${label}：「${raw}」不在参数「${param.name}」的档位里`);
      raw = hit.value;
    }
  } else {
    const v = inp.vars?.[src.name];
    if (v === undefined || v === "") {
      // 这里刻意**不**学 resolveVars 的"原样保留"：把 `{speed}` 逐字发给设备不是宽容，是骗人
      throw new SendEncodeError(`${label}：变量「${src.name}」还没有值（先解析到该字段，或改用参数）`);
    }
    raw = String(v);
  }

  if (f.type === "ascii" || f.type === "csv") {
    if (f.type === "csv") {
      throw new SendEncodeError(`${label}：csv 是解析侧的显示类型，发送谱暂不支持（详设 §9 R1）`);
    }
    return { bytes: utf8(raw) };
  }
  if (f.type === "bcd") return { bytes: bcdBytes(parseNumber(raw, label), width, label) };
  if (f.type === "bits") {
    const n = parseNumber(raw, label);
    const count = f.bits?.count ?? 1;
    const index = f.bits?.index ?? 0;
    const mask = ((1 << count) - 1) << index;
    if (n < 0 || n > (1 << count) - 1) {
      throw new SendEncodeError(`${label}：位段 ${count} 位，取值范围 0~${(1 << count) - 1}`);
    }
    return { bytes: [(n << index) & mask] };
  }
  const n = coerceNumber(raw, f, src.kind === "param" ? tpl.params.find((p) => p.id === src.paramId) : undefined, label);
  if (f.type === "float32" || f.type === "float64") {
    return { bytes: applyEndian(floatBytes(n, sendFieldWidth(f)), f.endian) };
  }
  return { bytes: applyEndian(beBytes(Math.round(n), sendFieldWidth(f)), f.endian) };
}

function checksumBytes(algo: string, data: number[]): number[] {
  switch (algo) {
    case "sum8":
      return [sum8(data)];
    case "xor8":
      return [xor8(data)];
    case "sumadd": {
      const v = sumadd16(data);
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "sum16": {
      const v = sum16(data);
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "crc16_modbus": {
      const v = crc16("modbus", data);
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "crc16_ccitt": {
      const v = crc16("ccitt-false", data);
      return [(v >> 8) & 0xff, v & 0xff];
    }
    case "crc16_x25": {
      // 反射算法（X.25 / BUETE），线上低字节在前，与 crc16_modbus 同一档
      const v = crc16("x25", data);
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "crc32": {
      const v = crc32(data) >>> 0;
      return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    }
    default:
      throw new SendEncodeError(`发送谱用了不支持的校验算法「${algo}」`);
  }
}

/** 覆盖范围：负终点按"距帧尾"算，与接收侧 `ChecksumCfg.coverageEnd` 同语义 */
function coverageSlice(bytes: number[], start: number, end: number): number[] {
  const from = Math.max(0, start);
  const to = end < 0 ? bytes.length + end : Math.min(bytes.length, end + 1);
  if (to <= from) throw new SendEncodeError(`校验覆盖范围是空的（start=${start}、end=${end}、帧长=${bytes.length}）`);
  return bytes.slice(from, to);
}

/**
 * 「字节 (hex)」输入框的解析。
 *
 * 旧实现是 `split(空格).map(parseInt(h,16)).filter(0..255)` —— 于是打 `1234`（忘了空格）
 * 得到 4660，被 filter 静默丢掉，那一块**变成 0 字节**而界面一声不吭。
 * 这里改成：连续 hex 按两两分组（`1234` = `12 34`），组不成对或超字节的 token 一律进 `bad`
 * 由界面点名，绝不悄悄改数据。
 */
export function parseHexInput(text: string): { bytes: number[]; bad: string[] } {
  const bytes: number[] = [];
  const bad: string[] = [];
  for (const raw of text.replace(/,/g, " ").split(/\s+/).filter(Boolean)) {
    if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
      bad.push(raw);
      continue;
    }
    for (let i = 0; i < raw.length; i += 2) bytes.push(Number.parseInt(raw.slice(i, i + 2), 16));
  }
  return { bytes, bad };
}

/** 参数默认值 + 本次覆盖 = 编码器要的 values。没覆盖也不给默认值时留空，由编码器报错点名 */
export function sendValues(tpl: SendTemplate, overrides?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of tpl.params) {
    const v = overrides?.[p.id];
    out[p.id] = v !== undefined && v !== "" ? v : p.def ?? "";
  }
  return out;
}

export function encodeSend(tpl: SendTemplate, inp: EncodeInput = {}): EncodeResult {
  if (!tpl.fields.length) throw new SendEncodeError(`发送谱「${tpl.name}」一个字段都没有`);
  const notes: string[] = [];
  const slots: { field: SendField; at: number; width: number }[] = [];
  /** 每个字段实际占的字节区间：ascii 变长、const 可多字节，所以不能拿 sendFieldWidth 累加 */
  const spans: { field: SendField; at: number; len: number }[] = [];
  const bytes: number[] = [];
  let seq = inp.seq ?? 0;
  let seqAfter = seq;

  for (const f of tpl.fields) {
    const at = bytes.length;
    if (f.source.kind === "len") {
      const width = sendFieldWidth(f);
      slots.push({ field: f, at, width });
      spans.push({ field: f, at, len: width });
      bytes.push(...new Array<number>(width).fill(0));
      continue;
    }
    if (f.role === "checksum" || f.role === "checksum2") {
      // 校验段的宽度**由算法决定**，不是用户填的：让它自己声明宽度就会长出"宽度与算法不符"
      // 这一类根本该存在的错误。它也不该绑来源——值是算出来的。
      if (!tpl.checksum) throw new SendEncodeError(`字段「${f.name}」标成校验，但这张谱没有选校验算法`);
      const want = checksumWidth(tpl.checksum.algo);
      if (want === 0) throw new SendEncodeError(`发送谱用了不支持的校验算法「${tpl.checksum.algo}」`);
      if (f.source.kind !== "const") {
        throw new SendEncodeError(`校验段「${f.name}」的值由算法算出，不能绑参数或变量`);
      }
      spans.push({ field: f, at, len: want });
      bytes.push(...new Array<number>(want).fill(0));
      continue;
    }
    const r = fieldBytes(f, tpl, inp, seq);
    if (f.source.kind === "seq") {
      seq += f.source.step ?? 1;
      seqAfter = seq;
    }
    spans.push({ field: f, at, len: r.bytes.length });
    bytes.push(...r.bytes);
    if (r.note) notes.push(r.note);
  }

  // 第二趟：长度域回填（校验还没算，所以长度算的是"不含校验头"的当前长度 —— 与 Rust 侧同序）
  for (const s of slots) {
    const src = s.field.source;
    if (src.kind !== "len") continue;
    const bodyLen = src.covers === "self" ? bytes.length : src.covers === "after" ? bytes.length - (s.at + s.width) : bytes.length - s.at;
    const v = bodyLen + (src.adjust ?? 0);
    if (v < 0) throw new SendEncodeError(`字段「${s.field.name}」算出负长度（${bodyLen} ${src.adjust ?? 0}）`);
    const enc = applyEndian(beBytes(v, s.width), s.field.endian);
    bytes.splice(s.at, s.width, ...enc);
    notes.push(`长度域「${s.field.name}」= ${v}`);
  }

  // 第三趟：校验。放在长度回填之后，才不会出现"长度对了校验错"
  if (tpl.checksum && tpl.checksum.algo !== "none") {
    const span = spans.find((s) => s.field.role === "checksum" || s.field.role === "checksum2");
    if (!span) throw new SendEncodeError("选了校验算法，但没有一个字段标成校验段");
    const data = coverageSlice(bytes, tpl.checksum.coverageStart, tpl.checksum.coverageEnd);
    const ck = checksumBytes(tpl.checksum.algo, data);
    bytes.splice(span.at, span.len, ...ck);
    notes.push(`${tpl.checksum.algo} = ${ck.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
  }

  const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  return { bytes, hex, notes, seqAfter };
}
