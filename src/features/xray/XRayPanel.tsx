import { useEffect, useRef, useState } from "react";
import { onRx } from "../../ipc/binbus";
import * as templateStore from "../protocol/templateStore";
import { toast } from "../ai/extRuntime";
import { tx, useLocale } from "../../i18n/strings";

/**
 * 结构发现 X-Ray（HANDOFF 十三待办 / P47）——面向「未知协议考古」的独立分析面板。
 *
 * 与 HexView 分离的理由（评审决议）：span 字段色（已解析世界）与熵条色（未解析世界）
 * 语义互斥；HexView 是流式跟随，本面板是批处理快照分析，交互节奏天然不同。
 *
 * 工作流：面板打开期间静默累积原始 RX（64KB 环形，回放/演示/真机全覆盖——
 * ingest 单点 tap 决定一切帧源都进 onRx）→ 点「采样分析」→ 周期检测给帧长候选 →
 * 按候选 L 相位对齐做列熵 → 恒定列（帧头候选）高亮 → 一键建模板预填 header，
 * 接上「先定帧边界、再拖字段」的既有协议定义流程。
 * 不定长/ASCII 协议无周期峰值 → 明确提示不适用。
 */

const SAMPLE_CAP = 64 * 1024; // 样本环上限
const MIN_L = 4;
const MAX_L = 256;
const MIN_ROWS = 8; // 每列至少 8 帧样本，统计才可信（低于则置信度打折）
const MAX_GRID_ROWS = 24; // 网格最多显示 24 行（防 canvas 过大）
const RAND_P = 1 / 256; // 随机数据匹配基线

interface Cand {
  L: number;
  /** 峰显著度：match(L) ÷ 邻域中位数（×倍数；≥5 视为显著峰） */
  conf: number;
}

interface ColStat {
  unique: number;
  H: number;
  top1: number;
  top1Byte: number;
  rows: number;
}

interface Run {
  /** 相位对齐后的列偏移 */
  start: number;
  len: number;
  bytes: number[];
  /** 是否从列 0 开始（真正的帧头候选） */
  headCandidate: boolean;
}

interface Analysis {
  cands: Cand[];
  L: number;
  phase: number;
  cols: ColStat[];
  runs: Run[];
  rows: number;
}

/**
 * 周期检测：对每个候选 L 算「相距 L 字节相等率」match(L)，取局部峰 top5（相邻 L<3 去重）。
 * 显著度 = match(L) ÷ 邻域中位数（±8 内、排除 ±2 峰坡）——不用绝对匹配率：
 * 帧头占帧比例低时（如 4/17）绝对 match 天然只有 ~24%，但对随机基线（~0.4%）
 * 是 60 倍强信号；显著度倍数才能正确区分「帧长峰」与「数据伪相关」。
 */
function findCandidates(s: Uint8Array): Cand[] {
  const N = s.length;
  const maxL = Math.min(MAX_L, Math.floor(N / MIN_ROWS));
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
    if (c < 5) continue;
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
function bestPhase(s: Uint8Array, L: number): number {
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
function columnStats(s: Uint8Array, L: number, phase: number): ColStat[] {
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
function constantRuns(cols: ColStat[]): Run[] {
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

function analyze(s: Uint8Array): Analysis | null {
  if (s.length < MIN_L * MIN_ROWS) return null;
  const cands = findCandidates(s);
  if (cands.length === 0) return { cands, L: 0, phase: 0, cols: [], runs: [], rows: 0 };
  // cands[0] = 选择序首位（显著度最高档中最小 L = 真帧长；倍频峰已折叠）
  const L = cands[0].L;
  const phase = bestPhase(s, L);
  const cols = columnStats(s, L, phase);
  return { cands, L, phase, cols, runs: constantRuns(cols), rows: Math.floor((s.length - phase) / L) };
}

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
const fmtKB = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

export function XRayPanel() {
  useLocale();
  const bufRef = useRef<Uint8Array>(new Uint8Array(SAMPLE_CAP));
  const lenRef = useRef(0);
  const [sampled, setSampled] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [selL, setSelL] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; c: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 面板打开期间静默累积原始 RX（回放重灌/演示源/真机全覆盖）；关闭即 unsub（生命周期红线）
  useEffect(() => {
    const un = onRx((p) => {
      if (p.bytes.length === 0) return;
      const buf = bufRef.current;
      let len = lenRef.current;
      for (let i = 0; i < p.bytes.length; i++) {
        if (len >= SAMPLE_CAP) {
          buf.copyWithin(0, p.bytes.length);
          len = SAMPLE_CAP - p.bytes.length;
        }
        buf[len++] = p.bytes[i];
      }
      lenRef.current = len;
    });
    // 样本量显示 500ms 节流（onRx 33ms 一批，没必要跟着刷）
    const t = window.setInterval(() => setSampled(lenRef.current), 500);
    return () => {
      un();
      window.clearInterval(t);
    };
  }, []);

  const run = () => {
    setBusy(true);
    // 让「分析中…」先上屏（同步计算 ~100ms 量级，批处理快照语义无进度条）
    window.setTimeout(() => {
      const s = bufRef.current.subarray(0, lenRef.current);
      const a = analyze(new Uint8Array(s));
      setResult(a);
      setSelL(a && a.cands.length > 0 ? a.cands[0].L : null);
      setBusy(false);
    }, 30);
  };

  // 选定帧长重算（切候选不需要重新采样，样本未变）
  const reselect = (L: number) => {
    if (!result) return;
    const s = new Uint8Array(bufRef.current.subarray(0, lenRef.current));
    const phase = bestPhase(s, L);
    const cols = columnStats(s, L, phase);
    setResult({ ...result, L, phase, cols, runs: constantRuns(cols), rows: Math.floor((s.length - phase) / L) });
    setSelL(L);
  };

  const buildTemplate = (r: Run) => {
    templateStore.addTemplate(r.bytes);
    toast(
      tx(
        `已创建模板并预填帧头 ${r.bytes.map(hex2).join(" ")}（帧长建议 ${result?.L ?? "?"}），可在协议模板/帧画布继续调整`,
        `Template created with header ${r.bytes.map(hex2).join(" ")} (suggested length ${result?.L ?? "?"}); refine it in Templates / Frame Canvas`,
      ),
    );
  };

  // 网格绘制：hex + 列头 + 每列底边熵条（恒定=强调 / 低熵=中性 / 高熵=暖红 / 淡=样本不足）
  const cellW = 34;
  const cellH = 20;
  const headH = 14;
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap || !result || result.L === 0) return;
    const L = result.L;
    const rows = Math.min(MAX_GRID_ROWS, result.rows);
    const W = L * cellW;
    const H = headH + rows * cellH;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const dark = document.documentElement.dataset.theme === "dark";
    const fg = dark ? "#c8cfda" : "#2c313a";
    const dim = dark ? "#5b6371" : "#9aa2ad";
    const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4a90d9";
    ctx.textAlign = "center";
    ctx.font = '11px "Cascadia Mono", Consolas, monospace';
    // 列头：列号（恒定列用强调色标记）
    for (let c = 0; c < L; c++) {
      const st = result.cols[c];
      const isConst = st.unique === 1;
      ctx.fillStyle = isConst ? acc : dim;
      ctx.fillText(String(c % 10), c * cellW + cellW / 2, headH - 3);
    }
    const s = new Uint8Array(bufRef.current.subarray(0, lenRef.current));
    for (let r = 0; r < rows; r++) {
      const yTop = headH + r * cellH;
      // 隔行底色
      if (r % 2 === 1) {
        ctx.fillStyle = dark ? "#282e38" : "#f6f7f9";
        ctx.fillRect(0, yTop, W, cellH);
      }
      for (let c = 0; c < L; c++) {
        const idx = result.phase + r * L + c;
        if (idx >= s.length) break;
        const cx = c * cellW + cellW / 2;
        const st = result.cols[c];
        const isConst = st.unique === 1;
        // 恒定列：强调色底 + 字节值加粗显示
        if (isConst) {
          ctx.fillStyle = dark ? "rgba(74,144,217,.16)" : "rgba(74,144,217,.12)";
          ctx.fillRect(c * cellW, yTop, cellW, cellH);
          ctx.fillStyle = acc;
        } else {
          ctx.fillStyle = fg;
        }
        ctx.fillText(hex2(s[idx]), cx, yTop + cellH / 2 + 3);
        // 底边熵条
        const trusted = st.rows >= MIN_ROWS;
        const a = trusted ? 0.9 : 0.35;
        ctx.fillStyle = isConst
          ? withAlpha(acc, a)
          : st.H <= 2 || st.top1 >= 0.95
            ? withAlpha(fg, a * 0.45)
            : st.H > 6
              ? withAlpha("#e0694e", a)
              : withAlpha("#e0a54e", a * 0.8);
        ctx.fillRect(c * cellW + 8, yTop + cellH - 3.5, cellW - 16, 2.5);
      }
    }
    // 网格线（列分隔，弱化）
    ctx.strokeStyle = dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.06)";
    ctx.beginPath();
    for (let c = 1; c < L; c++) {
      ctx.moveTo(c * cellW + 0.5, headH);
      ctx.lineTo(c * cellW + 0.5, headH + rows * cellH);
    }
    ctx.stroke();
  }, [result, sampled]);

  // hover tooltip：列统计
  const onMove = (e: React.MouseEvent) => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap || !result || result.L === 0) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < headH) return;
    const c = Math.floor(x / cellW);
    if (c < 0 || c >= result.L) return;
    const wr = wrap.getBoundingClientRect();
    setTip({ x: e.clientX - wr.left, y: e.clientY - wr.top, c });
  };

  const tipSt = tip && result && result.L > 0 ? result.cols[tip.c] : null;
  const lowSamples = sampled < MIN_L * MIN_ROWS;
  const noPeriod = result !== null && result.cands.length === 0;

  return (
    <div className="xray">
      <div className="xray-bar">
        <span className="xray-sample" title={tx("面板打开期间累积的原始 RX 样本（64KB 环形，新样本挤掉旧样本）", "Raw RX samples accumulated while the panel is open (64KB ring, newest replaces oldest)")}>
          {tx("样本", "Samples")} <b>{fmtKB(sampled)}</b>
        </span>
        <button className={`btn sm${busy ? "" : " primary"}`} onClick={run} disabled={busy || lowSamples}>
          {busy ? tx("分析中…", "Analyzing…") : tx("采样分析", "Analyze")}
        </button>
        {result && result.cands.length > 0 && (
          <select
            className="input xray-lsel"
            value={selL ?? result.cands[0].L}
            onChange={(e) => reselect(Number(e.target.value))}
            title={tx("疑似帧长候选（按峰显著度排序）", "Suspected frame-length candidates (ranked by peak salience)")}
          >
            {result.cands.map((c) => (
              <option key={c.L} value={c.L}>
                {tx(`帧长 ${c.L} · 显著度 ${c.conf.toFixed(1)}×`, `Length ${c.L} · salience ${c.conf.toFixed(1)}×`)}
              </option>
            ))}
          </select>
        )}
        <span className="xray-hint">
          {tx(
            "蓝=恒定（帧头候选）· 灰=低熵 · 红/橙=数据域 · 需设备连续发送同构帧",
            "Blue=constant (header candidates) · gray=low entropy · red/orange=data · device must send frames continuously",
          )}
        </span>
      </div>
      {sampled === 0 ? (
        <div className="xray-empty">
          {tx(
            "等待数据：连接设备、开演示源或回放会话，本面板打开期间会自动累积原始字节样本。",
            "Waiting for data: connect a device, start the demo source or replay a session — raw bytes accumulate while this panel is open.",
          )}
        </div>
      ) : lowSamples ? (
        <div className="xray-empty">
          {tx(
            `样本不足（至少 ${MIN_L * MIN_ROWS} 字节）：继续接收数据后点「采样分析」。`,
            `Not enough samples (at least ${MIN_L * MIN_ROWS} bytes): keep receiving, then click “Analyze”.`,
          )}
        </div>
      ) : busy ? (
        <div className="xray-empty">{tx("分析中…", "Analyzing…")}</div>
      ) : noPeriod ? (
        <div className="xray-empty">
          {tx(
            "未检测到显著重复周期：设备可能是不定长/ASCII 协议，或帧间存在空闲间隙。本功能不适用。",
            "No significant repetition period detected: the device may use variable-length/ASCII frames, or has inter-frame gaps. This tool does not apply.",
          )}
        </div>
      ) : result && result.L > 0 ? (
        <>
          <div className="xray-gridwrap" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
            <canvas ref={canvasRef} className="xray-canvas" />
            {tip && tipSt && (
              <div className="xray-tip" style={{ left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 300) - 190), top: Math.min(tip.y + 14, (wrapRef.current?.clientHeight ?? 200) - 70) }}>
                <div>{tx(`列 ${tip.c} · 样本 ${tipSt.rows} 帧`, `Column ${tip.c} · ${tipSt.rows} frames`)}</div>
                <div>
                  {tx(
                    `${tipSt.unique} 种取值 · 熵 ${tipSt.H.toFixed(2)} bit`,
                    `${tipSt.unique} distinct values · entropy ${tipSt.H.toFixed(2)} bit`,
                  )}
                </div>
                {tipSt.top1Byte >= 0 && (
                  <div>
                    {tx(
                      `高频 0x${hex2(tipSt.top1Byte)}（${(tipSt.top1 * 100).toFixed(0)}%）`,
                      `top 0x${hex2(tipSt.top1Byte)} (${(tipSt.top1 * 100).toFixed(0)}%)`,
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {result.runs.length > 0 && (
            <div className="xray-runs">
              <div className="xray-runs-head">
                {tx(
                  "恒定字节段（连续不变列）— 从列 0 起始的段即帧头候选，可直接建模板：",
                  "Constant byte runs (consecutive fixed columns) — a run starting at column 0 is a header candidate:",
                )}
              </div>
              {result.runs.map((r, i) => (
                <div key={i} className={`xray-run${r.headCandidate ? " head" : ""}`}>
                  <span className="xray-run-bytes">{r.bytes.map(hex2).join(" ")}</span>
                  <span className="xray-run-meta">
                    {r.headCandidate
                      ? tx(`帧头候选 · 列 ${r.start}~${r.start + r.len - 1}`, `header candidate · cols ${r.start}~${r.start + r.len - 1}`)
                      : tx(`恒定段 · 列 ${r.start}~${r.start + r.len - 1}（非帧头起始）`, `constant run · cols ${r.start}~${r.start + r.len - 1} (not at frame start)`)}
                  </span>
                  {r.headCandidate && (
                    <button className="btn sm" onClick={() => buildTemplate(r)}>
                      {tx("以此建模板", "Create template")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {result.rows > MAX_GRID_ROWS && (
            <div className="xray-more">
              {tx(`网格显示前 ${MAX_GRID_ROWS} 行（统计基于全部 ${result.rows} 行）`, `Grid shows first ${MAX_GRID_ROWS} rows (stats use all ${result.rows})`)}
            </div>
          )}
        </>
      ) : (
        <div className="xray-empty">{tx("点击「采样分析」开始", "Click “Analyze” to start")}</div>
      )}
    </div>
  );
}

/** #RRGGBB → rgba(r,g,b,a)（无法用全局 hexA：本面板独立绘制体系） */
function withAlpha(hex: string, a: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
