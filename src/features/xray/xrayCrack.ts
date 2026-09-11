/**
 * 校验算法爆破（P63a）——「协议考古学家」AI 增强层之一。
 *
 * 思路：给定冻结样本与推断的帧长 L / 相位 phase，枚举「算法 × 覆盖起点 × 校验位置 × 端序」
 * 组合，对采样行逐帧验证。全部通过 = 实锤；≥95% = 疑似。纯确定性穷举——
 * AI 不参与计算，只拿证据链 JSON 写推理报告（红线：模型手算校验不可靠）。
 *
 * 算法族与 Rust parser checksum_compute 完全对齐（6 种），保证实锤结果直接写进
 * 模板 checksum.algo 后可被解析器复验，不会出现「爆破命中但模板验不过」的坑。
 */
import { sum8, xor8, sumadd16, crc16, crc32 } from "../../shared/checksums";

/** 爆破算法族 = 模板系统 ChecksumAlgo 全集（与 Rust parser checksum_compute 对齐） */
export type CrackAlgo = "sum8" | "xor8" | "sumadd" | "crc16_modbus" | "crc16_ccitt" | "crc32";

interface AlgoDef {
  algo: CrackAlgo;
  size: 1 | 2 | 4;
  calc: (b: number[]) => number;
}

const ALGOS: AlgoDef[] = [
  { algo: "sum8", size: 1, calc: sum8 },
  { algo: "xor8", size: 1, calc: xor8 },
  { algo: "sumadd", size: 2, calc: sumadd16 },
  { algo: "crc16_modbus", size: 2, calc: (b) => crc16("modbus", b) },
  { algo: "crc16_ccitt", size: 2, calc: (b) => crc16("ccitt-false", b) },
  { algo: "crc32", size: 4, calc: crc32 },
];

export interface CrackHit {
  algo: CrackAlgo;
  /** 覆盖段起点（行内偏移，0 = 从帧头开始累加） */
  covStart: number;
  /** 校验字段起始偏移 */
  ckStart: number;
  /** 校验字段长度（字节） */
  ckLen: number;
  endian: "little" | "big";
  /** 通过帧占比 */
  passRate: number;
  /** 参与验证的行数 */
  rows: number;
  /** 全帧通过 = 实锤；≥95% = 疑似 */
  verdict: "solid" | "likely";
}

export interface CrackResult {
  hits: CrackHit[];
  /** 样本里实际可切的行数（未抽样前） */
  totalRows: number;
  /** 参与验证的行数（抽样后） */
  rows: number;
  /** 枚举的组合总数 */
  combos: number;
  /** 因时间预算被截断（结果可能漏组合） */
  truncated: boolean;
}

export interface CrackOpts {
  /** 参与验证的最大行数（均匀抽样，保留首尾行；默认 512） */
  maxRows?: number;
  /** 时间预算 ms（超出即截断；默认 120） */
  budgetMs?: number;
  /** 「疑似」通过率线（默认 0.95） */
  likelyRate?: number;
}

/** 覆盖段起点档位：0=全帧去尾；1/2=跳过帧头 1~2 字节（帧头常不参与校验） */
const COV_STARTS = [0, 1, 2];
/** 校验字段从帧尾向前的额外偏移档位（容帧尾符/ETX 占 1~2 字节） */
const CK_OFFSETS = [0, 1, 2];
/** 组合早停：一行未过且连败 ≥N 行即弃（实锤判定不受影响；疑似组合本来也到不了 95%） */
const EARLY_FAIL = 24;

export function crackChecksum(
  bytes: Uint8Array,
  L: number,
  phase: number,
  opts: CrackOpts = {},
): CrackResult {
  const maxRows = Math.max(8, Math.min(4096, Math.round(opts.maxRows ?? 512)));
  const budgetMs = Math.max(0, opts.budgetMs ?? 120); // 0 = 立即截断（测试截断路径用）
  const likelyRate = opts.likelyRate ?? 0.95;

  const totalRows = L >= 4 ? Math.floor((bytes.length - phase) / L) : 0;
  if (totalRows < 8 || L < 4) {
    return { hits: [], totalRows, rows: 0, combos: 0, truncated: false };
  }

  // 均匀抽样行（保留首尾行），每行转 number[] 一次供各算法复用
  const step = Math.max(1, Math.floor(totalRows / maxRows));
  const idx: number[] = [];
  for (let i = 0; i < totalRows; i += step) idx.push(i);
  if (idx[idx.length - 1] !== totalRows - 1) idx.push(totalRows - 1);
  const rows: number[][] = idx.map((i) =>
    Array.from(bytes.subarray(phase + i * L, phase + (i + 1) * L)),
  );

  const hits: CrackHit[] = [];
  const t0 = performance.now();
  let combos = 0;
  let truncated = false;

  outer: for (const def of ALGOS) {
    const endians: ("little" | "big")[] = def.size === 1 ? ["little"] : ["little", "big"];
    for (const covStart of COV_STARTS) {
      for (const ckOff of CK_OFFSETS) {
        const ckEnd = L - ckOff;
        const ckStart = ckEnd - def.size;
        if (ckStart <= covStart) continue; // 覆盖段为空
        for (const endian of endians) {
          if (performance.now() - t0 >= budgetMs) {
            truncated = true;
            break outer;
          }
          combos++;
          let pass = 0;
          let fails = 0;
          for (const row of rows) {
            const computed = def.calc(row.slice(covStart, ckStart)) >>> 0;
            let expected = 0;
            if (endian === "little") {
              for (let k = def.size - 1; k >= 0; k--) {
                expected = (((expected << 8) | row[ckStart + k]) >>> 0);
              }
            } else {
              for (let k = 0; k < def.size; k++) {
                expected = (((expected << 8) | row[ckStart + k]) >>> 0);
              }
            }
            if (computed === expected) pass++;
            else if (++fails >= EARLY_FAIL && pass === 0) break;
          }
          const passRate = pass / rows.length;
          if (passRate >= likelyRate) {
            hits.push({
              algo: def.algo,
              covStart,
              ckStart,
              ckLen: def.size,
              endian,
              passRate,
              rows: rows.length,
              verdict: passRate === 1 ? "solid" : "likely",
            });
          }
        }
      }
    }
  }

  hits.sort((a, b) => b.passRate - a.passRate || a.algo.localeCompare(b.algo));
  return { hits, totalRows, rows: rows.length, combos, truncated };
}

/** 人读格式：如「CRC16-Modbus（全帧，@帧尾 小端）」——UI 与 AI 报告共用 */
const ALGO_NAMES: Record<string, string> = {
  sum8: "SUM8",
  xor8: "XOR8",
  sumadd: "SUM+AC16",
  crc16_modbus: "CRC16-Modbus",
  crc16_ccitt: "CRC16-CCITT",
  crc32: "CRC32",
};

export function describeHit(h: CrackHit, L: number): string {
  const algo = ALGO_NAMES[h.algo] ?? h.algo;
  const cov = h.covStart === 0 ? "全帧" : `跳过前 ${h.covStart}B`;
  const pos = h.ckStart + h.ckLen === L ? "帧尾" : `帧尾-${L - (h.ckStart + h.ckLen)}B`;
  const end = h.ckLen > 1 ? ` ${h.endian === "little" ? "小端" : "大端"}` : "";
  return `${algo}（${cov}，@${pos}${end}）`;
}
