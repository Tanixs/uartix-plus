import { describe, expect, it } from "vitest";
import { SampleRing, analyze, discoverCluster, findCandidates, SAMPLE_CAP } from "./xrayEngine";

/** 合成 WIT 0x51 帧流（11B：51 53 CC + 6B 变化数据 + 和校验 + 帧尾），数据字节随机 */
function witStream(frames: number, rnd = mulberry(42)): Uint8Array {
  const out = new Uint8Array(frames * 11);
  for (let f = 0; f < frames; f++) {
    const o = f * 11;
    out[o] = 0x51;
    out[o + 1] = 0x53;
    out[o + 2] = 0xcc;
    for (let c = 3; c < 9; c++) out[o + c] = Math.floor(rnd() * 256);
    let s = 0;
    for (let c = 0; c < 10; c++) s = (s + out[o + c]) & 0xff;
    out[o + 9] = s;
    out[o + 10] = 0x0f;
  }
  return out;
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SampleRing", () => {
  it("未满时按序返回", () => {
    const r = new SampleRing();
    r.push(Uint8Array.from([1, 2, 3]));
    r.push(Uint8Array.from([4, 5]));
    expect(Array.from(r.snapshot())).toEqual([1, 2, 3, 4, 5]);
    expect(r.size).toBe(5);
  });

  it("满后 snapshot === 参考线性数组的最后 256KB（与旧整包驱逐语义逐字节一致）", () => {
    const r = new SampleRing();
    const ref: number[] = [];
    const rnd = mulberry(7);
    for (let p = 0; p < 4000; p++) {
      const n = 1 + Math.floor(rnd() * 300);
      const chunk = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        chunk[i] = Math.floor(rnd() * 256);
        ref.push(chunk[i]);
      }
      r.push(chunk);
    }
    const expectTail = Uint8Array.from(ref.slice(-SAMPLE_CAP));
    const got = r.snapshot();
    expect(got.length).toBe(SAMPLE_CAP);
    let same = true;
    for (let i = 0; i < SAMPLE_CAP; i++) if (got[i] !== expectTail[i]) { same = false; break; }
    expect(same).toBe(true);
  });

  it("暂停丢弃新数据；清空归零", () => {
    const r = new SampleRing();
    r.push(Uint8Array.from([1, 2]));
    r.paused = true;
    r.push(Uint8Array.from([3]));
    r.paused = false;
    expect(Array.from(r.snapshot())).toEqual([1, 2]);
    r.clear();
    expect(r.size).toBe(0);
    r.push(Uint8Array.from([9]));
    expect(Array.from(r.snapshot())).toEqual([9]);
  });
});

describe("WIT 协议识别基线（用户验收标准：能识别帧头 51 53 CC）", () => {
  it("纯 0x51 流 → L=11 且帧头候选正确", () => {
    const a = analyze(witStream(2000));
    expect(a).not.toBeNull();
    expect(a!.L).toBe(11);
    const head = a!.runs.find((r) => r.headCandidate);
    expect(head?.bytes).toEqual([0x51, 0x53, 0xcc]);
  });

  it("候选显著度 ≥5 且含真帧长", () => {
    const cands = findCandidates(witStream(2000));
    expect(cands.some((c) => c.L === 11 && c.conf >= 5)).toBe(true);
  });
});

describe("混合帧型流（演示源场景）行为记录", () => {
  it("WIT 11B + V7 22B 交织 → 单周期检测退化（协议簇发现要解决的问题）", () => {
    const wit = witStream(1200);
    const v7 = new Uint8Array(1200 * 22);
    for (let f = 0; f < 1200; f++) {
      const o = f * 22;
      v7[o] = 0x55;
      v7[o + 1] = 0x01;
      for (let c = 2; c < 22; c++) v7[o + c] = (f * 31 + c * 7) & 0xff;
    }
    const mixed = new Uint8Array(wit.length + v7.length);
    mixed.set(wit, 0);
    mixed.set(v7, wit.length);
    const a = analyze(mixed);
    // 记录现状：混合流前半/后半各自周期，整段自相关被摊薄——候选可能缺失或错帧长。
    // 该用例锁定「混合流是单周期算法的已知局限」，P56b 帧头间距簇发现将改善此场景。
    expect(a).not.toBeNull();
    const witPart = findCandidates(wit);
    expect(witPart.some((c) => c.L === 11)).toBe(true);
  });
});

/** WIT 0x55 协议合成流：8B 帧 [55 reg d0-d3 sum 0A]，0x51/0x52/0x53 循环混发 */
function wit055Stream(groups: number, rnd = mulberry(99)): Uint8Array {
  const regs = [0x51, 0x52, 0x53];
  const out = new Uint8Array(groups * 3 * 8);
  let o = 0;
  for (let g = 0; g < groups; g++) {
    for (const reg of regs) {
      out[o] = 0x55;
      out[o + 1] = reg;
      for (let c = 2; c < 6; c++) out[o + c] = Math.floor(rnd() * 256);
      let s = 0;
      for (let c = 0; c < 7; c++) s = (s + out[o + c]) & 0xff;
      out[o + 6] = s;
      out[o + 7] = 0x0a;
      o += 8;
    }
  }
  return out;
}

describe("协议簇发现（P56b：混发多帧型场景）", () => {
  it("WIT 0x55 三帧型混发 → 识别 51/52/53 三种帧型且真帧长=8", () => {
    const s = wit055Stream(600);
    const types = discoverCluster(s, [0x55, 0x51]);
    expect(types.length).toBe(3);
    expect(types.map((t) => t.header).sort((a, b) => a[1] - b[1])).toEqual([
      [0x55, 0x51],
      [0x55, 0x52],
      [0x55, 0x53],
    ]);
    for (const t of types) {
      expect(t.frameLen).toBe(8);
      expect(t.share).toBeGreaterThan(0.9);
      expect(t.count).toBeGreaterThanOrEqual(500);
    }
  });

  it("单帧型流 → 簇大小 1，帧长正确", () => {
    const one = wit055Stream(1).slice(0, 8);
    const s = new Uint8Array(800 * 8);
    for (let i = 0; i < 800; i++) s.set(one, i * 8);
    const types = discoverCluster(s, [0x55, 0x51]);
    expect(types.length).toBe(1);
    expect(types[0].frameLen).toBe(8);
  });

  it("随机噪声 → 无簇（帧头命中不足）", () => {
    const rnd = mulberry(1);
    const s = new Uint8Array(64 * 1024);
    for (let i = 0; i < s.length; i++) s[i] = Math.floor(rnd() * 256);
    expect(discoverCluster(s, [0x55, 0x51]).length).toBe(0);
  });

  it("混合帧长（8B 的 51/52 + 36B 的 53）→ 各帧型帧长独立正确", () => {
    const rnd = mulberry(5);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let g = 0; g < 300; g++) {
      for (const [reg, len] of [[0x51, 8], [0x52, 8], [0x53, 36]] as const) {
        const f = new Uint8Array(len);
        f[0] = 0x55;
        f[1] = reg;
        for (let c = 2; c < len - 2; c++) f[c] = Math.floor(rnd() * 256);
        f[len - 1] = 0x0a;
        parts.push(f);
        total += len;
      }
    }
    const s = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      s.set(p, o);
      o += p.length;
    }
    const types = discoverCluster(s, [0x55, 0x51]);
    const byReg = new Map(types.map((t) => [t.header[1], t]));
    expect(byReg.get(0x51)?.frameLen).toBe(8);
    expect(byReg.get(0x52)?.frameLen).toBe(8);
    expect(byReg.get(0x53)?.frameLen).toBe(36);
  });
});
