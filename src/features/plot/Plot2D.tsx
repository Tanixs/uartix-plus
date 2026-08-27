import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import * as plotStore from "./plotStore";

function fmtVal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

function hexA(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function Plot2D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const followXRef = useRef(true);
  const panRef = useRef<
    | null
    | {
        x0: number;
        y0: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
      }
  >(null);
  const boxRef = useRef<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const cleanupRefs = useRef<(() => void)[][]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const plot = useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const chart = chartRef.current;
    if (!wrap || !chart) return;
    const channels = plot.channels;
    const settings = plot.settings;
    if (uRef.current) {
      uRef.current.destroy();
      uRef.current = null;
    }
    if (channels.length === 0) return;

    const cs = getComputedStyle(document.documentElement);
    const axisColor = cs.getPropertyValue("--text-dim").trim() || "#8b93a1";
    const gridColor = cs.getPropertyValue("--border-soft").trim() || "#1d2229";
    const accent = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    const dimColor = axisColor;

    const opts: uPlot.Options = {
      width: Math.max(wrap.clientWidth, 80),
      height: Math.max(wrap.clientHeight, 60),
      cursor: {
        drag: { x: false, y: false },
        points: { size: 4 },
      },
      legend: { show: true, live: true },
      scales: { x: { time: settings.xSource === "time", auto: false } },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: settings.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          labelSize: 0,
          values:
            settings.xSource === "time"
              ? undefined
              : (_u, splits) =>
                  splits.map((v) =>
                    Number.isInteger(v) ? String(v) : v.toFixed(2),
                  ),
        },
        {
          stroke: axisColor,
          grid: { stroke: settings.grid ? gridColor : "transparent", width: 1 },
          ticks: { stroke: gridColor },
          values: (_u, splits) => splits.map((v) => fmtVal(v)),
        },
      ],
      series: [
        {},
        ...channels.map((ch) => ({
          label: ch.name,
          stroke: ch.color,
          width: settings.plotMode === "points" ? 0 : settings.lineWidth,
          show: ch.visible,
          spanGaps: false,
          points: { show: settings.plotMode === "points", size: 3 },
          value: (_u: uPlot, v: number | null) => fmtVal(v),
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const xs = u.data[0];
            const drawV = (
              val: number,
              color: string,
              dash: boolean,
              label: string,
            ) => {
              const px = u.bbox.left + u.valToPos(val, "x", true);
              if (px < u.bbox.left - 1 || px > u.bbox.left + u.bbox.width + 1)
                return;
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = dash ? 1 : 1.5;
              if (dash) ctx.setLineDash([5, 4]);
              ctx.beginPath();
              ctx.moveTo(px, u.bbox.top);
              ctx.lineTo(px, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.fillStyle = color;
              ctx.font = '10px "Segoe UI", sans-serif';
              ctx.textAlign =
                px > u.bbox.left + u.bbox.width - 46 ? "right" : "left";
              const lx = px > u.bbox.left + u.bbox.width - 46 ? px - 4 : px + 4;
              ctx.fillText(label, lx, u.bbox.top + 10);
              ctx.restore();
            };
            if (xs.length > 0) {
              drawV(xs[0], dimColor, true, "起");
              drawV(xs[xs.length - 1], accent, false, "最新");
            }
            const box = boxRef.current;
            if (box) {
              const r = u.over.getBoundingClientRect();
              const l = Math.min(box.x0, box.x1) - r.left;
              const t = Math.min(box.y0, box.y1) - r.top;
              const w = Math.abs(box.x1 - box.x0);
              const h = Math.abs(box.y1 - box.y0);
              ctx.save();
              ctx.fillStyle = hexA(accent, 0.12);
              ctx.strokeStyle = accent;
              ctx.lineWidth = 1;
              ctx.fillRect(l, t, w, h);
              ctx.strokeRect(l, t, w, h);
              ctx.restore();
            }
          },
        ],
        setScale: [
          (u) => {
            const x = u.data[0];
            if (!x.length) return;
            const { min, max } = u.scales.x;
            if (min == null || max == null) return;
            const last = x[x.length - 1];
            const span = max - min;
            if (last <= max && max - last < span * 0.02) {
              if (!followXRef.current) {
                followXRef.current = true;
                u.redraw();
              }
            }
          },
        ],
        ready: [
          (u) => {
            const removers: (() => void)[] = [];
            const overRect = () => u.over.getBoundingClientRect();
            const zoomX = (clientX: number, k: number) => {
              const sx = u.scales.x;
              const min = sx.min ?? 0;
              const max = sx.max ?? 1;
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
              const t = min + frac * (max - min);
              u.setScale("x", {
                min: t - (t - min) * k,
                max: t + (max - t) * k,
              });
              followXRef.current = false;
            };
            const zoomY = (clientY: number, k: number) => {
              const sy = u.scales.y;
              let min = sy.min ?? 0;
              let max = sy.max ?? 1;
              if (min === max) {
                min -= 1;
                max += 1;
              }
              const r = overRect();
              const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
              const v = max - frac * (max - min);
              u.setScale("y", {
                min: v - (v - min) * k,
                max: v + (max - v) * k,
              });
            };
            u.root.addEventListener("dblclick", () => {
              followXRef.current = true;
              u.setScale("y", {
                min: undefined as unknown as number,
                max: undefined as unknown as number,
              });
              u.redraw();
            });
            u.root.addEventListener(
              "wheel",
              (e) => {
                e.preventDefault();
                const rect = u.over.getBoundingClientRect();
                const inXZone =
                  e.clientY > rect.bottom &&
                  e.clientX >= rect.left &&
                  e.clientX <= rect.right;
                const inYZone =
                  e.clientX < rect.left &&
                  e.clientY >= rect.top &&
                  e.clientY <= rect.bottom;
                const k = e.deltaY > 0 ? 1.25 : 0.8;
                if (inXZone) zoomX(e.clientX, k);
                else if (inYZone) zoomY(e.clientY, k);
                else zoomX(e.clientX, k);
              },
              { passive: false },
            );
            const onDown = (e: MouseEvent) => {
              const r = overRect();
              if (
                e.clientX < r.left ||
                e.clientX > r.right ||
                e.clientY < r.top ||
                e.clientY > r.bottom
              )
                return;
              if (e.button === 0) {
                const sx = u.scales.x;
                const sy = u.scales.y;
                panRef.current = {
                  x0: e.clientX,
                  y0: e.clientY,
                  minX: sx.min ?? 0,
                  maxX: sx.max ?? 1,
                  minY: sy.min ?? 0,
                  maxY: sy.max ?? 1,
                };
                followXRef.current = false;
                e.preventDefault();
              } else if (e.button === 1) {
                boxRef.current = {
                  x0: e.clientX,
                  y0: e.clientY,
                  x1: e.clientX,
                  y1: e.clientY,
                };
                e.preventDefault();
              }
            };
            const onMove = (e: MouseEvent) => {
              if (panRef.current) {
                const p = panRef.current;
                const r = overRect();
                const dvx = ((e.clientX - p.x0) / r.width) * (p.maxX - p.minX);
                const dvy = ((e.clientY - p.y0) / r.height) * (p.maxY - p.minY);
                u.setScale("x", { min: p.minX - dvx, max: p.maxX - dvx });
                u.setScale("y", { min: p.minY - dvy, max: p.maxY - dvy });
              }
              if (boxRef.current) {
                const b = boxRef.current;
                b.x1 = e.clientX;
                b.y1 = e.clientY;
                u.redraw();
              }
            };
            const onUp = (e: MouseEvent) => {
              if (panRef.current && e.button === 0) panRef.current = null;
              if (boxRef.current && e.button === 1) {
                const b = boxRef.current;
                boxRef.current = null;
                const r = overRect();
                const l = Math.min(b.x0, b.x1) - r.left;
                const rr = Math.max(b.x0, b.x1) - r.left;
                const t = Math.min(b.y0, b.y1) - r.top;
                const bt = Math.max(b.y0, b.y1) - r.top;
                if (rr - l > 6) {
                  u.setScale("x", {
                    min: u.posToVal(l, "x"),
                    max: u.posToVal(rr, "x"),
                  });
                  followXRef.current = false;
                }
                if (bt - t > 6 && rr - l > 6) {
                  u.setScale("y", {
                    min: u.posToVal(t, "y"),
                    max: u.posToVal(bt, "y"),
                  });
                }
                u.redraw();
              }
            };
            const onCtx = (e: MouseEvent) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            };
            u.over.addEventListener("mousedown", onDown);
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            u.root.addEventListener("contextmenu", onCtx);
            removers.push(() => {
              u.over.removeEventListener("mousedown", onDown);
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              u.root.removeEventListener("contextmenu", onCtx);
            });
            cleanupRefs.current.push(removers);
          },
        ],
      },
    };

    const aligned = plotStore.buildAligned();
    const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
    const u = new uPlot(opts, data, chart);
    uRef.current = u;

    const ro = new ResizeObserver(() => {
      u.setSize({
        width: Math.max(wrap.clientWidth, 80),
        height: Math.max(wrap.clientHeight, 60),
      });
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      while (cleanupRefs.current.length) {
        const arr = cleanupRefs.current.pop();
        arr?.forEach((f) => f());
      }
      u.destroy();
      uRef.current = null;
    };
  }, [plot.channels, plot.settings, themeTick]);

  useEffect(() => {
    let visible = true;
    let io: IntersectionObserver | null = null;
    const wrap = wrapRef.current;
    if (wrap) {
      io = new IntersectionObserver((es) => {
        visible = es[0]?.isIntersecting ?? true;
      });
      io.observe(wrap);
    }
    const timer = setInterval(() => {
      const u = uRef.current;
      if (!u || !visible || !plotStore.isDirty()) return;
      plotStore.clearDirty();
      const settings = plotStore.getSnapshot().settings;
      const aligned = plotStore.buildAligned();
      const data: uPlot.AlignedData = [aligned.x, ...aligned.cols];
      u.setData(data, false);
      if (settings.yMode === "zero") {
        let m = 0;
        plotStore.getSnapshot().channels.forEach((ch, i) => {
          if (!ch.visible) return;
          const ys = data[i + 1] as (number | null)[];
          for (const v of ys) {
            if (v !== null && Math.abs(v) > m) m = Math.abs(v);
          }
        });
        if (m > 0) u.setScale("y", { min: -m * 1.15, max: m * 1.15 });
      }
      if (followXRef.current && data[0].length > 1) {
        const xd = data[0];
        const last = xd[xd.length - 1];
        const span = Math.max(
          last - xd[0],
          settings.xSource === "time" ? 10000 : 200,
        );
        u.setScale("x", { min: last - span, max: last + span * 0.05 });
      }
    }, 120);
    return () => {
      clearInterval(timer);
      io?.disconnect();
    };
  }, [plot.channels]);

  const autoY = () => {
    const u = uRef.current;
    if (!u) return;
    let min = Infinity;
    let max = -Infinity;
    u.series.forEach((s, i) => {
      if (i === 0 || !s.show) return;
      const ys = u.data[i] as (number | null)[];
      for (const v of ys) {
        if (v !== null && v !== undefined) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    });
    if (min === Infinity) return;
    const pad = ((max - min) || Math.abs(max) || 1) * 0.1;
    u.setScale("y", { min: min - pad, max: max + pad });
  };

  const resetView = () => {
    followXRef.current = true;
    const u = uRef.current;
    if (u) {
      u.setScale("y", {
        min: undefined as unknown as number,
        max: undefined as unknown as number,
      });
      u.redraw();
    }
  };

  const hasChannels = plot.channels.length > 0;

  return (
    <div className="plot">
      <div className="plot-bar">
        <select
          className="input"
          value={plot.settings.xSource}
          title="X 轴数据源"
          onChange={(e) => plotStore.setSetting({ xSource: e.target.value })}
        >
          <option value="time">X：时间</option>
          <option value="index">X：序号</option>
          {plot.channels.map((ch) => (
            <option key={ch.id} value={`ch:${ch.id}`}>
              X：{ch.name}
            </option>
          ))}
        </select>
        <button
          className="btn"
          onClick={autoY}
          title="Y 轴自动缩放至所有可见曲线全范围（留 10% 余量）"
        >
          Auto
        </button>
        {hasChannels && (
          <button className="btn" onClick={() => plotStore.clearChannels()}>
            清空通道
          </button>
        )}
        <div className="plot-bar-spacer" />
        {plot.channels.map((ch) => (
          <span key={ch.id} className="plot-chip" title="点击名称切换显示">
            <input
              type="color"
              className="color-input"
              value={ch.color}
              onChange={(e) => plotStore.setColor(ch.id, e.target.value)}
            />
            <span
              className={`plot-chip-name ${ch.visible ? "" : "off"}`}
              onClick={() => plotStore.toggleVisible(ch.id)}
            >
              {ch.name}
            </span>
            <button className="tpl-del" onClick={() => plotStore.removeChannel(ch.id)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div
        ref={wrapRef}
        className={`plot-wrap ${dragOver ? "dropping" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
      >
        <div ref={chartRef} className="plot-chart" />
        {!hasChannels && (
          <div className="plot-empty">
            打开左侧「字段图例」的眼睛即可实时绘图
            <br />
            左键拖动平移 · 中键框选缩放 · 双击复位 · 滚轮缩放（轴区对应轴） ·
            右键图表更多设置
          </div>
        )}
      </div>
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-title">图表设置</div>
          <div className="ctx-group">Y 轴</div>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ yMode: "auto" })}
          >
            {plot.settings.yMode === "auto" ? "●" : "○"} 自动范围
          </button>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ yMode: "zero" })}
          >
            {plot.settings.yMode === "zero" ? "●" : "○"} 包含零点（对称）
          </button>
          <div className="ctx-group">X 轴源</div>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ xSource: "time" })}
          >
            {plot.settings.xSource === "time" ? "●" : "○"} 时间
          </button>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ xSource: "index" })}
          >
            {plot.settings.xSource === "index" ? "●" : "○"} 序号
          </button>
          {plot.channels.map((ch) => (
            <button
              key={ch.id}
              className="ctx-item"
              onClick={() => plotStore.setSetting({ xSource: `ch:${ch.id}` })}
            >
              {plot.settings.xSource === `ch:${ch.id}` ? "●" : "○"} {ch.name}
            </button>
          ))}
          <div className="ctx-group">绘图</div>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ plotMode: "line" })}
          >
            {plot.settings.plotMode === "line" ? "●" : "○"} 连线
          </button>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ plotMode: "points" })}
          >
            {plot.settings.plotMode === "points" ? "●" : "○"} 仅画点
          </button>
          <div className="form-row" style={{ padding: "4px 8px" }}>
            <label>线宽</label>
            <select
              className="input"
              value={plot.settings.lineWidth}
              onChange={(e) =>
                plotStore.setSetting({ lineWidth: Number(e.target.value) })
              }
            >
              {[1, 2, 3].map((w) => (
                <option key={w} value={w}>
                  {w}px
                </option>
              ))}
            </select>
          </div>
          <button
            className="ctx-item"
            onClick={() => plotStore.setSetting({ grid: !plot.settings.grid })}
          >
            {plot.settings.grid ? "●" : "○"} 网格线
          </button>
          <div className="ctx-group">视图</div>
          <button className="ctx-item" onClick={() => { followXRef.current = true; setMenu(null); }}>
            {followXRef.current ? "●" : "○"} X 轴跟随最新
          </button>
          <button className="ctx-item" onClick={autoY}>
            Auto Y 轴
          </button>
          <button className="ctx-item" onClick={resetView}>
            复位视图
          </button>
        </div>
      )}
    </div>
  );
}
