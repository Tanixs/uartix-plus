/**
 * P121-C2 · 字节带上的换位与宽度规则。
 *
 * 为什么单独钉这几条：这台机器上进不去真实输入（CDP 的鼠标事件到不了页面，
 * 连一次普通 click 都收不到），所以"拖到第几块前面"这件事在自动化里验不了落带那一步；
 * 但**判定规则本身**是纯函数，能钉死。规则写错的症状很具体：
 * 往右拖一格跳两格、落在两块正中插错边、空带插不进去。
 *
 * P122-A 改写过一次：原来的 `dropIndexAt(rects, clientX)`（按块矩形的中线吸附）删了，
 * 因为字节带变成"一格一字节"，落点先要换算成**字节边界**再谈插到第几块前面。
 * 那条规则没有消失，它搬到了 `byteGrid.insertIndexAtBoundary` + `boundaryAt`，
 * 断言在 `byteGrid.test.ts`，比原来更严（多了 0 字节块与跨行段的用例）。
 */
import { describe, expect, it } from "vitest";
import type { FieldType } from "../../ipc/types";
import { fieldSize } from "../protocol/fieldTypes";
import { moveTargetIndex, sendFieldWidth, type SendField } from "./sendTypes";

describe("moveTargetIndex · 带内换位让回一格", () => {
  it("往前挪要让回一格（被拖那块先被摘掉，后面整体左移）", () => {
    // [A,B,C] 拖 B(from=1) 到 A 之前：落点 0
    expect(moveTargetIndex(1, 0)).toBe(0);
    // 拖 B 到 B 自己左半边：落点 1 = 原地不动
    expect(moveTargetIndex(1, 1)).toBe(1);
    // 拖 B 到 B 与 C 之间（落点 2）= 还是原地
    expect(moveTargetIndex(1, 2)).toBe(1);
    // 拖 B 到 C 之后（落点 3）= 末尾，即新数组的 2
    expect(moveTargetIndex(1, 3)).toBe(2);
    // 往后挪（from=2 落到 1 之前）不用让
    expect(moveTargetIndex(2, 1)).toBe(1);
  });
});

describe("sendFieldWidth · 与接收侧同一张宽表", () => {
  /**
   * P122-B 把这张契约改了，所以这条用例重写（不是放宽）：
   * 原先它钉的是"ascii 默认 1、bcd 默认 2，与接收侧 fieldSize 同兜底" —— 而后半句是假的，
   * 接收侧当时给 ascii 兜 4。两个数各猜各的，正是"同一块字节两个宽度"的根因。
   * 现在两边共用 `widthOf`：定长查表、变长只认作者声明的 size、**没声明就 0（不猜）**。
   */
  const f = (over: Partial<SendField>): SendField =>
    ({ id: "x", name: "x", type: "uint8", endian: "big", role: "data", source: { kind: "const", bytes: [] }, ...over }) as SendField;

  it("定长类型查表；变长类型取声明的 size", () => {
    expect(sendFieldWidth(f({}))).toBe(1);
    expect(sendFieldWidth(f({ type: "uint16" }))).toBe(2);
    expect(sendFieldWidth(f({ type: "float64" }))).toBe(8);
    expect(sendFieldWidth(f({ type: "bits" }))).toBe(1);
    expect(sendFieldWidth(f({ type: "ascii", size: 4 }))).toBe(4);
    expect(sendFieldWidth(f({ type: "bcd", size: 3 }))).toBe(3);
  });

  it("变长类型没声明 size ⇒ 0，不替作者猜一个宽度", () => {
    expect(sendFieldWidth(f({ type: "ascii" }))).toBe(0);
    expect(sendFieldWidth(f({ type: "bcd" }))).toBe(0);
    expect(sendFieldWidth(f({ type: "ascii", size: 0 }))).toBe(0);
  });

  it("csv 恒占 1 格（它是解析侧的显示类型，宽度由分隔符决定）", () => {
    expect(sendFieldWidth(f({ type: "csv" }))).toBe(1);
  });

  it("同一块在两个方向上必须是同一个宽度 —— 两侧逐类型对表", () => {
    const types: FieldType[] = [
      "uint8", "int8", "uint16", "int16", "uint32", "int32",
      "float32", "float64", "ascii", "bcd", "bits", "csv",
    ];
    for (const t of types) {
      for (const size of [undefined, 0, 1, 2, 5]) {
        const send = sendFieldWidth(f({ type: t, size }));
        const recv = fieldSize({ id: "x", name: "x", role: "data", offset: 0, type: t, endian: "big", color: "", size } as never);
        expect([t, size, send, recv], "变长类型缺 size 时两边不许各给一个数").toEqual([t, size, recv, recv]);
      }
    }
  });
});
