export const SAMPLE_CAP = 256 * 1024; // 样本环容量（可配置）
export const ANALYZE_WINDOWS = [64 * 1024, 256 * 1024] as const; // 分析窗口档位
export const MIN_L = 4;
export const MAX_L = 256;
export const MIN_ROWS = 8; // 每列至少 8 帧样本，统计才可信（低于则置信度打折）
export const MAX_GRID_ROWS = 24; // 网格最多显示 24 行（防 canvas 过大）
const RAND_P = 1 / 256; // 随机数据匹配基线

export interface Cand {
  L: number;
  /** 峰显著度：match(L) ÷ 邻域中位数（×倍数；≥5 视为显著峰） */
  conf: number;
}

export interface ColStat {
  unique: number;
  H: number;
  top1: number;
  top1Byte: number;
  rows: number;
}

export interface Run {
  /** 相位对齐后的列偏移 */
  start: number;
  len: number;
  bytes: number[];
  /** 是否从列 0 开始（真正的帧头候选） */
  headCandidate: boolean;
}

export interface Analysis {
  cands: Cand[];
  L: number;
  phase: number;
  cols: ColStat[];
  runs: Run[];
  rows: number;
  /** 分析时刻冻结的样本快照——切候选/重绘都基于它，与实时缓冲解耦（P56 错位修复） */
  bytes: Uint8Array;
}

/**
 * 字节环形样本缓冲：写指针 head，满后新字节逐个覆盖最旧（严格 FIFO）。
 * 与旧「整包 copyWithin 驱逐」语义等价（同为最近 N 字节时间序），但驱逐粒度为字节。
 */
export class SampleRing {
  private buf = new Uint8Array(SAMPLE_CAP);
  private len = 0;
  private head = 0;
  paused = false;

  push(bytes: Uint8Array): void {
    if (this.paused || bytes.length === 0) return;
    for (let i = 0; i < bytes.length; i++) {
      this.buf[this.head] = bytes[i];
      this.head = (this.head + 1) % SAMPLE_CAP;
      if (this.len < SAMPLE_CAP) this.len++;
    }
  }

  snapshot(window?: number): Uint8Array {
    let lin: Uint8Array;
    if (this.len < SAMPLE_CAP) {
      lin = this.buf.slice(0, this.len);
    } else {
      const h = this.head;
      lin = new Uint8Array(this.len);
      lin.set(this.buf.subarray(h), 0);
      lin.set(this.buf.subarray(0, h), this.len - h);
    }
    const want = Math.min(window ?? this.len, this.len);
    return want >= lin.length ? lin : lin.subarray(lin.length - want);
  }

  clear(): void {
    this.len = 0;
    this.head = 0;
  }

  get size(): number {
    return this.len;
  }
}

/**
 * 周期检测：对每个候选 L 算「相距 L 字节相等率」match(L)，取局部峰 top5（相邻 L<3 去重）。
 * 显著度 = match(L) ÷ 邻域中位数（±8 内、排除 ±2 峰坡）——不用绝对匹配率：
 * 帧头占帧比例低时（如 4/17）绝对 match 天然只有 ~24%，但对随机基线（~0.4%）
 * 是 60 倍强信号；显著度倍数才能正确区分「帧长峰」与「数据伪相关」。
 */
export interface AnalyzeOpts {
  /** 显著度阈值（默认 5×；低=灵敏，高=保守） */
  minConf?: number;
  /** 帧长搜索上限（默认 256） */
  maxLen?: number;
}

export function findCandidates(s: Uint8Array, minConf = 5, maxLenCap = MAX_L): Cand[] {
  const N = s.length;
  const maxL = Math.min(maxLenCap, Math.floor(N / MIN_ROWS));
  if (maxL < MIN_L) return [];
  const match = new Float64Array(maxL + 1);
  for (let L = MIN_L; L <= maxL; L++) {
    let m = 0;
    const n = N - L;
    for (let i = 0; i < n; i++) if (s[i] === s[i + L]) m++;
    match[L] = m / n;
  }
  const salience = (L: number): number => {
    const nb: number[] = [];
    for (let k = L - 8; k <= L + 8; k++) {
      if (k < MIN_L || k > maxL || Math.abs(k - L) <= 2) continue;
      nb.push(match[k]);
    }
    nb.sort((a, b) => a - b);
    const med = nb.length ? nb[Math.floor(nb.length / 2)] : RAND_P;
    return match[L] / Math.max(med, RAND_P);
  };
  const peaks: Cand[] = [];
  for (let L = MIN_L; L <= maxL; L++) {
    const c = salience(L);
    if (c < minConf) continue;
    const prev = L > MIN_L ? salience(L - 1) : -1;
    const next = L < maxL ? salience(L + 1) : -1;
    if (c >= prev && c >= next) peaks.push({ L, conf: c });
  }
  // 强峰阈值（最高显著度 ×50%）内按 L 升序选择 → 真帧长（最小周期）先于其倍频峰；
  // 倍频折叠（34/51/68… 都是 17×n 同相位峰）。不强求全局 conf 排序：倍频峰的
  // 邻域基线浮点微差会让 9×17 险胜 17（60.0 vs 61.0），按 L 升序才稳定
  const maxConf = peaks.reduce((m, p) => Math.max(m, p.conf), 0);
  const strong = peaks.filter((p) => p.conf >= maxConf * 0.5).sort((a, b) => a.L - b.L);
  const sel: Cand[] = [];
  for (const p of strong) {
    if (sel.some((q) => Math.abs(q.L - p.L) < 3)) continue;
    if (sel.some((q) => p.L % q.L === 0)) continue;
    sel.push(p);
    if (sel.length >= 5) break;
  }
  return sel.sort((a, b) => a.L - b.L);
}

/** 相位对齐：取使「第 0 列最高频字节占比」最大的相位偏移（帧头固定 → 该相位下占比最高） */
export function bestPhase(s: Uint8Array, L: number): number {
  let best = 0;
  let bestScore = -1;
  for (let ph = 0; ph < L; ph++) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = ph; i < s.length; i += L) {
      hist[s[i]]++;
      n++;
    }
    if (n === 0) continue;
    let top = 0;
    for (let v = 0; v < 256; v++) if (hist[v] > top) top = hist[v];
    const sc = top / n;
    if (sc > bestScore) {
      bestScore = sc;
      best = ph;
    }
  }
  return best;
}

/** 列统计：按 (phase, L) 对齐的完整行做每列 256 桶直方 → 唯一取值数/熵/Top1 占比 */
export function columnStats(s: Uint8Array, L: number, phase: number): ColStat[] {
  const hist: Uint32Array[] = Array.from({ length: L }, () => new Uint32Array(256));
  const count = new Uint32Array(L);
  let rows = 0;
  for (let i = phase; i + L <= s.length; i += L) {
    for (let c = 0; c < L; c++) {
      hist[c][s[i + c]]++;
      count[c]++;
    }
    rows++;
  }
  const cols: ColStat[] = [];
  for (let c = 0; c < L; c++) {
    let nz = 0;
    let H = 0;
    let topC = 0;
    let topV = -1;
    const n = count[c];
    for (let v = 0; v < 256; v++) {
      const k = hist[c][v];
      if (!k) continue;
      nz++;
      const p = k / n;
      H -= p * Math.log2(p);
      if (k > topC) {
        topC = k;
        topV = v;
      }
    }
    cols.push({ unique: nz, H, top1: n ? topC / n : 0, top1Byte: topV, rows: n });
  }
  void rows;
  return cols;
}

/** 恒定段：连续 unique==1 的列段；从列 0 起始的标记为帧头候选 */
export function constantRuns(cols: ColStat[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < cols.length) {
    if (cols[i].unique === 1) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1].unique === 1) j++;
      const bytes: number[] = [];
      for (let k = i; k <= j; k++) bytes.push(cols[k].top1Byte);
      runs.push({ start: i, len: j - i + 1, bytes, headCandidate: i === 0 });
      i = j + 1;
    } else i++;
  }
  return runs;
}

export function analyze(s: Uint8Array, opts: AnalyzeOpts = {}): Analysis | null {
  if (s.length < MIN_L * MIN_ROWS) return null;
  const cands = findCandidates(s, opts.minConf ?? 5, opts.maxLen ?? MAX_L);
  if (cands.length === 0) return { cands, L: 0, phase: 0, cols: [], runs: [], rows: 0, bytes: s };
  // cands[0] = 选择序首位（显著度最高档中最小 L = 真帧长；倍频峰已折叠）
  const L = cands[0].L;
  const phase = bestPhase(s, L);
  const cols = columnStats(s, L, phase);
  return { cands, L, phase, cols, runs: constantRuns(cols), rows: Math.floor((s.length - phase) / L), bytes: s };
}

/** 一种帧型：同帧头家族的同一类型字节 + 其帧间距统计 */
export interface FrameType {
  /** 完整帧头（前缀+类型字节），如 [0x55,0x51] */
  header: number[];
  /** 出现次数 */
  count: number;
  /** 真帧长 = 到「下一个任意帧头」的距离众数（≥50% 聚集才可信） */
  frameLen: number | null;
  /** 众数占比 */
  share: number;
  /** 帧间距直方图 top3 峰 */
  peaks: { len: number; n: number }[];
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 协议簇发现（P56b）：从帧头候选 [h0..hn] 提取固定前缀（除末字节），
 * 按「前缀+类型字节」把样本流分组为帧型家族（如 55 51 / 55 52 / 55 53），
 * 每种帧型的真帧长 = 到下一个任意帧头的距离众数——
 * 解决混发多帧型时单周期自相关摊薄失效的问题（WIT 0x55 类协议核心场景）。
 */
export function discoverCluster(s: Uint8Array, headBytes: number[], maxTypes = 16): FrameType[] {
  if (headBytes.length === 0 || s.length < 64) return [];
  const prefix = headBytes.slice(0, Math.max(1, headBytes.length - 1));
  const hits: { pos: number; type: number }[] = [];
  outer: for (let i = 0; i + prefix.length < s.length; i++) {
    for (let c = 0; c < prefix.length; c++) {
      if (s[i + c] !== prefix[c]) continue outer;
    }
    hits.push({ pos: i, type: s[i + prefix.length] });
  }
  if (hits.length < 20) return [];
  const groups = new Map<number, number[]>();
  for (const h of hits) {
    const arr = groups.get(h.type);
    if (arr) arr.push(h.pos);
    else groups.set(h.type, [h.pos]);
  }
  const allPos = hits.map((h) => h.pos).sort((a, b) => a - b);
  const out: FrameType[] = [];
  for (const [type, positions] of groups) {
    if (positions.length < 10) continue;
    const hist = new Map<number, number>();
    for (const p of positions) {
      const q = lowerBound(allPos, p + 1);
      if (q >= allPos.length) break;
      const d = allPos[q] - p;
      if (d >= 2 && d <= 1024) hist.set(d, (hist.get(d) ?? 0) + 1);
    }
    const peaks = [...hist.entries()]
      .map(([len, n]) => ({ len, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
    const top = peaks[0];
    out.push({
      header: [...prefix, type],
      count: positions.length,
      frameLen: top && top.n >= positions.length * 0.5 ? top.len : null,
      share: top ? top.n / positions.length : 0,
      peaks,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, maxTypes);
}
