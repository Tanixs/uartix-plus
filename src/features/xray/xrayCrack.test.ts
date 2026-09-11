import { describe, expect, it } from "vitest";

/**
 * 校验爆破测试（P63a）：新校验原语对齐标准向量 + 爆破引擎对已知协议流必命中、
 * 对噪声/错位帧长不误报实锤。
 */
import { crc16, crc32, sumadd16, sum8, xor8 } from "../../shared/checksums";
import { crackChecksum, describeHit } from "./xrayCrack";

/** 把 n 个 build(i) 生成的帧拼成连续字节流 */
function buildStream(n: number, build: (i: number) => number[]): Uint8Array {
  const all: number[] = [];
  for (let i = 0; i < n; i++) all.push(...build(i));
  return Uint8Array.from(all);
}

/** 确定性伪随机（LCG），噪声/载荷用 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 16) / 65536;
  };
}

const rnd = lcg(0xabcdef);
const payload = (n: number): number[] => Array.from({ length: n }, () => Math.floor(rnd() * 256));

describe("校验原语（对齐 Rust parser / 标准向量）", () => {
  it("crc32 标准向量 123456789 → 0xCBF43926", () => {
    expect(crc32([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])).toBe(0xcbf43926);
  });
  it("crc16 modbus 标准向量 123456789 → 0x4B37", () => {
    expect(crc16("modbus", [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])).toBe(0x4b37);
  });
  it("sumadd16 = 低 SC 高 AC（匿名 V7 同构）", () => {
    expect(sumadd16([1, 2])).toBe(0x0403); // sc=3, ac=4
    // sc: aa→ff→00；ac: aa→a9→a9 → 0 | (0xa9 << 8)
    expect(sumadd16([0xaa, 0x55, 0x01])).toBe(0xa900);
  });
});

describe("爆破命中（已知协议流必命中实锤）", () => {
  it("SUM8 @帧尾、全帧覆盖", () => {
    const stream = buildStream(32, (i) => {
      const f = [0xaa, 0x55, i & 0xff, (i >> 8) & 0xff, ...payload(1)];
      f.push(sum8(f));
      return f;
    });
    const r = crackChecksum(stream, 6, 0);
    const hit = r.hits.find((h) => h.verdict === "solid");
    expect(hit?.algo).toBe("sum8");
    expect(hit?.covStart).toBe(0);
    expect(hit?.ckStart).toBe(5);
  });

  it("CRC16-Modbus 小端 @帧尾", () => {
    const stream = buildStream(32, (i) => {
      const f = [0xaa, ...payload(6), i & 0xff];
      const c = crc16("modbus", f);
      f.push(c & 0xff, (c >> 8) & 0xff);
      return f;
    });
    const r = crackChecksum(stream, 10, 0);
    const hit = r.hits.find((h) => h.verdict === "solid");
    expect(hit?.algo).toBe("crc16_modbus");
    expect(hit?.endian).toBe("little");
    expect(hit?.ckStart).toBe(8);
  });

  it("SUM+AC16（sumadd）小端 @帧尾", () => {
    const stream = buildStream(24, (i) => {
      const f = [0xaa, 0x55, i & 0xff, ...payload(3)];
      const c = sumadd16(f);
      f.push(c & 0xff, (c >> 8) & 0xff);
      return f;
    });
    const r = crackChecksum(stream, 8, 0);
    // 注：SC 字节本身就是合法的 sum8 校验（sum8 覆盖[0,6) 读 row[6]），
    // 所以 sum8 同样实锤——这里只断言 sumadd 自身命中。
    const hit = r.hits.find((h) => h.verdict === "solid" && h.algo === "sumadd");
    expect(hit?.ckLen).toBe(2);
    expect(hit?.endian).toBe("little");
    expect(hit?.ckStart).toBe(6);
  });

  it("CRC32 大端 @帧尾", () => {
    const stream = buildStream(24, (i) => {
      const f = [0xbb, 0x66, ...payload(5), i & 0xff];
      const c = crc32(f);
      f.push((c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
      return f;
    });
    const r = crackChecksum(stream, 12, 0);
    const hit = r.hits.find((h) => h.verdict === "solid");
    expect(hit?.algo).toBe("crc32");
    expect(hit?.endian).toBe("big");
  });

  it("XOR8 帧尾有 1 字节 ETX（ckOffset=1 档）", () => {
    const stream = buildStream(32, (i) => {
      const f = [0xaa, i & 0xff, ...payload(2)];
      f.push(xor8(f), 0x0d);
      return f;
    });
    const r = crackChecksum(stream, 6, 0);
    const hit = r.hits.find((h) => h.verdict === "solid");
    expect(hit?.algo).toBe("xor8");
    expect(hit?.ckStart).toBe(4);
    expect(hit && hit.ckStart + hit.ckLen).toBe(5); // 不占最后一字节
  });

  it("相位偏移：帧流前有 3 字节噪声，phase=3 命中", () => {
    const stream = buildStream(32, (i) => {
      const f = [0xaa, 0x55, i & 0xff, ...payload(2)];
      f.push(sum8(f));
      return f;
    });
    const withNoise = Uint8Array.from([0x11, 0x22, 0x33, ...stream]);
    const r = crackChecksum(withNoise, 6, 3);
    expect(r.hits.some((h) => h.verdict === "solid" && h.algo === "sum8")).toBe(true);
  });
});

describe("不误报（噪声/错位全灭）", () => {
  it("纯随机噪声无 solid 命中", () => {
    const stream = buildStream(64, () => payload(17));
    const r = crackChecksum(stream, 17, 0);
    expect(r.hits.some((h) => h.verdict === "solid")).toBe(false);
  });

  it("帧长推断错位（L+1）无 solid 命中", () => {
    const stream = buildStream(32, (i) => {
      const f = [0xaa, 0x55, i & 0xff, ...payload(1)];
      f.push(sum8(f));
      return f;
    });
    const r = crackChecksum(stream, 7, 0);
    expect(r.hits.some((h) => h.verdict === "solid")).toBe(false);
  });

  it("样本不足 8 行直接拒绝", () => {
    const stream = buildStream(5, (i) => {
      const f = [0xaa, i];
      f.push(sum8(f));
      return f;
    });
    const r = crackChecksum(stream, 3, 0);
    expect(r.hits).toHaveLength(0);
    expect(r.totalRows).toBeLessThan(8);
  });
});

describe("护栏与描述", () => {
  it("零时间预算立即截断，一个组合都不跑", () => {
    const stream = buildStream(64, (i) => {
      const f = [0xaa, 0x55, i & 0xff, ...payload(9)];
      f.push(sum8(f));
      return f;
    });
    const r = crackChecksum(stream, 13, 0, { budgetMs: 0 });
    expect(r.truncated).toBe(true);
    expect(r.combos).toBe(0);
    expect(r.hits).toHaveLength(0);
  });

  it("describeHit 人读格式", () => {
    expect(
      describeHit({ algo: "crc16_modbus", covStart: 0, ckStart: 8, ckLen: 2, endian: "little", passRate: 1, rows: 32, verdict: "solid" }, 10),
    ).toContain("CRC16-Modbus");
    expect(
      describeHit({ algo: "xor8", covStart: 1, ckStart: 4, ckLen: 1, endian: "little", passRate: 1, rows: 32, verdict: "solid" }, 6),
    ).toContain("XOR8");
  });
});
