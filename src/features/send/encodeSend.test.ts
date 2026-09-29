/**
 * P121-B · 编码器的字节级契约。
 *
 * 每条期望都是**手算**的，不是"跑一遍把输出抄下来"——抄输出的测试只能证明代码和自己一致。
 * 覆盖：四种字节序（含 32 位的 CDAB/BADC）、有符号补码、浮点、BCD、位段、变长文本、
 * 长度域三种覆盖口径与 adjust、校验（含 CRC-16/MODBUS 的公开已知答案）、自增序号与回绕，
 * 以及"缺值必须报错、不许静默发原文"这一族。
 */
import { describe, expect, it } from "vitest";
import { SendEncodeError, encodeSend } from "./encodeSend";
import type { SendField, SendSource, SendTemplate } from "./sendTypes";

function field(over: Partial<SendField> & { name: string }): SendField {
  return {
    id: over.id ?? over.name,
    type: "uint8",
    endian: "big",
    role: "data",
    source: { kind: "const", bytes: [0] },
    ...over,
  } as SendField;
}
function tpl(fields: SendField[], rest: Partial<SendTemplate> = {}): SendTemplate {
  return {
    id: "t",
    name: "测试谱",
    note: "",
    fields,
    params: [],
    checksum: null,
    textMode: "hex",
    createdAt: 0,
    ...rest,
  };
}
const num = (name: string, type: SendField["type"], endian: SendField["endian"] = "big"): SendField =>
  field({
    name,
    type,
    endian,
    source: { kind: "param", paramId: name } satisfies SendSource,
  });
const withParam = (t: SendTemplate, name: string) => {
  t.params.push({ id: name, name, type: "int", def: "" });
  return t;
};

describe("encodeSend · 数值与字节序", () => {
  it("const 与定长整数按大端铺字节", () => {
    const t = withParam(tpl([field({ name: "HDR", source: { kind: "const", bytes: [0xa5] } }), num("P1", "uint16")]), "P1");
    expect(encodeSend(t, { values: { P1: "0x1234" } }).hex).toBe("A5 12 34");
  });

  it("uint32 四档字节序（ABCD / DCBA / CDAB / BADC）", () => {
    const one = (endian: SendField["endian"]) =>
      encodeSend(withParam(tpl([num("V", "uint32", endian)]), "V"), { values: { V: "0x12345678" } }).hex;
    expect(one("big")).toBe("12 34 56 78");
    expect(one("little")).toBe("78 56 34 12");
    expect(one("big-word-swap")).toBe("56 78 12 34");
    expect(one("little-word-swap")).toBe("34 12 78 56");
  });

  it("16 位下两对字节序等价（字序倒置对单字无意义）", () => {
    const one = (endian: SendField["endian"]) =>
      encodeSend(withParam(tpl([num("V", "uint16", endian)]), "V"), { values: { V: "0xABCD" } }).hex;
    expect(one("big")).toBe("AB CD");
    expect(one("big-word-swap")).toBe("AB CD");
    expect(one("little")).toBe("CD AB");
    expect(one("little-word-swap")).toBe("CD AB");
  });

  it("字序档对 64 位同样成立：float64 = 1.0 的 CDAB 是大端按字倒序", () => {
    const be = encodeSend(withParam(tpl([num("D", "float64")]), "D"), { values: { D: "1" } }).hex;
    const cdab = encodeSend(
      withParam(tpl([num("D", "float64", "big-word-swap")]), "D"),
      { values: { D: "1" } },
    ).hex;
    expect(be).toBe("3F F0 00 00 00 00 00 00");
    expect(cdab).toBe("00 00 00 00 00 00 3F F0");
  });

  it("有符号用补码：int16 = -2 → FF FE", () => {
    expect(encodeSend(withParam(tpl([num("V", "int16")]), "V"), { values: { V: "-2" } }).hex).toBe("FF FE");
  });

  it("float32 1.0 → 3F 80 00 00（大端）/ 00 00 80 3F（小端）", () => {
    const big = encodeSend(withParam(tpl([num("F", "float32")]), "F"), { values: { F: "1" } }).hex;
    const lit = encodeSend(withParam(tpl([num("F", "float32", "little")]), "F"), { values: { F: "1" } }).hex;
    expect(big).toBe("3F 80 00 00");
    expect(lit).toBe("00 00 80 3F");
  });

  it("float64 占 8 字节", () => {
    const hex = encodeSend(withParam(tpl([num("D", "float64")]), "D"), { values: { D: "1" } }).hex;
    expect(hex).toBe("3F F0 00 00 00 00 00 00");
  });

  it("BCD：1234 两字节 → 12 34；短值左补零", () => {
    const t = withParam(tpl([{ ...num("B", "bcd"), size: 2 }]), "B");
    expect(encodeSend(t, { values: { B: "1234" } }).hex).toBe("12 34");
    expect(encodeSend(t, { values: { B: "7" } }).hex).toBe("00 07");
  });

  it("位段：值 5 放 index=4、count=3 → 0x50", () => {
    const f = field({ name: "BIT", type: "bits", bits: { index: 4, count: 3 }, source: { kind: "param", paramId: "BIT" } });
    expect(encodeSend(tpl([f], { params: [{ id: "BIT", name: "BIT", type: "int", def: "" }] }), { values: { BIT: "5" } }).hex).toBe("50");
  });
  it("位段越界：3 位放不下 8", () => {
    const f = field({ name: "BIT", type: "bits", bits: { index: 0, count: 3 }, source: { kind: "param", paramId: "BIT" } });
    expect(() => encodeSend(tpl([f], { params: [{ id: "BIT", name: "BIT", type: "int", def: "" }] }), { values: { BIT: "8" } })).toThrow(/位段 3 位/);
  });

  it("ascii 变长：按 UTF-8 实际字节数发，notes 里说清楚", () => {
    const r = encodeSend(
      tpl([field({ name: "TXT", type: "ascii", source: { kind: "param", paramId: "TXT" } })], {
        params: [{ id: "TXT", name: "TXT", type: "text", def: "" }],
      }),
      { values: { TXT: "AB" } },
    );
    expect(r.hex).toBe("41 42");
  });

  it("csv 是解析侧的显示类型：发送明确报错，不静默出字节", () => {
    expect(() =>
      encodeSend(
        tpl([field({ name: "C", type: "csv", source: { kind: "param", paramId: "C" } })], {
          params: [{ id: "C", name: "C", type: "text", def: "" }],
        }),
        { values: { C: "1,2" } },
      ),
    ).toThrow(/暂不支持/);
  });
});

describe("encodeSend · 长度域", () => {
  const frame = (covers: "self" | "after" | "body", adjust?: number) =>
    tpl([
      field({ name: "HDR", role: "header", source: { kind: "const", bytes: [0xa5] } }),
      field({ name: "LEN", role: "length", source: { kind: "len", covers, adjust } }),
      field({ name: "D1", source: { kind: "const", bytes: [0x01] } }),
      field({ name: "D2", source: { kind: "const", bytes: [0x02] } }),
    ]);

  it("covers=after：只数长度域之后的字节", () => expect(encodeSend(frame("after")).hex).toBe("A5 02 01 02"));
  it("covers=body：含长度域自身", () => expect(encodeSend(frame("body")).hex).toBe("A5 03 01 02"));
  it("covers=self：整帧", () => expect(encodeSend(frame("self")).hex).toBe("A5 04 01 02"));
  it("adjust 把「含自身/不含自身」这类协议差补上", () => expect(encodeSend(frame("self", -1)).hex).toBe("A5 03 01 02"));
  it("负长度直接报错，而不是回绕成 255", () => expect(() => encodeSend(frame("after", -9))).toThrow(/负长度/));
});

describe("encodeSend · 校验", () => {
  /**
   * `coverageEnd` 的口径在这里钉死：**负数 = 从帧尾往回数几个字节不覆盖**。
   * 所以 1 字节 SUM8 用 -1（不含校验自身），2 字节 CRC16 用 -2，4 字节 CRC32 用 -4。
   * 这个口径与接收侧 `ChecksumCfg.coverageEnd`（"负数终点=距帧尾"）一致 —— 界面上会把
   * 覆盖区间画出来，是因为纯数字口径确实反直觉（详设 §4.2 的预览那一栏）。
   */
  const ck = (
    algo: "sum8" | "xor8" | "crc16_modbus" | "crc32",
    bytes: number[],
    width: number,
  ) =>
    tpl(
      [
        ...bytes.map((b, i) => field({ name: `B${i}`, source: { kind: "const", bytes: [b] } })),
        field({
          name: "CK",
          role: "checksum",
          type: "uint8",
          source: { kind: "const", bytes: [] },
        }),
      ],
      { checksum: { algo, coverageStart: 0, coverageEnd: -width } },
    );

  it("sum8 覆盖 [0, 帧尾前)", () => expect(encodeSend(ck("sum8", [0x01, 0x02, 0xfc], 1)).hex).toBe("01 02 FC FF"));
  it("xor8", () => expect(encodeSend(ck("xor8", [0x0f, 0x0f, 0x00], 1)).hex).toBe("0F 0F 00 00"));
  it("CRC-16/MODBUS 小端落帧：0x4B37 → 37 4B", () => {
    const ascii = Array.from("123456789", (c) => c.charCodeAt(0));
    expect(encodeSend(ck("crc16_modbus", ascii, 2)).hex).toBe("31 32 33 34 35 36 37 38 39 37 4B");
  });
  it("CRC-32 大端落帧：0xCBF43926", () => {
    const ascii = Array.from("123456789", (c) => c.charCodeAt(0));
    expect(encodeSend(ck("crc32", ascii, 4)).hex).toContain("CB F4 39 26");
  });
  it("校验段占几字节由算法决定，不由用户填", () => {
    const ascii = Array.from("123456789", (c) => c.charCodeAt(0));
    const one = encodeSend(ck("sum8", ascii, 1)).hex.split(" ").length;
    const four = encodeSend(ck("crc32", ascii, 4)).hex.split(" ").length;
    expect(four - one).toBe(3); // 4 字节 CRC32 替掉 1 字节 SUM8
  });
  it("校验段不许绑参数/变量：值是算出来的", () => {
    const t = tpl(
      [field({ name: "B", source: { kind: "const", bytes: [1] } }), field({ name: "CK", role: "checksum", source: { kind: "param", paramId: "CK" } })],
      { checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1 }, params: [{ id: "CK", name: "CK", type: "int", def: "0" }] },
    );
    expect(() => encodeSend(t)).toThrow(/不能绑参数或变量/);
  });
  it("选了算法却没有校验段 ⇒ 报错", () => {
    const t = tpl([field({ name: "B", source: { kind: "const", bytes: [1] } })], {
      checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1 },
    });
    expect(() => encodeSend(t)).toThrow(/没有.*标成校验/);
  });
});

describe("encodeSend · 自增帧序号（D9）", () => {
  const t = tpl([
    field({ name: "HDR", source: { kind: "const", bytes: [0xa5] } }),
    field({ name: "SEQ", role: "seq", source: { kind: "seq" } }),
  ]);
  it("每发一帧 +1，并把下一个值还给调用方", () => {
    const a = encodeSend(t, { seq: 0xfe });
    const b = encodeSend(t, { seq: a.seqAfter });
    expect(a.hex).toBe("A5 FE");
    expect(b.hex).toBe("A5 FF");
    expect(b.seqAfter).toBe(256);
  });
  it("按位宽回绕，不溢出成两字节", () => {
    expect(encodeSend(t, { seq: 256 }).hex).toBe("A5 00");
  });
  it("step / wrap 可配（有些协议序号只走偶数）", () => {
    const even = tpl([field({ name: "S", role: "seq", source: { kind: "seq", step: 2, wrap: 8 } })]);
    expect(encodeSend(even, { seq: 6 }).hex).toBe("06");
    expect(encodeSend(even, { seq: 8 }).hex).toBe("00");
  });
});

describe("encodeSend · 缺值与越界必须报错", () => {
  const t = withParam(tpl([num("P", "uint8")]), "P");
  it("参数没有值也没有默认 ⇒ 不发，点名参数", () => {
    expect(() => encodeSend(t, { values: { P: "" } })).toThrow(/参数「P」没有值/);
  });
  it("引用了不存在的参数 ⇒ 点名", () => {
    expect(() => encodeSend(tpl([field({ name: "X", source: { kind: "param", paramId: "nope" } })]))).toThrow(/不存在的参数/);
  });
  it("变量没有值 ⇒ 报错，绝不把「{name}」原样发给设备", () => {
    expect(() =>
      encodeSend(tpl([field({ name: "V", source: { kind: "var", name: "speed" } })]), { vars: {} }),
    ).toThrow(/变量「speed」还没有值/);
  });
  it("变量取到了就编", () => {
    expect(encodeSend(tpl([field({ name: "V", type: "uint16", source: { kind: "var", name: "speed" } })]), { vars: { speed: 300 } }).hex).toBe("01 2C");
  });
  it("超出字段类型范围 ⇒ 点名类型与范围", () => {
    expect(() => encodeSend(withParam(tpl([num("P", "uint8")]), "P"), { values: { P: "256" } })).toThrow(/uint8 的范围是 0~255/);
  });
  it("参数自带的 min/max 也拦", () => {
    const t2 = tpl([num("P", "uint8")]);
    t2.params.push({ id: "P", name: "P", type: "int", def: "", min: 1, max: 10 });
    expect(() => encodeSend(t2, { values: { P: "20" } })).toThrow(/大于上限 10/);
  });
  it("空谱 ⇒ 报错（不发一串空字节）", () => {
    expect(() => encodeSend(tpl([]))).toThrow(SendEncodeError);
  });
  it("enum 参数：标签与值都能给，给错档位点名", () => {
    const t3 = tpl([field({ name: "M", source: { kind: "param", paramId: "M" } })], {
      params: [{ id: "M", name: "M", type: "enum", def: "01", enumMap: [{ label: "启动", value: "01" }, { label: "停止", value: "00" }] }],
    });
    expect(encodeSend(t3, { values: { M: "停止" } }).hex).toBe("00");
    expect(encodeSend(t3, { values: { M: "01" } }).hex).toBe("01");
    expect(() => encodeSend(t3, { values: { M: "暂停" } })).toThrow(/不在参数「M」的档位里/);
  });
});
