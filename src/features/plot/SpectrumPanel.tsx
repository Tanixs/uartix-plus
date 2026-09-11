/**
 * 频谱分析面板（P65b）——FFT 频谱 + 直方图双模式。
 *
 * 数据源：复用 plotStore 的通道与 ChanData（零重复建设）；plotStore 的
 * onFrames 门控含 spectrum（见 plotStore.init），只开本面板也有数据入库。
 *
 * 性能红线：
 *  - 重算节流 800ms + 数据签名变化才算（末时间戳+点数），FFT N≤32768 为
 *    O(N logN)，稳态 CPU 占用可忽略；
 *  - 面板不可见（后台 tab / dock 非前台）跳过重算；关闭即停（panelActivity）；
 *  - uPlot 游标全关（CSS zoom 下原生游标错位——P23 教训），主峰数值走摘要行。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import uPlot from "uplot";
import {
  getSnapshot as getPlotSnapshot,
  getChanData,
  subscribe as subscribePlot,
  isDirty as plotDirty,
  type Channel,
} from "./plotStore";
import {
  amplitudeSpectrum,
  histogram,
  topPeaks,
  type Peak,
} from "./spectrum";
import { tx, useLocale } from "../../i18n/strings";

const HIST_BINS = 40;
const HIST_TAKE = 4096; // 直方图统计最近 N 个值（有界）
const REFRESH_MS = 800;
const DB_FLOOR = -140; // dB 视图下限（噪声底以下截断）

interface ViewPrefs {
  mode: "fft" | "hist";
  chanId: string;
  points: number;
  window: "hann" | "rect";
  yDb: boolean;
  paused: boolean;
}

const PREFS_KEY = "vs.spectrumSettings";

function loadPrefs(): ViewPrefs {
  const def: ViewPrefs = { mode: "fft", chanId: "", points: 4096, window: "hann", yDb: false, paused: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      mode: p.mode === "hist" ? "hist" : "fft",
      chanId: typeof p.chanId === "string" ? p.chanId : "",
      points: [1024, 2048, 4096, 8192, 16384, 32768].includes(Number(p.points))
        ? Number(p.points)
        : 4096,
      window: p.window === "rect" ? "rect" : "hann",
      yDb: p.yDb === true,
      paused: p.paused === true,
    };
  } catch {
    return def;
  }
}

interface FftSummary {
  kind: "fft";
  fs: number;
  n: number;
  binHz: number;
  peaks: Peak[];
}
interface HistSummary {
  kind: "hist";
  mean: number;
  std: number;
  min: number;
  max: number;
  n: number;
}
type Summary = FftSummary | HistSummary | null;

const fmtHz = (f: number): string =>
  f >= 1000 ? `${(f / 1000).toFixed(2)}kHz` : `${f.toFixed(f < 10 ? 2 : 1)}Hz`;
const fmtNum = (x: number): string => {
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 1e5 || a < 1e-3) return x.toExponential(2);
  return a >= 100 ? x.toFixed(1) : x.toFixed(3);
};

export function SpectrumPanel() {
  // 语言切换订阅：本面板画布无数值以外的文本，DOM 文案随重渲染即时更新
  useLocale();
  const plot = useSyncExternalStore(subscribePlot, getPlotSnapshot);
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);
  const [summary, setSummary] = useState<Summary>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const uRef = useRef<uPlot | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const patch = (p: Partial<ViewPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* 存储不可用仅内存生效 */
      }
      return next;
    });
  };

  // 主题切换 → 重建图表取新配色（与 Plot2D 同法）
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // 通道下拉数据：可见通道优先；当前选择失效时回退第一个可见通道
  const visChans = plot.channels.filter((c) => c.visible);
  const chanList = visChans.length > 0 ? visChans : plot.channels;
  const chan: Channel | null =
    chanList.find((c) => c.id === prefs.chanId) ?? chanList[0] ?? null;
  const chanId = chan?.id ?? "";

  /* ---------------- 数据 → uPlot + 摘要 ---------------- */

  const sigRef = useRef(""); // 数据签名：末时间戳+点数，变了才重算
  const compute = () => {
    const u = uRef.current;
    if (!u || !chan) return;
    const d = getChanData(chan.id);
    const p = prefsRef.current;
    if (d.t.length < 8) {
      setInsufficient(true);
      return;
    }
    setInsufficient(false);
    if (p.mode === "fft") {
      const sp = amplitudeSpectrum(d.t, d.v, { points: p.points, window: p.window });
      if (!sp) return;
      const mags = p.yDb
        ? Array.from(sp.mags, (m) => Math.max(DB_FLOOR, 20 * Math.log10(Math.max(m, 1e-9))))
        : Array.from(sp.mags);
      // true = 重置缩放：频谱固定全频段展示（不支持框选缩放，无状态可保）
      u.setData([Array.from(sp.freqs), mags], true);
      const peaks = topPeaks(sp.freqs, sp.mags, 3, Math.max(sp.binHz * 2, 0.5));
      setSummary({ kind: "fft", fs: sp.fs, n: sp.n, binHz: sp.binHz, peaks });
    } else {
      const vs = d.v.length > HIST_TAKE ? d.v.slice(d.v.length - HIST_TAKE) : d.v.slice();
      const h = histogram(vs, HIST_BINS);
      if (!h) return;
      const centers = h.edges.slice(0, -1).map((e, i) => (e + h.edges[i + 1]) / 2);
      u.setData([centers, h.counts], true);
      setSummary({ kind: "hist", mean: h.mean, std: h.std, min: h.min, max: h.max, n: h.n });
    }
  };
  const computeRef = useRef(compute);
  computeRef.current = compute;

  /* ---------------- uPlot 生命周期（结构变化才重建） ---------------- */

  useEffect(() => {
    const wrap = wrapRef.current;
    const chart = chartRef.current;
    if (!wrap || !chart) return;
    if (uRef.current) {
      uRef.current.destroy();
      uRef.current = null;
    }
    const cs = getComputedStyle(document.documentElement);
    const axisColor = cs.getPropertyValue("--text-dim").trim() || "#8b93a1";
    const gridColor = cs.getPropertyValue("--border-soft").trim() || "#1d2229";
    const accent = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    const isHist = prefsRef.current.mode === "hist";

    const opts: uPlot.Options = {
      width: Math.max(wrap.clientWidth, 80),
      height: Math.max(wrap.clientHeight, 60),
      // 游标全关：CSS zoom 下 uPlot 原生游标错位（P23 教训）；主峰数值走摘要行
      cursor: { x: false, y: false, drag: { x: false, y: false, setScale: false } },
      series: [
        {},
        isHist
          ? {
              // 直方图：阶梯轮廓 + 半透明填充（40 bins 下与柱状观感等同）
              stroke: accent,
              fill: `${accent}33`,
              width: 2,
              paths: uPlot.paths?.stepped?.({ align: 1 }),
              points: { show: false },
            }
          : {
              stroke: accent,
              width: 1.5,
              points: { show: false },
            },
      ],
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1 },
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1 },
        },
      ],
      legend: { show: false },
    };
    const u = new uPlot(opts, [[], []], chart);
    uRef.current = u;
    computeRef.current();

    const ro = new ResizeObserver(() => {
      u.setSize({
        width: Math.max(wrap.clientWidth, 80),
        height: Math.max(wrap.clientHeight, 60),
      });
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
    // 重建条件：模式切换（series 结构不同）、主题变化；yDb 只改数据走重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, themeTick]);

  /* ---------------- 重算触发 ---------------- */

  // 参数/通道变化 → 立即重算
  useEffect(() => {
    sigRef.current = ""; // 强制重算
    computeRef.current();
  }, [chanId, prefs.points, prefs.window, prefs.mode, prefs.yDb]);

  // 周期重算：可见 + 未暂停 + 数据签名变化（800ms 节流，性能红线）
  useEffect(() => {
    const timer = setInterval(() => {
      const wrap = wrapRef.current;
      if (!wrap || wrap.clientWidth === 0 || document.hidden) return;
      if (prefsRef.current.paused) return;
      if (!chanId) return;
      const d = getChanData(chanId);
      const sig = `${d.t.length}|${d.t.length ? d.t[d.t.length - 1] : 0}`;
      if (sig === sigRef.current && !plotDirty()) return;
      sigRef.current = sig;
      // dirty 属于整个 plot 管线，只读不消费（2D 面板的 tick 依赖它）
      computeRef.current();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chanId]);

  const axisLabel =
    prefs.mode === "fft"
      ? prefs.yDb
        ? tx("幅值 (dB)", "Amplitude (dB)")
        : tx("幅值", "Amplitude")
      : tx("计数", "Count");
  const axisName =
    prefs.mode === "fft" ? tx("频率 (Hz)", "Frequency (Hz)") : tx("值", "Value");

  return (
    <div className="plot spectrum">
      <div className="plot-bar">
        <button
          className={`icon-btn ${prefs.mode === "fft" ? "primary" : ""}`}
          onClick={() => patch({ mode: "fft" })}
          title={tx("FFT 频谱：看频率成分与主峰", "FFT spectrum: view frequency components and dominant peaks")}
        >
          {tx("频谱", "Spectrum")}
        </button>
        <button
          className={`icon-btn ${prefs.mode === "hist" ? "primary" : ""}`}
          onClick={() => patch({ mode: "hist" })}
          title={tx("直方图：看数据分布与离散度", "Histogram: view data distribution and dispersion")}
        >
          {tx("直方图", "Histogram")}
        </button>
        <select
          className="input"
          value={chanId}
          onChange={(e) => patch({ chanId: e.target.value })}
          disabled={chanList.length === 0}
          title={tx("选择分析通道（2D 曲线点亮的字段）", "Channel to analyze (fields lit up in the 2D plot)")}
        >
          {chanList.length === 0 && <option value="">{tx("无通道", "No channels")}</option>}
          {chanList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {prefs.mode === "fft" && (
          <>
            <select
              className="input"
              value={prefs.points}
              onChange={(e) => patch({ points: Number(e.target.value) })}
              title={tx("FFT 点数：越大频率分辨率越高（分析时间越长）", "FFT points: more points give finer frequency resolution (longer analysis window)")}
            >
              {[1024, 2048, 4096, 8192, 16384, 32768].map((n) => (
                <option key={n} value={n}>
                  {n} {tx("点", "pts")}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={prefs.window}
              onChange={(e) => patch({ window: e.target.value as "hann" | "rect" })}
              title={tx("窗函数：Hann 抑制泄漏（推荐）；矩形频率分辨率最高但有旁瓣", "Window: Hann suppresses leakage (recommended); rectangle has the finest frequency resolution but sidelobes")}
            >
              <option value="hann">{tx("Hann 窗", "Hann")}</option>
              <option value="rect">{tx("矩形窗", "Rectangle")}</option>
            </select>
            <button
              className={`icon-btn ${prefs.yDb ? "primary" : ""}`}
              onClick={() => patch({ yDb: !prefs.yDb })}
              title={tx("Y 轴单位：线性幅值 / dB（看噪声底用 dB）", "Y unit: linear amplitude / dB (use dB to inspect the noise floor)")}
            >
              {prefs.yDb ? "dB" : tx("线性", "Linear")}
            </button>
          </>
        )}
        <div className="plot-bar-spacer" />
        <button
          className={`icon-btn ${prefs.paused ? "primary" : ""}`}
          onClick={() => patch({ paused: !prefs.paused })}
          title={prefs.paused
            ? tx("已冻结：点此恢复实时刷新", "Frozen: click to resume live refresh")
            : tx("暂停刷新：冻结当前谱面便于观察", "Pause refresh: freeze the current spectrum for inspection")}
        >
          {prefs.paused ? tx("▶ 继续", "▶ Resume") : tx("⏸ 冻结", "⏸ Freeze")}
        </button>
      </div>
      <div className="plot-wrap">
        <div ref={chartRef} className="plot-chart" />
        {(chanList.length === 0 || insufficient) && (
          <div className="plot-empty">
            {chanList.length === 0 ? (
              <>
                {tx("先在 2D 曲线面板点亮字段图例的眼睛添加通道", "Toggle the eye icons in the 2D plot's field legend to add channels")}
                <br />
                {tx("本面板与 2D 曲线共享通道数据", "This panel shares channel data with the 2D plot")}
              </>
            ) : (
              <>{tx("该通道数据少于 8 个点，连接设备或启动演示源积累数据后再看", "Fewer than 8 points on this channel; connect a device or start the demo source to collect data")}</>
            )}
          </div>
        )}
      </div>
      <div className="spectrum-summary" role="status">
        {prefs.paused && <span className="ss-flag">{tx("已冻结", "Frozen")}</span>}
        {summary?.kind === "fft" && (
          <span>
            fs {fmtHz(summary.fs)} · N {summary.n} · {tx("分辨率", "res")} {summary.binHz.toFixed(2)}Hz
            {summary.peaks.length > 0 && (
              <>
                {tx(" ｜ 主峰 ", " | peaks ")}
                {summary.peaks
                  .map((p, i) => `${i + 1}) ${fmtHz(p.freq)}=${fmtNum(p.mag)}`)
                  .join("  ")}
              </>
            )}
          </span>
        )}
        {summary?.kind === "hist" && (
          <span>
            {tx("均值", "Mean")} {fmtNum(summary.mean)} · σ {fmtNum(summary.std)} · {tx("最小", "Min")} {fmtNum(summary.min)} · {tx("最大", "Max")}{" "}
            {fmtNum(summary.max)} · N {summary.n}
          </span>
        )}
        {!summary && !insufficient && chanList.length > 0 && (
          <span>
            {axisName} / {axisLabel} — {tx("等待数据…", "waiting for data…")}
          </span>
        )}
      </div>
    </div>
  );
}
