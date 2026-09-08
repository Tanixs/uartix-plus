import { describe, expect, it } from "vitest";
import { Rd, decodeFrames, decodeRx, decodeTx } from "./binbus";

/** 测试侧编码器：按 busevt.rs 小端线格式构造缓冲（与 Rust encode_* 同构） */
class Wr {
  private chunks: number[] = [];
  byte(v: number) {
    this.chunks.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.byte(v);
    this.byte(v >> 8);
    return this;
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.byte(v / 2 ** (8 * i));
    return this;
  }
  u64(v: number) {
    for (let i = 0; i < 8; i++) this.byte(Math.floor(v / 2 ** (8 * i)));
    return this;
  }
  f64(v: number) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.byte(b.getUint8(i));
    return this;
  }
  bytes(bs: Uint8Array | number[]) {
    for (const x of bs) this.byte(x);
    return this;
  }
  str(dict: string[], s: string) {
    return this.u16(dict.indexOf(s));
  }
  buf(): ArrayBuffer {
    return Uint8Array.from(this.chunks).buffer;
  }
}

function dictBlock(w: Wr, dict: string[]) {
  const enc = new TextEncoder();
  w.u16(dict.length);
  for (const s of dict) {
    const b = enc.encode(s);
    w.u16(b.length).bytes(b);
  }
  return w;
}

/** 构造读取器并消费首字节 msg_type（与 dispatch 行为一致） */
function rd(w: Wr): Rd {
  const r = new Rd(w.buf());
  r.byte();
  return r;
}

describe("decodeFrames", () => {
  it("单行全字段往返（字典去重/错误哨兵/可选字节）", () => {
    const dict = ["t1", "模板一", "#f00", "f1", "角度", "校验失败"];
    const w = new Wr().byte(1).u64(111).u64(222).u64(333).u64(444);
    dictBlock(w, dict).u32(1);
    w.str(dict, "t1").str(dict, "模板一").str(dict, "#f00");
    w.u64(1000).u64(7).u32(9).byte(0);
    w.u16(dict.indexOf("校验失败"));
    w.byte(1).u32(3).bytes([0x51, 0x52, 0x53]);
    w.u16(1);
    w.str(dict, "f1").str(dict, "角度").f64(1.5).f64(30.25).byte(0);
    const p = decodeFrames(rd(w));
    expect(p.emitTs).toBe(111);
    expect(p.total).toBe(222);
    expect(p.errors).toBe(333);
    expect(p.dropped).toBe(444);
    const r0 = p.rows[0];
    expect(r0.tplId).toBe("t1");
    expect(r0.tplName).toBe("模板一");
    expect(r0.valid).toBe(false);
    expect(r0.error).toBe("校验失败");
    expect(Array.from(r0.bytes!)).toEqual([0x51, 0x52, 0x53]);
    expect(r0.fields[0]).toEqual({ id: "f1", name: "角度", raw: 1.5, value: 30.25, text: null });
  });

  it("error 哨兵 0xffff 还原 null；无字节时 bytes 缺省", () => {
    const dict = ["t", "n", "c"];
    const w = new Wr().byte(1).u64(0).u64(0).u64(0).u64(0);
    dictBlock(w, dict).u32(1);
    w.str(dict, "t").str(dict, "n").str(dict, "c");
    w.u64(1).u64(2).u32(4).byte(1).u16(0xffff).byte(0).u16(0);
    const p = decodeFrames(rd(w));
    expect(p.rows[0].error).toBeNull();
    expect(p.rows[0].bytes).toBeUndefined();
    expect("bytes" in p.rows[0]).toBe(false);
  });
});

describe("decodeRx / decodeTx", () => {
  it("rx 时间戳与字节", () => {
    const w = new Wr().byte(2).u64(10).u64(20).u64(30).u32(2).bytes([0xab, 0xcd]);
    const p = decodeRx(rd(w));
    expect(p).toEqual({ tsFirst: 10, tsLast: 20, emitTs: 30, bytes: new Uint8Array([0xab, 0xcd]) });
  });
  it("tx 单时间戳与字节", () => {
    const w = new Wr().byte(3).u64(99).u32(1).bytes([0x7f]);
    const p = decodeTx(rd(w));
    expect(p.ts).toBe(99);
    expect(Array.from(p.bytes)).toEqual([0x7f]);
  });
});
