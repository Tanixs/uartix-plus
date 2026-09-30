/**
 * P121-E · 从一帧反推发送谱（#102）的判据。
 *
 * 这个模块的全部立足点是一句话：**反推出来的谱编回去必须逐字节等于那一帧**。
 * 所以下面每一条都在跑那道闸口（`encodeSend(草稿).hex === 原帧`），
 * 而不是断言"字段数对不对""名字起得好不好"那种看起来像证据的东西。
 * 校验段与长度回填的候选是穷举出来的，判据同样只有这一条：能复现就留下，不能就退回定长字节。
 */
import { describe, expect, it } from "vitest";
import { crc16, crc32, sum16, sum8, sumadd16, xor8 } from "../../shared/checksums";
import { encodeSend } from "./encodeSend";
import { detectChecksum, inferSendSpec, InferError, type InferField } from "./inferSpec";

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const ckLow = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const ckHigh = (v: number) => [(v >> 8) & 0xff, v & 0xff];

/** 一条"照原帧能复现"的断言，所有用例共用 */
function expectRoundTrip(bytes: number[], fields?: InferField[]) {
  const r = inferSendSpec(bytes, fields ? { fields } : {});
  const enc = encodeSend(r.tpl, { seq: r.tpl.nextSeq });
  expect(enc.hex, `复现失败：${hex(bytes)}\nnotes: ${r.notes.join("；")}`).toBe(hex(bytes));
  return r;
}

describe("P121-E · detectChecksum", () => {
  it("尾巴是 crc16-modbus 就认出来，覆盖从帧头起", () => {
    const body = [0x01, 0x02, 0x03, 0x04];
    const bytes = [...body, ...ckLow(crc16("modbus", body))];
    expect(detectChecksum(bytes)).toMatchObject({ algo: "crc16_modbus", size: 2, covStart: 0 });
  });

  it("帧头不计入覆盖时，covStart 跟着挪（这是现场最常见的形状）", () => {
    const head = [0xaa];
    const body = [0x11, 0x22, 0x33];
    const bytes = [...head, ...body, ...ckLow(crc16("modbus", body))];
    expect(detectChecksum(bytes)).toMatchObject({ algo: "crc16_modbus", covStart: 1 });
  });

  it("八支算法造的帧都能认出校验段（并按各自落帧字节序认）", () => {
    const body = [0x31, 0x32, 0x33, 0x34];
    const c32 = crc32(body) >>> 0;
    const cases: [string, number[]][] = [
      ["sum8", [...body, sum8(body)]],
      ["xor8", [...body, xor8(body)]],
      ["sumadd", [...body, ...ckLow(sumadd16(body))]],
      ["sum16", [...body, ...ckLow(sum16(body))]],
      ["crc16_modbus", [...body, ...ckLow(crc16("modbus", body))]],
      ["crc16_x25", [...body, ...ckLow(crc16("x25", body))]],
      ["crc16_ccitt", [...body, ...ckHigh(crc16("ccitt-false", body))]],
      ["crc32", [...body, (c32 >>> 24) & 0xff, (c32 >>> 16) & 0xff, (c32 >>> 8) & 0xff, c32 & 0xff]],
    ];
    for (const [algo, bytes] of cases) {
      expect(detectChecksum(bytes), `${algo} 造的帧该被认出来`).not.toBeNull();
      // 字节序写错的话，那支算法根本不会出现在命中里；而草稿编不回原帧会在这里红
      expect(() => expectRoundTrip(bytes), `${algo} 的草稿要能编回原帧`).not.toThrow();
    }
    // 最强的那两支要点名到算法，别只验"认出了某个"
    expect(detectChecksum(cases[7][1])?.algo).toBe("crc32");
    expect(detectChecksum(cases[4][1])?.algo).toBe("crc16_modbus");
  });

  it("确实没有校验解释的帧，就不硬安一支（假阳性比漏检更难查）", () => {
    // 末字节 0x00 不是挑的，是拿 detectChecksum 自己扫出来的：12 个前缀字节、尾字节 0~255
    // 逐个试过才找到这条对八支算法在任何覆盖起点上都对不上的 —— 短帧想找"无解释"的形状并不容易，
    // 这正是这条功能必须把偶然率交底的原因
    const bytes = [0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0x00];
    expect(detectChecksum(bytes)).toBeNull();
  });
});

describe("P121-E · inferSendSpec 的闸口", () => {
  it("尾巴对不上任何校验段 ⇒ 草稿就是一段定长字节", () => {
    const bytes = [0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0x00];
    expect(detectChecksum(bytes)).toBeNull();
    const r = expectRoundTrip(bytes);
    expect(r.tpl.checksum).toBeNull();
    expect(r.tpl.fields).toHaveLength(1);
    expect(r.tpl.fields[0].source.kind).toBe("const");
    expect(r.notes.join()).toContain("没有能验出的校验段");
  });

  it("1 字节的巧合证据会被接受，但必须把偶然率交底", () => {
    // 这帧的末字节 0x03 恰好 = sum8(0x01,0x02)：关系是真的，可"真是校验段"这件事未必
    const r = expectRoundTrip([0xaa, 0x01, 0x02, 0x03]);
    expect(r.tpl.checksum?.algo).toBe("sum8");
    expect(r.notes.join()).toContain("1/256");
  });

  it("多种解释都能对上时取最强的那支（4 字节 > 2 字节 > 1 字节）", () => {
    const body = [0x01, 0x02, 0x03];
    const modbus = ckLow(crc16("modbus", body));
    const bytes = [...body, ...modbus];
    // 末字节若同时是 sum8(前缀)，排序必须把 2 字节的 crc16_modbus 排在 1 字节的 sum8 前面
    const hit = detectChecksum(bytes);
    expect(hit?.size, "有更弱的解释也不能降级成 1 字节").toBe(2);
    expect(hit?.algo).toBe("crc16_modbus");
    expect(hit!.alternatives).toBeGreaterThanOrEqual(0);
    const r = expectRoundTrip(bytes);
    expect(r.tpl.checksum).toMatchObject({ algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 });
    expect(r.tpl.fields.some((f) => f.role === "checksum"), "认出了算法却没有校验域，编码器会当场点名").toBe(true);
  });

  it("给了字段边界就按边界切块：帧头 / 长度 / 数据 / 校验", () => {
    const head = [0xaa];
    const len = [3];
    const data = [0x11, 0x22, 0x33];
    const body = [...head, ...len, ...data];
    const bytes = [...body, ...ckLow(crc16("modbus", body))];
    const fields: InferField[] = [
      { name: "帧头", role: "header", offset: 0, size: 1 },
      { name: "长度", role: "length", offset: 1, size: 1 },
      { name: "数据", role: "data", offset: 2, size: 3 },
      { name: "校验", role: "checksum", offset: 5, size: 2 },
    ];
    const r = expectRoundTrip(bytes, fields);
    expect(r.tpl.fields.map((f) => f.role)).toEqual(["header", "length", "data", "checksum"]);
    const lenField = r.tpl.fields.find((f) => f.role === "length");
    expect(lenField?.source.kind, "能复现的长度回填就不该退回定长字节").toBe("len");
    expect(r.notes.join()).toContain("按长度回填");
  });

  it("序号域取这一帧的值当起点，第一次发就是这一帧", () => {
    const head = [0xaa];
    const data = [0x07];
    const bytes = [...head, 0x05, ...data];
    const fields: InferField[] = [
      { name: "帧头", role: "header", offset: 0, size: 1 },
      { name: "序号", role: "seq", offset: 1, size: 1 },
      { name: "数据", role: "data", offset: 2, size: 1 },
    ];
    const r = expectRoundTrip(bytes, fields);
    expect(r.tpl.nextSeq, "计数器起点就是这一帧那个 5").toBe(5);
    expect(r.tpl.fields.find((f) => f.role === "seq")?.source.kind).toBe("seq");
  });

  it("边界与这一帧对不上 ⇒ 退回整段定长字节，但帧还是要能复现", () => {
    const bytes = [0xaa, 0x01, 0x02];
    const fields: InferField[] = [
      { name: "长度", role: "length", offset: 0, size: 1 },
      { name: "数据", role: "data", offset: 0, size: 2 }, // 与上一块重叠：这种布局不该硬凑
    ];
    const r = expectRoundTrip(bytes, fields);
    expect(r.tpl.fields.some((f) => f.source.kind === "len"), "重叠边界不能留下回填").toBe(false);
    expect(r.notes.join()).toContain("定长字节");
  });

  it("多块长度域时不做回填（那是试，不是推），帧仍复现", () => {
    const bytes = [0xaa, 0x02, 0x01, 0x02, 0xff];
    const fields: InferField[] = [
      { name: "帧头", role: "header", offset: 0, size: 1 },
      { name: "长度A", role: "length", offset: 1, size: 1 },
      { name: "长度B", role: "length", offset: 2, size: 2 },
    ];
    const r = expectRoundTrip(bytes, fields);
    expect(r.tpl.fields.filter((f) => f.source.kind === "len")).toHaveLength(0);
  });

  it("空帧与非字节的输入点名报错，不交出一张空谱", () => {
    expect(() => inferSendSpec([])).toThrow(InferError);
    expect(() => inferSendSpec([0x00, 256])).toThrow(/0~255/);
    expect(() => inferSendSpec([1.5])).toThrow(/0~255/);
  });

  it("草稿的备注把做的事都写着 —— 用户不必点开控制台就知道它替他猜了什么", () => {
    const body = [0x01, 0x02];
    const r = expectRoundTrip([...body, ...ckLow(crc16("modbus", body))]);
    expect(r.tpl.note).toContain("crc16_modbus");
    expect(r.tpl.note).toContain("校验");
  });

  it("性质：任何输入（含随机帧）产出的草稿都能复现原帧", () => {
    // 造一批形状各异的帧：有/无校验、不同覆盖起点、长度域、纯随机尾巴。
    // 注意别边遍历边往同一个数组 push —— 那会让这个循环永不结束（上一版就栽在这儿）
    const bodies: number[][] = [];
    for (let n = 4; n < 14; n++) bodies.push(Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff));
    const samples: number[][] = [];
    for (const body of bodies) {
      samples.push(body);
      samples.push([...body, ...ckLow(crc16("modbus", body))]);
      samples.push([...body, ...ckHigh(crc16("ccitt-false", body))]);
      samples.push([...body, sum8(body)]);
    }
    expect(samples.length).toBe(40);
    for (const bytes of samples) {
      const r = inferSendSpec(bytes);
      expect(encodeSend(r.tpl, { seq: r.tpl.nextSeq }).hex, `帧 ${hex(bytes)}`).toBe(hex(bytes));
    }
  });
});
