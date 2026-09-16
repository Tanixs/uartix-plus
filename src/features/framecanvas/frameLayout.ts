import type { FieldDef, FieldRole, FrameTemplate } from "../../ipc/types";
import { fieldSize } from "../protocol/fieldTypes";
import { tx } from "../../i18n/strings";

export const PAD_L = 10;
export const PAD_T = 12;
export const PAD_R = 14;
export const BLOK_PAD = 4;
export const ROW_XTRA = 8;

export interface Blk {
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

export interface Item {
  g0: number;
  g1: number;
  x0: number;
  x1: number;
  p0: boolean;
  p1: boolean;
  ax: boolean;
  blk: Blk;
}

export interface Row {
  y: number;
  items: Item[];
}

export interface Layout {
  rows: Row[];
  rowH: number;
  s: number;
  frLen: number;
}

export function checksumLen(algo: string | null): number {
  if (!algo || algo === "none") return 0;
  if (algo === "sum8" || algo === "xor8") return 1;
  if (algo === "crc32") return 4;
  return 2;
}

export interface CovRun {
  lo: number;
  len: number;
  kind: "fld" | "gap";
}

/** 字段在某一帧长下的有效区间（P85a）：负偏移→距帧尾解析；
 *  变长帧校验字段→引擎强制锚尾（parser.rs verify 同构）；
 *  spanTail→伸到保留区/后继字段前。与 parser.rs、buildBlocks 三方共享的唯一真相。 */
export interface EffRange {
  start: number;
  len: number;
  span: boolean;
}

export function effStartRaw(f: FieldDef, frameLen: number): number {
  return f.offset < 0 && frameLen > 0 ? frameLen + f.offset : f.offset;
}

export function effRange(
  tpl: FrameTemplate,
  f: FieldDef,
  frameLen: number,
  sorted?: FieldDef[],
): EffRange | null {
  const hb = tpl.boundary.headerBytes.length;
  const sz0 = fieldSize(f);
  const ckVar = tpl.boundary.mode !== "fixedLength";
  const spanT =
    !!f.spanTail &&
    f.offset >= 0 &&
    (f.role === "data" || f.role === "payload") &&
    f.type !== "csv";
  if (f.offset < 0) {
    if (frameLen <= 0) return null;
    const start = Math.max(hb, frameLen + f.offset);
    const len = Math.min(sz0, frameLen - start);
    if (len <= 0 || start < 0 || start >= frameLen) return null;
    return { start, len, span: false };
  }
  if (f.role === "checksum" && ckVar && frameLen > 0) {
    const start = Math.max(hb, frameLen - footerTail(tpl) - sz0);
    const len = Math.min(sz0, frameLen - start);
    if (len <= 0) return { start, len: 0, span: false };
    return { start, len, span: false };
  }
  if (spanT && frameLen > 0) {
    const end = Math.max(f.offset, frameLen - (checksumTail(tpl) + footerTail(tpl)));
    const list = sorted ?? [...tpl.fields].sort(
      (a, b) => effStartRaw(a, frameLen) - effStartRaw(b, frameLen),
    );
    const nf = list[list.indexOf(f) + 1];
    const nextEff = nf ? effStartRaw(nf, frameLen) : end;
    const nextOff = nf && nextEff > f.offset ? nextEff : end;
    const len = Math.min(end, nextOff) - f.offset;
    return { start: f.offset, len, span: true };
  }
  return { start: f.offset, len: sz0, span: false };
}

export function coverageRuns(tpl: FrameTemplate, frameLen: number): CovRun[] {
  const covered = new Uint8Array(Math.max(0, frameLen));
  for (const f of tpl.fields) {
    const er = effRange(tpl, f, frameLen);
    if (!er || er.len <= 0) continue;
    for (let i = er.start; i < Math.min(frameLen, er.start + er.len); i++) {
      if (i >= 0) covered[i] = 1;
    }
  }
  const runs: CovRun[] = [];
  let i = 0;
  while (i < frameLen) {
    const isGap = covered[i] === 0;
    let j = i;
    while (j < frameLen && (covered[j] === 0) === isGap) j++;
    runs.push({ lo: i, len: j - i, kind: isGap ? "gap" : "fld" });
    i = j;
  }
  return runs;
}

export function checksumTail(tpl: FrameTemplate): number {
  return tpl.checksum && tpl.checksum.algo !== "none"
    ? checksumLen(tpl.checksum.algo)
    : 0;
}

export function footerTail(tpl: FrameTemplate): number {
  return tpl.boundary.mode === "footer" && tpl.boundary.footerBytes?.length
    ? tpl.boundary.footerBytes.length
    : 0;
}

export function reservedTail(tpl: FrameTemplate): number {
  return checksumTail(tpl) + footerTail(tpl);
}

export function skeletonLen(tpl: FrameTemplate): number {
  if (tpl.boundary.mode === "fixedLength" && tpl.boundary.fixedLength) {
    return tpl.boundary.fixedLength;
  }
  let end = tpl.boundary.headerBytes.length;
  for (const f of tpl.fields) {
    if (f.offset < 0) {
      end = Math.max(end, -f.offset);
      continue;
    }
    const sz = fieldSize(f);
    if (sz > 0) end = Math.max(end, f.offset + sz);
  }
  end += reservedTail(tpl);
  return Math.min(64, Math.max(8, end + 4));
}

export function buildBlocks(tpl: FrameTemplate | null, frLen: number): Blk[] {  if (!tpl) {
    const gap: Blk = { start: 0, len: frLen, key: "g0", kind: "gap", fid: null, color: "", label: null, role: null, locked: false };
    return [gap];
  }
  const hb = tpl.boundary.headerBytes;
  const pieces: Blk[] = [];
  if (hb.length > 0) {
    pieces.push({ start: 0, len: hb.length, key: "h0", kind: "hdr", fid: null, color: "#e8a33d", label: tx("帧头", "Header"), role: null, locked: false });
  }
  const fields = [...tpl.fields].sort((a, b) => {
    const ea = a.offset < 0 ? frLen + a.offset : a.offset;
    const eb = b.offset < 0 ? frLen + b.offset : b.offset;
    return ea - eb;
  });
  let pos = hb.length;
  for (let fi = 0; fi < fields.length; fi++) {
    const f = fields[fi];
    const er = effRange(tpl, f, frLen, fields);
    const sz = er ? er.len : fieldSize(f);
    const blkStart = er ? er.start : f.offset;
    const spanT = er?.span ?? false;
    if (hb.length > 0 && blkStart >= 0 && blkStart + sz <= hb.length) continue;
    if (blkStart > pos) {
      pieces.push({ start: pos, len: blkStart - pos, key: `g${pos}`, kind: "gap", fid: null, color: "", label: null, role: null, locked: false });
    }
    if (sz > 0 && blkStart >= 0 && blkStart < frLen) {
      const m = Math.min(sz, frLen - blkStart);
      pieces.push({
        start: blkStart,
        len: m,
        key: `f${f.id}`,
        kind: "fld",
        fid: f.id,
        color: f.color,
        label: spanT ? `${f.name} ↔` : f.name,
        role: f.role,
        locked: !!f.locked,
      });
    }
    if (blkStart + sz > pos) pos = blkStart + sz;
  }
  pos = Math.min(pos, frLen);
  const tailLen = Math.min(checksumTail(tpl) + footerTail(tpl), frLen);
  const tailStart = Math.max(pos, frLen - tailLen);
  if (tailStart > pos) {
    pieces.push({
      start: pos,
      len: tailStart - pos,
      key: `g${pos}`,
      kind: "gap",
      fid: null,
      color: "",
      label: null,
      role: null,
      locked: false,
    });
  }
  if (tailStart < frLen) {
    pieces.push({
      start: tailStart,
      len: frLen - tailStart,
      key: "ck0",
      kind: "ftr",
      fid: null,
      color: "#db61a2",
      label: footerTail(tpl) > 0 ? tx("帧尾", "Footer") : tx("校验", "Checksum"),
      role: null,
      locked: false,
    });
  }
  if (pieces.length === 0) {
    pieces.push({ start: 0, len: frLen, key: "g0", kind: "gap", fid: null, color: "", label: null, role: null, locked: false });
  }
  pieces.sort((a, b) => a.start - b.start);
  const merged: Blk[] = [];
  for (const p of pieces) {
    if (p.kind === "gap") {
      const end = Math.min(p.start + p.len, frLen);
      if (end <= p.start) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.kind === "gap" && p.start <= prev.start + prev.len) {
        prev.len = Math.max(prev.start + prev.len, end) - prev.start;
      } else {
        merged.push({ ...p, len: end - p.start });
      }
    } else {
      merged.push(p);
    }
  }
  return merged;
}

export function layoutBlocks(
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
      const vw = avail();
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
