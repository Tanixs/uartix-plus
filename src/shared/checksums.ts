/**
 * 校验原语（前端侧）：与 Rust parser.rs 的校验实现同一套参数，
 * 供指令工厂组帧、Modbus 内核、自定义协议预览共用——避免同一算法两处实现漂移。
 */
import type { CrcParams } from "../ipc/types";

export function sum8(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
}

export function xor8(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) s ^= b;
  return s;
}

/** 匿名 V7：SUMCHECK 与 ADDCHECK，从帧头 0xAA 累加到 DATA 区结束 */
export function anoCheck(bytes: number[]): { sc: number; ac: number } {
  let sc = 0;
  let ac = 0;
  for (const b of bytes) {
    sc = (sc + b) & 0xff;
    ac = (ac + sc) & 0xff;
  }
  return { sc, ac };
}

/** 16 位累加校验（Rust parser "sumadd"，2 字节 = 低字节 SC 高字节 AC，与匿名 V7 SC+AC 同构） */
export function sumadd16(bytes: number[]): number {
  const { sc, ac } = anoCheck(bytes);
  return sc | (ac << 8);
}

/** 16 位累加和：逐字节加进 16 位累加器取低 16 位（与 sumadd 的 SC+AC 双字节不是一支算法） */
export function sum16(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xffff;
  return s;
}

/** 标准 CRC-32（反射 poly 0xEDB88320，init/xorout 0xFFFFFFFF——与 Rust parser crc32 同参数） */
export function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type Crc16Algo = "modbus" | "ccitt-false" | "x25";

/**
 * 校验字段占几字节 —— **数字只有这一份**。
 *
 * P121-B2 把原先抄了四份的数字收在这里：`protocol/templateStore.CHECKSUM_SIZES` 现在是它的一层
 * 视图（剔掉 `none`，因为那几处 `?? 1` 依赖"认不出来时按 1 字节预留"），
 * `framecanvas/frameLayout.checksumLen` 与发送侧 `checksumWidth` 都从这里取数。
 *
 * **兜底没统一，而且不止一条**（统一会改到帧画布与引擎的行为）：
 *  发送侧 `checksumWidth` 认不出 ⇒ 0（编码时直接点名报错，不凑数）；
 *  接收侧布局 `checksumLen`：空串/null/`none` ⇒ 0，表里没有的算法名 ⇒ 2（字段已在带上了，先占两位）；
 *  `CHECKSUM_SIZES` 的读方认不出 ⇒ 1（另有两处按 `fieldSize(f)` 走）；
 *  引擎 `parser.rs::checksum_size` 认不出 ⇒ 1。八支已知算法在引擎里**都有自己的臂**了
 *  （以前 sum8/xor8 靠兜底拿宽度，动那条兜底等于动它们的接收宽度 —— #94 那批已把它们写开）。
 * 已知算法的宽度与算法集合由 `checksums.test.ts` 扫 `parser.rs` / `vdev.rs` / 面板选项钉住——
 * 改一边忘一边当场红。还剩的两件事：虚拟设备 `vdev.rs` 只认 5 支（模拟帧发不出 x25/sum16），
 * 以及 CRC 还不能自己填参数（#100）。
 */
export const CHECKSUM_WIDTHS: Record<string, number> = {
  none: 0,
  sum8: 1,
  xor8: 1,
  sumadd: 2,
  sum16: 2,
  crc16_modbus: 2,
  crc16_ccitt: 2,
  crc16_x25: 2,
  crc32: 4,
  // crc_custom 不在表里：它的宽度是 `crc.width / 8`，由 checksumWidth 的第二入参回答
};

/** `crc_custom` 专用：算法名给不出宽度，宽度在参数里 */
export const CRC_CUSTOM = "crc_custom";

/**
 * CRC 参数框的字面量：认十进制，也认 `0x` 十六进制（`poly` 这类值天生写成十六进制）。
 * 认不出来就返回 null 由界面点名 —— 两处界面（TX组帧台 / 属性面板）共用这一条规则，
 * 免得同一框在一边收 0x1021、在另一边收成别的数。
 */
export function parseCrcLiteral(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** crc_custom 的起手参数：CRC-16/CCITT-FALSE。三处界面共用这一份，免得各挑一个模型 */
export const CRC_DEFAULT: CrcParams = {
  width: 16,
  poly: 0x1021,
  init: 0xffff,
  refin: false,
  refout: false,
  xorout: 0,
};

export function checksumWidth(algo: string | null | undefined, crc?: CrcParams | null): number {
  if (!algo) return 0;
  if (algo === CRC_CUSTOM) return crc ? crc.width / 8 : 0;
  return CHECKSUM_WIDTHS[algo] ?? 0;
}

/**
 * 参数化 CRC（Rockwell 那套：width / poly / init / refin / refout / xorout）。
 *
 * `poly` 按**既约式**写（CRC-16/CCITT 是 0x1021，不是 0x11021），所以三个公开模型可以直接
 * 当自证用：同一份实现必须算出 Modbus 0x4B37、X-25 0x906E、CRC-32 0xCBF43926 —— 参数填错
 * 就复现不出来。`parser.rs` 里有一份同参数的实现，两边由 `checksums.test.ts` 的 ⑨ 钉住。
 */
export function crcByParams(p: CrcParams, bytes: number[]): number {
  const mask = p.width === 32 ? 0xffffffff : (1 << p.width) - 1;
  const top = 1 << (p.width - 1);
  const reflect = (v: number, w: number) => {
    let r = 0;
    for (let i = 0; i < w; i++) if (v & (1 << i)) r |= 1 << (w - 1 - i);
    return r >>> 0;
  };
  let crc = (p.init & mask) >>> 0;
  for (let b of bytes) {
    if (p.refin) b = reflect(b, 8);
    crc = ((crc ^ (b << (p.width - 8))) & mask) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = crc & top ? (((crc << 1) ^ p.poly) & mask) >>> 0 : ((crc << 1) & mask) >>> 0;
    }
  }
  if (p.refout) crc = reflect(crc, p.width);
  return ((crc ^ (p.xorout & mask)) & mask) >>> 0;
}

/**
 * 参数的合法性检查 —— **返回错误文字，不返回布尔**。
 * 参数化最容易出的事是"看着能填、算出来是 0"：非法值必须点名，绝不静默按默认值凑一帧。
 */
export function crcParamError(p: CrcParams | null | undefined): string | null {
  if (!p) return "选了 crc_custom，但一个参数都没填";
  if (p.width !== 8 && p.width !== 16 && p.width !== 32) {
    return `CRC 位数只支持 8 / 16 / 32（当前 ${p.width}）`;
  }
  const mask = p.width === 32 ? 0xffffffff : (1 << p.width) - 1;
  for (const [k, v] of [
    ["poly", p.poly],
    ["init", p.init],
    ["xorout", p.xorout],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > mask) {
      return `CRC 的 ${k}（${v}）超出 ${p.width} 位（0~${mask.toString(16)}）；多项式要写去掉最高位的既约式`;
    }
  }
  return null;
}

export function crc16(algo: Crc16Algo, bytes: number[]): number {
  const cfg = {
    modbus: { poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0x0000 },
    "ccitt-false": { poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000 },
    x25: { poly: 0x1021, init: 0xffff, refin: true, refout: true, xorout: 0xffff },
  }[algo];
  const reflect = (v: number, w: number) => {
    let r = 0;
    for (let i = 0; i < w; i++) if (v & (1 << i)) r |= 1 << (w - 1 - i);
    return r;
  };
  let crc = cfg.init;
  for (let b of bytes) {
    if (cfg.refin) b = reflect(b, 8);
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ cfg.poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  if (cfg.refout) crc = reflect(crc, 16);
  return (crc ^ cfg.xorout) & 0xffff;
}
