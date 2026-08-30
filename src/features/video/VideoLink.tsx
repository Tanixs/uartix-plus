import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { EmptyState } from "../../shared/EmptyState";
import { NumInput, TextInput } from "../protocol/PropertiesPanel";

interface FrameRec {
  url: string;
  size: number;
  ts: number;
}

type PixFmt = "gray8" | "rgb565" | "rgb888";

interface RawCfg {
  mode: "jpeg" | "raw";
  head: string;
  fixedW: number;
  wOff: number;
  fixedH: number;
  hOff: number;
  pix: PixFmt;
  be: boolean;
}

const RAW_KEY = "vs.video.raw";
const MAX_FRAMES = 12;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const MAX_RAW_PIXELS = 4096 * 4096;
const BUF_LIMIT = 8 * 1024 * 1024;

function loadRaw(): RawCfg {
  const fallback: RawCfg = {
    mode: "jpeg",
    head: "5A A5",
    fixedW: 0,
    wOff: 0,
    fixedH: 0,
    hOff: 0,
    pix: "gray8",
    be: false,
  };
  try {
    const raw = localStorage.getItem(RAW_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<RawCfg>;
    return {
      mode: p.mode === "raw" ? "raw" : "jpeg",
      head: typeof p.head === "string" ? p.head : fallback.head,
      fixedW: Math.max(0, Math.round(Number(p.fixedW ?? 0))),
      wOff: Math.max(0, Math.round(Number(p.wOff ?? 0))),
      fixedH: Math.max(0, Math.round(Number(p.fixedH ?? 0))),
      hOff: Math.max(0, Math.round(Number(p.hOff ?? 0))),
      pix:
        p.pix === "rgb565" || p.pix === "rgb888" || p.pix === "gray8"
          ? p.pix
          : "gray8",
      be: Boolean(p.be),
    };
  } catch {
    return fallback;
  }
}

function parseHex(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.trim().split(/[\s,]+/)) {
    if (!tok) continue;
    const v = parseInt(tok.replace(/^0x/i, ""), 16);
    if (Number.isFinite(v) && v >= 0 && v <= 255) out.push(v);
  }
  return out;
}

function findSeq(buf: Uint8Array, from: number, seq: number[]): number {
  const end = buf.length - seq.length;
  for (let i = Math.max(0, from); i <= end; i++) {
    if (buf[i] !== seq[0]) continue;
    let ok = true;
    for (let j = 1; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export function VideoLink() {
  const [frames, setFrames] = useState<FrameRec[]>([]);
  const [selected, setSelected] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [flip, setFlip] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [stats, setStats] = useState({ fps: 0, count: 0, bytes: 0, dropped: 0 });
  const [cfg, setCfg] = useState<RawCfg>(loadRaw);
  const cfgRef = useRef<RawCfg>(cfg);
  const pausedRef = useRef(false);
  const bufRef = useRef<Uint8Array>(new Uint8Array(0));
  const scanRef = useRef(0);
  const soiRef = useRef(-1);
  const countRef = useRef(0);
  const droppedRef = useRef(0);
  const bytesRef = useRef(0);
  const fpsTimesRef = useRef<number[]>([]);
  const urlsRef = useRef<string[]>([]);
  const cvsRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });

  const patchCfg = (p: Partial<RawCfg>) => {
    const next = { ...cfgRef.current, ...p };
    cfgRef.current = next;
    setCfg(next);
    localStorage.setItem(RAW_KEY, JSON.stringify(next));
    bufRef.current = new Uint8Array(0);
    scanRef.current = 0;
    soiRef.current = -1;
  };

  const pushFrame = (url: string, size: number) => {
    urlsRef.current.push(url);
    countRef.current += 1;
    bytesRef.current = size;
    fpsTimesRef.current.push(performance.now());
    fpsTimesRef.current = fpsTimesRef.current.filter(
      (t) => performance.now() - t < 5000,
    );
    setFrames((prev) =>
      [...prev, { url, size, ts: Date.now() }].slice(-MAX_FRAMES),
    );
  };

  useEffect(() => {
    const unlisten = listen<{ bytes: number[] }>("serial:rx", (e) => {
      if (pausedRef.current) return;
      const inc = e.payload.bytes;
      if (!inc.length) return;
      const buf = bufRef.current;
      const merged = new Uint8Array(buf.length + inc.length);
      merged.set(buf);
      merged.set(inc, buf.length);
      let buf2 = merged;
      let pos = scanRef.current;
      let changed = false;
      const cfg0 = cfgRef.current;

      if (cfg0.mode === "jpeg") {
        while (pos < buf2.length) {
          if (soiRef.current < 0) {
            const idx = findSeq(buf2, pos, [0xff, 0xd8, 0xff]);
            if (idx < 0) {
              pos = Math.max(0, buf2.length - 2);
              break;
            }
            soiRef.current = idx;
            pos = idx + 3;
          }
          const eoi = findSeq(buf2, pos, [0xff, 0xd9]);
          if (eoi < 0) break;
          const size = eoi + 2 - soiRef.current;
          if (size <= MAX_JPEG_BYTES) {
            const jpg = buf2.slice(soiRef.current, eoi + 2);
            const url = URL.createObjectURL(
              new Blob([jpg], { type: "image/jpeg" }),
            );
            pushFrame(url, size);
            changed = true;
          } else {
            droppedRef.current += 1;
          }
          pos = eoi + 2;
          soiRef.current = -1;
        }
      } else {
        const head = parseHex(cfg0.head);
        const headLen = head.length;
        const bpp =
          cfg0.pix === "gray8" ? 1 : cfg0.pix === "rgb565" ? 2 : 3;
        if (headLen > 0) {
          while (pos < buf2.length) {
            if (soiRef.current < 0) {
              const idx = findSeq(buf2, pos, head);
              if (idx < 0) {
                pos = Math.max(0, buf2.length - headLen);
                break;
              }
              soiRef.current = idx;
              pos = idx + headLen;
            }
            const start = soiRef.current;
            const rdU16 = (off: number): number => {
              if (off < 0 || off + 2 > buf2.length) return -1;
              return cfg0.be
                ? (buf2[off] << 8) | buf2[off + 1]
                : buf2[off] | (buf2[off + 1] << 8);
            };
            const w =
              cfg0.fixedW > 0
                ? cfg0.fixedW
                : rdU16(start + headLen + cfg0.wOff);
            const h =
              cfg0.fixedH > 0 ? cfg0.fixedH : rdU16(start + headLen + cfg0.hOff);
            if (w <= 0 || h <= 0 || w * h > MAX_RAW_PIXELS) {
              droppedRef.current += 1;
              pos = start + 1;
              soiRef.current = -1;
              continue;
            }
            const end = start + headLen + w * h * bpp;
            if (buf2.length < end) break;
            if (!cvsRef.current) cvsRef.current = document.createElement("canvas");
            const cv = cvsRef.current;
            cv.width = w;
            cv.height = h;
            const c2d = cv.getContext("2d");
            if (c2d) {
              const img = c2d.createImageData(w, h);
              const d = img.data;
              const pxs = buf2.slice(start + headLen, end);
              let di = 0;
              if (cfg0.pix === "gray8") {
                for (let i = 0; i < pxs.length; i++) {
                  d[di] = d[di + 1] = d[di + 2] = pxs[i];
                  d[di + 3] = 255;
                  di += 4;
                }
              } else if (cfg0.pix === "rgb888") {
                for (let i = 0; i + 2 < pxs.length; i += 3) {
                  d[di] = pxs[i];
                  d[di + 1] = pxs[i + 1];
                  d[di + 2] = pxs[i + 2];
                  d[di + 3] = 255;
                  di += 4;
                }
              } else {
                for (let i = 0; i + 1 < pxs.length; i += 2) {
                  const v = cfg0.be
                    ? (pxs[i] << 8) | pxs[i + 1]
                    : pxs[i] | (pxs[i + 1] << 8);
                  d[di] = ((v >> 11) & 0x1f) * 255 / 31;
                  d[di + 1] = ((v >> 5) & 0x3f) * 255 / 63;
                  d[di + 2] = (v & 0x1f) * 255 / 31;
                  d[di + 3] = 255;
                  di += 4;
                }
              }
              c2d.putImageData(img, 0, 0);
              pushFrame(cv.toDataURL("image/png"), end - start);
              changed = true;
            }
            pos = end;
            soiRef.current = -1;
          }
        }
      }
      scanRef.current = pos;
      if (buf2.length > BUF_LIMIT) {
        const keep = soiRef.current >= 0 ? soiRef.current : pos;
        buf2 = buf2.slice(Math.min(keep, buf2.length));
        scanRef.current = pos - Math.min(keep, pos);
        if (soiRef.current >= 0) soiRef.current -= keep;
      }
      bufRef.current = buf2;
      if (!changed) return;
      setFrames((prev) => prev.slice(-MAX_FRAMES));
    });
    return () => {
      void unlisten.then((f) => f());
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const win = fpsTimesRef.current.filter((x) => performance.now() - x < 5000);
      setStats({
        fps: win.length >= 2 ? Math.round((win.length / 5) * 10) / 10 : win.length,
        count: countRef.current,
        bytes: bytesRef.current,
        dropped: droppedRef.current,
      });
    }, 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (frames.length > 1) {
      const cut = frames.slice(0, frames.length - MAX_FRAMES);
      for (const f of cut) {
        if (f.url.startsWith("blob:")) URL.revokeObjectURL(f.url);
      }
    }
  }, [frames]);

  const current =
    selected >= 0 && selected < frames.length
      ? frames[selected]
      : frames[frames.length - 1];

  const togglePause = () => {
    const v = !pausedRef.current;
    pausedRef.current = v;
    setPaused(v);
  };

  const clearAll = () => {
    for (const u of urlsRef.current) {
      if (u.startsWith("blob:")) URL.revokeObjectURL(u);
    }
    urlsRef.current = [];
    bufRef.current = new Uint8Array(0);
    scanRef.current = 0;
    soiRef.current = -1;
    countRef.current = 0;
    droppedRef.current = 0;
    bytesRef.current = 0;
    fpsTimesRef.current = [];
    setFrames([]);
    setSelected(-1);
  };

  const saveFrame = () => {
    if (!current) return;
    const a = document.createElement("a");
    a.href = current.url;
    a.download = `frame_${new Date(current.ts).toISOString().replace(/[:.]/g, "-")}${current.url.startsWith("data:") ? ".png" : ".jpg"}`;
    a.click();
  };

  const resetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const view = paused ? frames[frames.length - 1] : current;
  const reviewing = !paused && selected >= 0 && selected < frames.length - 1;

  return (
    <div className="video-panel">
      <div className="video-bar">
        <button className={`btn ${paused ? "primary" : ""}`} onClick={togglePause}>
          {paused ? "继续" : "暂停"}
        </button>
        <button className="btn" onClick={saveFrame} disabled={!view} title="保存当前显示的帧">
          保存当前帧
        </button>
        <button
          className={`btn ${mirror ? "primary" : ""}`}
          onClick={() => setMirror((v) => !v)}
          title="水平镜像"
        >
          镜像
        </button>
        <button
          className={`btn ${flip ? "primary" : ""}`}
          onClick={() => setFlip((v) => !v)}
          title="垂直翻转"
        >
          翻转
        </button>
        <button className={`btn ${cfg.mode === "raw" ? "primary" : ""}`} onClick={() => setRawOpen(true)}>
          解析设置
        </button>
        <button className="btn" onClick={clearAll}>
          清空
        </button>
        <div className="video-bar-spacer" />
        <span className="video-stat">
          {stats.fps.toFixed(1)} FPS · 共 {stats.count} 帧 · {stats.bytes} B
          {stats.dropped > 0 ? ` · 丢弃 ${stats.dropped}` : ""}
        </span>
      </div>
      <div
        className="video-view"
        ref={viewRef}
        onWheel={(e) => {
          e.preventDefault();
          const r = viewRef.current?.getBoundingClientRect();
          if (!r) return;
          const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * -0.0012);
          const nz = Math.min(8, Math.max(0.2, zoomRef.current * k));
          const kr = nz / zoomRef.current;
          const mx = e.clientX - r.left - r.width / 2;
          const my = e.clientY - r.top - r.height / 2;
          const np = {
            x: mx - (mx - panRef.current.x) * kr,
            y: my - (my - panRef.current.y) * kr,
          };
          zoomRef.current = nz;
          panRef.current = np;
          setZoom(nz);
          setPan(np);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.button !== 1) return;
          panDragRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = panDragRef.current;
          if (!p) return;
          const np = { x: p.px + (e.clientX - p.x), y: p.py + (e.clientY - p.y) };
          panRef.current = np;
          setPan(np);
        }}
        onPointerUp={() => {
          panDragRef.current = null;
        }}
        onDoubleClick={resetView}
        style={{ cursor: panDragRef.current ? "grabbing" : "grab" }}
      >
        {view ? (
          <>
            <img
              className="video-frame"
              src={view.url}
              alt="video frame"
              draggable
              style={{
                transform:
                  `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) ${mirror ? "scaleX(-1) " : ""}${flip ? "scaleY(-1)" : ""}`.trim() ||
                  undefined,
              }}
            />
            {zoom !== 1 && (
              <span className="video-tag">{Math.round(zoom * 100)}% · 双击复位</span>
            )}
            {paused && <span className="video-tag warn">已暂停</span>}
            {!paused && reviewing && (
              <span className="video-tag warn">回看中 · 点击「实时」返回</span>
            )}
          </>
        ) : (
          <EmptyState
            title="等待图传数据"
            hint={[
              "默认自动识别 JPEG 图片流（FFD8FF … FFD9），串口 / TCP / UDP 通吃",
              "RAW 灰度 / RGB 传感器请在「解析设置」中配置帧头与分辨率",
            ]}
          />
        )}
      </div>
      {frames.length > 0 && (
        <div className="video-strip">
          <button
            className={`video-thumb-btn ${selected === -1 && !paused ? "on" : ""}`}
            onClick={() => setSelected(-1)}
            title="实时"
          >
            实时
          </button>
          {frames.map((f, i) => (
            <button
              key={f.url}
              className={`video-thumb-btn ${
                (paused && i === frames.length - 1) || (!paused && selected === i)
                  ? "on"
                  : ""
              }`}
              onClick={() => setSelected(i)}
              title={`${new Date(f.ts).toLocaleTimeString()} · ${f.size} B`}
            >
              <img src={f.url} alt="" />
            </button>
          ))}
        </div>
      )}
      {rawOpen && (
        <div className="modal-mask" onMouseDown={() => setRawOpen(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">图传解析设置</div>
            <div className="form-row">
              <label>格式</label>
              <select
                className="input"
                value={cfg.mode}
                onChange={(e) => patchCfg({ mode: e.target.value as RawCfg["mode"] })}
              >
                <option value="jpeg">JPEG 自动识别</option>
                <option value="raw">RAW 自定义帧</option>
              </select>
            </div>
            {cfg.mode === "raw" && (
              <>
                <div className="form-row">
                  <label>帧头 HEX</label>
                  <TextInput
                    value={cfg.head}
                    onCommit={(v) => patchCfg({ head: v })}
                    placeholder="5A A5"
                  />
                </div>
                <div className="form-row">
                  <label>宽度</label>
                  <select
                    className="input"
                    value={cfg.fixedW > 0 ? "fixed" : "frame"}
                    onChange={(e) =>
                      patchCfg({ fixedW: e.target.value === "fixed" ? 320 : 0 })
                    }
                  >
                    <option value="frame">帧内 u16 偏移</option>
                    <option value="fixed">固定值</option>
                  </select>
                  <NumInput
                    value={cfg.fixedW > 0 ? cfg.fixedW : cfg.wOff}
                    width={72}
                    onCommit={(v) =>
                      patchCfg(
                        cfg.fixedW > 0 ? { fixedW: v } : { wOff: v },
                      )
                    }
                  />
                </div>
                <div className="form-row">
                  <label>高度</label>
                  <select
                    className="input"
                    value={cfg.fixedH > 0 ? "fixed" : "frame"}
                    onChange={(e) =>
                      patchCfg({ fixedH: e.target.value === "fixed" ? 240 : 0 })
                    }
                  >
                    <option value="frame">帧内 u16 偏移</option>
                    <option value="fixed">固定值</option>
                  </select>
                  <NumInput
                    value={cfg.fixedH > 0 ? cfg.fixedH : cfg.hOff}
                    width={72}
                    onCommit={(v) =>
                      patchCfg(
                        cfg.fixedH > 0 ? { fixedH: v } : { hOff: v },
                      )
                    }
                  />
                </div>
                <div className="form-row">
                  <label>像素格式</label>
                  <select
                    className="input"
                    value={cfg.pix}
                    onChange={(e) => patchCfg({ pix: e.target.value as PixFmt })}
                  >
                    <option value="gray8">灰度 GRAY8（1B/像素）</option>
                    <option value="rgb565">RGB565（2B/像素）</option>
                    <option value="rgb888">RGB888（3B/像素）</option>
                  </select>
                  <label>字节序</label>
                  <select
                    className="input"
                    value={cfg.be ? "be" : "le"}
                    onChange={(e) => patchCfg({ be: e.target.value === "be" })}
                  >
                    <option value="le">小端 LE</option>
                    <option value="be">大端 BE</option>
                  </select>
                </div>
                <div className="cmd-hint" style={{ marginLeft: 0 }}>
                  帧契约：帧头后紧跟像素数据；宽高可从帧内偏移读 u16 或用固定值
                </div>
              </>
            )}
            <div className="modal-foot">
              <span />
              <button className="btn primary" onClick={() => setRawOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
