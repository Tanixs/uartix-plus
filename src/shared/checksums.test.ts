/**
 * P121-A · 校验原语的契约钉。
 *
 * 为什么要单独钉：同一批算法有**两份实现**——`shared/checksums.ts`（发送侧组帧、指令工厂、
 * Modbus 内核用）与 `src-tauri/src/parser.rs` 的 `checksum_compute`（接收侧解析热路径用）。
 * 两份一直"看起来一样"，但没有任何东西钉着：改一边忘一边时，症状是"能发出去、自己解不回来"，
 * 而那正是 P121 详设 §10 里 JCom 对照表点出的同一族病。
 *
 * 三层判据，从最硬到最软：
 *  ① **公开已知答案**（"123456789" 的 CRC-16/MODBUS = 0x4B37、CRC-16/CCITT-FALSE = 0x29B1、
 *     CRC-32 = 0xCBF43926，最后一个与 Node `zlib.crc32` 对过）——它独立于我们两份实现；
 *  ② 同一张向量表在 TS 侧逐算法成立；
 *  ③ 那张表的每个期望值**也出现在 Rust 源文里**（两边必须同时改，改一边当场红）。
 *
 * 已知缺口（明写，不假装）：`x25` 与 `sum16` 只有 TS 侧有——接收侧解不了它们，
 * 属于"能发不能解"。P121-B 的 D10（CRC 参数化）会把算法表收成一份，届时删掉这条注释。
 */
import { describe, expect, it } from "vitest";
import { anoCheck, crc16, crc32, sum8, sumadd16, xor8 } from "./checksums";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

/** 与 `parser.rs` 测试里的 `VECTORS` 同一张表：改这里必须同时改那里 */
const VECTORS: {
  name: string;
  bytes: number[];
  sum8: number;
  xor8: number;
  sumadd16: number;
  modbus: number;
  ccitt: number;
  crc32: number;
}[] = [
  {
    name: "123456789",
    bytes: [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39],
    sum8: 0xdd,
    xor8: 0x31,
    sumadd16: 0x15dd,
    modbus: 0x4b37,
    ccitt: 0x29b1,
    crc32: 0xcbf43926,
  },
  {
    name: "AA 55 01 02 0F",
    bytes: [0xaa, 0x55, 0x01, 0x02, 0x0f],
    sum8: 0x11,
    xor8: 0xf3,
    sumadd16: 0xbc11,
    modbus: 0x703d,
    ccitt: 0x1405,
    crc32: 0xa32d9a9e,
  },
  {
    name: "AA",
    bytes: [0xaa],
    sum8: 0xaa,
    xor8: 0xaa,
    sumadd16: 0xaaaa,
    modbus: 0x3f3f,
    ccitt: 0xf550,
    crc32: 0xe401a57b,
  },
];

describe("P121-A · 校验原语", () => {
  it("① 公开已知答案（独立于本仓库两份实现）", () => {
    const v = VECTORS[0].bytes;
    expect(crc16("modbus", v), "CRC-16/MODBUS 的 check 值是公开的 0x4B37").toBe(0x4b37);
    expect(crc16("ccitt-false", v), "CRC-16/CCITT-FALSE 的 check 值是公开的 0x29B1").toBe(0x29b1);
    expect(crc32(v) >>> 0, "CRC-32 的 check 值是公开的 0xCBF43926（与 zlib 一致）").toBe(0xcbf43926);
  });

  it("② 向量表在 TS 侧逐算法成立", () => {
    for (const t of VECTORS) {
      expect(sum8(t.bytes), `${t.name} sum8`).toBe(t.sum8);
      expect(xor8(t.bytes), `${t.name} xor8`).toBe(t.xor8);
      expect(sumadd16(t.bytes), `${t.name} sumadd16`).toBe(t.sumadd16);
      expect(crc16("modbus", t.bytes), `${t.name} crc16-modbus`).toBe(t.modbus);
      expect(crc16("ccitt-false", t.bytes), `${t.name} crc16-ccitt`).toBe(t.ccitt);
      expect(crc32(t.bytes) >>> 0, `${t.name} crc32`).toBe(t.crc32);
    }
    // sumadd16 与匿名 V7 的 SC/AC 是同一件事的两种写法，这里钉住它们别各漂各的
    for (const t of VECTORS) {
      const { sc, ac } = anoCheck(t.bytes);
      expect(sumadd16(t.bytes), `${t.name}：sumadd16 必须等于 SC | AC<<8`).toBe((sc | (ac << 8)) & 0xffff);
    }
  });

  it("③ 同一张表的期望值也写在 Rust 侧（改一边忘一边当场红）", () => {
    const rust = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/parser.rs", import.meta.url)),
      "utf8",
    );
    const missing: string[] = [];
    for (const t of VECTORS) {
      for (const [algo, v] of [
        ["sum8", t.sum8],
        ["xor8", t.xor8],
        ["sumadd", t.sumadd16],
        ["crc16_modbus", t.modbus],
        ["crc16_ccitt", t.ccitt],
        ["crc32", t.crc32],
      ] as [string, number][]) {
        // Rust 侧写 0x 大写或小写都算命中；按 4/8 位补齐再找
        const hex = v.toString(16);
        const wide = v > 0xffff ? hex.padStart(8, "0") : hex.padStart(4, "0");
        if (!new RegExp(`0x(${hex}|${wide})`, "i").test(rust)) missing.push(`${t.name} ${algo} = 0x${wide}`);
      }
    }
    expect(missing, `这些向量只在 TS 侧，Rust 的 checksum_compute 测试没跟上：${missing.join("、")}`).toEqual([]);
  });
});
