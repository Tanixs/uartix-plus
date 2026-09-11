/**
 * 序列比对 / 状态机推断（P63c）——「协议考古学家」AI 增强层之二。
 *
 * 约束：X-Ray 样本环只存字节不存时间戳（P47 决议），故 v1 全部基于字节流：
 * - 帧型分类：帧头签名匹配（簇发现的长签名优先，前 2 字节兜底）；
 * - 周期/事件：同型帧的字节间距变异系数（CV 低 = 等间隔周期帧）；
 * - 轮询循环：符号序列最小周期检测（≥98% 匹配即视为循环节）。
 * 请求-应答配对需发送方向采样（v2，SampleRing 上游接 TX 后解锁）。
 *
 * 与爆破同样按需单次执行、基于冻结快照；行取样必须连续（跳行会伪造序列跳变），
 * 故超上限只取最近 maxRows 行（新状态比旧状态更有代表性）。
 */

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

export interface SymStat {
  /** 帧头签名（hex 显示串） */
  sym: string;
  /** 出现行数 */
  count: number;
  /** 相邻出现的字节间距中位数 */
  spacingMed: number;
  /** 间距变异系数（std/mean，越小越等间隔） */
  spacingCV: number;
  /** 等间隔且次数足够 = 周期帧；否则 = 事件帧 */
  kind: "periodic" | "event";
}

export interface CycleInfo {
  /** 一个循环节内的符号序列（末段切片，可能是任意旋转位） */
  pattern: string[];
  /** 循环节长度（帧） */
  period: number;
  /** 匹配率（≥0.98 才判定） */
  matchRatio: number;
}

export interface SeqReport {
  syms: SymStat[];
  cycle: CycleInfo | null;
  /** 实际分析的行数 */
  rows: number;
  /** 总行数超出上限被截断（只取最近 maxRows 行） */
  truncated: boolean;
}

/** 序列分析默认行上限（连续行，不能抽样） */
export const SEQ_MAX_ROWS = 2048;
/** 循环节判定线 */
const CYCLE_RATIO = 0.98;
/** 周期帧判定：至少出现次数 + 间距变异系数上限 */
const PERIODIC_MIN_COUNT = 5;
const PERIODIC_MAX_CV = 0.3;

export function analyzeSequence(
  bytes: Uint8Array,
  L: number,
  phase: number,
  headers: number[][],
  maxRows = SEQ_MAX_ROWS,
): SeqReport {
  const totalRows = L >= 4 ? Math.floor((bytes.length - phase) / L) : 0;
  if (totalRows < 8 || L < 4) {
    return { syms: [], cycle: null, rows: totalRows, truncated: false };
  }
  const startRow = Math.max(0, totalRows - maxRows);
  const rows = totalRows - startRow;
  const truncated = startRow > 0;

  // 帧头签名表：长者优先（避免短签名抢先匹配）；<2B 签名噪声太大，丢弃
  const hs = headers
    .filter((h) => h.length >= 2 && h.length <= L)
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((h) => ({ hex: h.map(hex2).join(" "), bytes: h }));

  const syms: string[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const off = phase + (startRow + i) * L;
    let sym: string | null = null;
    for (const h of hs) {
      let ok = true;
      for (let k = 0; k < h.bytes.length; k++) {
        if (bytes[off + k] !== h.bytes[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        sym = h.hex;
        break;
      }
    }
    syms[i] = sym ?? `${hex2(bytes[off])} ${hex2(bytes[off + 1])}`;
  }

  // 每符号统计：出现行号 → 间距（行距 × L = 字节距）
  const idx = new Map<string, number[]>();
  for (let i = 0; i < rows; i++) {
    const arr = idx.get(syms[i]);
    if (arr) arr.push(i);
    else idx.set(syms[i], [i]);
  }
  const stats: SymStat[] = Array.from(idx.entries()).map(([sym, arr]) => {
    const gaps: number[] = [];
    for (let k = 1; k < arr.length; k++) gaps.push(arr[k] - arr[k - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    const cv = gaps.length >= 2 ? Math.sqrt(variance) / (mean || 1) : 0;
    return {
      sym,
      count: arr.length,
      spacingMed: median(gaps) * L,
      spacingCV: cv,
      kind: arr.length >= PERIODIC_MIN_COUNT && cv <= PERIODIC_MAX_CV ? "periodic" : "event",
    };
  });
  stats.sort((a, b) => b.count - a.count);

  return { syms: stats, cycle: shortestCycle(syms), rows, truncated };
}

/** 最小周期检测：p 自增找到第一个全序列匹配率 ≥98% 的周期即为最短循环节 */
function shortestCycle(s: string[]): CycleInfo | null {
  const n = s.length;
  if (n < 4) return null;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    let match = 0;
    for (let i = p; i < n; i++) if (s[i] === s[i - p]) match++;
    const ratio = match / (n - p);
    if (ratio >= CYCLE_RATIO) {
      return { pattern: s.slice(n - p), period: p, matchRatio: ratio };
    }
  }
  return null;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
