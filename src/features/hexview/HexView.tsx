import { useEffect, useRef, useState, useSyncExternalStore, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FieldDef, HexSlice, SpanOut } from "../../ipc/types";
import * as serialStore from "../serial/serialStore";
import * as templateStore from "../protocol/templateStore";
import * as telemetryStore from "../protocol/telemetryStore";
import * as fcStore from "../framecanvas/frameStore";
import { fieldSize, PALETTE } from "../protocol/templateStore";

const ROW_H = 20;
const COLS = 16;
const PAD_L = 10;
const PAD_T = 8;
const GUTTER_W = 72;
const CELL_W = 26;
const ASCII_GAP = 18;
const SCROLL_W = 14;
const FETCH_MARGIN = 64 * COLS;
const MONO = '"Cascadia Mono", Consolas, monospace';

function hexA(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function HexView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef({ follow: true, viewEnd: COLS - 1 });
  const sliceRef = useRef<HexSlice | null>(null);
  const fetchingRef = useRef(false);
  const dirtyRef = useRef(true);
  const selRef = useRef<{ anchor: number; focus: number } | null>(null);
  const dragRef = useRef<
    | null
    | { kind: "sel" }
    | { kind: "sb"; grab: number }
  >(null);
  const flashRef = useRef<{ seq: number; until: number } | null>(null);
  const hitsRef = useRef<{ seqs: number[]; len: number; idx: number }>({
    seqs: [],
    len: 0,
    idx: 0,
  });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1, zf: 1 });
  const protoRef = useRef(templateStore.getSnapshot());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPattern, setSearchPattern] = useState("");
  const [searchHits, setSearchHits] = useState<number[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const proto = useSyncExternalStore(
    templateStore.subscribe,
    templateStore.getSnapshot,
  );
  const tele = useSyncExternalStore(
    telemetryStore.subscribe,
    telemetryStore.getSnapshot,
  );
  const serial = useSyncExternalStore(
    serialStore.subscribe,
    serialStore.getSnapshot,
  );
  protoRef.current = proto;

  const rowsVisible = () =>
    Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 10) / ROW_H));

  const sbGeom = () => {
    const { w, h } = sizeRef.current;
    const total = serialStore.getSnapshot().rxTotal;
    const rows = rowsVisible();
    const trackY = 4;
    const trackH = Math.max(0, h - 8);
    const visible = Math.min(rows * COLS, Math.max(total, 1));
    const thumbH =
      total > 0
        ? Math.max(24, Math.min(trackH, (visible / total) * trackH))
        : trackH;
    const maxEnd = Math.max(total - 1, COLS - 1);
    const topEnd = Math.min(maxEnd, rows * COLS - 1);
    const frac =
      total > 0
        ? (viewRef.current.viewEnd - topEnd) / Math.max(1, maxEnd - topEnd)
        : 0;
    const thumbY =
      trackY + Math.min(1, Math.max(0, frac)) * (trackH - thumbH);
    return {
      sbX: w - SCROLL_W - 2,
      trackY,
      trackH,
      thumbH,
      thumbY,
      total,
      maxEnd,
      topEnd,
    };
  };

  const applySb = (yAbs: number) => {
    const g = sbGeom();
    const frac = Math.min(
      1,
      Math.max(0, (yAbs - g.trackY) / Math.max(1, g.trackH - g.thumbH)),
    );
    viewRef.current.viewEnd = Math.round(
      g.topEnd + frac * (g.maxEnd - g.topEnd),
    );
    viewRef.current.follow = frac >= 0.999;
    dirtyRef.current = true;
  };

  const clampViewEnd = (ve: number, total: number) => {
    const maxEnd = Math.max(total - 1, COLS - 1);
    const minEnd = Math.min(maxEnd, 8 * COLS - 1);
    return Math.min(Math.max(ve, minEnd), maxEnd);
  };

  const byteAt = (seq: number): number | undefined => {
    const sl = sliceRef.current;
    if (!sl) return undefined;
    const idx = seq - sl.start;
    if (idx < 0 || idx >= sl.bytes.length) return undefined;
    return sl.bytes[idx];
  };

  const spanAt = (seq: number): SpanOut | null => {
    const sl = sliceRef.current;
    if (!sl) return null;
    const arr = sl.spans;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = arr[mid];
      if (seq < s.start) hi = mid - 1;
      else if (seq >= s.start + s.len) lo = mid + 1;
      else return s;
    }
    return null;
  };

  const hitAt = (seq: number): number => {
    const hits = hitsRef.current;
    if (!hits.len || !hits.seqs.length) return -1;
    let lo = 0;
    let hi = hits.seqs.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hits.seqs[mid] <= seq) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans < 0) return -1;
    const s = hits.seqs[ans];
    return seq < s + hits.len ? s : -1;
  };

  const tplById = (id: string) =>
    protoRef.current.rules.templates.find((t) => t.id === id) ?? null;

  const fieldAt = (span: SpanOut, seq: number): FieldDef | null => {
    const tpl = tplById(span.tplId);
    if (!tpl) return null;
    const off = seq - span.start;
    for (const f of tpl.fields) {
      if (off >= f.offset && off < f.offset + fieldSize(f)) return f;
    }
    return null;
  };

  const ensureData = () => {
    const total = serialStore.getSnapshot().rxTotal;
    const v = viewRef.current;
    const frozen = serialStore.isViewFrozen();
    if (v.follow && !frozen) v.viewEnd = Math.max(total - 1, COLS - 1);
    v.viewEnd = clampViewEnd(v.viewEnd, total);
    const rows = rowsVisible();
    const wantStart = Math.max(0, v.viewEnd + 1 - rows * COLS - FETCH_MARGIN);
    const wantEnd = Math.min(total, v.viewEnd + 1 + FETCH_MARGIN);
    const sl = sliceRef.current;
    const covered =
      sl &&
      sl.start <= wantStart &&
      sl.start + sl.bytes.length >= wantEnd &&
      sl.total === total;
    if (!covered && !fetchingRef.current && wantEnd > wantStart) {
      fetchingRef.current = true;
      invoke<HexSlice>("hex_fetch", { start: wantStart, end: wantEnd })
        .then((s) => {
          sliceRef.current = s;
          fetchingRef.current = false;
          dirtyRef.current = true;
        })
        .catch(() => {
          fetchingRef.current = false;
        });
    }
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue("--bg-inset").trim() || "#0b0d10";
    const textCol = cs.getPropertyValue("--text").trim() || "#e6e9ee";
    const dimCol = cs.getPropertyValue("--text-dim").trim() || "#8b93a1";
    const accent = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `12px ${MONO}`;
    ctx.textBaseline = "middle";
    const charW = ctx.measureText("0").width;
    const total = serialStore.getSnapshot().rxTotal;
    const rows = rowsVisible();
    const v = viewRef.current;
    const firstSeq = Math.max(0, v.viewEnd + 1 - rows * COLS);
    const rowMid = (r: number) => PAD_T + r * ROW_H + ROW_H / 2;

    if (total === 0) {
      ctx.fillStyle = dimCol;
      ctx.font = `13px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillText(
        "等待数据… 连接串口，或在左侧「协议模板」面板启动演示数据源",
        PAD_L + 8,
        h / 2,
      );
      return;
    }

    const flash =
      flashRef.current && flashRef.current.until > performance.now()
        ? flashRef.current
        : null;
    const hits = hitsRef.current;
    const curHit =
      hits.len && hits.seqs.length
        ? hits.seqs[Math.min(hits.idx, hits.seqs.length - 1)]
        : -1;
    const sel = selRef.current;
    const selLo = sel ? Math.min(sel.anchor, sel.focus) : 0;
    const selHi = sel ? Math.max(sel.anchor, sel.focus) : -1;
    ctx.font = `12px ${MONO}`;

    for (let r = 0; r < rows; r++) {
      const rowBase = firstSeq + r * COLS;
      if (rowBase >= total) break;
      ctx.fillStyle = dimCol;
      ctx.globalAlpha = 0.75;
      ctx.fillText(
        rowBase.toString(16).padStart(8, "0").toUpperCase(),
        PAD_L,
        rowMid(r),
      );
      ctx.globalAlpha = 1;
      let ascii = "";
      for (let c = 0; c < COLS; c++) {
        const seq = rowBase + c;
        if (seq >= total) break;
        const byte = byteAt(seq);
        if (byte === undefined) continue;
        const x = PAD_L + GUTTER_W + c * CELL_W;
        const span = spanAt(seq);
        let fill: string | null = null;
        if (span && !span.valid) {
          fill = "rgba(229,83,75,0.14)";
        } else if (span) {
          const tpl = tplById(span.tplId);
          if (tpl) fill = hexA(tpl.color, 0.08);
        }
        const field = span && span.valid ? fieldAt(span, seq) : null;
        if (field) fill = hexA(field.color, 0.3);
        if (hitAt(seq) >= 0) fill = hexA(accent, 0.16);
        if (flash && span && span.start === flash.seq) {
          fill = hexA(accent, 0.45);
        }
        if (seq >= selLo && seq <= selHi) fill = hexA(accent, 0.4);
        if (curHit >= 0 && seq >= curHit && seq < curHit + hits.len)
          fill = hexA(accent, 0.5);
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fillRect(x - 2, PAD_T + r * ROW_H + 1, charW * 2 + 6, ROW_H - 2);
        }
        if (curHit >= 0 && seq >= curHit && seq < curHit + hits.len) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.2;
          ctx.strokeRect(
            x - 2.5,
            PAD_T + r * ROW_H + 0.5,
            charW * 2 + 7,
            ROW_H - 1,
          );
        }
        ctx.fillStyle = textCol;
        ctx.fillText(
          byte.toString(16).padStart(2, "0").toUpperCase(),
          x,
          rowMid(r),
        );
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·";
      }
      ctx.fillStyle = dimCol;
      ctx.fillText(
        ascii,
        PAD_L + GUTTER_W + COLS * CELL_W + ASCII_GAP,
        rowMid(r),
      );
    }

    const g = sbGeom();
    ctx.fillStyle = hexA(dimCol, 0.15);
    ctx.fillRect(g.sbX, g.trackY, SCROLL_W, g.trackH);
    ctx.fillStyle = hexA(accent, 0.55);
    ctx.beginPath();
    ctx.roundRect(g.sbX + 2, g.thumbY, SCROLL_W - 4, g.thumbH, 4);
    ctx.fill();

    if (!v.follow) {
      ctx.fillStyle = dimCol;
      ctx.font = `11px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillText("↑ 历史模式", w - 150, 14);
    }
  };

  useEffect(() => {
    let raf = 0;
    const unsubA = serialStore.subscribe(() => {
      if (!serialStore.isViewFrozen()) dirtyRef.current = true;
    });
    const unsubB = templateStore.subscribe(() => {
      dirtyRef.current = true;
    });
    const loop = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        ensureData();
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsubA();
      unsubB();
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const zf = rect.width > 0 && wrap.offsetWidth > 0 ? rect.width / wrap.offsetWidth : 1;
      sizeRef.current = {
        w: rect.width / zf,
        h: rect.height / zf,
        dpr: (window.devicePixelRatio || 1) * zf,
        zf,
      };
      canvas.width = Math.round(sizeRef.current.w * sizeRef.current.dpr);
      canvas.height = Math.round(sizeRef.current.h * sizeRef.current.dpr);
      canvas.style.width = `${sizeRef.current.w}px`;
      canvas.style.height = `${sizeRef.current.h}px`;
      dirtyRef.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const total = serialStore.getSnapshot().rxTotal;
      const v = viewRef.current;
      const step = Math.max(1, Math.floor(rowsVisible() / 2)) * COLS;
      if (e.deltaY > 0) v.viewEnd += step;
      else v.viewEnd -= step;
      v.follow = v.viewEnd >= total - 1 - COLS;
      v.viewEnd = clampViewEnd(v.viewEnd, total);
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const req = proto.locateReq;
    if (!req) return;
    viewRef.current.follow = false;
    viewRef.current.viewEnd =
      req.seq + Math.floor((rowsVisible() * COLS) / 2);
    viewRef.current.viewEnd = clampViewEnd(
      viewRef.current.viewEnd,
      serialStore.getSnapshot().rxTotal,
    );
    flashRef.current = { seq: req.seq, until: performance.now() + 900 };
    dirtyRef.current = true;
  }, [proto.locateReq?.nonce]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "Escape") {
        if (searchOpen) closeSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  const parsePattern = (text: string): number[] | null => {
    const out: number[] = [];
    for (const tok of text.split(/[\s,]+/)) {
      if (!tok) continue;
      const t = tok.replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]{1,2}$/.test(t)) return null;
      out.push(parseInt(t, 16));
    }
    return out.length ? out : null;
  };

  const doSearch = async () => {
    const bytes = parsePattern(searchPattern);
    if (!bytes) {
      setSearchErr("格式无效");
      return;
    }
    setSearchErr(null);
    try {
      const hits = await invoke<{ seq: number }[]>("hex_search", {
        pattern: bytes,
      });
      const seqs = hits.map((h) => h.seq);
      hitsRef.current = { seqs, len: bytes.length, idx: 0 };
      setSearchHits(seqs);
      setSearchIdx(0);
      if (seqs.length) templateStore.locate(seqs[0]);
      else setSearchErr("无匹配");
    } catch (e) {
      setSearchErr(String(e));
    }
  };

  const stepSearch = (d: number) => {
    if (!searchHits.length) return;
    const n = (searchIdx + d + searchHits.length) % searchHits.length;
    setSearchIdx(n);
    hitsRef.current.idx = n;
    templateStore.locate(searchHits[n]);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    hitsRef.current = { seqs: [], len: 0, idx: 0 };
    dirtyRef.current = true;
  };

  const hitTest = (x: number, y: number): number | null => {
    const rows = rowsVisible();
    const r = Math.floor((y - PAD_T) / ROW_H);
    if (r < 0 || r >= rows) return null;
    const c = Math.floor((x - PAD_L - GUTTER_W + 4) / CELL_W);
    if (c < 0 || c >= COLS) return null;
    const firstSeq = Math.max(
      0,
      viewRef.current.viewEnd + 1 - rows * COLS,
    );
    const seq = firstSeq + r * COLS + c;
    const total = serialStore.getSnapshot().rxTotal;
    return seq >= 0 && seq < total ? seq : null;
  };

  const commitSelection = () => {
    const sel = selRef.current;
    if (!sel) return;
    const lo = Math.min(sel.anchor, sel.focus);
    const hi = Math.max(sel.anchor, sel.focus);
    const bytes: number[] = [];
    for (let s = lo; s <= hi; s++) {
      const b = byteAt(s);
      if (b === undefined) break;
      bytes.push(b);
    }
    if (bytes.length) {
      templateStore.setHexSelection({ start: lo, end: hi, bytes });
    }
  };

  const localXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const zf = sizeRef.current.zf || 1;
    return { x: (e.clientX - rect.left) / zf, y: (e.clientY - rect.top) / zf };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localXY(e);
    const g = sbGeom();
    if (x >= g.sbX) {
      const inThumb = y >= g.thumbY && y <= g.thumbY + g.thumbH;
      const grab = inThumb ? y - g.thumbY : g.thumbH / 2;
      if (!inThumb) applySb(y - grab);
      dragRef.current = { kind: "sb", grab };
      return;
    }
    const seq = hitTest(x, y);
    if (seq === null) return;
    selRef.current = { anchor: seq, focus: seq };
    dragRef.current = { kind: "sel" };
    dirtyRef.current = true;
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { y } = localXY(e);
    if (drag.kind === "sel") {
      const rect = e.currentTarget.getBoundingClientRect();
      const zf = sizeRef.current.zf || 1;
      const seq = hitTest((e.clientX - rect.left) / zf, y);
      if (seq !== null && selRef.current) {
        selRef.current.focus = seq;
        dirtyRef.current = true;
      }
    } else {
      applySb(y - drag.grab);
    }
  };

  const onMouseUp = () => {
    if (dragRef.current?.kind === "sel") commitSelection();
    dragRef.current = null;
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = localXY(e);
    const seq = hitTest(x, y);
    if (seq === null) return;
    const sel = selRef.current;
    const covers =
      sel &&
      seq >= Math.min(sel.anchor, sel.focus) &&
      seq <= Math.max(sel.anchor, sel.focus);
    if (!covers) {
      selRef.current = { anchor: seq, focus: seq };
      commitSelection();
      dirtyRef.current = true;
    }
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const jumpToTail = () => {
    viewRef.current.follow = true;
    dirtyRef.current = true;
  };

  const clearData = async () => {
    try {
      await invoke("hex_clear");
    } catch {
      return;
    }
    serialStore.resetRx();
    fcStore.clearArchive();
    dirtyRef.current = true;
  };

  const sel = proto.hexSelection;
  const selLen = sel ? sel.end - sel.start + 1 : 0;
  const selHex = sel
    ? sel.bytes
        .slice(0, 12)
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ") + (selLen > 12 ? " …" : "")
    : "";

  const selSpan = sel ? spanAt(sel.start) : null;
  const menuItems = (() => {
    if (!sel || !selLen) return null;
    const templates = proto.rules.templates;
    const inSpan = (tplId: string) =>
      !!selSpan && selSpan.valid && selSpan.tplId === tplId;
    const offset = selSpan ? sel.start - selSpan.start : -1;
    const defType = () => {
      if (selLen === 1) return "uint8" as const;
      if (selLen === 2) return "uint16" as const;
      if (selLen === 4) return "float32" as const;
      if (selLen === 8) return "float64" as const;
      return "ascii" as const;
    };
    const addFieldFor = (
      tplId: string,
      role: "length" | "checksum" | "data",
      tplName: string,
      fieldCount: number,
    ) => {
      if (!sel) return;
      const type =
        role === "length"
          ? selLen === 1
            ? "uint8"
            : "uint16"
          : role === "checksum"
            ? selLen >= 4
              ? "uint32"
              : selLen === 2
                ? "uint16"
                : "uint8"
            : defType();
      const name =
        role === "length"
          ? "长度"
          : role === "checksum"
            ? "校验"
            : `数据${fieldCount + 1}`;
      templateStore.addField(tplId, {
        id: crypto.randomUUID(),
        name,
        role: role === "length" ? "length" : role === "checksum" ? "checksum" : "data",
        offset,
        type: type as FieldDef["type"],
        endian: "little",
        size: type === "ascii" ? selLen : null,
        color: PALETTE[fieldCount % PALETTE.length],
      });
      void tplName;
    };
    return (
      <>
        <div className="ctx-title">
          选区 0x{sel.start.toString(16)} ~ 0x{sel.end.toString(16)} ·{" "}
          {selLen} 字节 · {selHex}
        </div>
        <button
          className="ctx-item"
          disabled={selLen > 8}
          onClick={() => templateStore.addTemplate(sel.bytes)}
        >
          新建模板（帧头 = 选区字节）
        </button>
        {templates.map((tpl) => (
          <Fragment key={tpl.id}>
            <div className="ctx-group">
              <span
                className="tpl-dot"
                style={{ background: tpl.color }}
              />
              {tpl.name}
            </div>
            <button
              className="ctx-item"
              disabled={
                !inSpan(tpl.id) || selLen > 2 || offset < tpl.boundary.headerBytes.length
              }
              onClick={() =>
                addFieldFor(tpl.id, "length", tpl.name, tpl.fields.length)
              }
            >
              定义为长度字段（偏移 {Math.max(offset, 0)}）
            </button>
            <button
              className="ctx-item"
              disabled={!inSpan(tpl.id) || selLen > 4}
              onClick={() =>
                addFieldFor(tpl.id, "checksum", tpl.name, tpl.fields.length)
              }
            >
              定义为校验字段（偏移 {Math.max(offset, 0)}）
            </button>
            <button
              className="ctx-item"
              disabled={!inSpan(tpl.id)}
              onClick={() =>
                addFieldFor(tpl.id, "data", tpl.name, tpl.fields.length)
              }
            >
              定义为数据字段（偏移 {Math.max(offset, 0)}）
            </button>
          </Fragment>
        ))}
        <div className="ctx-group">其他</div>
        <button
          className="ctx-item"
          onClick={() => navigator.clipboard.writeText(selHex)}
        >
          复制为 Hex
        </button>
        <button
          className="ctx-item"
          onClick={() =>
            navigator.clipboard.writeText(
              sel.bytes
                .map((b) =>
                  b >= 0x20 && b < 0x7f
                    ? String.fromCharCode(b)
                    : "·",
                )
                .join(""),
            )
          }
        >
          复制为 ASCII
        </button>
      </>
    );
  })();

  return (
    <div className="hexview">
      <div className="hex-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="hex-canvas"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onContextMenu={onContextMenu}
        />
        {!viewRef.current.follow && (
          <button className="btn hex-follow-btn" onClick={jumpToTail}>
            跟随最新 ↓
          </button>
        )}
        <button
          className="btn hex-clear-btn"
          title="清空接收缓冲、帧归档与统计"
          onClick={() => void clearData()}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
        </button>
        {searchOpen && (
          <div className="hex-search">
            <input
              autoFocus
              className="input"
              placeholder="搜索 Hex 字节，如 AA 55"
              value={searchPattern}
              onChange={(e) => setSearchPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doSearch();
              }}
            />
            <button className="btn" onClick={doSearch}>
              搜索
            </button>
            {searchHits.length > 0 && (
              <>
                <span className="hex-search-count">
                  {searchIdx + 1}/{searchHits.length}
                </span>
                <button className="btn" onClick={() => stepSearch(-1)} title="上一个">
                  ↑
                </button>
                <button className="btn" onClick={() => stepSearch(1)} title="下一个">
                  ↓
                </button>
              </>
            )}
            {searchErr && <span className="hex-search-err">{searchErr}</span>}
            <button className="btn" onClick={closeSearch} title="关闭">
              ×
            </button>
          </div>
        )}
      </div>
      <div className="hex-status">
        <span className="hex-status-left">
          {sel
            ? `选区 ${selLen} 字节：${selHex || "…"}`
            : "拖拽框选字节 → 右键定义为协议字段 · Ctrl+F 搜索"}
        </span>
        <span className="hex-status-right">
          缓冲 {serial.rxTotal} B · 帧 {tele.stats.total} · 错帧{" "}
          {tele.stats.errors}
        </span>
      </div>
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems}
        </div>
      )}
    </div>
  );
}
