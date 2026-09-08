import { describe, expect, it } from "vitest";
import { formatHexBytes, parseHexBytes } from "./hexBytes";

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
