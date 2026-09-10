import { describe, expect, it } from "vitest";
import { CODECS, type FactoryField } from "./commandFactory";
import { parseRequestPdu, rtuCrcOk, takeRtuFrame } from "../modbus/mb";

const unhex = (s: string) => s.trim().split(/\s+/).map((x) => Number.parseInt(x, 16));
const codec = (id: string) => CODECS.find((c) => c.id === id)!;
const fieldsOf = (id: string, v: Record<string, string>): FactoryField[] => {
  const f = codec(id).fields;
  return typeof f === "function" ? f(v) : f;
};

/**
 * M2-b：指令工厂的 Modbus 编解码器只是内核的一层皮，
 * 这里守"皮"的部分——表单参数怎么进内核、分段预览是否齐全。
 */
describe("指令工厂 Modbus RTU", () => {
  it("规范示例：从站 1 读 10 个保持寄存器 → 01 03 00 00 00 0A C5 CD", () => {
    const r = codec("modbus").build({ addr: "1", fn: "3", reg: "0", val: "10" });
    expect(r.frames).toEqual(["01 03 00 00 00 0A C5 CD"]);
    expect(r.parts.map((p) => p.label)).toEqual([
      "从站",
      "功能码",
      "起始地址",
      "数量",
      "CRC16",
    ]);
  });

  it("手册编号 40001 自动换算成线上 0 基址（与直接填 0 完全同帧）", () => {
    const legacy = codec("modbus").build({ addr: "1", fn: "3", reg: "40001", val: "1" });
    const raw = codec("modbus").build({ addr: "1", fn: "3", reg: "0", val: "1" });
    expect(legacy.frames).toEqual(raw.frames);
    expect(unhex(legacy.frames[0]).slice(0, 6)).toEqual([1, 3, 0, 0, 0, 1]);
    expect(rtuCrcOk(unhex(legacy.frames[0]))).toBe(true);
  });

  it("新增写多点：FC16 带数据区，FC15 按位打包", () => {
    const w16 = codec("modbus").build({ addr: "1", fn: "16", reg: "1", vals: "1 2 3" });
    const bytes = unhex(w16.frames[0]);
    expect(w16.frames[0]).toMatch(/^01 10 00 01 00 03 06 00 01 00 02 00 03 [0-9A-F]{2} [0-9A-F]{2}$/);
    expect(rtuCrcOk(bytes)).toBe(true);
    const pdu = takeRtuFrame([...bytes], "slave")?.pdu ?? [];
    expect(parseRequestPdu(pdu)).toEqual({ fn: 0x10, addr: 1, qty: 3, values: [1, 2, 3] });

    const w15 = codec("modbus").build({ addr: "1", fn: "15", reg: "0", vals: "1 0 1 1 0 0 0 0 1" });
    expect(unhex(w15.frames[0]).slice(0, 9)).toEqual([1, 0x0f, 0, 0, 0, 9, 2, 0x0d, 1]);
  });

  it("线圈值上线转成 FF00/0000，第三项标签随功能码变化", () => {
    const r = codec("modbus").build({ addr: "5", fn: "5", reg: "3", val: "1" });
    expect(unhex(r.frames[0]).slice(0, 6)).toEqual([5, 5, 0, 3, 0xff, 0]);
    expect(fieldsOf("modbus", { fn: "5" }).find((f) => f.key === "val")?.label).toBe("线圈值");
    expect(fieldsOf("modbus", { fn: "3" }).find((f) => f.key === "val")?.label).toBe("数量");
    expect(fieldsOf("modbus", { fn: "16" }).some((f) => f.key === "vals")).toBe(true);
  });

  it("越界参数抛中文错误（UI 直接显示，不静默组坏帧）", () => {
    expect(() => codec("modbus").build({ addr: "300", fn: "3", reg: "0", val: "1" })).toThrowError(
      /从站地址/,
    );
    expect(() => codec("modbus").build({ addr: "1", fn: "3", reg: "0", val: "999" })).toThrowError(
      /1~125/,
    );
    expect(() => codec("modbus").build({ addr: "1", fn: "16", reg: "0", vals: "" })).toThrowError(
      /不能为空/,
    );
  });
});

describe("指令工厂 Modbus TCP", () => {
  it("MBAP 头自动组：协议标识 0000、长度含单元地址、无 CRC", () => {
    const r = codec("modbus-tcp").build({ addr: "1", fn: "3", reg: "0", val: "2", txn: "18" });
    expect(r.frames).toEqual(["00 12 00 00 00 06 01 03 00 00 00 02"]);
    expect(r.parts.map((p) => p.label)).toEqual([
      "事务号",
      "协议标识",
      "长度",
      "单元",
      "功能码",
      "起始地址",
      "数量",
    ]);
  });

  it("事务号填 0 时自动递增（连发两帧不重复）", () => {
    const a = codec("modbus-tcp").build({ addr: "1", fn: "3", reg: "0", val: "1", txn: "0" });
    const b = codec("modbus-tcp").build({ addr: "1", fn: "3", reg: "0", val: "1", txn: "0" });
    expect(a.frames[0].slice(0, 5)).not.toBe(b.frames[0].slice(0, 5));
  });
});
