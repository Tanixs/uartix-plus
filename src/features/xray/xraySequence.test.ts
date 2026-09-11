import { describe, expect, it } from "vitest";

/**
 * 序列推断测试（P63c）：周期帧/事件帧分类、轮询循环节检测、噪声不误判、行上限截断。
 */
import { analyzeSequence, SEQ_MAX_ROWS } from "./xraySequence";

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

/** 构造 L 定长帧：header + 载荷 */
function row(header: number[], L: number): number[] {
  const pad = L - header.length;
  return [...header, ...Array.from({ length: pad }, (_, i) => (i * 7 + 0x31) & 0xff)];
}

/** 行数组 → 连续字节流（注意要扁平到 number[] 一层，Uint8Array.from 不接受嵌套数组） */
function toStream(rows: number[][]): Uint8Array {
  return Uint8Array.from(rows.flat());
}

/** 确定性伪随机（LCG） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 16) / 65536;
  };
}

const HA = [0xaa, 0x01];
const HB = [0xaa, 0x02];
const HC = [0xaa, 0x03];
const HEADERS = [HA, HB, HC];

describe("帧型分类（周期 vs 事件）", () => {
  it("单一帧型周期流：kind=periodic，循环节 [A] 周期 1", () => {
    const stream = Uint8Array.from(Array.from({ length: 32 }, () => row(HA, 8)).flat());
    const r = analyzeSequence(stream, 8, 0, HEADERS);
    expect(r.syms).toHaveLength(1);
    expect(r.syms[0].kind).toBe("periodic");
    expect(r.syms[0].sym).toBe("AA 01");
    expect(r.cycle?.period).toBe(1);
    expect(r.cycle?.pattern).toEqual(["AA 01"]);
  });

  it("A→B→A→C 轮询循环：循环节 4 帧，各型均为周期帧", () => {
    const cycle = [HA, HB, HA, HC];
    const rows: number[][] = [];
    for (let i = 0; i < 10; i++) for (const h of cycle) rows.push(row(h, 8));
    const r = analyzeSequence(toStream(rows), 8, 0, HEADERS);
    expect(r.cycle?.period).toBe(4);
    expect(r.cycle?.pattern).toEqual(["AA 01", "AA 02", "AA 01", "AA 03"]);
    expect(r.cycle?.matchRatio).toBeGreaterThanOrEqual(0.98);
    for (const s of r.syms) expect(s.kind).toBe("periodic");
  });

  it("事件帧（偶发、次数少）标 event，不破坏整体循环判定", () => {
    const rnd = lcg(0xfeed);
    const rows: number[][] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(row(HA, 8));
      if (i === 17 || i === 41) rows.push(row([0x5a, 0x99], 8)); // 未知帧头 → 兜底签名
      if (rnd() < 0) rows.push(row(HA, 8)); // 保持 rnd 确定性引用（永不触发）
    }
    const stream = Uint8Array.from(rows.flat());
    const r = analyzeSequence(stream, 8, 0, [HA]);
    const ev = r.syms.find((s) => s.sym === "5A 99");
    expect(ev?.count).toBe(2);
    expect(ev?.kind).toBe("event");
    const a = r.syms.find((s) => s.sym === "AA 01");
    expect(a?.kind).toBe("periodic");
    expect(a?.count).toBe(60);
  });
});

describe("不误判", () => {
  it("随机符号汤无循环节", () => {
    const rnd = lcg(0xbeef);
    const pool = [HA, HB, HC];
    const stream = Uint8Array.from(
      Array.from({ length: 200 }, () => row(pool[Math.floor(rnd() * 3)], 8)).flat(),
    );
    const r = analyzeSequence(stream, 8, 0, HEADERS);
    expect(r.cycle).toBeNull();
  });

  it("样本不足 8 行拒绝", () => {
    const stream = Uint8Array.from(Array.from({ length: 5 }, () => row(HA, 8)).flat());
    const r = analyzeSequence(stream, 8, 0, HEADERS);
    expect(r.syms).toHaveLength(0);
    expect(r.cycle).toBeNull();
  });
});

describe("护栏", () => {
  it(`超过 ${SEQ_MAX_ROWS} 行只取最近行并标 truncated`, () => {
    const stream = Uint8Array.from(
      Array.from({ length: SEQ_MAX_ROWS + 100 }, () => row(HA, 8)).flat(),
    );
    const r = analyzeSequence(stream, 8, 0, HEADERS);
    expect(r.truncated).toBe(true);
    expect(r.rows).toBe(SEQ_MAX_ROWS);
    // 截断后仍是单一周期流（取的是最近行）
    expect(r.cycle?.period).toBe(1);
  });

  it("长签名优先于 2 字节兜底", () => {
    // 簇签名 3 字节 AA 01 55，兜底会给出 "AA 01" —— 必须用长签名
    const stream = Uint8Array.from(Array.from({ length: 16 }, () => row([0xaa, 0x01, 0x55], 8)).flat());
    const r = analyzeSequence(stream, 8, 0, [[0xaa, 0x01, 0x55]]);
    expect(r.syms).toHaveLength(1);
    expect(r.syms[0].sym).toBe("AA 01 55");
  });

  it("间距中位数 = 符号间隔 × 帧长（字节）", () => {
    const cycle = [HA, HB];
    const rows: number[][] = [];
    for (let i = 0; i < 20; i++) for (const h of cycle) rows.push(row(h, 10));
    const r = analyzeSequence(toStream(rows), 10, 0, HEADERS);
    expect(r.syms.length).toBeGreaterThan(0);
    for (const s of r.syms) expect(s.spacingMed).toBe(20); // B 的间距 2 行 × 10B
  });
});

describe("显示辅助", () => {
  it("hex2 补零大写", () => {
    expect(hex2(0x5)).toBe("05");
    expect(hex2(0xab)).toBe("AB");
  });
});
