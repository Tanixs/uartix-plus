/**
 * P121-C2 · 字节带上的落点与换位规则。
 *
 * 为什么单独钉这几条：这台机器上进不去真实输入（CDP 的鼠标事件到不了页面，
 * 连一次普通 click 都收不到），所以"拖到第几块前面"这件事在自动化里验不了落带那一步；
 * 但**判定规则本身**是纯函数，能钉死。规则写错的症状很具体：
 * 往右拖一格跳两格、落在两块正中插错边、空带插不进去。
 */
import { describe, expect, it } from "vitest";
import { dropIndexAt, moveTargetIndex, sendFieldWidth, type SendField } from "./sendTypes";

const at = (left: number) => ({ left, width: 100 });
const THREE = [at(0), at(100), at(200)];

describe("dropIndexAt · 半格吸附", () => {
  it("空带 = 0；越过最右边的中线 = 追加到末尾", () => {
    expect(dropIndexAt([], 999)).toBe(0);
    expect(dropIndexAt(THREE, 249)).toBe(2);
    expect(dropIndexAt(THREE, 250)).toBe(3); // 最后一块的中线也按"越过"处理
    expect(dropIndexAt(THREE, -50)).toBe(0);
  });

  it("没越过中线算这块之前，越过了算后面一块之前", () => {
    expect(dropIndexAt(THREE, 49)).toBe(0);
    expect(dropIndexAt(THREE, 50)).toBe(1); // 正好压中线：按"越过"处理
    expect(dropIndexAt(THREE, 149)).toBe(1);
    expect(dropIndexAt(THREE, 150)).toBe(2);
  });
});

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
