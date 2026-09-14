/**
 * P74-3 发送载荷 {var} 模板插值 golden 用例（sendTpl.ts 纯函数）。
 * 覆盖：text/hex 双模式的数值/布尔/字符串/未知名保留/边界值。
 */
import { describe, expect, it } from "vitest";
import { flowInterpolateHex, flowInterpolateText } from "./sendTpl";

const VARS: Record<string, number | string | boolean> = {
  n: 300,
  small: 5,
  neg: -12,
  frac: 3.6,
  inf: Number.POSITIVE_INFINITY,
  flag: true,
  off: false,
  s: "AB",
  zh: "温",
};

const get = (name: string) => VARS[name];

describe("flowInterpolateText", () => {
  it("数值/布尔/字符串直接 String()；未知名原样保留", () => {
    expect(flowInterpolateText("AA {n} BB", get)).toBe("AA 300 BB");
    expect(flowInterpolateText("{flag}", get)).toBe("true");
    expect(flowInterpolateText("v={s}!", get)).toBe("v=AB!");
    expect(flowInterpolateText("{nope}", get)).toBe("{nope}");
    expect(flowInterpolateText("x{unknown}y{n}", get)).toBe("x{unknown}y300");
  });

  it("多占位与相邻占位", () => {
    expect(flowInterpolateText("{small},{n}", get)).toBe("5,300");
    expect(flowInterpolateText("{s}{zh}", get)).toBe("AB温");
  });

  it("非法名（数字开头/带连字符）不是占位", () => {
    expect(flowInterpolateText("{1abc}", get)).toBe("{1abc}");
    expect(flowInterpolateText("{a-b}", get)).toBe("{a-b}");
  });

  it("空串与无占位透传", () => {
    expect(flowInterpolateText("", get)).toBe("");
    expect(flowInterpolateText("plain", get)).toBe("plain");
  });
});

describe("flowInterpolateHex", () => {
  it("数值 → 大端最小偶数字节对", () => {
    expect(flowInterpolateHex("AA {small} 55", get)).toBe("AA 05 55");
    expect(flowInterpolateHex("{n}", get)).toBe("012C");
    expect(flowInterpolateHex("00{n}", get)).toBe("00012C");
  });

  it("布尔 → 01/00", () => {
    expect(flowInterpolateHex("{flag}", get)).toBe("01");
    expect(flowInterpolateHex("{off}", get)).toBe("00");
  });

  it("字符串 → UTF-8 hex 大写", () => {
    expect(flowInterpolateHex("{s}", get)).toBe("4142");
    expect(flowInterpolateHex("{zh}", get)).toBe("E6B8A9");
  });

  it("负数：取绝对值前置 FF；非有限数原样保留", () => {
    expect(flowInterpolateHex("{neg}", get)).toBe("FF0C");
    expect(flowInterpolateHex("{inf}", get)).toBe("{inf}");
  });

  it("小数四舍五入到整数字节", () => {
    expect(flowInterpolateHex("{frac}", get)).toBe("04");
  });

  it("未知名原样保留", () => {
    expect(flowInterpolateHex("AA {nope}", get)).toBe("AA {nope}");
  });
});
