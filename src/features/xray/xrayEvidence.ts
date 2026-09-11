/**
 * 证据链构建（P63d）——「协议考古学家」AI 增强层之三。
 *
 * 铁律：所有数值结论由确定性引擎产出（xrayEngine / xrayCrack / xraySequence），
 * 本模块只做「摘要 + 编号」；模型拿证据链 JSON 写推理报告，
 * 引用证据编号发言，禁止对原始字节自行计算（LLM 手算校验不可靠）。
 */
import type { Analysis, FrameType } from "./xrayEngine";
import { crackChecksum, describeHit } from "./xrayCrack";
import { analyzeSequence } from "./xraySequence";

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

export interface EvidenceItem {
  /** 证据编号（E1、E2…），要求模型在报告里逐条引用 */
  id: string;
  text: string;
}

export interface XrayEvidence {
  evidence: EvidenceItem[];
  meta: {
    frameLen: number;
    phase: number;
    rows: number;
    windowBytes: number;
    crackRows: number;
    crackCombos: number;
    crackTruncated: boolean;
  };
}

export function buildEvidence(a: Analysis, cluster: FrameType[]): XrayEvidence {
  const texts: string[] = [];

  // 帧长候选（显著度降序，最多 5）
  if (a.cands.length > 0) {
    texts.push(
      `帧长候选（自相关显著度）: ${a.cands.slice(0, 5).map((c) => `${c.L}B（${c.conf.toFixed(1)}×）`).join("、")}`,
    );
  } else {
    texts.push("帧长候选: 无显著周期峰");
  }
  texts.push(`当前选定帧长 ${a.L}B、相位 ${a.phase}，冻结快照 ${a.bytes.length}B 可切 ${a.rows} 行`);

  // 帧头候选（列 0 起始恒定段）
  const heads = a.runs.filter((r) => r.headCandidate).slice(0, 3);
  if (heads.length > 0) {
    texts.push(`帧头候选: ${heads.map((r) => `${r.bytes.map(hex2).join(" ")}（列 ${r.start}~${r.start + r.len - 1}）`).join("、")}`);
  }

  // 高熵列（数据域特征，压缩为区间）
  const hi = a.cols.map((c, i) => (c.H > 6 ? i : -1)).filter((i) => i >= 0);
  if (hi.length > 0) {
    const spans: string[] = [];
    let s = hi[0];
    let prev = hi[0];
    for (let k = 1; k <= hi.length; k++) {
      if (hi[k] !== prev + 1) {
        spans.push(s === prev ? `${s}` : `${s}~${prev}`);
        s = hi[k] ?? -1;
      }
      prev = hi[k] ?? prev;
    }
    texts.push(`高熵数据域列: ${spans.join("、")}（熵 >6bit，接近随机=加密/压缩/浮点）`);
  }

  // 协议簇（≤6 种帧型）
  for (const t of cluster.slice(0, 6)) {
    texts.push(
      `帧型 ${t.header.map(hex2).join(" ")}: ${t.count} 帧` +
        (t.frameLen !== null ? `，帧长 ${t.frameLen}B（${Math.round(t.share * 100)}% 聚集）` : "，帧间距不集中"),
    );
  }

  // 校验爆破（实锤优先，合计 ≤6 条）
  const cr = crackChecksum(a.bytes, a.L, a.phase);
  const solid = cr.hits.filter((h) => h.verdict === "solid");
  const likely = cr.hits.filter((h) => h.verdict === "likely");
  for (const h of solid.slice(0, 4)) {
    texts.push(`校验爆破实锤: ${describeHit(h, a.L)}，${cr.rows} 行全部通过`);
  }
  for (const h of likely.slice(0, 2)) {
    texts.push(`校验爆破疑似: ${describeHit(h, a.L)}，通过率 ${(h.passRate * 100).toFixed(1)}%`);
  }
  if (cr.hits.length === 0) {
    texts.push("校验爆破: 无命中（帧长可能不准，或存在变长帧/帧尾符）");
  }

  // 序列（周期/事件帧 + 循环节）
  const seq = analyzeSequence(a.bytes, a.L, a.phase, cluster.map((t) => t.header));
  for (const s of seq.syms.slice(0, 8)) {
    texts.push(
      `序列·${s.kind === "periodic" ? "周期帧" : "事件帧"} ${s.sym}: ${s.count} 帧，间距 ~${s.spacingMed}B，CV ${s.spacingCV.toFixed(2)}`,
    );
  }
  if (seq.cycle) {
    texts.push(
      `轮询循环: ${seq.cycle.pattern.join(" → ")}（循环节 ${seq.cycle.period} 帧，匹配 ${(seq.cycle.matchRatio * 100).toFixed(0)}%）`,
    );
  }

  return {
    evidence: texts.map((text, i) => ({ id: `E${i + 1}`, text })),
    meta: {
      frameLen: a.L,
      phase: a.phase,
      rows: a.rows,
      windowBytes: a.bytes.length,
      crackRows: cr.rows,
      crackCombos: cr.combos,
      crackTruncated: cr.truncated,
    },
  };
}
