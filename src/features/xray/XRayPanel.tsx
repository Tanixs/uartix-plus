import { useEffect, useRef, useState } from "react";
import { onRx } from "../../ipc/binbus";
import * as templateStore from "../protocol/templateStore";
import { toast } from "../ai/extRuntime";
import { tx, useLocale } from "../../i18n/strings";
import { IconPause, IconPlay, IconTrash } from "../../shared/icons";
import {
  MIN_L,
  MIN_ROWS,
  MAX_GRID_ROWS,
  ANALYZE_WINDOWS,
  SampleRing,
  analyze,
  bestPhase,
  columnStats,
  constantRuns,
  discoverCluster,
  type Analysis,
  type FrameType,
  type Run,
} from "./xrayEngine";

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

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
const fmtKB = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

export function XRayPanel() {
  useLocale();
  const ringRef = useRef<SampleRing>(new SampleRing());
  const [sampled, setSampled] = useState(0);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [selL, setSelL] = useState<number | null>(null);
  const [cluster, setCluster] = useState<FrameType[]>([]);
  const [clusterSel, setClusterSel] = useState<boolean[]>([]);
  const applyCluster = (types: FrameType[]) => {
    setCluster(types);
    setClusterSel(types.map((t) => t.frameLen !== null));
  };
  const [minConf, setMinConf] = useState(5);
  const [maxLen, setMaxLen] = useState(256);
  const [win, setWin] = useState(64 * 1024);
  const [tip, setTip] = useState<{ x: number; y: number; c: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 面板打开期间静默累积原始 RX（回放重灌/演示源/真机全覆盖）；关闭即 unsub（生命周期红线）
  useEffect(() => {
    const un = onRx((p) => ringRef.current.push(p.bytes));
    // 样本量显示 500ms 节流（onRx 33ms 一批，没必要跟着刷）
    const t = window.setInterval(() => setSampled(ringRef.current.size), 500);
    return () => {
      un();
      window.clearInterval(t);
    };
  }, []);

  const togglePause = () =>
    setPaused((v) => {
      ringRef.current.paused = !v;
      return !v;
    });

  const clearSamples = () => {
    ringRef.current.clear();
    setSampled(0);
  };

  const run = () => {
    setBusy(true);
    // 让「分析中…」先上屏（同步计算 ~100ms 量级，批处理快照语义无进度条）
    window.setTimeout(() => {
      const s = ringRef.current.snapshot(win);
      const a = analyze(s, { minConf, maxLen });
      setResult(a && { ...a, bytes: s });
      setSelL(a && a.cands.length > 0 ? a.cands[0].L : null);
      const head = a?.runs.find((r) => r.headCandidate);
      applyCluster(head ? discoverCluster(s, head.bytes) : []);
      setBusy(false);
    }, 30);
  };

  // 选定帧长在冻结快照上重算（切候选不读实时缓冲——样本继续流入不影响已出的分析）
  const reselect = (L: number) => {
    if (!result) return;
    const s = result.bytes;
    const phase = bestPhase(s, L);
    const cols = columnStats(s, L, phase);
    const runs = constantRuns(cols);
    setResult({ ...result, L, phase, cols, runs, rows: Math.floor((s.length - phase) / L) });
    setSelL(L);
    const head = runs.find((r) => r.headCandidate);
    applyCluster(head ? discoverCluster(s, head.bytes) : []);
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

  const usableFrames = () =>
    cluster
      .filter((t, i) => t.frameLen !== null && clusterSel[i])
      .map((t) => ({ header: t.header, len: t.frameLen! }));

  const buildOneFrame = (t: FrameType) => {
    if (t.frameLen === null) return;
    templateStore.createClusterFromFrames(tx("发现协议", "Discovered"), [{ header: t.header, len: t.frameLen }]);
    toast(
      tx(
        `已创建模板 ${t.header.map(hex2).join(" ")}（帧长 ${t.frameLen}B，sum8 校验为占位），可在帧画布继续调整`,
        `Template ${t.header.map(hex2).join(" ")} created (length ${t.frameLen}B, sum8 placeholder); refine in Frame Canvas`,
      ),
    );
  };

  const buildClusterTpl = () => {
    const frames = usableFrames();
    if (!frames.length) return;
    templateStore.createClusterFromFrames(tx("发现协议簇", "Discovered cluster"), frames);
    toast(
      tx(
        `已按簇创建 ${frames.length} 条帧型模板（帧头+定长+sum8 占位校验，默认停用），可在协议模板/帧画布逐条调整`,
        `Cluster with ${frames.length} frame templates created (header + fixed length + sum8 placeholder, disabled by default); refine in Templates / Frame Canvas`,
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
    const s = result.bytes;
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
        <button
          className={`btn sm${paused ? " warn" : ""}`}
          onClick={togglePause}
          title={paused ? tx("继续累积样本", "Resume sampling") : tx("暂停累积（新数据到达但不写入样本环）", "Pause sampling (incoming data ignored)")
          }
        >
          {paused ? <IconPlay /> : <IconPause />}
          {paused ? tx("继续", "Resume") : tx("暂停", "Pause")}
        </button>
        <button
          className="btn sm"
          onClick={clearSamples}
          disabled={sampled === 0}
          title={tx("清空样本环（不影响已冻结的分析快照）", "Clear the sample ring (frozen analysis snapshot unaffected)")}
        >
          <IconTrash />
          {tx("清空", "Clear")}
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
      <div className="xray-params">
        <label className="xray-param">
          {tx("显著度 ≥", "Salience ≥")}
          <select className="input" value={minConf} onChange={(e) => setMinConf(Number(e.target.value))}>
            {[3, 5, 8, 12].map((v) => (
              <option key={v} value={v}>{v}×</option>
            ))}
          </select>
        </label>
        <label className="xray-param">
          {tx("帧长上限", "Max length")}
          <select className="input" value={maxLen} onChange={(e) => setMaxLen(Number(e.target.value))}>
            {[64, 128, 256].map((v) => (
              <option key={v} value={v}>{v}B</option>
            ))}
          </select>
        </label>
        <label className="xray-param">
          {tx("分析窗口", "Window")}
          <select className="input" value={win} onChange={(e) => setWin(Number(e.target.value))}>
            {ANALYZE_WINDOWS.map((v) => (
              <option key={v} value={v}>{fmtKB(v)}</option>
            ))}
          </select>
        </label>
        <span className="xray-hint">{tx("参数在下次「采样分析」时生效", "Parameters apply on the next analysis")}</span>
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
                  <button
                    className="btn sm"
                    onClick={() => applyCluster(discoverCluster(result.bytes, r.bytes))}
                    title={tx("以此段为帧头做协议簇发现（若列 0 帧头不是真帧头，可手动指定如 55 51 的段）", "Run cluster discovery with this run as the header seed (e.g. pick 55 51 when column 0 is not the real header)")}
                  >
                    {tx("簇分析", "Cluster")}
                  </button>
                  {r.headCandidate && (
                    <button className="btn sm" onClick={() => buildTemplate(r)}>
                      {tx("以此建模板", "Create template")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {cluster.length > 0 && (
            <div className="xray-runs">
              <div className="xray-runs-head">
                {tx(
                  "协议簇发现（帧头家族按帧间距分组）— 每种帧型的真帧长：",
                  "Detected frame types (header family grouped by inter-frame distance):",
                )}
              </div>
              {cluster.map((t, i) => (
                <div key={i} className={`xray-run${t.frameLen !== null ? " head" : ""}`}>
                  <input
                    type="checkbox"
                    className="xray-ft-chk"
                    checked={clusterSel[i] ?? false}
                    disabled={t.frameLen === null}
                    onChange={(e) =>
                      setClusterSel((prev) => prev.map((v, k) => (k === i ? e.target.checked : v)))
                    }
                    title={tx("勾选后可批量按簇建模板", "Tick to include in cluster creation")}
                  />
                  <span className="xray-run-bytes">{t.header.map(hex2).join(" ")}</span>
                  <span className="xray-run-meta">
                    {tx(`${t.count} 帧`, `${t.count} frames`)} ·{" "}
                    {t.frameLen !== null
                      ? tx(`帧长 ${t.frameLen}B（${Math.round(t.share * 100)}% 聚集）`, `length ${t.frameLen}B (${Math.round(t.share * 100)}% tight)`)
                      : tx("帧间距不集中（不定长帧？）", "spacing uneven (variable length?)")}
                  </span>
                  {t.frameLen !== null && (
                    <button className="btn sm" onClick={() => buildOneFrame(t)}>
                      {tx("建此模板", "Create")}
                    </button>
                  )}
                </div>
              ))}
              {usableFrames().length > 0 && (
                <div className="xray-run head">
                  <span className="xray-run-meta">
                    {tx(`已勾选 ${usableFrames().length} 种帧型`, `${usableFrames().length} frame types selected`)}
                  </span>
                  <button className="btn sm primary" onClick={buildClusterTpl}>
                    {tx("按勾选建模板", "Create selected")}
                  </button>
                </div>
              )}
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
