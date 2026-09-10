/**
 * Modbus 内核（M2-a）：编解码 + 数据区模型 + 流式切帧。
 *
 * 一处实现、三处复用：指令工厂组帧（M2-b）、模拟从站应答（M2-c）、主站轮询表（M2-d）。
 * 与 Rust 解码器（src-tauri/src/parser.rs）的约定严格一致：
 *  - RTU ADU = [从站][FC][PDU][CRC16 低字节在前]
 *  - FC01/02 响应的「字节数」由位数向上取整而来
 *  - 字序四档 ABCD/DCBA/CDAB/BADC 与 read_uint 互逆
 * 线上地址一律 0 基址（协议字段值）；手册编号（40001…）用 legacyToAddr 换算。
 *
 * 本模块刻意不 import 指令工厂（那边会反过来 import 本模块，成环）：
 * CRC16-Modbus 在这里独立实现，算法与 shared/checksums.ts 一致。
 */

import type { Endian, ValueLabel } from "../../ipc/types";

/* ================= 功能码与常量 ================= */

export type MbFn = 0x01 | 0x02 | 0x03 | 0x04 | 0x05 | 0x06 | 0x0f | 0x10;

export const MB_FNS: MbFn[] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0f, 0x10];

export const FC_LABEL: Record<number, string> = {
  0x01: "01 读线圈",
  0x02: "02 读离散输入",
  0x03: "03 读保持寄存器",
  0x04: "04 读输入寄存器",
  0x05: "05 写单线圈",
  0x06: "06 写单寄存器",
  0x0f: "15 写多个线圈",
  0x10: "16 写多个寄存器",
};

export function fcLabel(fn: number): string {
  const key = fn & 0x7f;
  const base = FC_LABEL[key] ?? `${key.toString(16).toUpperCase().padStart(2, "0")} 未知功能码`;
  return fn & 0x80 ? `${base}（异常响应）` : base;
}

/** 数据区：线圈（可读写位）、离散输入（只读位）、保持寄存器（可写字）、输入寄存器（只读字） */
export type MbArea = "coil" | "disc" | "holding" | "input";

/** 读功能码 → 它读的是哪个区 */
export const AREA_OF_READ_FN: Record<number, MbArea> = {
  0x01: "coil",
  0x02: "disc",
  0x03: "holding",
  0x04: "input",
};

/** 功能码 → 数据区（含写功能码）：决定手册编号段与提示文字 */
export function areaOfFn(fn: number): MbArea {
  const read = AREA_OF_READ_FN[fn];
  if (read) return read;
  return fn === 0x05 || fn === 0x0f ? "coil" : "holding";
}

export const AREA_LABEL: Record<MbArea, string> = {
  coil: "线圈",
  disc: "离散输入",
  holding: "保持寄存器",
  input: "输入寄存器",
};

/** 协议约束：寄存器单次 125 个、位 2000 个 */
export const MAX_QTY_REG = 125;
export const MAX_QTY_BIT = 2000;
/** RTU ADU 上限（含从站与 CRC）；超长一律按噪声处理，避免坏长度域卡住整条流 */
export const MAX_ADU = 256;

export const EX_ILLEGAL_FUNCTION = 1;
export const EX_ILLEGAL_ADDRESS = 2;
export const EX_SLAVE_FAILURE = 3;
export const EX_ACKNOWLEDGE = 4;
export const EX_SLAVE_BUSY = 5;
export const EX_MEMORY_PARITY = 8;
export const EX_GATEWAY_PATH = 10;
export const EX_GATEWAY_NO_REPLY = 11;

/** 规范异常码 → 文字（从站注入选项、UI 提示与模板值标签同源） */
export const MB_EXCEPTION_LABELS: ValueLabel[] = [
  { v: EX_ILLEGAL_FUNCTION, t: "非法功能码" },
  { v: EX_ILLEGAL_ADDRESS, t: "非法数据地址" },
  { v: EX_SLAVE_FAILURE, t: "从站设备故障" },
  { v: EX_ACKNOWLEDGE, t: "响应确认（处理中）" },
  { v: EX_SLAVE_BUSY, t: "从站设备忙" },
  { v: EX_MEMORY_PARITY, t: "存储奇偶校验错误" },
  { v: EX_GATEWAY_PATH, t: "网关路径不可用" },
  { v: EX_GATEWAY_NO_REPLY, t: "网关目标无响应" },
];

export function exceptionText(code: number): string {
  return MB_EXCEPTION_LABELS.find((l) => l.v === code)?.t ?? `未知异常码 ${code}`;
}

/* ================= CRC ================= */

/** CRC16-Modbus：poly 0x8005 反射算法（等价于查表法 init 0xFFFF / xorout 0） */
export function mbCrc(bytes: number[]): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** 校验帧尾 CRC16（低字节在前） */
export function rtuCrcOk(frame: number[]): boolean {
  if (frame.length < 4) return false;
  const got = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return mbCrc(frame.slice(0, frame.length - 2)) === got;
}

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];

function needRange(v: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`「${label}」需为 ${min}~${max}`);
}

/* ================= 位区工具 ================= */

/** 取第 i 位（每字节低位在前，与 Modbus 位打包一致） */
export function bitGet(buf: Uint8Array, i: number): 0 | 1 {
  return (((buf[i >> 3] ?? 0) >> (i & 7)) & 1) as 0 | 1;
}

export function bitSet(buf: Uint8Array, i: number, on: boolean): void {
  const byte = i >> 3;
  if (byte >= buf.length) return;
  if (on) buf[byte] = (buf[byte] | (1 << (i & 7))) & 0xff;
  else buf[byte] = buf[byte] & ~(1 << (i & 7)) & 0xff;
}

/** 打包位区 → 0/1 数组 */
export function bitsOf(buf: Uint8Array, start: number, qty: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < qty; i++) out.push(bitGet(buf, start + i));
  return out;
}

/** 0/1 数组 → 打包位区 */
export function packBits(bits: number[]): Uint8Array {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => bitSet(packed, i, !!v));
  return packed;
}

/* ================= 字序（与 Rust read_uint 互逆） ================= */

/**
 * 32 位量 → 线上 4 字节。记 b3 为最高有效字节：
 * big(ABCD)=[b3,b2,b1,b0]、little(DCBA)=[b0,b1,b2,b3]、
 * big-word-swap(CDAB)=[b1,b0,b3,b2]、little-word-swap(BADC)=[b2,b3,b0,b1]
 */
export function encodeU32Bytes(value: number, endian: Endian): number[] {
  const u = value >>> 0;
  const b0 = u & 0xff;
  const b1 = (u >>> 8) & 0xff;
  const b2 = (u >>> 16) & 0xff;
  const b3 = (u >>> 24) & 0xff;
  switch (endian) {
    case "big":
      return [b3, b2, b1, b0];
    case "little":
      return [b0, b1, b2, b3];
    case "big-word-swap":
      return [b1, b0, b3, b2];
    case "little-word-swap":
      return [b2, b3, b0, b1];
  }
}

/** 线上 4 字节 → 32 位无符号数（encodeU32Bytes 的逆） */
export function decodeU32Bytes(w: number[], endian: Endian): number {
  const w0 = w[0] ?? 0;
  const w1 = w[1] ?? 0;
  const w2 = w[2] ?? 0;
  const w3 = w[3] ?? 0;
  const b: number[] = [];
  if (endian === "big") {
    b[3] = w0; b[2] = w1; b[1] = w2; b[0] = w3;
  } else if (endian === "little") {
    b[0] = w0; b[1] = w1; b[2] = w2; b[3] = w3;
  } else if (endian === "big-word-swap") {
    b[1] = w0; b[0] = w1; b[3] = w2; b[2] = w3;
  } else {
    b[2] = w0; b[3] = w1; b[0] = w2; b[1] = w3;
  }
  return (((b[3] ?? 0) << 24) >>> 0 | ((b[2] ?? 0) << 16) | ((b[1] ?? 0) << 8) | (b[0] ?? 0)) >>> 0;
}

/** 两个寄存器 → 4 个线上字节（Modbus 规定寄存器内部固定大端） */
export function regsToBytes(r0: number, r1: number): number[] {
  return be16(r0 & 0xffff).concat(be16(r1 & 0xffff));
}

export function bytesToRegs(w: number[]): [number, number] {
  return [((w[0] << 8) | w[1]) & 0xffff, ((w[2] << 8) | w[3]) & 0xffff];
}

/** 32 位值 → 两个寄存器（按字序），供写多点使用 */
export function u32ToRegs(value: number, endian: Endian): [number, number] {
  return bytesToRegs(encodeU32Bytes(value, endian));
}

export function regsToU32(r0: number, r1: number, endian: Endian): number {
  return decodeU32Bytes(regsToBytes(r0, r1), endian);
}

/** 浮点：按 IEEE-754 位型走同一套字序 */
export function f32ToRegs(value: number, endian: Endian): [number, number] {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, value, false);
  return u32ToRegs(dv.getUint32(0, false), endian);
}

export function regsToF32(r0: number, r1: number, endian: Endian): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, regsToU32(r0, r1, endian), false);
  return dv.getFloat32(0, false);
}

/* ================= 组帧 ================= */

export interface MbRequest {
  slave: number;
  fn: number;
  /** 起始地址 / 线圈地址（0 基址） */
  addr: number;
  /** 读功能码：数量 */
  qty?: number;
  /** FC05：0/1（非 0 视为置位）；FC06：寄存器值 */
  value?: number;
  /** FC15：0/1 数组；FC16：字数组。数量由数组长度决定 */
  values?: number[];
}

/** 组请求 PDU（含功能码，不含从站地址与 CRC）：RTU 与 TCP 共用同一套参数校验 */
export function buildRequestPdu(r: MbRequest): number[] {
  needRange(r.addr, 0, 0xffff, "起始地址");
  const body: number[] = [r.fn];
  switch (r.fn) {
    case 0x01:
    case 0x02:
      needRange(r.qty ?? 0, 1, MAX_QTY_BIT, "数量");
      body.push(...be16(r.addr), ...be16(r.qty ?? 0));
      break;
    case 0x03:
    case 0x04:
      needRange(r.qty ?? 0, 1, MAX_QTY_REG, "数量");
      body.push(...be16(r.addr), ...be16(r.qty ?? 0));
      break;
    case 0x05:
      body.push(...be16(r.addr), r.value ? 0xff : 0x00, 0x00);
      break;
    case 0x06:
      needRange(r.value ?? 0, 0, 0xffff, "写入值");
      body.push(...be16(r.addr), ...be16(r.value ?? 0));
      break;
    case 0x0f: {
      const vals = r.values ?? [];
      needRange(vals.length, 1, MAX_QTY_BIT, "写入值数量");
      const packed = packBits(vals);
      body.push(...be16(r.addr), ...be16(vals.length), packed.length, ...packed);
      break;
    }
    case 0x10: {
      const vals = r.values ?? [];
      needRange(vals.length, 1, MAX_QTY_REG, "写入值数量");
      body.push(...be16(r.addr), ...be16(vals.length), vals.length * 2);
      for (const v of vals) body.push(...be16(v & 0xffff));
      break;
    }
    default:
      throw new Error(`不支持的功能码 ${fcLabel(r.fn)}`);
  }
  return body;
}

/** 组 RTU 请求帧（含从站地址与 CRC）；参数越界抛中文错误，UI 可直接提示 */
export function buildRtuRequest(r: MbRequest): number[] {
  needRange(r.slave, 0, 247, "从站地址");
  const body = [r.slave, ...buildRequestPdu(r)];
  const crc = mbCrc(body);
  return [...body, crc & 0xff, (crc >> 8) & 0xff];
}

/** 事务号自增计数器；传 0 表示"自动取下一个"（16 位回绕） */
let txnCounter = 0;
export function nextTxn(v: number): number {
  if (v) return v & 0xffff;
  txnCounter = (txnCounter + 1) & 0xffff;
  return txnCounter;
}

/** 组 TCP 请求 ADU（MBAP 头，无 CRC）；unit 省略时用从站地址 */
export function buildTcpRequest(r: MbRequest, txn: number, unit = r.slave): number[] {
  return buildTcpAdu({ txn: nextTxn(txn), unit: unit & 0xff, pdu: buildRequestPdu(r) });
}

/** 正常响应/回显 PDU → RTU ADU（含从站与 CRC） */
export function buildRtuResponse(slave: number, pdu: number[]): number[] {
  const body = [slave, ...pdu];
  const crc = mbCrc(body);
  return [...body, crc & 0xff, (crc >> 8) & 0xff];
}

/** 异常响应 PDU：FC|0x80 + 异常码 */
export function exceptionPdu(fn: number, code: number): number[] {
  return [(fn | 0x80) & 0xff, code & 0xff];
}

export function isExceptionPdu(pdu: number[]): boolean {
  return ((pdu[0] ?? 0) & 0x80) !== 0;
}

/** 读响应 PDU（寄存器/位区通用）：[FC, 字节数, 数据…] */
export function readResponsePdu(fn: number, data: number[]): number[] {
  return [fn, data.length, ...data];
}

/* ================= 从站数据区 ================= */

export interface MbBanks {
  coils: Uint8Array;
  discs: Uint8Array;
  holding: Uint16Array;
  input: Uint16Array;
}

/** 默认每区 1000 点（位区 1000 字节 = 8000 位），够现场调试 */
export function makeBanks(bits = 1000, words = 1000): MbBanks {
  return {
    coils: new Uint8Array(bits),
    discs: new Uint8Array(bits),
    holding: new Uint16Array(words),
    input: new Uint16Array(words),
  };
}

export function isBitArea(area: MbArea): boolean {
  return area === "coil" || area === "disc";
}

export function bankOf(b: MbBanks, area: MbArea): Uint8Array | Uint16Array {
  if (area === "coil") return b.coils;
  if (area === "disc") return b.discs;
  return area === "holding" ? b.holding : b.input;
}

/** 地址是否落在数据区内（位区按位数判、字区按字数判） */
export function inRange(b: MbBanks, area: MbArea, addr: number, qty: number): boolean {
  const bank = bankOf(b, area);
  const cap = isBitArea(area) ? bank.length * 8 : bank.length;
  return addr >= 0 && qty >= 1 && addr + qty <= cap;
}

export type MbOutcome =
  | { kind: "response"; pdu: number[] }
  | { kind: "exception"; code: number }
  /** 广播（从站 0）：协议规定不作答 */
  | { kind: "silent" };

/**
 * 用数据区应答一条请求 PDU（从站核心）。
 * 未知功能码 → 01；地址/数量越界 → 02；广播读 → 静默；广播写 → 执行但不答。
 */
export function answerPdu(banks: MbBanks, slave: number, pdu: number[]): MbOutcome {
  const fn = pdu[0] ?? 0;
  const addr = (pdu[1] << 8) | pdu[2];
  const qty = (pdu[3] << 8) | pdu[4];
  const broadcast = slave === 0;
  const echoOrSilent = (p: number[]): MbOutcome =>
    broadcast ? { kind: "silent" } : { kind: "response", pdu: p };

  switch (fn) {
    case 0x01:
    case 0x02: {
      if (broadcast) return { kind: "silent" };
      const area: MbArea = fn === 0x01 ? "coil" : "disc";
      if (qty < 1 || qty > MAX_QTY_BIT || !inRange(banks, area, addr, qty)) {
        return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      }
      const packed = packBits(bitsOf(bankOf(banks, area) as Uint8Array, addr, qty));
      return { kind: "response", pdu: readResponsePdu(fn, [...packed]) };
    }
    case 0x03:
    case 0x04: {
      if (broadcast) return { kind: "silent" };
      const area: MbArea = fn === 0x03 ? "holding" : "input";
      if (qty < 1 || qty > MAX_QTY_REG || !inRange(banks, area, addr, qty)) {
        return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      }
      const bank = bankOf(banks, area) as Uint16Array;
      const data: number[] = [];
      for (let i = 0; i < qty; i++) data.push(...be16(bank[addr + i]));
      return { kind: "response", pdu: readResponsePdu(fn, data) };
    }
    case 0x05: {
      // 强制值必须是 FF00 / 0000（规范），FF00=闭合
      if (pdu[3] !== 0xff || pdu[4] !== 0x00) {
        if (!(pdu[3] === 0x00 && pdu[4] === 0x00)) return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      }
      if (!inRange(banks, "coil", addr, 1)) return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      bitSet(banks.coils, addr, pdu[3] === 0xff);
      return echoOrSilent([fn, pdu[1], pdu[2], pdu[3], pdu[4]]);
    }
    case 0x06: {
      if (!inRange(banks, "holding", addr, 1)) return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      banks.holding[addr] = ((pdu[3] << 8) | pdu[4]) & 0xffff;
      return echoOrSilent([fn, pdu[1], pdu[2], pdu[3], pdu[4]]);
    }
    case 0x0f:
    case 0x10: {
      const words = fn === 0x10;
      const area: MbArea = words ? "holding" : "coil";
      const byteCount = pdu[5] ?? 0;
      const expect = words ? qty * 2 : Math.ceil(qty / 8);
      if (qty < 1 || expect !== byteCount || pdu.length < 6 + expect) {
        return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      }
      if (!inRange(banks, area, addr, qty)) return { kind: "exception", code: EX_ILLEGAL_ADDRESS };
      if (words) {
        for (let i = 0; i < qty; i++) {
          banks.holding[addr + i] = ((pdu[6 + i * 2] << 8) | pdu[7 + i * 2]) & 0xffff;
        }
      } else {
        for (let i = 0; i < qty; i++) {
          bitSet(banks.coils, addr + i, ((pdu[6 + (i >> 3)] ?? 0) >> (i & 7) & 1) === 1);
        }
      }
      return echoOrSilent([fn, pdu[1], pdu[2], pdu[3], pdu[4]]);
    }
    default:
      return { kind: "exception", code: EX_ILLEGAL_FUNCTION };
  }
}

/* ================= RTU 流式切帧 ================= */

export interface RtuFrame {
  slave: number;
  fn: number;
  /** 含功能码的 PDU（= 帧去掉从站地址与 CRC） */
  pdu: number[];
  bytes: number[];
  crcOk: boolean;
}

/**
 * 该视角下此帧的总长度；null = 字节还不够，等下一批；0 = 此处不可能是帧首。
 *
 * 不靠"两种解释都试试"猜长度：**方向决定帧长**（真实协议栈同做法）——
 *  - 收请求侧（从站）：FC01–06 恒 8 字节；FC15/16 = 9 + 数据字节数
 *  - 收响应侧（主站）：FC01–04 读响应 = 5 + 字节数；FC05/06/15/16 回显 = 8
 *  - 异常响应（FC|0x80）两侧都是 5
 *
 * 字节数超过协议上限（252）判为"这里不是帧首"：坏帧被污染的长度域若拿去等待，
 * 会把整条流卡死在永远等不到的字节上。主站更稳的用法见 MbView 的 expectLen。
 */
export function rtuFrameLen(buf: number[], from: number, side: "slave" | "master"): number | null {
  if (buf.length - from < 3) return null;
  const fn = buf[from + 1];
  if (fn === undefined) return null;
  if ((fn & 0x80) !== 0) return 5;
  if (fn === 0x0f || fn === 0x10) {
    if (side === "slave") {
      const bc = buf[from + 6];
      if (bc === undefined) return null;
      return bc > 252 ? 0 : 9 + bc;
    }
    return 8;
  }
  if (fn >= 0x01 && fn <= 0x06) {
    if (side === "slave" || fn >= 0x05) return 8; // 读请求 / 写单点请求与其回显都是定长 8
    const bc = buf[from + 2];
    if (bc === undefined) return null;
    return bc > 252 ? 0 : 5 + bc;
  }
  return 0;
}

/**
 * 取帧视角：
 *  - `"slave"` / `"master"`：按方向推出的帧长
 *  - `{ expectLen }`：调用方**已知**帧长。主站轮询最稳的用法——它自己发的请求决定了
 *    响应长度（5 + 数据字节数），于是坏帧里被污染的字节数再也卡不住流
 */
export type MbView = "slave" | "master" | { expectLen: number };

function viewLen(buf: number[], view: MbView): number | null {
  if (typeof view === "object") return buf.length < 4 ? null : view.expectLen;
  return rtuFrameLen(buf, 0, view);
}

function frameOf(bytes: number[]): RtuFrame {
  return {
    slave: bytes[0],
    fn: bytes[1],
    pdu: bytes.slice(1, bytes.length - 2),
    bytes,
    crcOk: rtuCrcOk(bytes),
  };
}

/**
 * 从字节流头部取出一帧（原地消费 `buf`）；数据还不够时返回 null。
 * CRC 不符时**只前进 1 字节继续找**（重同步），避免把紧随其后的好帧一起吃掉；
 * 被丢弃的字节数通过 `onDrop` 告知调用方，用于「噪声丢弃」计数。
 */
export function takeRtuFrame(
  buf: number[],
  view: MbView,
  onDrop?: (bytes: number) => void,
): RtuFrame | null {
  let dropped = 0;
  for (;;) {
    const len = viewLen(buf, view);
    if (len === null) break; // 等更多字节
    if (len <= 0 || len > MAX_ADU) {
      buf.splice(0, 1);
      dropped++;
      continue;
    }
    if (buf.length < len) break; // 帧还没收满
    if (rtuCrcOk(buf.slice(0, len))) {
      const bytes = buf.splice(0, len);
      if (dropped && onDrop) onDrop(dropped);
      return frameOf(bytes);
    }
    buf.splice(0, 1); // 坏帧：按噪声处理，前进 1 字节重找
    dropped++;
  }
  if (dropped && onDrop) onDrop(dropped);
  return null;
}

/** 解析请求 PDU 的 [功能码, 地址, 数量]；写多点附带解析出的值数组 */
export function parseRequestPdu(pdu: number[]): {
  fn: number;
  addr: number;
  qty: number;
  values: number[];
} {
  const fn = pdu[0] ?? 0;
  const addr = (pdu[1] << 8) | pdu[2];
  const qty = (pdu[3] << 8) | pdu[4];
  if (fn !== 0x0f && fn !== 0x10) return { fn, addr, qty, values: [] };
  const bc = pdu[5] ?? 0;
  const data = pdu.slice(6, 6 + bc);
  if (fn === 0x10) {
    const values: number[] = [];
    for (let i = 0; i + 1 < data.length; i += 2) values.push((data[i] << 8) | data[i + 1]);
    return { fn, addr, qty, values };
  }
  return { fn, addr, qty, values: bitsOf(new Uint8Array(data), 0, qty) };
}

/* ================= Modbus TCP（MBAP） ================= */

export interface TcpAdu {
  txn: number;
  unit: number;
  pdu: number[];
}

/** 组 TCP ADU：事务 2 + 协议标识 0000 + 长度 2（含单元地址）+ 单元 + PDU */
export function buildTcpAdu(adu: TcpAdu): number[] {
  const len = adu.pdu.length + 1;
  return [
    (adu.txn >> 8) & 0xff,
    adu.txn & 0xff,
    0x00,
    0x00,
    (len >> 8) & 0xff,
    len & 0xff,
    adu.unit & 0xff,
    ...adu.pdu,
  ];
}

/** 解析 TCP ADU；长度不足或协议标识非 0 返回 null */
export function parseTcpAdu(bytes: number[]): TcpAdu | null {
  if (bytes.length < 8) return null;
  if (bytes[2] !== 0x00 || bytes[3] !== 0x00) return null;
  const len = (bytes[4] << 8) | bytes[5];
  const total = 6 + len;
  if (len < 2 || bytes.length < total) return null;
  return { txn: (bytes[0] << 8) | bytes[1], unit: bytes[6], pdu: bytes.slice(7, total) };
}

/** TCP 流式取帧：吐出所有完整 ADU，剩余留在 buf（协议标识非法时逐字节重找） */
export function takeTcpFrames(buf: number[]): TcpAdu[] {
  const out: TcpAdu[] = [];
  for (;;) {
    if (buf.length < 8) return out;
    if (buf[2] !== 0x00 || buf[3] !== 0x00) {
      buf.splice(0, 1);
      continue;
    }
    const len = (buf[4] << 8) | buf[5];
    const total = 6 + len;
    if (len < 2 || len > 254) {
      buf.splice(0, 1);
      continue;
    }
    if (buf.length < total) return out;
    const one = parseTcpAdu(buf.splice(0, total));
    if (one) out.push(one);
  }
}

/* ================= 手册编号换算 ================= */

/**
 * 传统 PLC 手册编号 → 线上 0 基址。
 * 只在该区的传统段内才换算（保持 40001+ / 输入 30001+ / 离散 10001+）；
 * 线圈段有天然歧义（手册 00001 与线上地址 1 撞车），一律按 0 基址原样处理。
 */
const LEGACY_BASE: Record<MbArea, number> = {
  coil: 0,
  disc: 10001,
  input: 30001,
  holding: 40001,
};

export function legacyToAddr(n: number, area: MbArea): number {
  const base = LEGACY_BASE[area];
  return base > 0 && n >= base ? n - base : n;
}

/** 线上 0 基址 → 手册编号（UI 显示用；线圈不偏移） */
export function addrToLegacy(addr: number, area: MbArea): number {
  return addr + LEGACY_BASE[area];
}
