/**
 * P121-B · 往返的另一半：TS 编码 → Rust 解码。
 *
 * `parser.rs` 的 `mod send_round_trip` 拿这些字节喂给真正的解码路径
 * （`read_uint` / `decode_numeric` / `checksum_compute`）并断言还原成编码前的数；
 * 这里则用 `encodeSend` 造出**同一批字节**。两边各测各的都不算证明，
 * 同一批字节两边都过才算 —— 所以最后一条测试扫 Rust 源文，确认每个 hex 都还在对面。
 */
import { describe, expect, it } from "vitest";
import { encodeSend } from "./encodeSend";
import type { SendField, SendTemplate } from "./sendTypes";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

function field(over: Partial<SendField> & { name: string }): SendField {
  return {
    id: over.name,
    type: "uint8",
    endian: "big",
    role: "data",
    source: { kind: "const", bytes: [0] },
    ...over,
  } as SendField;
}
function t(fields: SendField[]): SendTemplate {
  return {
    id: "rt", name: "往返", note: "", fields, params: [], checksum: null,
    textMode: "hex", createdAt: 0,
  };
}

/** 与 `parser.rs` 里 `send_round_trip` 用的那批 hex 同一份 */
const VECTORS: { name: string; hex: string; tpl: SendTemplate }[] = [
  {
    name: "大端帧",
    hex: "A5 12 34 FF FE 3F 80 00 00",
    tpl: t([
      field({ name: "HDR", role: "header", source: { kind: "const", bytes: [0xa5] } }),
      field({ name: "U16", type: "uint16", source: { kind: "param", paramId: "U16" } }),
      field({ name: "I16", type: "int16", source: { kind: "param", paramId: "I16" } }),
      field({ name: "F32", type: "float32", source: { kind: "param", paramId: "F32" } }),
    ]),
  },
  {
    name: "小端帧",
    hex: "78 56 34 12 00 00 80 3F",
    tpl: t([
      field({ name: "U32", type: "uint32", endian: "little", source: { kind: "param", paramId: "U32" } }),
      field({ name: "F32", type: "float32", endian: "little", source: { kind: "param", paramId: "F32" } }),
    ]),
  },
  {
    name: "CDAB 字序",
    hex: "56 78 12 34",
    tpl: t([field({ name: "W", type: "uint32", endian: "big-word-swap", source: { kind: "param", paramId: "W" } })]),
  },
  {
    name: "BADC 字序",
    hex: "34 12 78 56",
    tpl: t([field({ name: "W", type: "uint32", endian: "little-word-swap", source: { kind: "param", paramId: "W" } })]),
  },
  {
    name: "float64",
    hex: "3F F0 00 00 00 00 00 00",
    tpl: t([field({ name: "D", type: "float64", source: { kind: "param", paramId: "D" } })]),
  },
  {
    name: "位段",
    hex: "50",
    tpl: t([field({ name: "BIT", type: "bits", bits: { index: 4, count: 3 }, source: { kind: "param", paramId: "BIT" } })]),
  },
];

/** 参数值：编码前的"人话值"，Rust 侧断言的就是还原出它 */
const VALUES: Record<string, Record<string, string>> = {
  大端帧: { U16: "0x1234", I16: "-2", F32: "1" },
  小端帧: { U32: "0x12345678", F32: "1" },
  "CDAB 字序": { W: "0x12345678" },
  "BADC 字序": { W: "0x12345678" },
  float64: { D: "1" },
  位段: { BIT: "5" },
};

describe("P121-B · 往返（TS 编码侧）", () => {
  for (const v of VECTORS) {
    it(`${v.name} 编出与 Rust 测试同一批字节`, () => {
      // 参数声明补齐：编码器**要求 paramId 在 params 里存在**（引用不存在的参数就报错，
      // 不会拿一个野值凑数），所以这里按 VALUES 的键建壳
      v.tpl.params = Object.keys(VALUES[v.name] ?? {}).map((id) => ({
        id,
        name: id,
        type: "int" as const,
        def: "",
      }));
      expect(encodeSend(v.tpl, { values: VALUES[v.name] ?? {} }).hex).toBe(v.hex);
    });
  }

  it("CRC16-Modbus 与 CRC-32 的落帧字节序", () => {
    const body = Array.from("123456789", (c) => c.charCodeAt(0));
    const crc16Tpl = t([
      ...body.map((b, i) => field({ name: `B${i}`, source: { kind: "const", bytes: [b] } })),
      field({ name: "CK", role: "checksum", source: { kind: "const", bytes: [] } }),
    ]);
    crc16Tpl.checksum = { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 };
    expect(encodeSend(crc16Tpl).hex).toBe("31 32 33 34 35 36 37 38 39 37 4B");

    const crc32Tpl = t([
      ...body.map((b, i) => field({ name: `B${i}`, source: { kind: "const", bytes: [b] } })),
      field({ name: "CK", role: "checksum", source: { kind: "const", bytes: [] } }),
    ]);
    crc32Tpl.checksum = { algo: "crc32", coverageStart: 0, coverageEnd: -4 };
    expect(encodeSend(crc32Tpl).hex).toBe("31 32 33 34 35 36 37 38 39 CB F4 39 26");
  });

  it("对面还在测同一批字节（改一边忘一边当场红）", () => {
    const rust = readFileSync(fileURLToPath(new URL("../../../src-tauri/src/parser.rs", import.meta.url)), "utf8");
    const mod = rust.slice(rust.indexOf("mod send_round_trip"));
    expect(mod.length, "parser.rs 里找不到 `mod send_round_trip` —— 往返的另一半被删了").toBeGreaterThan(100);
    // Rust 侧那张对账表（模块开头的注释）里，每个 hex 都要作为连续串出现
    const header = rust.slice(0, rust.indexOf("#[cfg(test)]\nmod send_round_trip"));
    const missing = VECTORS.map((v) => v.hex)
      .concat(["31 32 33 34 35 36 37 38 39 37 4B", "31 32 33 34 35 36 37 38 39 CB F4 39 26"])
      .filter((hex) => !header.includes(hex));
    expect(missing, `这些 hex 只在 TS 侧，Rust 的往返表没跟上：${missing.join(" / ")}`).toEqual([]);
  });
});
