/**
 * 校验原语（前端侧）：与 Rust parser.rs 的校验实现同一套参数，
 * 供指令工厂组帧、Modbus 内核、自定义协议预览共用——避免同一算法两处实现漂移。
 */

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
 *  引擎 `parser.rs::checksum_size` 认不出 ⇒ 1，**而 sum8/xor8 今天就没有自己的臂、正靠这条兜底取宽度**
 *  ——动它等于改这两支的接收宽度，#94b 收兜底时先读 `checksums.test.ts` 的 ⑥。
 * 六个已知算法三方一致由 `checksums.test.ts` 扫 `parser.rs` / `vdev.rs` / 面板选项钉住——
 * 改一边忘一边当场红。剩下那半（CRC 参数化 + 兜底收成一条 + 接收侧缺 x25/sum16）在 #94b。
 */
export const CHECKSUM_WIDTHS: Record<string, number> = {
  none: 0,
  sum8: 1,
  xor8: 1,
  sumadd: 2,
  crc16_modbus: 2,
  crc16_ccitt: 2,
  crc32: 4,
};

export function checksumWidth(algo: string | null | undefined): number {
  if (!algo) return 0;
  return CHECKSUM_WIDTHS[algo] ?? 0;
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
