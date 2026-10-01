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

describe("sendFieldWidth · 变长类型的宽度取 size", () => {
  const f = (over: Partial<SendField>): SendField =>
    ({ id: "x", name: "x", type: "uint8", endian: "big", role: "data", source: { kind: "const", bytes: [] }, ...over }) as SendField;

  it("ascii 默认 1、bcd 默认 2，与接收侧 fieldSize 同兜底", () => {
    expect(sendFieldWidth(f({}))).toBe(1);
    expect(sendFieldWidth(f({ type: "ascii" }))).toBe(1);
    expect(sendFieldWidth(f({ type: "ascii", size: 4 }))).toBe(4);
    expect(sendFieldWidth(f({ type: "bcd" }))).toBe(2);
    expect(sendFieldWidth(f({ type: "uint16" }))).toBe(2);
    expect(sendFieldWidth(f({ type: "float64" }))).toBe(8);
    expect(sendFieldWidth(f({ type: "bits" }))).toBe(1);
  });
});
