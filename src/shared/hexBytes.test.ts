import { describe, expect, it } from "vitest";
import {
  formatHexBytes,
  formatHexPattern,
  isExactMask,
  parseHexBytes,
  parseHexPattern,
} from "./hexBytes";

describe("parseHexBytes", () => {
  it("空格分隔", () => {
    expect(parseHexBytes("AA 55 0C")).toEqual([0xaa, 0x55, 0x0c]);
  });
  it("逗号/分号/混合分隔与 0x 前缀", () => {
    expect(parseHexBytes("0xAA,0x55;0c")).toEqual([0xaa, 0x55, 0x0c]);
  });
  it("全角逗号分号归一", () => {
    expect(parseHexBytes("AA，55；0C")).toEqual([0xaa, 0x55, 0x0c]);
  });
  it("空串返回空数组", () => {
    expect(parseHexBytes("   ")).toEqual([]);
  });
  it("非法字符返回 null", () => {
    expect(parseHexBytes("GG")).toBeNull();
    expect(parseHexBytes("123")).toBeNull();
    expect(parseHexBytes("AA 0x")).toBeNull();
  });
});

describe("formatHexBytes", () => {
  it("大写两位补零空格分隔", () => {
    expect(formatHexBytes([0, 0xab, 0xff])).toBe("00 AB FF");
  });
  it("parse/format 往返一致", () => {
    const bytes = [0x51, 0x00, 0x0a, 0xbc];
    expect(parseHexBytes(formatHexBytes(bytes))).toEqual(bytes);
  });
});

describe("parseHexPattern", () => {
  it("普通写法等价于全精确掩码", () => {
    expect(parseHexPattern("AA 55")).toEqual({ bytes: [0xaa, 0x55], mask: [0xff, 0xff] });
    expect(isExactMask([0xff, 0xff])).toBe(true);
  });
  it("?? 整字节通配（Modbus 任意从站地址）", () => {
    expect(parseHexPattern("?? 03")).toEqual({ bytes: [0x00, 0x03], mask: [0x00, 0xff] });
  });
  it("半字节通配 A? / ?5", () => {
    expect(parseHexPattern("A? ?5")).toEqual({ bytes: [0xa0, 0x05], mask: [0xf0, 0x0f] });
  });
  it("显式按位掩码 NN&MM（异常响应 FC 的 bit7）", () => {
    expect(parseHexPattern("80&80")).toEqual({ bytes: [0x80], mask: [0x80] });
  });
  it("非法 token 返回 null", () => {
    expect(parseHexPattern("GG")).toBeNull();
    expect(parseHexPattern("A??")).toBeNull();
    expect(parseHexPattern("80&")).toBeNull();
    expect(parseHexPattern("&FF")).toBeNull();
  });
  it("空串为空前缀（允许清空帧头）", () => {
    expect(parseHexPattern("   ")).toEqual({ bytes: [], mask: [] });
  });
  it("format/parse 往返：混合通配与精确", () => {
    const cases = [
      { bytes: [0x00, 0x03], mask: [0x00, 0xff] },
      { bytes: [0x00, 0x80], mask: [0x00, 0x80] },
      { bytes: [0xa0, 0x05], mask: [0xf0, 0x0f] },
      { bytes: [0x12, 0x34], mask: [0xff, 0xff] },
    ];
    for (const c of cases) {
      const text = formatHexPattern(c.bytes, c.mask);
      const back = parseHexPattern(text);
      expect(back).not.toBeNull();
      // 逐位比较语义：值在被掩码覆盖的位上必须一致
      expect(
        back!.bytes.map((b, i) => b & back!.mask[i]).join(","),
        `往返后有效位不变：${text}`,
      ).toBe(c.bytes.map((b, i) => b & c.mask[i]).join(","));
      expect(back!.mask).toEqual(c.mask);
    }
  });
  it("全精确掩码格式化时不输出通配符（旧数据外观不变）", () => {
    expect(formatHexPattern([0xaa, 0x55], [0xff, 0xff])).toBe("AA 55");
    expect(formatHexPattern([0xaa, 0x55], null)).toBe("AA 55");
  });
});
