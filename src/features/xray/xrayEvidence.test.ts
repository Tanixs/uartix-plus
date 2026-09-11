import { describe, expect, it } from "vitest";

/**
 * 证据链构建测试（P63d）：编号连续、实锤/无命中文案正确、对无周期数据健壮。
 */
import { analyze } from "./xrayEngine";
import { buildEvidence } from "./xrayEvidence";
import { crc16 } from "../../shared/checksums";

/** 构造 16B 定长 CRC16-Modbus 帧：AA 55 | seq u16 | 随机载荷 10B | crc16 小端 */
function buildStream(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 16) / 65536;
  };
  const all: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = [0xaa, 0x55, i & 0xff, (i >> 8) & 0xff];
    for (let k = 0; k < 10; k++) f.push(Math.floor(rnd() * 256));
    const c = crc16("modbus", f);
    f.push(c & 0xff, (c >> 8) & 0xff);
    all.push(...f);
  }
  return Uint8Array.from(all);
}

describe("buildEvidence 证据链", () => {
  it("CRC16-Modbus 协议流：编号连续 + 实锤 + 帧长候选 + 高熵域", () => {
    const bytes = buildStream(128, 0x1234);
    const a = analyze(bytes, { minConf: 5, maxLen: 64 })!;
    expect(a.L).toBe(16); // 帧长应被正确推断
    const ev = buildEvidence(a, []);
    // 编号连续 E1..En
    ev.evidence.forEach((e, i) => expect(e.id).toBe(`E${i + 1}`));
    const all = ev.evidence.map((e) => e.text).join("\n");
    expect(all).toContain("帧长候选");
    expect(all).toContain("帧头候选");
    expect(all).toContain("AA 55");
    expect(all).toContain("校验爆破实锤");
    expect(all).toContain("CRC16-Modbus");
    expect(ev.meta.frameLen).toBe(16);
    expect(ev.meta.crackRows).toBeGreaterThan(0);
  });

  it("纯随机数据（无周期/无命中）不崩且文案明确", () => {
    let s = 0x9999;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s >>> 16) / 65536;
    };
    const bytes = Uint8Array.from(Array.from({ length: 4096 }, () => Math.floor(rnd() * 256)));
    const a = analyze(bytes, { minConf: 5, maxLen: 64 })!;
    const ev = buildEvidence(a, []);
    const all = ev.evidence.map((e) => e.text).join("\n");
    if (a.cands.length === 0) expect(all).toContain("无显著周期峰");
    expect(all).toContain("无命中");
  });

  it("带簇信息时输出帧型证据", () => {
    const bytes = buildStream(64, 0x777);
    const a = analyze(bytes, { minConf: 5, maxLen: 64 })!;
    const ev = buildEvidence(a, [
      { header: [0xaa, 0x55], count: 40, frameLen: 16, share: 0.9, peaks: [{ len: 16, n: 40 }] },
      { header: [0xbb, 0x66], count: 8, frameLen: null, share: 0.2, peaks: [] },
    ]);
    const all = ev.evidence.map((e) => e.text).join("\n");
    expect(all).toContain("帧型 AA 55: 40 帧，帧长 16B");
    expect(all).toContain("帧间距不集中");
  });
});
