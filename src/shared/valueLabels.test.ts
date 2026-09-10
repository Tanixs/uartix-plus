import { describe, expect, it } from "vitest";
import { formatLabelSpec, labeledValue, labelText, parseLabelSpec } from "./valueLabels";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

describe("值标签（枚举注解）", () => {
  it("命中值时给出文字，未命中为 null", () => {
    const ls = [
      { v: 1, t: "非法功能码" },
      { v: 2, t: "非法数据地址" },
    ];
    expect(labelText(ls, 2)).toBe("非法数据地址");
    expect(labelText(ls, 6)).toBeNull();
    expect(labelText(null, 1)).toBeNull();
    expect(labelText([], 1)).toBeNull();
  });

  it("浮点值按 1e-9 容差匹配（缩放后的状态字也能命中）", () => {
    const ls = [{ v: 0.3, t: "待机" }];
    expect(labelText(ls, 0.1 * 3)).toBe("待机");
  });

  it("NaN/Infinity 不参与匹配", () => {
    const ls = [{ v: 0, t: "零" }];
    expect(labelText(ls, Number.NaN)).toBeNull();
    expect(labelText(ls, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("单元格文本 = 数字 + 标签（无标签时只有数字）", () => {
    const ls = [{ v: 2, t: "非法数据地址" }];
    expect(labeledValue(ls, 2, fmt)).toBe("2 非法数据地址");
    expect(labeledValue(ls, 9, fmt)).toBe("9");
    expect(labeledValue(undefined, 9, fmt)).toBe("9");
  });

  it("编辑文本按「值=文字」逐行解析，忽略空行与缺分隔符的行", () => {
    const ls = parseLabelSpec("1=非法功能码\n\n 2 = 非法数据地址 \n3:设备故障\n垃圾");
    expect(ls).toEqual([
      { v: 1, t: "非法功能码" },
      { v: 2, t: "非法数据地址" },
    ]);
  });

  it("支持 0x 十六进制值（与协议手册写法一致）", () => {
    expect(parseLabelSpec("0xFF00=置位\n0x0000=复位")).toEqual([
      { v: 0xff00, t: "置位" },
      { v: 0, t: "复位" },
    ]);
  });

  it("标签列表可回写成编辑文本（往返一致）", () => {
    const ls = parseLabelSpec("1=非法功能码\n2=非法数据地址");
    expect(formatLabelSpec(ls)).toBe("1=非法功能码; 2=非法数据地址");
    expect(parseLabelSpec(formatLabelSpec(ls))).toEqual(ls);
    expect(formatLabelSpec(null)).toBe("");
  });
});
