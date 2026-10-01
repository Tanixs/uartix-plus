/**
 * P122-A · 组帧台字节网格的模型：一格 = 一个**将要发出的字节**。
 *
 * 两条规矩都是从取证里长出来的，写在这儿免得下一个人再撞一次：
 *
 *  1. **块宽必须来自 `encodeSend` 的 spans**，不许自己按类型推。ascii 块的字节数由
 *     **值**决定（编码器直接铺 utf8，不做 padding），拿 `sendFieldWidth` 累加会得到
 *     与实际帧不符的格数——编码器里那段注释早就在说这件事（`encodeSend.ts` 的 spans）。
 *     网格照它那份用，真值才只有一份。
 *  2. **逐格可写只发生在 const 块**。别的块的字节 = 类型 + 值 + 字节序的结果，
 *     让格子直接收字节等于在网格里再造一个绕过类型的编码器，与 P121 立的
 *     "预览与发送同源"打架。校验段虽然是 const 来源，值却是算出来的，所以它也不可写。
 *
 * 编码失败时**没有字节可画**：`predictedBlocks` 只摆块的顺序与声明宽度，不画格子也不画尺。
 * 这是刻意的降级——把"猜的宽度"画成格子，用户会以为那就是要发出去的东西。
 */
import type { FieldRole, FieldType } from "../../ipc/types";
import { checksumWidth } from "../../shared/checksums";
import { sendFieldWidth, type SendField, type SendTemplate } from "./sendTypes";

/** 一格的字面宽。CSS 里不重复写这个数：轨道宽与段宽全从这里算，两处写就必然对不齐 */
export const CELL_W = 22;
export const CELL_GAP = 2;
export const PITCH = CELL_W + CELL_GAP;
/** 行首那条偏移槽的宽度：网格的尺就是它，与 HexView 的地址栏同一族 */
export const RULER_W = 30;
/** 0 字节块画成的那个点的宽度 */
export const POINT_W = 10;
export const MIN_COLS = 4;
export const MAX_COLS = 24;
/**
 * 条带上画块名的最小段宽（P123-A）。一格宽的块只有 20px，两字中文名必被裁成
 * "帧…"再压一层选中环 —— 帧画布同一层用的是 34px 门槛（`FrameCanvas.tsx:998`），
 * 这里取同一个数：不够宽就只留色块，名字交给悬浮提示。
 */
export const LABEL_MIN_W = 34;

export interface GridBlock {
  fieldId: string;
  name: string;
  role: FieldRole;
  /** 字段类型：网格本身不靠它算宽度，但"这块能不能拖宽"要说得出是谁 */
  type: FieldType;
  color: string;
  /** 起始字节下标；0 字节的块也有一条这样的边界 */
  start: number;
  len: number;
  /** 逐格可写：只有 const 来源且不是校验段 */
  editable: boolean;
}

export interface GridSeg {
  block: GridBlock;
  /** 行内起始字节下标 */
  start: number;
  len: number;
  /** 接上一行的续段：不重复写块名 */
  cont: boolean;
  /** 0 字节的块：画成边界上的一个点——它不占格子，但必须还能被点中和拖走 */
  point: boolean;
}

export interface GridRow {
  idx0: number;
  cells: number;
  segs: GridSeg[];
  cov: { start: number; len: number }[];
}

export interface GridModel {
  blocks: GridBlock[];
  /** 第 i 格属于哪一块。null 只在编码器的 spans 没盖住全部字节时出现（画成空格并说明） */
  owner: (GridBlock | null)[];
  bytes: number[];
  total: number;
  /** 校验覆盖到的字节区间，已按"负终点 = 距帧尾"归一化；没有校验 ⇒ null */
  cov: { start: number; len: number } | null;
}

/** 编码器给得出这两样才画格子 */
export interface EncodedSpans {
  bytes: number[];
  spans: { fieldId: string; at: number; len: number }[];
}

export const isCkRole = (r: FieldRole): boolean => r === "checksum" || r === "checksum2";

const blockOf = (f: SendField, start: number, len: number): GridBlock => ({
  fieldId: f.id,
  name: f.name,
  role: f.role,
  type: f.type,
  color: f.color ?? "",
  start,
  len,
  editable: f.source.kind === "const" && !isCkRole(f.role),
});

/**
 * 覆盖范围归一化。与 `encodeSend.coverageSlice` 逐字同式：**正终点含它自己那一格**，
 * 负终点按"距帧尾"算。这条语义写错的症状是覆盖带比真正参与计算的范围多一格。
 */
export function coverageRange(
  start: number,
  end: number,
  total: number,
): { start: number; len: number } | null {
  if (total <= 0) return null;
  const from = Math.max(0, start);
  const to = end < 0 ? total + end : Math.min(total, end + 1);
  if (to <= from) return null;
  return { start: from, len: to - from };
}

export function gridModel(tpl: SendTemplate, enc: EncodedSpans | null): GridModel {
  const byId = new Map(tpl.fields.map((f) => [f.id, f]));
  const blocks: GridBlock[] = [];
  const bytes = enc?.bytes ?? [];
  if (enc) {
    for (const s of enc.spans) {
      const f = byId.get(s.fieldId);
      if (f) blocks.push(blockOf(f, s.at, s.len));
    }
  }
  const total = bytes.length;
  const owner: (GridBlock | null)[] = new Array<GridBlock | null>(total).fill(null);
  for (const b of blocks) {
    for (let i = b.start; i < Math.min(total, b.start + b.len); i++) owner[i] = b;
  }
  const ck = tpl.checksum && tpl.checksum.algo !== "none" ? tpl.checksum : null;
  return {
    blocks,
    owner,
    bytes,
    total,
    cov: ck ? coverageRange(ck.coverageStart, ck.coverageEnd, total) : null,
  };
}

/** 编码还没通过时的降级条带：宽度是**声明**的，不是算出来的，所以调用方不画格子 */
export function predictedBlocks(tpl: SendTemplate): GridBlock[] {
  const out: GridBlock[] = [];
  let at = 0;
  for (const f of tpl.fields) {
    // const 块的字节数就是它自己那个数组的长度（`fieldBytes` 原样铺出来），
    // 拿类型宽会把 4 字节的帧头画成 1 格 —— 条带立刻与真帧错位
    const declared =
      isCkRole(f.role) && tpl.checksum && tpl.checksum.algo !== "none"
        ? checksumWidth(tpl.checksum.algo, tpl.checksum.crc)
        : f.source.kind === "const"
          ? f.source.bytes.length
          : sendFieldWidth(f);
    const len = Number.isFinite(declared) && declared > 0 ? declared : 0;
    out.push(blockOf(f, at, len));
    at += len;
  }
  return out;
}

export function rowsOf(model: GridModel, cols: number): GridRow[] {
  const n = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(cols)));
  const rows: GridRow[] = [];
  for (let idx0 = 0; idx0 < model.total; idx0 += n) {
    const end = Math.min(idx0 + n, model.total);
    const segs: GridSeg[] = [];
    for (const b of model.blocks) {
      if (b.len === 0) {
        // 点归它左边那一行的开头；正好落在行末的点交给下一行当行首，只画一次
        if (b.start < idx0 || b.start > end) continue;
        if (b.start === end && end < model.total) continue;
        segs.push({ block: b, start: b.start - idx0, len: 0, cont: false, point: true });
        continue;
      }
      const s = Math.max(b.start, idx0);
      const e = Math.min(b.start + b.len, end);
      if (e <= s) continue;
      segs.push({ block: b, start: s - idx0, len: e - s, cont: s > b.start, point: false });
    }
    const cov: { start: number; len: number }[] = [];
    if (model.cov && model.cov.start < end && model.cov.start + model.cov.len > idx0) {
      const s = Math.max(model.cov.start, idx0);
      const e = Math.min(model.cov.start + model.cov.len, end);
      cov.push({ start: s - idx0, len: e - s });
    }
    rows.push({ idx0, cells: end - idx0, segs, cov });
  }
  return rows;
}

/**
 * 落在某条字节边界上时，插到第几块前面。
 *
 * 0 字节的点**贴在边界的右侧**：同一边界上的插入排在它前面。反过来的话
 * （`start + 0 <= boundary` 也算"在它之前"）那个点就永远插不到前面去了。
 */
export function insertIndexAtBoundary(blocks: GridBlock[], boundary: number): number {
  let n = 0;
  for (const b of blocks) {
    if (b.len > 0 ? b.start + b.len <= boundary : b.start < boundary) n++;
  }
  return n;
}

/** 插入指示条该亮在哪一格的哪一侧 */
export function caretAt(
  model: GridModel,
  at: number,
): { cell: number; side: "left" | "right" } | null {
  if (model.total === 0) return null;
  const boundary = at >= 0 && at < model.blocks.length ? model.blocks[at].start : model.total;
  if (boundary < model.total) return { cell: boundary, side: "left" };
  return { cell: model.total - 1, side: "right" };
}

/**
 * 这一截是不是那块的收尾那一截。
 *
 * 把手只许画在块的右端：跨行的块有两条截，中间那道断口不是块的边界。
 * 注意 `seg.start` 是**行内**偏移而 `block.start` 是**全局**偏移 —— 拿行内偏移直接比块长
 * 会错（第一版就错了：那样只有起点正好在 0 的块才有把手）。
 */
export const segEndsBlock = (rowIdx0: number, seg: GridSeg): boolean =>
  !seg.point && rowIdx0 + seg.start + seg.len === seg.block.start + seg.block.len;

/** 段在行内的像素位置。点画在边界中央，越界的一边夹回来 */
export function segBox(seg: GridSeg): { left: number; width: number } {
  if (seg.point) {
    return { left: Math.max(0, seg.start * PITCH - POINT_W / 2), width: POINT_W };
  }
  return { left: seg.start * PITCH, width: seg.len * PITCH - CELL_GAP };
}

/**
 * 编码报错时把错误指到块上。
 *
 * 这是**显示层**的启发式：`SendEncodeError` 的话术一律点名字段（`「名字」`），
 * 所以拿名字回认一次就能把那块标红。认不出返回 ""，界面只剩那句错误原文——
 * 宁可不标，也不猜一个看着像的。
 */
export function guessBadFieldId(msg: string, tpl: SendTemplate): string {
  for (const f of tpl.fields) {
    if (f.name && msg.includes(`「${f.name}」`)) return f.id;
  }
  return "";
}

export const hexByte = (b: number): string => b.toString(16).padStart(2, "0").toUpperCase();

/** 拖边界能拖到的上限：再宽就不是"一块字段"而是一段报文了 */
export const MAX_BLOCK_W = 64;

/** 拖动量 → 新宽度：一格一字节，四舍五入到整格，夹在 1~MAX_BLOCK_W */
export function resizeWidthBy(current: number, dx: number, pitch: number = PITCH): number {
  return Math.min(MAX_BLOCK_W, Math.max(1, current + Math.round(dx / pitch)));
}

/**
 * 这块能不能拖宽，以及拖完该改什么。
 *
 * 只有"宽度真的是自己说得上"的块才给把手：
 *  · const —— 它的字节数组就是它的宽度（拖宽补 00，拖窄砍尾）；
 *  · bcd —— 声明的 size 直接决定编出几个字节。
 * `ascii` 刻意不给：编码器铺的是值的 UTF-8，不 padding 也不截断，
 * 给它一个把手就是做一个"拖了什么都不改"的假开关（§8-34）。
 * 定长数值类型的宽度由类型决定，也不是能拖的东西。
 */
export function resizedField(f: SendField, width: number): Partial<SendField> | null {
  if (f.source.kind === "const" && !isCkRole(f.role)) {
    const bytes = f.source.bytes.slice(0, width);
    while (bytes.length < width) bytes.push(0);
    return { source: { kind: "const", bytes } };
  }
  if (f.type === "bcd" && !isCkRole(f.role)) return { size: width };
  return null;
}

export const canResize = (f: SendField): boolean =>
  (f.source.kind === "const" && !isCkRole(f.role)) || (f.type === "bcd" && !isCkRole(f.role));
