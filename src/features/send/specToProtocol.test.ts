/**
 * P122-B · 发送谱 → 解析协议 的投影规则。
 *
 * 这座桥的价值全在"不撒谎"上：能对上的地方才写，靠这一帧才确定的地方要写进 notes。
 * 所以这里一半的用例在验 note，而不是验结构 —— note 少一句，用户就会以为派生出来的是原样。
 */
import { describe, expect, it } from "vitest";
import type { CrcParams } from "../../ipc/types";
import { checksumWireEndian } from "../../shared/checksums";
import { coverageRange } from "./byteGrid";
import { encodeSend } from "./encodeSend";
import { DeriveError, covEndToReceive, toReceiveTpl } from "./specToProtocol";
import type { SendField, SendTemplate } from "./sendTypes";

const CRC8: CrcParams = { width: 8, poly: 0x07, init: 0, refin: false, refout: false, xorout: 0 };

const f = (over: Partial<SendField>): SendField =>
  ({
    id: "x",
    name: "x",
    type: "uint8",
    endian: "big",
    role: "data",
    source: { kind: "const", bytes: [1] },
    ...over,
  }) as SendField;

const spec = (fields: SendField[], over: Partial<SendTemplate> = {}): SendTemplate =>
  ({
    id: "st1",
    name: "谱",
    note: "",
    fields,
    params: [],
    checksum: null,
    nextSeq: 0,
    createdAt: 0,
    ...over,
  }) as SendTemplate;

/** 真编一遍再派生：投影吃的就是将要上线的那帧字节，不另算宽度 */
const derive = (s: SendTemplate) => {
  const enc = encodeSend(s, { seq: s.nextSeq });
  return { enc, ...toReceiveTpl(s, { bytes: enc.bytes, spans: enc.spans }, { id: "tpl-new", color: "#123456" }) };
};

describe("toReceiveTpl · 偏移与块", () => {
  it("偏移 = 前缀和，顺序 = 帧内顺序，字段 id 原样带过去", () => {
    const s = spec([
      f({ id: "a", name: "帧头", source: { kind: "const", bytes: [0xaa, 0xbb] } }),
      f({ id: "b", name: "v", type: "uint16", endian: "little", source: { kind: "const", bytes: [1, 2] } }),
      f({ id: "c", name: "尾", role: "footer", source: { kind: "const", bytes: [0x55] } }),
    ]);
    const { tpl, enc } = derive(s);
    expect(enc.hex).toBe("AA BB 01 02 55");
    expect(tpl.fields.map((x) => [x.id, x.offset, x.type, x.endian])).toEqual([
      ["a", 0, "uint8", "big"],
      ["b", 2, "uint16", "little"],
      ["c", 4, "uint8", "big"],
    ]);
    expect(tpl.fromSpecId).toBe("st1");
  });

  it("空的固定字节块不占字节 ⇒ 不进协议，并说一句", () => {
    const s = spec([
      f({ id: "a", name: "A", source: { kind: "const", bytes: [7] } }),
      f({ id: "z", name: "空", source: { kind: "const", bytes: [] } }),
    ]);
    const { tpl, notes } = derive(s);
    expect(tpl.fields.map((x) => x.id)).toEqual(["a"]);
    expect(notes.join("；")).toContain("不占字节");
  });

  it("没声明长度的文本块：用这一帧里看得见的长度，不猜 4，并说明值变了会错位", () => {
    const s = spec(
      [
        f({ id: "t", name: "txt", type: "ascii", role: "payload", source: { kind: "param", paramId: "P" } }),
      ],
      { params: [{ id: "P", name: "P", type: "text", def: "HELLO" }] },
    );
    const { tpl, notes } = derive(s);
    expect(tpl.fields[0].size).toBe(5);
    expect(notes.join("；")).toContain("这一帧实际是");
    expect(notes.join("；"), "不许静默当成原样可解析").toContain("错位");
  });

  it("csv 是解析侧的显示类型：按定长文本放进协议并点名", () => {
    const s = spec([f({ id: "v", name: "val", type: "csv", size: 3, source: { kind: "const", bytes: [1, 2, 3] } })]);
    const { tpl, notes } = derive(s);
    expect(tpl.fields[0].type).toBe("ascii");
    expect(notes.join("；")).toContain("csv");
  });

  it("谱与帧对不上就抛错点名，不交出一半成品协议", () => {
    const s = spec(
      [
        f({ id: "a", name: "A", source: { kind: "const", bytes: [1, 2] } }),
        f({ id: "b", name: "超界", type: "uint32", source: { kind: "param", paramId: "P" } }),
      ],
      { params: [{ id: "P", name: "P", type: "uint", def: "1" }] },
    );
    const enc = encodeSend(s);
    expect(enc.hex).toBe("01 02 00 00 00 01");
    // 只给前 4 字节：那块 u32 要占 4 格，装不下 —— 宁可抛错也不交出一张偏移错位的协议
    const short = { bytes: enc.bytes.slice(0, 4), spans: enc.spans };
    expect(() => toReceiveTpl(s, short, { id: "t" })).toThrow(DeriveError);
    expect(() => toReceiveTpl(s, short, { id: "t" })).toThrow(/超界/);
  });
});

describe("toReceiveTpl · 帧头与定界", () => {
  it("开头连续的固定字节当同步字", () => {
    const s = spec([
      f({ id: "h", name: "帧头", role: "header", source: { kind: "const", bytes: [0xaa] } }),
      f({ id: "d", name: "d", source: { kind: "param", paramId: "P" } }),
    ], { params: [{ id: "P", name: "P", type: "uint", def: "1" }] });
    expect(derive(s).tpl.boundary.headerBytes).toEqual([0xaa]);
    expect(derive(s).tpl.boundary.mode).toBe("fixedLength");
    expect(derive(s).tpl.boundary.fixedLength).toBe(2);
  });

  it("第一块不是固定字节 ⇒ 不猜帧头，明说解析链路第一步空着", () => {
    const s = spec([
      f({ id: "p", name: "p", source: { kind: "param", paramId: "P" } }),
      f({ id: "h", name: "头", role: "header", source: { kind: "const", bytes: [0xaa] } }),
    ], { params: [{ id: "P", name: "P", type: "uint", def: "1" }] });
    const { tpl, notes } = derive(s);
    expect(tpl.boundary.headerBytes).toEqual([]);
    expect(notes.join("；")).toContain("没认出帧头");
  });

  it("长度域按 covers 换算成修正值：数帧头之后的字节 ⇒ 修正 = 帧头 + 长度域宽", () => {
    const s = spec([
      f({ id: "h", name: "帧头", role: "header", source: { kind: "const", bytes: [0xaa, 0x77] } }),
      f({ id: "l", name: "len", role: "length", source: { kind: "len", covers: "after" } }),
      f({ id: "d", name: "d", type: "uint16", source: { kind: "const", bytes: [1, 2] } }),
    ]);
    const { tpl, notes } = derive(s);
    expect(tpl.boundary.mode).toBe("lengthField");
    expect(tpl.boundary.lengthOffset).toBe(2);
    expect(tpl.boundary.lengthSize).toBe(1);
    expect(tpl.boundary.lengthAdjust).toBe(3);
    expect(notes.join("；")).toContain("总帧长 = 值 + 3");
  });

  it("covers=self 数整帧 ⇒ 修正 0", () => {
    const s = spec([
      f({ id: "h", name: "帧头", role: "header", source: { kind: "const", bytes: [0xaa] } }),
      f({ id: "l", name: "len", role: "length", source: { kind: "len", covers: "self" } }),
      f({ id: "d", name: "d", source: { kind: "const", bytes: [9] } }),
    ]);
    expect(derive(s).tpl.boundary.lengthAdjust).toBe(0);
  });

  it("有长度域却没帧头：退回定长并说明长度域只当普通字段", () => {
    const s = spec([
      f({ id: "l", name: "len", role: "length", source: { kind: "len", covers: "after" } }),
      f({ id: "d", name: "d", source: { kind: "const", bytes: [9] } }),
    ]);
    const { tpl, notes } = derive(s);
    expect(tpl.boundary.mode).toBe("fixedLength");
    expect(notes.join("；")).toContain("没认出帧头");
  });
});

describe("校验的两种口径与字节序", () => {
  it("正终点：发送侧含自身、解析侧不含 ⇒ 换算 +1，覆盖到的字节数不变", () => {
    const s = spec(
      [
        f({ id: "d", name: "d", type: "uint32", source: { kind: "const", bytes: [1, 2, 3, 4] } }),
        f({ id: "ck", name: "ck", role: "checksum", source: { kind: "const", bytes: [] } }),
      ],
      { checksum: { algo: "sum8", coverageStart: 0, coverageEnd: 1 } },
    );
    const { tpl, enc } = derive(s);
    // 发送侧口径：0..1 含自身 = 2 字节（1+2=03）
    expect(coverageRange(0, 1, enc.bytes.length)).toEqual({ start: 0, len: 2 });
    expect(enc.bytes[4]).toBe(0x03);
    // 解析侧口径：终点不含，所以写 2 才是同样那 2 字节
    expect(tpl.checksum!.coverageEnd).toBe(covEndToReceive(1));
    expect(coverageRange(tpl.checksum!.coverageStart, tpl.checksum!.coverageEnd - 1, enc.bytes.length)).toEqual({
      start: 0,
      len: 2,
    });
  });

  it("负终点两边同义，不换算", () => {
    expect(covEndToReceive(-2)).toBe(-2);
    expect(covEndToReceive(5)).toBe(6);
  });

  it("校验块的类型按算法宽度定，endian 按落帧字节序定", () => {
    const s = spec(
      [
        f({ id: "d", name: "d", source: { kind: "const", bytes: [1, 2] } }),
        f({ id: "ck", name: "ck", role: "checksum", source: { kind: "const", bytes: [] } }),
      ],
      { checksum: { algo: "crc32", coverageStart: 0, coverageEnd: -4 } },
    );
    const { tpl } = derive(s);
    expect(tpl.fields.find((x) => x.id === "ck")!.type).toBe("uint32");
    expect(tpl.checksum!.endian).toBe("big");
  });

  it("线上字节序：反射的低字节在前，crc_custom 跟着 refout 走", () => {
    expect(checksumWireEndian("crc16_modbus")).toBe("little");
    expect(checksumWireEndian("crc16_x25")).toBe("little");
    expect(checksumWireEndian("crc16_ccitt")).toBe("big");
    expect(checksumWireEndian("crc32")).toBe("big");
    expect(checksumWireEndian("sum16")).toBe("little");
    expect(checksumWireEndian("crc_custom", CRC8)).toBe("big");
    expect(checksumWireEndian("crc_custom", { ...CRC8, refout: true })).toBe("little");
  });

  it("负终点两边同一个意思：原样带过去，覆盖到的还是那 3 字节", () => {
    const s = spec(
      [
        f({ id: "h", name: "帧头", role: "header", source: { kind: "const", bytes: [0xaa] } }),
        f({ id: "v", name: "v", type: "uint16", source: { kind: "const", bytes: [1, 2] } }),
        f({ id: "ck", name: "ck", role: "checksum", source: { kind: "const", bytes: [] } }),
      ],
      { checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 } },
    );
    const { tpl, enc } = derive(s);
    expect(enc.bytes.length).toBe(5);
    expect(tpl.checksum!.coverageEnd).toBe(-2);
    // 解析侧同样是"距帧尾 2 字节"，即前 3 个字节参与计算
    expect(coverageRange(0, tpl.checksum!.coverageEnd, enc.bytes.length)).toEqual({ start: 0, len: 3 });
  });
});

describe("toReceiveTpl · 拒绝空话", () => {
  it("没有一块的谱派不出东西，点名是哪张谱", () => {
    expect(() => toReceiveTpl(spec([]), { bytes: [1], spans: [] }, { id: "t" })).toThrow(/谱「谱」一个字段都没有/);
  });
  it("空帧同样不派", () => {
    expect(() => toReceiveTpl(spec([f({ id: "a", name: "A" })]), { bytes: [], spans: [] }, { id: "t" })).toThrow(/这一帧是空的/);
  });
});
