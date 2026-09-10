import { describe, expect, it } from "vitest";
import {
  addrToLegacy,
  answerPdu,
  bitGet,
  bitSet,
  buildRtuRequest,
  buildRtuResponse,
  buildTcpAdu,
  exceptionPdu,
  f32ToRegs,
  inRange,
  legacyToAddr,
  makeBanks,
  mbCrc,
  parseRequestPdu,
  parseTcpAdu,
  regsToF32,
  regsToU32,
  rtuCrcOk,
  rtuFrameLen,
  takeRtuFrame,
  takeTcpFrames,
  u32ToRegs,
  type RtuFrame,
} from "./mb";

const hex = (b: number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/** 把整段字节喂给切帧器，取回所有帧（side = 谁在收流） */
function drain(bytes: number[], side: "slave" | "master"): RtuFrame[] {
  const buf = [...bytes];
  const out: RtuFrame[] = [];
  for (;;) {
    const f = takeRtuFrame(buf, side);
    if (!f) break;
    out.push(f);
  }
  return out;
}

describe("Modbus 组帧（RTU）", () => {
  it("读保持寄存器请求与规范示例逐字节一致", () => {
    const f = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 10 });
    expect(hex(f)).toBe("01 03 00 00 00 0A C5 CD");
    expect(mbCrc([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a])).toBe(0xcdc5);
    expect(rtuCrcOk(f)).toBe(true);
  });

  it("写单线圈按规范输出 FF00 / 0000", () => {
    expect(hex(buildRtuRequest({ slave: 17, fn: 0x05, addr: 123, value: 1 }).slice(0, 6))).toBe(
      "11 05 00 7B FF 00",
    );
    expect(hex(buildRtuRequest({ slave: 17, fn: 0x05, addr: 123, value: 0 }).slice(0, 6))).toBe(
      "11 05 00 7B 00 00",
    );
  });

  it("写多寄存器：字节数 = 2×数量，数据大端逐个排列", () => {
    const f = buildRtuRequest({ slave: 1, fn: 0x10, addr: 1, values: [1, 2, 3] });
    expect(hex(f.slice(0, 13))).toBe("01 10 00 01 00 03 06 00 01 00 02 00 03");
    expect(f.length).toBe(9 + 6);
    expect(rtuCrcOk(f)).toBe(true);
  });

  it("写多线圈按位打包（低位在前）", () => {
    const f = buildRtuRequest({ slave: 1, fn: 0x0f, addr: 0, values: [1, 0, 1, 1, 0, 0, 0, 0, 1] });
    expect(hex(f.slice(0, 9))).toBe("01 0F 00 00 00 09 02 0D 01");
  });

  it("越界参数抛出中文错误，供 UI 直接显示", () => {
    expect(() => buildRtuRequest({ slave: 248, fn: 0x03, addr: 0, qty: 1 })).toThrowError(/从站地址/);
    expect(() => buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 126 })).toThrowError(/1~125/);
    expect(() => buildRtuRequest({ slave: 1, fn: 0x02, addr: 0, qty: 2001 })).toThrowError(/2000/);
    expect(() => buildRtuRequest({ slave: 1, fn: 0x2b as number, addr: 0 })).toThrowError(/功能码/);
  });
});

describe("RTU 流式切帧", () => {
  it("帧长由方向决定，不需要猜：请求定长 8，读响应按字节数", () => {
    const req = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 10 });
    expect(rtuFrameLen(req, 0, "slave")).toBe(8);
    const rsp = buildRtuResponse(1, [0x03, 4, 0, 1, 0, 2]);
    expect(rtuFrameLen(rsp, 0, "master")).toBe(9); // 3 + 字节数4 + CRC2
    // 同一帧从站侧（把响应当请求）就是定长 8，这正是"方向"必须显式给出的原因
    expect(rtuFrameLen(rsp, 0, "slave")).toBe(8);
  });

  it("分块到达时按字节数定帧，不依赖帧间隔", () => {
    const rsp = buildRtuResponse(3, [0x03, 6, 0, 0x2c, 0, 0x1f, 0, 0x6b]);
    const buf: number[] = [];
    const got: RtuFrame[] = [];
    for (const b of rsp) {
      buf.push(b);
      const f = takeRtuFrame(buf, "master");
      if (f) got.push(f);
    }
    expect(got.length).toBe(1);
    expect(got[0].slave).toBe(3);
    expect(got[0].pdu).toEqual([0x03, 6, 0, 0x2c, 0, 0x1f, 0, 0x6b]);
    expect(buf.length).toBe(0);
  });

  it("主从两条流各自背靠背取出，PDU 含功能码", () => {
    const reqs = [
      ...buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 2 }),
      ...buildRtuRequest({ slave: 2, fn: 0x01, addr: 0, qty: 16 }),
    ];
    const rsps = [
      ...buildRtuResponse(1, [0x03, 4, 0, 10, 0, 20]),
      ...buildRtuResponse(2, [0x01, 2, 0b10110101, 0b00001011]),
    ];
    const a = drain(reqs, "slave");
    const b = drain(rsps, "master");
    expect(a.map((f) => [f.slave, f.fn])).toEqual([
      [1, 0x03],
      [2, 0x01],
    ]);
    expect(b.map((f) => f.pdu)).toEqual([
      [0x03, 4, 0, 10, 0, 20],
      [0x01, 2, 0b10110101, 0b00001011],
    ]);
    expect([...a, ...b].every((f) => f.crcOk)).toBe(true);
  });

  it("帧前有噪声时逐字节重同步，好帧不被吃掉", () => {
    const good = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 10 });
    let dropped = 0;
    const buf = [0xaa, 0xbb, ...good];
    const f = takeRtuFrame(buf, "slave", (n) => {
      dropped += n;
    });
    expect(f).toBeTruthy();
    expect(f!.bytes).toEqual(good);
    expect(f!.crcOk).toBe(true);
    expect(dropped).toBe(2);
  });

  it("坏 CRC 帧只吃掉自己，不影响其后好帧（从站侧请求定长）", () => {
    const bad = buildRtuRequest({ slave: 1, fn: 0x03, addr: 0, qty: 1 });
    bad[bad.length - 1] ^= 0xff;
    const good = buildRtuRequest({ slave: 2, fn: 0x03, addr: 5, qty: 3 });
    const frames = drain([...bad, ...good], "slave");
    expect(frames.length).toBe(1);
    expect(frames[0].slave).toBe(2);
    expect(frames[0].bytes).toEqual(good);
  });

  it("响应里的字节数被污染时，主站用自己的期望长度仍能取回好帧", () => {
    const bad = buildRtuResponse(1, [0x03, 2, 0x01, 0x02]);
    bad[2] = 0xf0; // 长度域被打坏：按响应解释会一直等不存在的字节
    bad[bad.length - 1] ^= 0xff;
    const good = buildRtuResponse(1, [0x03, 2, 0x03, 0x04]);
    // 期望长度 = 5 + 数据字节数（自己发的请求决定的），不依赖被污染的字节数
    const buf = [...bad, ...good];
    const f = takeRtuFrame(buf, { expectLen: 7 });
    expect(f).toBeTruthy();
    expect(f!.pdu).toEqual([0x03, 2, 0x03, 0x04]);
    expect(f!.crcOk).toBe(true);
  });
});

describe("从站数据区应答", () => {
  it("读保持寄存器返回大端字", () => {
    const b = makeBanks(64, 64);
    b.holding[0] = 300;
    b.holding[1] = 1234;
    const out = answerPdu(b, 1, [0x03, 0x00, 0x00, 0x00, 0x02]);
    expect(out.kind).toBe("response");
    expect((out as { pdu: number[] }).pdu).toEqual([0x03, 4, 0x01, 0x2c, 0x04, 0xd2]);
  });

  it("读线圈按位打包且字节数 = ⌈位数/8⌉（跨字节续位）", () => {
    const b = makeBanks(64, 64);
    [0, 3, 8].forEach((i) => bitSet(b.coils, i, true));
    const out = answerPdu(b, 1, [0x01, 0x00, 0x00, 0x00, 12]) as { pdu: number[] };
    expect(out.pdu[1]).toBe(2);
    expect(hex(out.pdu.slice(2))).toBe("09 01");
  });

  it("写单/多寄存器与写线圈真实落到数据区", () => {
    const b = makeBanks(64, 64);
    answerPdu(b, 7, [0x06, 0x00, 0x01, 0x12, 0x34]);
    expect(b.holding[1]).toBe(0x1234);
    answerPdu(b, 7, [0x10, 0x00, 0x02, 0x00, 0x02, 0x04, 0x00, 0x0a, 0x00, 0x0b]);
    expect([b.holding[2], b.holding[3]]).toEqual([10, 11]);
    answerPdu(b, 7, [0x0f, 0x00, 0x00, 0x00, 0x03, 0x01, 0b00000101]);
    expect([0, 1, 2].map((i) => bitGet(b.coils, i))).toEqual([1, 0, 1]);
  });

  it("未知功能码回 01、越界回 02、广播读静默、广播写执行不答", () => {
    const b = makeBanks(64, 64);
    expect(answerPdu(b, 1, [0x2b, 0, 0, 0, 1])).toEqual({ kind: "exception", code: 1 });
    expect(answerPdu(b, 1, [0x03, 0x00, 0x63, 0x00, 0x02])).toEqual({ kind: "exception", code: 2 });
    expect(answerPdu(b, 0, [0x03, 0x00, 0x00, 0x00, 0x02])).toEqual({ kind: "silent" });
    const out = answerPdu(b, 0, [0x06, 0x00, 0x05, 0x00, 0x2a]);
    expect(out.kind).toBe("silent");
    expect(b.holding[5]).toBe(42);
  });

  it("响应帧可被切帧器原样解回（自洽性）", () => {
    const b = makeBanks(64, 64);
    b.input[7] = 999;
    const pdu = (answerPdu(b, 9, [0x04, 0x00, 0x07, 0x00, 0x01]) as { pdu: number[] }).pdu;
    const frame = buildRtuResponse(9, pdu);
    const got = drain(frame, "master");
    expect(got.length).toBe(1);
    expect(got[0].pdu).toEqual(pdu);
  });

  it("越界判定与数据区容量一致", () => {
    const b = makeBanks(8, 4);
    expect(inRange(b, "holding", 3, 1)).toBe(true);
    expect(inRange(b, "holding", 3, 2)).toBe(false);
    expect(inRange(b, "coil", 63, 1)).toBe(true);
    expect(inRange(b, "coil", 64, 1)).toBe(false);
  });
});

describe("请求 PDU 解析与字序", () => {
  it("写多点请求能被解析回原值", () => {
    const f = buildRtuRequest({ slave: 1, fn: 0x10, addr: 100, values: [1, 2, 3] });
    const p = parseRequestPdu(drain(f, "slave")[0].pdu);
    expect(p).toEqual({ fn: 0x10, addr: 100, qty: 3, values: [1, 2, 3] });
    const g = buildRtuRequest({ slave: 1, fn: 0x0f, addr: 5, values: [1, 0, 1] });
    expect(parseRequestPdu(drain(g, "slave")[0].pdu)).toEqual({
      fn: 0x0f,
      addr: 5,
      qty: 3,
      values: [1, 0, 1],
    });
  });

  it("四种字序两两不同且可逆（写错字序是现场最常见的坑）", () => {
    const orders = ["big", "little", "big-word-swap", "little-word-swap"] as const;
    const variants = orders.map((o) => hex(u32ToRegs(0x12345678, o)));
    expect(new Set(variants).size).toBe(4);
    for (const o of orders) {
      const [r0, r1] = u32ToRegs(0xdeadbeef, o);
      expect(regsToU32(r0, r1, o)).toBe(0xdeadbeef);
      const [f0, f1] = f32ToRegs(-12.5, o);
      expect(regsToF32(f0, f1, o)).toBeCloseTo(-12.5, 5);
    }
    // Modbus 寄存器内部固定大端：ABCD → [高字, 低字]
    expect(u32ToRegs(0x12345678, "big")).toEqual([0x1234, 0x5678]);
    expect(u32ToRegs(0x12345678, "big-word-swap")).toEqual([0x5678, 0x1234]);
  });

  it("异常响应 PDU 带 FC|0x80，整帧长度 5", () => {
    const f = buildRtuResponse(4, exceptionPdu(0x03, 2));
    expect(f.length).toBe(5);
    expect(rtuFrameLen(f, 0, "master")).toBe(5);
    expect(drain(f, "master")[0].fn).toBe(0x83);
  });
});

describe("Modbus TCP（MBAP）", () => {
  it("长度域含单元地址，往返一致", () => {
    const pdu = [0x03, 0x00, 0x00, 0x00, 0x02];
    const adu = buildTcpAdu({ txn: 0x1234, unit: 1, pdu });
    expect(hex(adu.slice(0, 7))).toBe("12 34 00 00 00 06 01");
    expect(adu.length).toBe(12);
    expect(parseTcpAdu(adu)).toEqual({ txn: 0x1234, unit: 1, pdu });
  });

  it("粘包与半包都能取出完整 ADU", () => {
    const a = buildTcpAdu({ txn: 1, unit: 1, pdu: [0x03, 0, 0, 0, 1] });
    const b = buildTcpAdu({ txn: 2, unit: 1, pdu: [0x03, 2, 0, 7] });
    const buf = [...a, ...b];
    const got = takeTcpFrames(buf);
    expect(got.map((x) => x.txn)).toEqual([1, 2]);
    expect(buf.length).toBe(0);
    const half = [...a.slice(0, 5), ...a.slice(5)];
    const first = takeTcpFrames(half.slice(0, 6));
    expect(first.length).toBe(0);
    expect(takeTcpFrames(half).map((x) => x.txn)).toEqual([1]);
  });

  it("协议标识非 0 时逐字节重找，不崩不卡", () => {
    const a = buildTcpAdu({ txn: 9, unit: 1, pdu: [0x03, 0, 0, 0, 1] });
    const got = takeTcpFrames([0xff, 0xfe, 0xaa, 0xbb, ...a]);
    expect(got.map((x) => x.txn)).toEqual([9]);
  });
});

describe("手册编号换算", () => {
  it("40001/30001/10001/00001 ↔ 0 基址", () => {
    expect(legacyToAddr(40001, "holding")).toBe(0);
    expect(legacyToAddr(40010, "holding")).toBe(9);
    expect(legacyToAddr(30005, "input")).toBe(4);
    expect(legacyToAddr(10003, "disc")).toBe(2);
    expect(legacyToAddr(1, "coil")).toBe(1); // ≤0xffff 视为线上地址
    expect(legacyToAddr(0, "coil")).toBe(0);
    expect(addrToLegacy(0, "holding")).toBe(40001);
    expect(legacyToAddr(addrToLegacy(37, "holding"), "holding")).toBe(37);
  });
});
