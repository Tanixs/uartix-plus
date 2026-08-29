import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FieldDef, FieldRole, FieldType, FrameTemplate } from "../../ipc/types";
import * as fcStore from "./frameStore";
import * as serialStore from "../serial/serialStore";
import * as templateStore from "../protocol/templateStore";
import * as telemetryStore from "../protocol/telemetryStore";
import { fieldSize, PALETTE } from "../protocol/templateStore";
import { groupDisplayName, presetGroupKey } from "./presets";

const MONO = '"Cascadia Mono", Consolas, monospace';
const PAD_L = 10;
const PAD_T = 12;
const PAD_R = 14;
const GAP = 2;
const BLOK_PAD = 4;
const ROW_XTRA = 8;
const ANIM_MS = 220;
const SCROLL_W = 14;

const fsvg = (children: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconSave = () => fsvg(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>);
const IconUndo = () => fsvg(<><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></>);
const IconRedo = () => fsvg(<><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></>);
const IconTrash = () => fsvg(<><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
const IconPrev = () => fsvg(<polyline points="15 18 9 12 15 6" />);
const IconNext = () => fsvg(<polyline points="9 18 15 12 9 6" />);
const IconFollow = ({ on }: { on: boolean }) =>
  fsvg(on ? <><circle cx="12" cy="12" r="3" fill="currentColor" /><circle cx="12" cy="12" r="8" /></> : <><polygon points="6 4 20 12 6 20" /></>);
const IconCheck = () => fsvg(<polyline points="20 6 9 17 4 12" />);
const IconAlert = () => fsvg(<><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>);

function ArchStat() {
  const meta = useSyncExternalStore(fcStore.subscribe, fcStore.getMeta);
  return (
    <span className="fc-stat" title="归档的有效帧数与字节数；已过滤为剔除的杂散/坏包字节">
      <b>{meta.frames}</b>帧<i>·</i>{fmtB(meta.bytes)}
      {meta.dropped > 0 ? <em className="fc-stat-warn">滤{fmtB(meta.dropped)}</em> : null}
    </span>
  );
}

function ArchEmptyGate({ children }: { children: React.ReactNode }) {
  const meta = useSyncExternalStore(fcStore.subscribe, fcStore.getMeta);
  return <>{meta.frames === 0 ? children : null}</>;
}

const ROLE_META: Record<FieldRole, { zh: string; tag: string; chip: string }> = {
  header: { zh: "帧头", tag: "HDR", chip: "#e8a33d" },
  addr: { zh: "目标地址", tag: "ADR", chip: "#39c5cf" },
  id: { zh: "功能码", tag: "ID", chip: "#4e9cef" },
  seq: { zh: "序号", tag: "SEQ", chip: "#f0883e" },
  length: { zh: "数据长度", tag: "LEN", chip: "#3fb950" },
  data: { zh: "数据内容", tag: "DATA", chip: "#bc8cff" },
  payload: { zh: "数据载荷", tag: "PLD", chip: "#bc8cff" },
  checksum: { zh: "和校验", tag: "CK1", chip: "#d29922" },
  checksum2: { zh: "附加校验", tag: "CK2", chip: "#e5534b" },
  footer: { zh: "帧尾", tag: "FTR", chip: "#db61a2" },
};

const TYPE_LABEL: Record<FieldType, string> = {
  uint8: "uint8",
  int8: "int8",
  uint16: "uint16",
  int16: "int16",
  uint32: "uint32",
  int32: "int32",
  float32: "float32",
  float64: "float64",
  ascii: "ascii",
  bcd: "bcd",
  bits: "bits",
  csv: "csv·自适应",
};

const SIZE_TYPES: Record<number, FieldType[]> = {
  1: ["uint8", "int8"],
  2: ["uint16", "int16"],
  3: ["uint32", "int32"],
  4: ["float32", "uint32", "int32"],
  6: ["float64"],
  8: ["float64"],
};

const NAME_HINTS: Record<number, string[]> = {
  1: ["温度", "电压", "状态", "信号"],
  2: ["温度", "俯仰", "横滚", "偏航", "电流"],
  3: ["保留", "填充", "签名"],
  4: ["四元数W", "经度", "纬度", "速度"],
};

const TYPE_ORDER: FieldType[] = [
  "uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "ascii", "bcd", "bits", "csv",
];

interface Blk {
  start: number;
  len: number;
  key: string;
  kind: "hdr" | "ftr" | "fld" | "gap";
  fid: string | null;
  color: string;
  label: string | null;
  role: FieldRole | null;
  locked: boolean;
}

interface Item {
  g0: number;
  g1: number;
  x0: number;
  x1: number;
  p0: boolean;
  p1: boolean;
  ax: boolean;
  blk: Blk;
}

interface Row {
  y: number;
  items: Item[];
}

interface Layout {
  rows: Row[];
  rowH: number;
  s: number;
  frLen: number;
}

function checksumLen(algo: string | null): number {
  if (!algo || algo === "none") return 0;
  if (algo === "sum8" || algo === "xor8") return 1;
  if (algo === "crc32") return 4;
  return 2;
}

function reservedTail(tpl: FrameTemplate): number {
  let rt = 0;
  if (tpl.checksum && tpl.checksum.algo !== "none") {
    if (tpl.checksum.coverageEnd <= 0) rt += checksumLen(tpl.checksum.algo);
  }
  if (tpl.boundary.mode === "footer" && tpl.boundary.footerBytes?.length) {
    rt += tpl.boundary.footerBytes.length;
  }
  return rt;
}

function skeletonLen(tpl: FrameTemplate): number {
  if (tpl.boundary.mode === "fixedLength" && tpl.boundary.fixedLength) {
    return tpl.boundary.fixedLength;
  }
  let end = tpl.boundary.headerBytes.length;
  for (const f of tpl.fields) {
    const sz = fieldSize(f);
    if (sz > 0) end = Math.max(end, f.offset + sz);
  }
  end += reservedTail(tpl);
  return Math.min(64, Math.max(8, end + 4));
}

function hexA(hex: string, a: number): string {
  if (!hex.startsWith("#")) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bl = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${bl},${Math.max(0, Math.min(1, a))})`;
}

function mixC(a: string, b: string, t: number): string {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  return `rgb(${Math.round(parseInt(pa.slice(0, 2), 16) * t + parseInt(pb.slice(0, 2), 16) * (1 - t))},${Math.round(parseInt(pa.slice(2, 4), 16) * t + parseInt(pb.slice(2, 4), 16) * (1 - t))},${Math.round(parseInt(pa.slice(4, 6), 16) * t + parseInt(pb.slice(4, 6), 16) * (1 - t))})`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function rrLR(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rl: number,
  rv: number,
) {
  const m = Math.min(h / 2, w / 2);
  const l = Math.min(rl, m);
  const r = Math.min(rv, m);
  ctx.beginPath();
  ctx.moveTo(x + l, y);
  ctx.lineTo(x + w - r, y);
  if (r > 0) ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  if (r > 0) ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + l, y + h);
  if (l > 0) ctx.arcTo(x, y + h, x, y + h - l, l);
  ctx.lineTo(x, y + l);
  if (l > 0) ctx.arcTo(x, y, x + l, y, l);
  ctx.closePath();
}

function fmtB(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roleOf(f: FieldDef): FieldRole {
  return f.role;
}

function buildBlocks(tpl: FrameTemplate | null, frLen: number): Blk[] {  if (!tpl) {
    const gap: Blk = { start: 0, len: frLen, key: "g0", kind: "gap", fid: null, color: "", label: null, role: null, locked: false };
    return [gap];
  }
  const hb = tpl.boundary.headerBytes;
  const pieces: Blk[] = [];
  if (hb.length > 0) {
    pieces.push({ start: 0, len: hb.length, key: "h0", kind: "hdr", fid: null, color: "#e8a33d", label: "帧头", role: null, locked: false });
  }
  const fields = [...tpl.fields].sort((a, b) => a.offset - b.offset);
  let pos = hb.length;
  for (const f of fields) {
    const sz = fieldSize(f);
    if (hb.length > 0 && f.offset >= 0 && f.offset + sz <= hb.length) continue;
    if (f.offset > pos) {
      pieces.push({ start: pos, len: f.offset - pos, key: `g${pos}`, kind: "gap", fid: null, color: "", label: null, role: null, locked: false });
    }
    if (sz > 0 && f.offset < frLen) {
      const m = Math.min(sz, frLen - f.offset);
      pieces.push({
        start: f.offset,
        len: m,
        key: `f${f.id}`,
        kind: "fld",
        fid: f.id,
        color: f.color,
        label: f.name,
        role: f.role,
        locked: !!f.locked,
      });
    }
    if (f.offset + sz > pos) pos = f.offset + sz;
  }
  const rt = reservedTail(tpl);
  if (rt > 0 && pos < frLen) {
    const tailLen = Math.min(rt, frLen - pos);
    pieces.push({
      start: pos,
      len: tailLen,
      key: "ck0",
      kind: "ftr",
      fid: null,
      color: "#db61a2",
      label: "校验",
      role: null,
      locked: false,
    });
  } else if (tpl.boundary.mode === "footer" && tpl.boundary.footerBytes?.length && pos < frLen) {
    const fl = Math.min(tpl.boundary.footerBytes.length, frLen - pos);
    pieces.push({ start: pos, len: fl, key: "ft0", kind: "ftr", fid: null, color: "#db61a2", label: "帧尾", role: null, locked: false });
  } else if (pos < frLen) {
    pieces.push({ start: pos, len: frLen - pos, key: `g${pos}`, kind: "gap", fid: null, color: "", label: null, role: null, locked: false });
  }
  if (pieces.length === 0) {
    pieces.push({ start: 0, len: frLen, key: "g0", kind: "gap", fid: null, color: "", label: null, role: null, locked: false });
  }
  pieces.sort((a, b) => a.start - b.start);
  return pieces;
}

function layoutBlocks(
  pieces: Blk[],
  s: number,
  width: number,
): { rows: Row[]; rowH: number } {
  const rowH = s + ROW_XTRA;
  const rows: Row[] = [];
  let x = PAD_L;
  let y = PAD_T;
  let cur: Row = { y, items: [] };
  const pushRow = () => {
    if (cur.items.length > 0) rows.push(cur);
    y += rowH;
    x = PAD_L;
    cur = { y, items: [] };
  };
  const avail = () => width - PAD_R - x;
  for (const blk of pieces) {
    let g = blk.start;
    let rem = blk.len;
    let first = true;
    while (rem > 0) {
      if (x > PAD_L && avail() < s + BLOK_PAD) pushRow();
      let vw = avail();
      if (vw < s + BLOK_PAD && x > PAD_L) pushRow();
      const maxCells = Math.floor((vw - BLOK_PAD) / s);
      if (maxCells < 1) pushRow();
      const take = Math.max(1, Math.min(rem, maxCells));
      cur.items.push({
        g0: g,
        g1: g + take - 1,
        x0: x,
        x1: x + take * s - BLOK_PAD,
        p0: !first,
        p1: take < blk.len,
        ax: first && take > 0,
        blk,
      });
      x += take * s;
      rem -= take;
      if (rem > 0) pushRow();
      first = false;
      g += take;
      if (avail() < s && rem > 0) pushRow();
    }
    if (cur.items.length > 0 && avail() < s) pushRow();
  }
  if (cur.items.length > 0) rows.push(cur);
  return { rows, rowH };
}

function FrameCanvas() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLSpanElement | null>(null);
  const sizeRef = useRef({ w: 600, h: 400, dpr: 1, zf: 1 });
  const cellRef = useRef(28);
  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef<{ live: boolean; fi: number }>({ live: true, fi: 0 });
  const tplSelRef = useRef<string | null>(null);
  const selRef = useRef<{ lo: number; hi: number } | null>(null);
  const selDragRef = useRef<{ anchor: number; downX: number; downY: number; moved: boolean } | null>(null);
  const hoverRef = useRef<{ off: number; x: number; y: number } | null>(null);
  const dragSbRef = useRef<{ grabY: number; grabScroll: number } | null>(null);
  const scrollRef = useRef(0);
  const dirtyRef = useRef(true);
  const protoRef = useRef(templateStore.getSnapshot());
  const teleRef = useRef(telemetryStore.getSnapshot());
  const animsRef = useRef<Map<string, number>>(new Map());
  const dlgRef = useRef<DlgInit | null>(null);
  const menuRef = useRef<
    | { kind: "sel"; tplId: string; lo: number; size: number }
    | { kind: "field"; tplId: string; fid: string; locked: boolean }
    | { kind: "hdr"; tplId: string; nbytes: number }
    | { kind: "ftr"; tplId: string; hasFB: boolean }
    | null
  >(null);
  const [cellSize, setCellSize] = useState(28);
  const [dlg, setDlg] = useState<DlgInit | null>(null);
  const [menuState, setMenuState] = useState<{ x: number; y: number } | null>(null);
  const [tabRev, setTabRev] = useState(0);
  const [errOpen, setErrOpen] = useState(false);
  const [pending, setPending] = useState<{ msg: string; apply?: () => void } | null>(null);
  const [saveSt, setSaveSt] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSave = async () => {
    if (saveSt === "saving") return;
    setSaveSt("saving");
    const ok = await templateStore.saveNow();
    setSaveSt(ok ? "ok" : "err");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveSt("idle"), ok ? 1600 : 4000);
  };
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  protoRef.current = proto;
  teleRef.current = telemetryStore.getSnapshot();
  cellRef.current = cellSize;

  const fcds = useMemo(
    () => proto.rules.templates.filter((t) => t.enabled),
    [proto.rules.templates],
  );
  const tabCounts = useMemo(
    () => fcStore.tplCounts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fcds],
  );
  const groups = useMemo(() => {
    const map = new Map<string, FrameTemplate[]>();
    for (const t of fcds) {
      const key = presetGroupKey(t) ?? t.id;
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()].map(([key, tpls]) => {
      return {
        key,
        label: groupDisplayName(key, tpls[0]),
        color: tpls[0].color,
        tpls,
        cnt: tpls.reduce((a, t) => a + (tabCounts.get(t.id) ?? 0), 0),
      };
    });
  }, [fcds, tabCounts]);

  const curTpl = useMemo(() => {
    const id = tplSelRef.current;
    if (id) return proto.rules.templates.find((t) => t.id === id) ?? null;
    return groups[0]?.tpls[0] ?? fcds[0] ?? null;
  }, [proto.rules.templates, groups, fcds, tabRev]);
  tplSelRef.current = curTpl?.id ?? null;

  const resolved = useMemo(() => {
    const arch = fcStore.archiveRef();
    let fi = viewRef.current.fi;
    if (viewRef.current.live) {
      const tid = curTpl?.id;
      let found = -1;
      for (let i = arch.list.length - 1; i >= 0; i--) {
        if (!tid || arch.list[i].tplId === tid) {
          found = i;
          break;
        }
      }
      fi = found;
    }
    const fr = fi >= 0 && fi < arch.list.length ? arch.list[fi] : null;
    return { fi: Math.max(0, fi), fr };
  }, [tabRev, curTpl]);
  viewRef.current.fi = resolved.fi;
  const liveUI = viewRef.current.live;
  const resolvedRef = useRef(resolved);
  const curRef = useRef(curTpl);
  resolvedRef.current = resolved;
  curRef.current = curTpl;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const zf = r.width > 0 && el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      sizeRef.current = {
        w: r.width / zf,
        h: r.height / zf,
        dpr: (window.devicePixelRatio || 1) * zf,
        zf,
      };
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mo = new MutationObserver(() => {
      dirtyRef.current = true;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    dirtyRef.current = true;
  }, [proto, cellSize]);

  useEffect(() => {
    const unsub = fcStore.subscribe(() => {
      dirtyRef.current = true;
    });
    return () => {
      unsub();
    };
  }, []);

  const drawGapBg = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = "rgba(128,128,160,0.07)";
    rr(ctx, x, y, w, h, 4);
    ctx.fill();
  };

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h, dpr } = sizeRef.current;
    if (w < 10 || h < 10) return;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const cs = getComputedStyle(document.documentElement);
    const dark = document.documentElement.dataset.theme !== "light";
    const cPanel = cs.getPropertyValue("--bg-panel").trim() || "#161a20";
    const cFg = cs.getPropertyValue("--text").trim() || "#d7dde7";
    const cAcc = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cPanel;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${Math.max(8, Math.min(Math.round(cellRef.current * 0.36), 13))}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let real = resolvedRef.current.fr;
    if (viewRef.current.live) {
      const tid = curRef.current?.id;
      const lr = tid ? fcStore.lastOf(tid) : null;
      if (lr) {
        real = lr;
        viewRef.current.fi = fcStore.lastIndexOf(tid!);
      }
    }
    const tplD = curRef.current;
    if (navRef.current) {
      navRef.current.textContent = real
        ? `#${viewRef.current.fi} · ${real.len}B · ${real.tplName}`
        : tplD
          ? "骨架编辑 · 未收流"
          : "";
    }
    const draftLen = !real && tplD ? skeletonLen(tplD) : 0;
    const fr =
      real ??
      (draftLen > 0
        ? {
            tplId: tplD!.id,
            tplName: tplD!.name,
            color: tplD!.color,
            tsMs: 0,
            seq: 0,
            len: draftLen,
            valid: true,
            error: null,
            fields: [],
            bytes: [] as number[],
          }
        : null);
    if (!fr) {
      const tpl = curRef.current;
      if (tpl) {
        const bx = "0x" + tpl.boundary.headerBytes.map((b) => b.toString(16).padStart(2, "0")).join(" ").toUpperCase();
        ctx.fillStyle = dark ? "#5b6371" : "#98a0ab";
        ctx.font = `12px system-ui,sans-serif`;
        ctx.fillText(`暂无「${tpl.name}」的帧数据 — 连接设备或打开演示源`, w / 2, h / 2 - 10);
        ctx.fillText(`帧头 ${bx} · 启用的模板正在过滤数据流`, w / 2, h / 2 + 12);
      }
      return;
    }
    const isDraft = !real;
    const frLen = fr.len;

    const s = cellRef.current;
    const rowsTotal0 = 0;
    void rowsTotal0;
    const sbW = SCROLL_W;
    const fldMap = new Map((tplD?.fields ?? []).map((f) => [f.id, f]));
    const pieces = buildBlocks(curRef.current, frLen);
    const first0 = layoutBlocks(pieces, s, w);
    const sbReserve = first0.rows.length > Math.max(1, Math.floor((h - PAD_T - 6) / first0.rowH)) ? sbW : 0;
    const { rows, rowH } = layoutBlocks(pieces, s, w - sbReserve);
    layoutRef.current = { rows, rowH, s, frLen };

    const sel = selRef.current;
    const hv = hoverRef.current;
    let hoverFldKey: string | null = null;
    if (hv) {
      const tpl0 = curRef.current;
      const fld0 = tpl0 ? findFieldAt(tpl0, hv.off) : null;
      if (fld0) hoverFldKey = `f${fld0.id}`;
    }
    const now = Date.now();
    const rowsTotal = rows.length;
    const visRows = Math.max(1, Math.floor((h - PAD_T - 6) / rowH));
    scrollRef.current = Math.min(Math.max(0, scrollRef.current), Math.max(0, rowsTotal - visRows));
    const r0 = Math.floor(scrollRef.current);
    const r1 = Math.min(rowsTotal, r0 + visRows + 1);

    for (let r = r0; r < r1; r++) {
      const row = rows[r];
      if (row.y + rowH > h + 4) break;
      const yTop = row.y - r0 * rowH;
      for (const it of row.items) {
        const blk = it.blk;
        const x0 = it.x0;
        const x1 = it.x1;
        const wRun = x1 - x0;
        const rl = it.p0 ? 0 : 4;
        const rv = it.p1 ? 0 : 4;
        const itemSel = sel && sel.lo <= it.g1 && sel.hi >= it.g0;
        let hoverHit = false;
        if (hv && blk.kind === "fld" && hv.off >= blk.start && hv.off < blk.start + blk.len) {
          hoverHit = true;
        }
        if (blk.kind === "hdr") {
          ctx.fillStyle = hexA("#e8a33d", dark ? 0.96 : 0.92);
          rrLR(ctx, x0 - 1, yTop, wRun + 2, s, rl, rv);
          ctx.fill();
          if (wRun > 56) {
            ctx.fillStyle = "#fff";
            ctx.fillText("HDR", x0 + 12, yTop + s / 2 + 1);
          }
        } else if (blk.kind === "ftr") {
          ctx.fillStyle = hexA(blk.color, dark ? 0.45 : 0.38);
          rrLR(ctx, x0, yTop, wRun, s, rl, rv);
          ctx.fill();
          ctx.strokeStyle = hexA(blk.color, 0.8);
          rrLR(ctx, x0 + 0.5, yTop + 0.5, wRun - 1, s - 1, rl, rv);
          ctx.stroke();
          if (wRun > 56) {
            ctx.fillStyle = dark ? mixC(cFg, blk.color, 0.7) : "#000000";
            ctx.fillText("CK", x0 + 12, yTop + s / 2 + 1);
          }
        } else if (blk.kind === "fld") {
          const animKey = `${curRef.current?.id}:${blk.fid}`;
          const until = animsRef.current.get(animKey);
          let pulse = 0;
          if (until && now < until) {
            const p = 1 - (until - now) / ANIM_MS;
            pulse = (1 - p) * 0.7;
          }
          ctx.fillStyle = hexA(blk.color, (dark ? 0.46 : 0.38) + pulse);
          rrLR(ctx, x0, yTop, wRun, s, rl, rv);
          ctx.fill();
          ctx.strokeStyle = hexA(blk.color, (dark ? 0.9 : 0.82) + pulse);
          rrLR(ctx, x0 + 0.5, yTop + 0.5, wRun - 1, s - 1, rl, rv);
          ctx.stroke();
          if (blk.locked) {
            ctx.fillStyle = hexA(blk.color, 0.95);
            ctx.fillRect(x0 + 2, yTop + s - 3, 4, 3);
            ctx.beginPath();
            ctx.arc(x0 + 4, yTop + s - 5.5, 2.2, Math.PI, 0);
            ctx.fill();
          }
        } else {
          drawGapBg(ctx, x0, yTop, wRun, s);
        }

        if (blk.kind !== "gap") {
          const tplBT = curRef.current;
          for (let g = it.g0; g <= it.g1 && g < frLen; g++) {
            let bb: number | undefined;
            if (!isDraft) {
              bb = fr.bytes![g];
            } else if (tplBT) {
              if (blk.kind === "hdr" && g < tplBT.boundary.headerBytes.length) {
                bb = tplBT.boundary.headerBytes[g];
              } else if (blk.kind === "ftr" && tplBT.boundary.mode === "footer" && tplBT.boundary.footerBytes?.length) {
                const fb = tplBT.boundary.footerBytes;
                const fStart = frLen - fb.length;
                if (g >= fStart) bb = fb[g - fStart];
              }
            }
            if (bb === undefined && blk.kind === "fld" && blk.fid) {
              const fd = fldMap.get(blk.fid);
              const di = fd ? g - fd.offset : -1;
              if (fd?.disc?.length && di >= 0 && di < fd.disc.length) {
                bb = fd.disc[di];
              }
            }
            const cx = x0 + (g - it.g0) * s + s / 2;
            const txtC =
              blk.kind === "hdr"
                ? "#ffffff"
                : blk.kind === "fld"
                  ? (dark ? mixC(cFg, blk.color, 0.68) : mixC("#000000", blk.color, 0.6))
                  : dark ? mixC(cFg, blk.color, 0.78) : mixC("#000000", blk.color, 0.6);
            ctx.fillStyle = txtC;
            ctx.fillText(bb === undefined ? "--" : bb.toString(16).toUpperCase().padStart(2, "0"), cx, yTop + s / 2 + 1);
          }
        } else {
          for (let g = it.g0; g <= it.g1 && g < frLen; g++) {
            const bb = isDraft ? undefined : fr.bytes![g];
            const cx = x0 + (g - it.g0) * s + s / 2;
            ctx.fillStyle = dark ? "#5b6371" : "#9aa2ad";
            ctx.fillText(bb === undefined ? "··" : bb.toString(16).toUpperCase().padStart(2, "0"), cx, yTop + s / 2 + 1);
          }
        }
        if (it.ax && blk.kind === "fld" && blk.label) {
          const fd = curRef.current?.fields.find((f) => f.id === blk.fid);
          const lv = fd ? teleRef.current.latest[fd.id] : null;
          ctx.font = `9.5px system-ui,sans-serif`;
          ctx.textAlign = "right";
          if (wRun >= 100) {
            const valTxt = lv && lv.valid ? lv.text ?? String(round4(lv.value)) : null;
            if (valTxt && ctx.measureText(valTxt).width <= wRun - 10) {
              ctx.fillStyle = hexA(blk.color, dark ? 0.95 : 0.88);
              ctx.fillText(valTxt, x1 - 5, yTop + 9);
            }
          }
          if (wRun >= 52) {
            const nameW = ctx.measureText(blk.label).width;
            if (nameW <= wRun - 10) {
              ctx.fillStyle = dark ? mixC(cFg, blk.color, 0.66) : mixC("#000000", blk.color, 0.55);
              ctx.fillText(blk.label, x1 - 5, yTop + s - 4);
            }
          }
          ctx.textAlign = "center";
          ctx.font = `${Math.max(8, Math.min(Math.round(s * 0.36), 13))}px ${MONO}`;
        }
        if (it.p1 && blk.kind !== "gap") {
          ctx.strokeStyle = hoverHit ? cAcc : hexA(blk.kind === "hdr" ? "#e8a33d" : blk.color, 0.32);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0 + 2, yTop + s + GAP + 0.8);
          ctx.lineTo(x1 - 2, yTop + s + GAP + 0.8);
          ctx.stroke();
        }
        if (itemSel) {
          const a = Math.max(sel.lo, it.g0);
          const b = Math.min(sel.hi, it.g1);
          const sx = x0 + (a - it.g0) * s;
          const sw = x0 + (b - it.g0) * s + s - sx;
          ctx.fillStyle = hexA(cAcc, 0.18);
          rr(ctx, sx, yTop, sw, s, 3);
          ctx.fill();
          if (!hoverHit) {
            ctx.strokeStyle = cAcc;
            ctx.lineWidth = 1.4;
            rr(ctx, sx + 0.6, yTop + 0.6, sw - 1.2, s - 1.2, 3);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
          if (selDragRef.current) {
            ctx.font = `9px ${MONO}`;
            ctx.fillStyle = dark ? "#5b6371" : "#9aa2ad";
            ctx.textAlign = "left";
            ctx.fillText(`${b - a + 1}B`, sx + sw + 6, yTop + s - 3);
            ctx.font = `${Math.max(8, Math.min(Math.round(s * 0.36), 13))}px ${MONO}`;
            ctx.textAlign = "center";
          }
        }
      }
      if (hoverFldKey) {
        const segs: { x: number; y: number; w: number; first: boolean; last: boolean }[] = [];
        for (let r = r0; r < r1; r++) {
          for (const it of rows[r].items) {
            if (it.blk.key !== hoverFldKey) continue;
            segs.push({
              x: it.x0,
              y: rows[r].y - r0 * rowH,
              w: it.x1 - it.x0,
              first: !it.p0,
              last: !it.p1,
            });
          }
        }
        ctx.fillStyle = hexA(cAcc, 0.06);
        for (const sg of segs) {
          rr(ctx, sg.x - 2, sg.y - 2, sg.w + 4, s + 4, 6);
          ctx.fill();
        }
        ctx.strokeStyle = cAcc;
        ctx.lineWidth = 2;
        for (const sg of segs) {
          ctx.beginPath();
          rrLR(
            ctx,
            sg.x - 2,
            sg.y - 2,
            sg.w + 4,
            s + 4,
            sg.first ? 6 : 0,
            sg.last ? 6 : 0,
          );
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }
      if (rowsTotal > visRows) {
        ctx.strokeStyle = dark ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.06)";
        ctx.strokeRect(0, yTop + rowH + 0.5, w, 1);
      }
    }
    if (rowsTotal > visRows) {
      const trackX = w - SCROLL_W - 2;
      const trackH = h - 10;
      ctx.fillStyle = dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)";
      rr(ctx, trackX, 5, SCROLL_W, trackH, 5);
      ctx.fill();
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      const frac = rowsTotal > visRows ? scrollRef.current / (rowsTotal - visRows) : 0;
      ctx.fillStyle = dragSbRef.current
        ? dark ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.42)"
        : dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.26)";
      rr(ctx, trackX + 2, 5 + frac * (trackH - th), SCROLL_W - 4, th, 4);
      ctx.fill();
    }
    ctx.restore();
    updateTooltip();
  }, []);

  function updateTooltip() {
    const tip = tipRef.current;
    const hv = hoverRef.current;
    if (!tip || !hv || dragSbRef.current || selDragRef.current) {
      if (tip) tip.style.display = "none";
      return;
    }
    const { fr } = resolvedRef.current;
    if (!fr || !fr.bytes || hv.off >= fr.bytes.length) {
      tip.style.display = "none";
      return;
    }
    const b = fr.bytes[hv.off];
    const tpl = curRef.current;
    let field: FieldDef | null = null;
    if (tpl) {
      for (const f of tpl.fields) {
        const sz = fieldSize(f);
        if (hv.off >= f.offset && hv.off < f.offset + sz) {
          field = f;
          break;
        }
      }
    }
    const isHdr = tpl ? hv.off < tpl.boundary.headerBytes.length : false;
    const ascii = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "—";
    let cat: string;
    if (isHdr) cat = "帧头";
    else if (field) {
      const rm = roleOf(field);
      cat = `${ROLE_META[rm].zh}${field.locked ? " 🔒" : ""}${field.role === "checksum" || field.role === "checksum2" || field.role === "footer" ? "（未验证连接）" : ""}`;
    } else cat = "未定义字节";
    const roleChip = field ? ROLE_META[roleOf(field)].tag : "";
    const fieldLine = field
      ? `<div class="fc-tip-row"><span>字段</span><b>${field.name}${roleChip ? ` [${roleChip}]` : ""}</b></div>`
      : "";
    const discLine =
      field && field.disc?.length && hv.off === field.offset
        ? `<div class="fc-tip-row"><span>识别</span><b>${field.disc.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}</b></div>`
        : "";
    let valLine = "";
    if (field) {
      if (hv.off === field.offset) {
        const lv = teleRef.current.latest[field.id];
        if (lv && lv.valid) {
          valLine = `<div class="fc-tip-row"><span>数值</span><b>${lv.text ?? String(round4(lv.value))}${field.unit ? ` ${field.unit}` : ""}</b></div>`;
        }
      }
    }
    tip.innerHTML =
      `<div class="fc-tip-hex">${b.toString(16).toUpperCase().padStart(2, "0")}h</div>` +
      `<div class="fc-tip-row"><span>十进制</span><b>${b}</b></div>` +
      `<div class="fc-tip-row"><span>ASCII</span><b>${ascii}</b></div>` +
      `<div class="fc-tip-row"><span>类别</span><b>${cat}</b></div>` +
      fieldLine +
      discLine +
      valLine +
      `<div class="fc-tip-row"><span>位置</span><b>帧内 ${hv.off} B</b></div>`;
    tip.style.display = "block";
    tip.style.left = `${Math.min(hv.x + 14, sizeRef.current.w - tip.offsetWidth - 10)}px`;
    tip.style.top = `${Math.min(hv.y + 16, sizeRef.current.h - tip.offsetHeight - 10)}px`;
  }

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (animsRef.current.size > 0) dirtyRef.current = true;
      for (const [k, u] of animsRef.current) if (u < Date.now()) animsRef.current.delete(k);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        paint();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paint]);

  const localXY = (ev: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const zf = sizeRef.current.zf || 1;
    return { lx: (ev.clientX - rect.left) / zf, ly: (ev.clientY - rect.top) / zf };
  };

  const hitOffset = (lx: number, ly: number): { off: number } | null => {
    const lay = layoutRef.current;
    if (!lay) return null;
    const { rows, rowH, s } = lay;
    const r0 = Math.floor(scrollRef.current);
    const relRow = Math.floor((ly - PAD_T + r0 * rowH) / rowH);
    if (relRow < 0 || relRow >= rows.length) return null;
    const row = rows[relRow];
    for (const it of row.items) {
      const right = it.x0 + s * (it.g1 - it.g0 + 1) - BLOK_PAD;
      if (lx >= it.x0 && lx < right) {
        const ci = Math.min(Math.max(0, Math.floor((lx - it.x0) / s)), it.g1 - it.g0);
        return { off: it.g0 + ci };
      }
    }
    return null;
  };

  const onDown = (ev: React.MouseEvent) => {
    closeMenu();
    const { lx, ly } = localXY(ev);
    if (ev.button !== 0) return;
    if (lx >= sizeRef.current.w - SCROLL_W - 2) {
      const lay = layoutRef.current;
      if (!lay) return;
      const rowsTotal = lay.rows.length;
      const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
      if (rowsTotal <= visRows) return;
      const trackH = sizeRef.current.h - 10;
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      resizeSB(trackH, th, rowsTotal, visRows, ly);
      return;
    }
    const hit = hitOffset(lx, ly);
    selRef.current = null;
    if (!hit) return;
    selRef.current = { lo: hit.off, hi: hit.off };
    selDragRef.current = { anchor: hit.off, downX: lx, downY: ly, moved: false };
    dirtyRef.current = true;
  };

  function resizeSB(trackH: number, th: number, rowsTotal: number, visRows: number, ly: number) {
    const frac = rowsTotal > visRows ? scrollRef.current / (rowsTotal - visRows) : 0;
    const thumbY = 5 + frac * (trackH - th);
    if (ly >= thumbY && ly <= thumbY + th) {
      dragSbRef.current = { grabY: ly - thumbY, grabScroll: scrollRef.current };
    } else {
      dragSbRef.current = { grabY: th / 2, grabScroll: scrollRef.current };
      scrollRef.current = Math.min(
        Math.max(0, ((ly - PAD_T - th / 2) / Math.max(1, trackH - th)) * Math.max(0, rowsTotal - visRows)),
        Math.max(0, rowsTotal - visRows),
      );
      dirtyRef.current = true;
    }
  }

  const onMove = (ev: React.MouseEvent) => {
    if (dragSbRef.current) {
      const ly = localXY(ev).ly;
      const lay = layoutRef.current;
      if (!lay) return;
      const rowsTotal = lay.rows.length;
      const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
      const trackH = sizeRef.current.h - 10;
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      const frac = (ly - PAD_T - dragSbRef.current.grabY) / Math.max(1, trackH - th);
      scrollRef.current = Math.min(
        Math.max(0, dragSbRef.current.grabScroll + frac * Math.max(0, rowsTotal - visRows)),
        Math.max(0, rowsTotal - visRows),
      );
      dirtyRef.current = true;
      return;
    }
    if (selDragRef.current) {
      const { lx, ly } = localXY(ev);
      const dx = lx - selDragRef.current.downX;
      const dy = ly - selDragRef.current.downY;
      if (Math.abs(dx) + Math.abs(dy) > 4) selDragRef.current.moved = true;
      const p = hitOffset(lx, ly);
      if (!p) {
        dirtyRef.current = true;
        return;
      }
      const lo = Math.min(selDragRef.current.anchor, p.off);
      const hi = Math.max(selDragRef.current.anchor, p.off);
      if (hi >= lo) selRef.current = { lo, hi };
      dirtyRef.current = true;
      return;
    }
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) {
      if (hoverRef.current) {
        hoverRef.current = null;
        if (tipRef.current) tipRef.current.style.display = "none";
        dirtyRef.current = true;
      }
      canvasRef.current!.style.cursor = "default";
      return;
    }
    const prev = hoverRef.current;
    hoverRef.current = { off: p.off, x: lx, y: ly };
    if (!prev || prev.off !== p.off) {
      dirtyRef.current = true;
      updateTooltip();
    }
    const { fr } = resolvedRef.current;
    const tpl = curRef.current;
    let overReserved = false;
    let overField = false;
    if (fr && tpl) {
      const rt = reservedTail(tpl);
      overReserved = p.off < tpl.boundary.headerBytes.length || p.off >= fr.len - rt;
      overField = !!findFieldAt(tpl, p.off);
    }
    canvasRef.current!.style.cursor = overField
      ? "pointer"
      : overReserved
        ? "not-allowed"
        : "crosshair";
  };

  const onUp = (ev: React.MouseEvent) => {
    dragSbRef.current = null;
    if (selDragRef.current) {
      const wasSel = selDragRef.current;
      selDragRef.current = null;
      dirtyRef.current = true;
      if (ev.button !== 2 && !wasSel.moved && selRef.current && selRef.current.hi >= selRef.current.lo) {
        const tpl = curRef.current;
        const fld = tpl ? findFieldAt(tpl, selRef.current.lo) : null;
        if (fld && tpl) {
          templateStore.setSelection({ kind: "field", templateId: tpl.id, fieldId: fld.id });
        } else {
          templateStore.setSelection(null);
        }
        selRef.current = null;
      }
    }
  };

  const findFieldAt = (tpl: FrameTemplate, off: number): FieldDef | null => {
    for (const f of tpl.fields) {
      const sz = fieldSize(f);
      if (off >= f.offset && off < f.offset + sz) return f;
    }
    return null;
  };

  const onCtx = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) {
      closeMenu();
      return;
    }
    const tpl = curRef.current;
    if (!tpl) return;
    const sel = selRef.current;
    if (sel && sel.lo <= sel.hi && p.off >= sel.lo && p.off <= sel.hi) {
      menuRef.current = {
        kind: "sel",
        tplId: tpl.id,
        lo: sel.lo,
        size: sel.hi - sel.lo + 1,
      };
      openMenuAt(ev.clientX, ev.clientY);
      return;
    }
    selRef.current = { lo: p.off, hi: p.off };
    dirtyRef.current = true;
    const fld = findFieldAt(tpl, p.off);
    if (fld) {
      menuRef.current = {
        kind: "field",
        tplId: tpl.id,
        fid: fld.id,
        locked: !!fld.locked,
      };
      openMenuAt(ev.clientX, ev.clientY);
      return;
    }
    const fr = resolvedRef.current.fr;
    if (fr && fr.len > 0) {
      const hb = tpl.boundary.headerBytes;
      const rt = reservedTail(tpl);
      const tailStart = fr.len - rt;
      if (p.off < hb.length) {
        menuRef.current = { kind: "hdr", tplId: tpl.id, nbytes: hb.length };
        openMenuAt(ev.clientX, ev.clientY);
        return;
      }
      if (rt > 0 && p.off >= tailStart && p.off < fr.len) {
        const hasFB = tpl.boundary.mode === "footer";
        menuRef.current = { kind: "ftr", tplId: tpl.id, hasFB };
        openMenuAt(ev.clientX, ev.clientY);
        return;
      }
    }
    menuRef.current = { kind: "sel", tplId: tpl.id, lo: p.off, size: 1 };
    openMenuAt(ev.clientX, ev.clientY);
  };

  const openMenuAt = (cx: number, cy: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    setMenuState({ x: cx - rect.left, y: cy - rect.top });
    dirtyRef.current = true;
  };
  const closeMenu = () => {
    setMenuState(null);
    menuRef.current = null;
  };

  useEffect(() => {
    const up = () => {
      dragSbRef.current = null;
      if (selDragRef.current) {
        const a = selDragRef.current.anchor;
        selDragRef.current = null;
        selRef.current = { lo: a, hi: a };
        dirtyRef.current = true;
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onWheel = (ev: React.WheelEvent) => {
    const lay = layoutRef.current;
    if (!lay) return;
    const rowsTotal = lay.rows.length;
    const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
    const delta = Math.sign(ev.deltaY) * Math.max(1, Math.round(Math.abs(ev.deltaY) / 40)) * 2;
    scrollRef.current = Math.min(Math.max(0, scrollRef.current + delta), Math.max(0, rowsTotal - visRows));
    dirtyRef.current = true;
  };

  const doUndo = () => {
    templateStore.undo();
  };

  const doRedo = () => {
    templateStore.redo();
  };

  const fireAnim = (key: string) => {
    animsRef.current.set(key, Date.now() + ANIM_MS);
    setTimeout(() => (dirtyRef.current = true), ANIM_MS + 20);
    dirtyRef.current = true;
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      ev.shiftKey ? doRedo() : doUndo();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      doRedo();
    } else if (ev.key === "Escape") {
      selRef.current = null;
      closeMenu();
      dirtyRef.current = true;
    } else if (ev.key === "ArrowLeft") {
      setViewF((f) => Math.max(0, f - 1));
    } else if (ev.key === "ArrowRight") {
      setViewF((f) => f + 1);
    }
  };

  const setViewF = (fn: (fi: number) => number) => {
    const arch = fcStore.archiveRef();
    if (arch.list.length === 0) return;
    const ni = Math.min(arch.list.length - 1, Math.max(0, fn(viewRef.current.fi)));
    viewRef.current = { live: false, fi: ni };
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
  };

  const setViewLive = () => {
    viewRef.current = { live: true, fi: 0 };
    dirtyRef.current = true;
  };

  const defineFromMenu = () => {
    const m = menuRef.current;
    closeMenu();
    if (!m || m.kind !== "sel") return;
    dlgRef.current = {
      kind: "field",
      tplId: m.tplId,
      tplName: protoRef.current.rules.templates.find((t) => t.id === m.tplId)?.name ?? "",
      lo: m.lo,
      size: m.size,
      isAscii: false,
    };
    setDlg(dlgRef.current);
  };

  const undefine = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!tpl || !fd) return;
    if (fd.locked) return;
    templateStore.removeField(tplId, fid);
    fireAnim(`un:${fid}`);
    dirtyRef.current = true;
  };

  const toggleLock = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!fd) return;
    templateStore.patchField(tplId, fid, { locked: !fd.locked });
    dirtyRef.current = true;
  };

  const editField = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!tpl || !fd) return;
    closeMenu();
    dlgRef.current = {
      kind: "field",
      tplId,
      tplName: tpl.name,
      lo: fd.offset,
      size: fieldSize(fd),
      edit: true,
      field: fd,
      isAscii: fd.type === "ascii",
    };
    setDlg(dlgRef.current);
  };

  const openHdrDlg = (tplId: string) => {
    closeMenu();
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    if (!tpl) return;
    dlgRef.current = {
      kind: "hdr",
      tplId,
      tplName: tpl.name,
      bytes: [...tpl.boundary.headerBytes],
    };
    setDlg(dlgRef.current);
  };

  const openFtrDlg = (tplId: string) => {
    closeMenu();
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    if (!tpl) return;
    dlgRef.current = {
      kind: "ftr",
      tplId,
      tplName: tpl.name,
      bytes: [...(tpl.boundary.footerBytes ?? [])],
    };
    setDlg(dlgRef.current);
  };

  const onDblClick = (ev: React.MouseEvent) => {
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) return;
    const tpl = curRef.current;
    const fr = resolvedRef.current.fr;
    if (!tpl || !fr || fr.len <= 0) return;
    if (p.off < tpl.boundary.headerBytes.length) {
      openHdrDlg(tpl.id);
      return;
    }
    const rt = reservedTail(tpl);
    if (rt > 0 && p.off >= fr.len - rt && !findFieldAt(tpl, p.off) && tpl.boundary.mode === "footer") {
      openFtrDlg(tpl.id);
    }
  };


  const renderTabs = () => (
    <div className="fc-tabs">
      <div className="fc-tabs-label">协议</div>
      {groups.map((g) => {
        const on = !!curTpl && g.tpls.some((t) => t.id === curTpl!.id);
        return (
          <div className={`fc-tabgrp${on ? " on" : ""}`} key={g.key}>
            <button
              className="fc-tab"
              onClick={() => selectTab(g.tpls.some((t) => t.id === curTpl?.id) ? curTpl!.id : g.tpls[0].id)}
              title="点击切换到该协议"
            >
              <i style={{ background: g.color }} />
              {g.label}
              <span className="fc-tab-cnt">{g.cnt}</span>
            </button>
            {g.tpls.length > 1 && (
              <select
                className="fc-tabsub"
                value={curTpl && g.tpls.some((t) => t.id === curTpl!.id) ? curTpl.id : g.tpls[0].id}
                title="选择帧型"
                onChange={(e) => selectTab(e.target.value)}
              >
                {g.tpls.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{tabCounts.get(t.id) ?? 0}）
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );

  const selectTab = (tid: string) => {
    tplSelRef.current = tid;
    viewRef.current = { live: true, fi: 0 };
    selRef.current = null;
    scrollRef.current = 0;
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
    const cur = templateStore.getSnapshot().selection;
    if (!cur || cur.templateId !== tid) {
      templateStore.setSelection({ kind: "template", templateId: tid });
    }
  };
  void tabRev;

  useEffect(() => {
    const sel = proto.selection;
    if (!sel) return;
    if (tplSelRef.current === sel.templateId) return;
    tplSelRef.current = sel.templateId;
    viewRef.current = { live: true, fi: 0 };
    selRef.current = null;
    scrollRef.current = 0;
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
  }, [proto.selection]);

  return (
    <div className="fc-root" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="fc-toolbar">
        <button
          className={`btn sm icon${saveSt === "ok" ? " saved-ok" : ""}${saveSt === "err" ? " saved-err" : ""}${saveSt === "saving" ? " saving" : ""}`}
          onClick={doSave}
          title={
            saveSt === "err"
              ? "保存失败：模板格式未通过解析内核校验"
              : saveSt === "ok"
                ? "已保存并同步到解析内核"
                : "保存协议模板（立即同步到本地与解析内核）"
          }
        >
          {saveSt === "ok" ? <IconCheck /> : saveSt === "err" ? <IconAlert /> : <IconSave />}
        </button>
        {proto.syncError ? (
          <span
            className={`fc-sync-warn${errOpen ? " open" : ""}`}
            title={proto.syncError}
            onClick={() => setErrOpen((v) => !v)}
          >
            {errOpen ? `校验未通过：${proto.syncError}` : "校验未通过（点击查看原因）"}
          </span>
        ) : null}
        <ArchStat />
        <span className="fc-navinfo" ref={navRef} />
        <label className="fc-cellsz" title="单元格尺寸">
          <input
            type="range"
            min={18}
            max={48}
            value={cellSize}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => setCellSize(Number(e.target.value))}
          />
          <b>{cellSize}</b>
        </label>
        <button className="btn sm icon" onClick={doUndo} title="撤销 (Ctrl+Z)">
          <IconUndo />
        </button>
        <button className="btn sm icon" onClick={doRedo} title="重做 (Ctrl+Y)">
          <IconRedo />
        </button>
        <div className="fc-toolbar-spacer" />
        <button className="btn sm icon nav" onClick={() => setViewF((f) => f - 1)} title="上一帧 (←)">
          <IconPrev />
        </button>
        <button className={`btn sm icon${liveUI ? " primary" : ""}`} onClick={setViewLive} title="跟随最新有效帧（页签切换即跟随该类型）">
          <IconFollow on={liveUI} />
        </button>
        <button className="btn sm icon nav" onClick={() => setViewF((f) => f + 1)} title="下一帧 (→)">
          <IconNext />
        </button>
        <button className="btn sm icon" onClick={() => { fcStore.clearArchive(); viewRef.current = { live: true, fi: 0 }; dirtyRef.current = true; }} title="清空帧归档字节池">
          <IconTrash />
        </button>
      </div>
      {renderTabs()}
      <div className="fc-body" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseDown={onDown}
          onMouseUp={onUp}
          onContextMenu={onCtx}
          onDoubleClick={onDblClick}
          onMouseLeave={() => {
            hoverRef.current = null;
            if (tipRef.current) tipRef.current.style.display = "none";
            dirtyRef.current = true;
          }}
          onWheel={onWheel}
        />
        <div className="fc-tip" ref={tipRef} />
        {menuState &&
          (() => {
            const m = menuRef.current;
            if (!m) return null;
            return (
              <>
                <div className="fc-menu-mask" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
                <div className="fc-menu" style={{ left: menuState.x, top: menuState.y }}>
                  {m.kind === "sel" && (
                    <>
                      <button className="fc-menu-item primary" onClick={defineFromMenu}>
                        ✎ 定义为字段…
                      </button>
                      {(() => {
                        const tpl0 = curRef.current;
                        if (
                          !tpl0 ||
                          tpl0.boundary.mode !== "fixedLength" ||
                          m.size !== 1
                        )
                          return null;
                        const fld0 = findFieldAt(tpl0, m.lo);
                        if (fld0) return null;
                        if (m.lo < tpl0.boundary.headerBytes.length) return null;
                        if (m.lo >= (tpl0.boundary.fixedLength ?? 0)) return null;
                        return (
                          <>
                            <button
                              className="fc-menu-item"
                              onClick={() => {
                                const e2 = templateStore.insertFrameCell(m.tplId, m.lo);
                                closeMenu();
                                if (e2) setPending({ msg: e2 });
                                dirtyRef.current = true;
                              }}
                            >
                              ⤒ 在此格前插入格（帧长 +1）
                            </button>
                            <button
                              className="fc-menu-item"
                              onClick={() => {
                                const e2 = templateStore.deleteFrameCell(m.tplId, m.lo);
                                closeMenu();
                                if (e2) setPending({ msg: e2 });
                                selRef.current = null;
                                dirtyRef.current = true;
                              }}
                            >
                              ✕ 删除此格（帧长 −1）
                            </button>
                          </>
                        );
                      })()}
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        取消选择 (Esc)
                      </button>
                    </>
                  )}
                  {m.kind === "field" && (
                    <>
                      <button
                        className="fc-menu-item"
                        onClick={() => {
                          closeMenu();
                          editField(m.tplId, m.fid);
                        }}
                      >
                        ✎ 编辑字段…
                      </button>
                      <button
                        className="fc-menu-item danger"
                        disabled={m.locked}
                        onClick={() => {
                          closeMenu();
                          undefine(m.tplId, m.fid);
                        }}
                      >
                        ⨯ 取消字段定义{m.locked ? "（已锁定）" : ""}
                      </button>
                      <button
                        className="fc-menu-item"
                        onClick={() => {
                          closeMenu();
                          toggleLock(m.tplId, m.fid);
                        }}
                      >
                        {m.locked ? "🔓 解锁字段" : "🔒 锁定字段"}
                      </button>
                    </>
                  )}
                  {m.kind === "hdr" && (
                    <>
                      <button className="fc-menu-item primary" onClick={() => openHdrDlg(m.tplId)}>
                        ✎ 编辑帧头…<span className="fc-menu-sub">当前 {m.nbytes} 字节</span>
                      </button>
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        取消选择 (Esc)
                      </button>
                    </>
                  )}
                  {m.kind === "ftr" && (
                    <>
                      {m.hasFB ? (
                        <button className="fc-menu-item primary" onClick={() => openFtrDlg(m.tplId)}>
                          ✎ 编辑帧尾字节…<span className="fc-menu-sub">双击亦可</span>
                        </button>
                      ) : (
                        <button className="fc-menu-item" disabled>
                          校验尾（长度由校验算法决定）
                        </button>
                      )}
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        取消选择 (Esc)
                      </button>
                    </>
                  )}
                </div>
              </>
            );
          })()}
        {pending && (
          <div className="modal-mask" onMouseDown={() => setPending(null)}>
            <div className="modal fc-confirm" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-title">字段冲突</div>
              <div className="fc-confirm-body">{pending.msg}</div>
              <div className="modal-foot">
                <span />
                <button className="btn" onClick={() => setPending(null)}>取消</button>
                {pending.apply && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      pending.apply?.();
                      setPending(null);
                    }}
                  >
                    覆盖并继续
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {dlg &&
          (dlg.kind === "field" ? (
            <FieldDialog
              init={dlg}
              onCancel={() => setDlg(null)}
              onOk={(f) => {
                const applyIt = () => {
                  if (dlg.edit && dlg.field) {
                    templateStore.patchField(dlg.tplId, dlg.field.id, {
                      id: dlg.field.id,
                      name: f.name,
                      role: f.role,
                      type: f.type,
                      endian: f.endian,
                      scale: f.scale,
                      unit: f.unit,
                      color: f.color,
                      size: f.size,
                      csvDelim: f.csvDelim,
                      csvType: f.csvType,
                    });
                    fireAnim(`${dlg.tplId}:${dlg.field.id}`);
                  } else {
                    templateStore.addField(dlg.tplId, f);
                    fireAnim(`${dlg.tplId}:${f.id}`);
                  }
                  setDlg(null);
                  selRef.current = null;
                  dirtyRef.current = true;
                };
                const base = dlg.edit && dlg.field ? dlg.field : f;
                const c = templateStore.fieldConflictInfo(
                  dlg.tplId,
                  base.id,
                  f.offset,
                  fieldSize({ ...base, ...f }),
                );
                if (c.overFrame) {
                  setPending({ msg: `无法保存：${c.overFrame}。请先增大「总帧长/最大帧长」或缩小字段。` });
                  return;
                }
                if (c.overlapName) {
                  setPending({
                    msg: `保存后将覆盖字段「${c.overlapName}」的前 ${c.overlapBytes} 字节。是否继续？`,
                    apply: applyIt,
                  });
                  return;
                }
                applyIt();
              }}
            />
          ) : (
            <HeadTailDialog
              init={dlg}
              onCancel={() => setDlg(null)}
              onSave={(bytes) => {
                if (dlg.kind === "hdr") {
                  templateStore.patchBoundary(dlg.tplId, { headerBytes: bytes });
                } else {
                  templateStore.patchBoundary(dlg.tplId, { footerBytes: bytes });
                }
                setDlg(null);
                selRef.current = null;
                dirtyRef.current = true;
              }}
            />
          ))}
        <ArchEmptyGate>
          {!curTpl && (
            <div className="fc-empty">
              <div className="fc-empty-title">等待有效帧…</div>
              <div className="fc-empty-desc">
                这里只呈现通过「协议模板」校验的完整数据帧。
                {serial.status !== "connected" ? "可先连接设备或启动演示源；" : ""}
                添加预设协议请用左侧「＋ 预设」。
              </div>
            </div>
          )}
        </ArchEmptyGate>
      </div>
    </div>
  );
}


type DlgInit =
  | {
      kind: "field";
      tplId: string;
      tplName: string;
      lo: number;
      size: number;
      edit?: boolean;
      field?: FieldDef | null;
      isAscii: boolean;
    }
  | { kind: "hdr" | "ftr"; tplId: string; tplName: string; bytes: number[] };

function parseHex(text: string): number[] | null {
  const t = text.trim().replace(/，/g, " ");
  if (!t) return [];
  const words = t.split(/[\s,;]+/).filter((w) => w.length > 0);
  const out: number[] = [];
  for (const w of words) {
    const v = parseInt(w, 16);
    if (!/^0x[0-9a-fA-F]{1,2}$/.test(w) && !/^[0-9a-fA-F]{1,2}$/.test(w)) return null;
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    out.push(v);
  }
  return out;
}

function HeadTailDialog({
  init,
  onSave,
  onCancel,
}: {
  init: Extract<DlgInit, { kind: "hdr" | "ftr" }>;
  onSave: (bytes: number[]) => void;
  onCancel: () => void;
}) {
  const isHdr = init.kind === "hdr";
  const [text, setText] = useState(
    init.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
  );
  const [err, setErr] = useState<string | null>(null);
  const protoLive = useSyncExternalStore(
    templateStore.subscribe,
    templateStore.getSnapshot,
  );
  useEffect(() => {
    const t = protoLive.rules.templates.find((x) => x.id === init.tplId);
    if (!t) return;
    const live = isHdr
      ? t.boundary.headerBytes
      : t.boundary.footerBytes ?? [];
    const cur = parseHex(text);
    const same =
      cur !== null &&
      cur.length === live.length &&
      cur.every((b, i) => b === live[i]);
    if (!same) {
      setText(
        live.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
      );
    }
  }, [protoLive, init.tplId, isHdr]);
  const bump = (n: number) => {
    const cur = parseHex(text);
    if (!cur) return;
    if (n > 0) {
      setText(
        [...cur.map((b) => b.toString(16).toUpperCase().padStart(2, "0")), "00"].join(" "),
      );
    } else if (cur.length > 0) {
      const next = cur.slice(0, cur.length - 1);
      setText(next.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "));
    }
    setErr(null);
  };
  const save = () => {
    const ws = parseHex(text);
    if (ws === null) {
      setErr("输入无效：仅接受 0–255 的十六进制字节，如 AA 55 0C");
      return;
    }
    onSave(ws);
  };
  const curLen = parseHex(text)?.length ?? null;

  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div className="fc-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fc-dlg-title">
          {isHdr ? "编辑帧头" : "编辑帧尾"}{" "}
          <span className="fc-dlg-sub">
            {init.tplName} · 十六进制字节序列
          </span>
        </div>
        <div className="fc-dlg-row">
          <label className="fc-sb-l">字节</label>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              e.stopPropagation();
            }}
            placeholder={isHdr ? "如 AA 55" : "如 0D 0A 或 2C"}
          />
        </div>
        <div className="fc-dlg-row fc-sb-row">
          <span className={`fc-sb-info${curLen === null ? " bad" : ""}`}>
            {curLen === null ? "解析失败" : `当前 ${text.trim() ? curLen : 0} 字节 · 空格/逗号分隔`}
          </span>
          <button className="btn sm" onClick={() => bump(-1)} disabled={!curLen || curLen <= 0} title="去掉末尾一个字节">
            −1 字节
          </button>
          <button className="btn sm" onClick={() => bump(1)} title="末尾追加一个 00 字节">
            +1 字节
          </button>
        </div>
        {isHdr ? (
          <div className="fc-dlg-warn soft">
            帧头可为空（从首字节直接收集）；无需帧头的帧请在属性面板将模式改为「固定帧尾」。
          </div>
        ) : (
          <div className="fc-dlg-warn soft">
            帧尾字节为空时，该模板将被引擎以「缺少帧尾字节」拒绝，需在属性面板补充帧尾或换用「长度字段」成帧方式。
          </div>
        )}
        {err && <div className="fc-dlg-warn">{err}</div>}
        <div className="fc-dlg-foot">
          <button className="btn" onClick={() => { setText(""); setErr(null); }}>清空</button>
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={save}>保存生效</button>
        </div>
      </div>
    </div>
  );
}

const ROLE_GROUPS: { label: string; roles: FieldRole[] }[] = [
  { label: "定位", roles: ["header", "addr", "id", "seq", "length"] },
  { label: "数据", roles: ["data", "payload"] },
  { label: "校验", roles: ["checksum", "checksum2", "footer"] },
];

function FieldDialog({
  init,
  onOk,
  onCancel,
}: {
  init: Extract<DlgInit, { kind: "field" }>;
  onOk: (f: FieldDef) => void;
  onCancel: () => void;
}) {
  const recs = SIZE_TYPES[init.size] ?? [];
  const defType: FieldType = recs[0] ?? "uint8";
  const [name, setName] = useState(NAME_HINTS[init.size]?.[0] ?? `字段${init.lo}`);
  const [type, setType] = useState<FieldType>(defType);
  const [endian, setEndian] = useState<"little" | "big">("little");
  const [role, setRole] = useState<FieldRole>(init.field?.role ?? "data");
  const [scale, setScale] = useState("");
  const [unit, setUnit] = useState(init.field?.unit ?? "");
  const [color, setColor] = useState(init.field?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [csvDelim, setCsvDelim] = useState(init.field?.csvDelim ?? ",");
  const [csvType, setCsvType] = useState(init.field?.csvType ?? "float32");
  useEffect(() => {
    if (init.field && init.edit) {
      setType(init.field.type);
      setEndian(init.field.endian);
      setScale(init.field.scale != null ? String(init.field.scale) : "");
      if (init.field.csvDelim) setCsvDelim(init.field.csvDelim);
      if (init.field.csvType) setCsvType(init.field.csvType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const needsEndian = type === "uint16" || type === "int16" || type === "uint32" || type === "int32" || type === "float32" || type === "float64";
  const fixedSize = fieldSize({ id: "", name: "", role: "data", offset: 0, type, endian, color: "" });
  const mismatched = init.isAscii ? false : recs.length > 0 && !recs.includes(type);

  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div className="fc-dlg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fc-dlg-title">
          {init.edit ? "编辑字段" : "定义字段"}{" "}
          <span className="fc-dlg-sub">
            {init.tplName} · 帧内偏移 {init.lo} · 长度 {init.size}B
          </span>
        </div>
        {init.size !== fixedSize && (
          <div className="fc-dlg-warn">所选类型占 {fixedSize}B ≠ 选区 {init.size}B — 请核对长度</div>
        )}
        {mismatched && (
          <div className="fc-dlg-warn soft">智能推荐:{recs.map((r) => TYPE_LABEL[r]).join(" / ")}（{init.size}字节）</div>
        )}
        <div className="fc-dlg-row">
          <label>名称</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 温度值" />
        </div>
        <div className="fc-dlg-row">
          <label>协议角色</label>
          <div className="fc-dlg-roles">
            {ROLE_GROUPS.map((grp) => (
              <div className="fc-dlg-roles-g" key={grp.label}>
                <span className="fc-dlg-roles-l">{grp.label}</span>
                {grp.roles.map((rl) => (
                  <button
                    key={rl}
                    className={`fc-role-chip${role === rl ? " on" : ""}`}
                    style={{ "--chipc": ROLE_META[rl].chip } as React.CSSProperties}
                    onClick={() => setRole(rl)}
                  >
                    <i />
                    {ROLE_META[rl].zh}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="fc-dlg-row">
          <label>数据类型</label>
          <select value={type} onChange={(e) => setType(e.target.value as FieldType)}>
            {(recs.length ? [...recs, ...TYPE_ORDER.filter((t) => !recs.includes(t))] : TYPE_ORDER).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
                {recs.includes(t) ? " ✓推荐" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="fc-dlg-row">
          <label>字节序</label>
          <select value={endian} onChange={(e) => setEndian(e.target.value as "little" | "big")} disabled={!needsEndian}>
            <option value="little">小端 LE（低前）</option>
            <option value="big">大端 BE（高前）</option>
          </select>
        </div>
        {type === "csv" && (
          <>
            <div className="fc-dlg-warn soft">
              自适应分隔数值（JustFloat 式）：覆盖本字段区到校验/帧尾前，按每帧实际段数动态输出 通道1…通道N（上限 64）。
            </div>
            <div className="fc-dlg-row">
              <label>分隔符</label>
              <input
                value={csvDelim}
                onChange={(e) => setCsvDelim(e.target.value)}
                placeholder="如 , 或 \\ 或 ;"
                style={{ width: 90 }}
              />
            </div>
            <div className="fc-dlg-row">
              <label>元素类型</label>
              <select value={csvType} onChange={(e) => setCsvType(e.target.value)}>
                <option value="float32">float（小数）</option>
                <option value="uint8">uint8</option>
                <option value="int8">int8</option>
                <option value="uint16">uint16</option>
                <option value="int16">int16</option>
                <option value="uint32">uint32</option>
                <option value="int32">int32</option>
                <option value="float64">float64</option>
              </select>
            </div>
          </>
        )}
        <div className="fc-dlg-row">
          <label>缩放倍率</label>
          <input value={scale} onChange={(e) => setScale(e.target.value)} placeholder="如 0.01 或 100" />
        </div>
        <div className="fc-dlg-row">
          <label>单位</label>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="如 °C" />
        </div>
        <div className="fc-dlg-row">
          <label>颜色</label>
          <div className="fc-dlg-colors">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="fc-color-picker"
              title="自由取色"
            />
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`fc-color-chip${color === c ? " on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn primary"
            onClick={() =>
              onOk({
                id: init.field?.id ?? crypto.randomUUID(),
                name: name.trim() || `字段${init.lo}`,
                role,
                offset: init.lo,
                type,
                endian,
                scale: scale.trim() ? Number(scale) : null,
                unit: unit.trim() || null,
                color,
                size: type === "ascii" || type === "bcd" ? init.size : null,
                bits: init.field?.bits ?? null,
                locked: init.field?.locked ?? false,
                csvDelim: type === "csv" ? csvDelim || "," : null,
                csvType: type === "csv" ? csvType : null,
              })
            }
          >
            {init.edit ? "保存修改" : "确认定义"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FrameCanvas;
