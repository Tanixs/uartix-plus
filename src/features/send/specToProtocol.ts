/**
 * P122-B · 发送谱 → 解析协议 的投影（与 `fromFrame.ts` 那条反推是**相反方向**的一座桥）。
 *
 * 为什么这座桥比反推可靠：谱是确定的生成器 —— 每一块的类型、字节序、宽度都写在自己身上，
 * 顺序就是帧里的顺序。把"顺序 + 宽度"写成绝对偏移是**无损**的，不像从一帧字节反推那样要猜校验。
 *
 * 但有三处必须明说，因为它们不是谱自己的事实，而是这一帧的事实：
 *  1. 变长块（ascii/bcd）的字节数跟着**值**走。这里取的是"刚才编出来的那一帧"的长度，
 *     并把它写进块的 size。值变长变短就会错位 —— 要真变长得在属性里开「变长载荷」。
 *  2. 帧头是猜的：拿开头连续的 const 块当同步字。猜不出来就不填，让解析链路第一步空着说。
 *  3. 覆盖范围的终点，发送侧**含**它自己那一格、解析侧**不含**（`coverageSlice` 用 `end+1`，
 *     `parser.rs` 用 `cov_start..cov_end`）。直接抄数字会少算一字节，所以这里换算一次。
 */
import type { Boundary, ChecksumCfg, FieldDef, FieldType } from "../../ipc/types";
import { checksumWidth, checksumWireEndian } from "../../shared/checksums";
import { sendFieldWidth, type SendField, type SendTemplate } from "./sendTypes";

export class DeriveError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DeriveError";
  }
}

export interface DerivedTpl {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
  boundary: Boundary;
  checksum: ChecksumCfg | null;
  fields: FieldDef[];
  /** 来处：只记录"从哪张谱派来"，不做同步（两边各改各的，谁也不许偷偷改对方） */
  fromSpecId: string;
}

const isCk = (r: string) => r === "checksum" || r === "checksum2";

/** 校验字段该是什么类型：宽度决定类型，与 `templateStore.setChecksumAlgo` 同规则 */
const ckType = (size: number): FieldType => (size === 1 ? "uint8" : size === 2 ? "uint16" : "uint32");

/**
 * 发送侧的覆盖终点 → 解析侧的终点。
 *
 * 负数两边同义（距帧尾几个字节），正数发送侧含自身、解析侧不含 —— 差一格。
 */
export function covEndToReceive(end: number): number {
  return end < 0 ? end : end + 1;
}

/** 这块在这一帧里占几个字节：const 看它自己的字节数，校验看算法，其余看声明的宽度 */
function widthIn(f: SendField, frame: number[], at: number, ckSize: number): number {
  if (isCk(f.role)) return ckSize;
  if (f.source.kind === "const") return f.source.bytes.length;
  const declared = sendFieldWidth(f);
  // 变长类型没声明 size：这一帧里它到底有几个字节是**看得见**的，就用看见的那个数，
  // 而不是替它猜一个（历史上接收侧默认 4、发送侧默认 1）
  if (declared === 0 && (f.type === "ascii" || f.type === "bcd")) {
    return Math.max(0, frame.length - at);
  }
  return declared;
}

/** 帧头：开头连续几块 const（通常是那一块"帧头"）；一块都没有就不猜 */
function headerRun(fields: SendField[]): number[] {
  const out: number[] = [];
  for (const f of fields) {
    if (f.source.kind !== "const" || isCk(f.role)) break;
    out.push(...f.source.bytes);
  }
  return out;
}

export function toReceiveTpl(
  spec: SendTemplate,
  frame: number[],
  opts: { id: string; name?: string; color?: string },
): { tpl: DerivedTpl; notes: string[] } {
  if (!spec.fields.length) throw new DeriveError(`发送谱「${spec.name}」一个字段都没有，派生不出协议`);
  if (!frame.length) throw new DeriveError(`发送谱「${spec.name}」这一帧是空的，派生不出协议`);
  const notes: string[] = [];
  const ckSize =
    spec.checksum && spec.checksum.algo !== "none"
      ? checksumWidth(spec.checksum.algo, spec.checksum.crc)
      : 0;
  const fields: FieldDef[] = [];
  let at = 0;
  let lenBlock: { at: number; size: number; endian: SendField["endian"]; covers: string; adjust?: number } | null = null;
  let empty = 0;

  for (const f of spec.fields) {
    const w = widthIn(f, frame, at, ckSize);
    if (w <= 0) {
      // 一块不占字节的 const（清空了的固定字节）在帧里根本不存在 —— 协议里也不该有它
      empty++;
      continue;
    }
    if (at + w > frame.length) {
      throw new DeriveError(
        `块「${f.name}」在第 ${at} 字节要占 ${w} 字节，可这一帧只有 ${frame.length} 字节 —— 谱与帧对不上，先别派生`,
      );
    }
    const type: FieldType = isCk(f.role) ? ckType(w) : f.type === "csv" ? "ascii" : f.type;
    if (f.type === "csv") {
      notes.push(`块「${f.name}」是 csv（解析侧的显示类型，发不出去）：按 ascii 定长 ${w} 字节放进协议`);
    }
    const needSize = f.type === "ascii" || f.type === "bcd" || type === "ascii";
    if (needSize && sendFieldWidth(f) === 0) {
      notes.push(
        `块「${f.name}」没声明字节数：按这一帧的实际长度 ${w} 定了下来。值长度一变就会错位，真要变长在属性里开「变长载荷」`,
      );
    }
    if (f.source.kind === "len") {
      lenBlock = { at, size: w, endian: f.endian, covers: f.source.kind === "len" ? f.source.covers : "after", adjust: f.source.adjust };
    }
    fields.push({
      // 字段 id 原样带过来：两边指的是同一块，回头对得上账
      id: f.id,
      name: f.name,
      role: f.role,
      offset: at,
      type,
      endian: f.endian,
      size: needSize ? w : null,
      color: f.color || opts.color || "#8a93a6",
      bits: f.bits ?? null,
    });
    at += w;
  }
  if (empty) notes.push(`有 ${empty} 块不占字节（空的固定字节），没进协议`);
  if (at !== frame.length) {
    notes.push(`铺到第 ${at} 字节，而这一帧有 ${frame.length} 字节：末尾 ${frame.length - at} 字节没有块认领`);
  }

  const headerBytes = headerRun(spec.fields);
  if (!headerBytes.length) {
    notes.push("没认出帧头（开头第一块不是固定字节）：解析链路第一步（同步字）留空，需要你在属性里补");
  }

  // 定界：有长度域且有帧头才用「长度字段」，否则退回定长（引擎按帧头同步，没头就没法用长度域）
  let boundary: Boundary;
  if (lenBlock && headerBytes.length) {
    const hb = headerBytes.length;
    const adj =
      lenBlock.adjust ??
      (lenBlock.covers === "self" ? 0 : lenBlock.covers === "body" ? hb : hb + lenBlock.size);
    boundary = {
      mode: "lengthField",
      headerBytes,
      maxLength: Math.max(64, frame.length * 4),
      lengthOffset: lenBlock.at,
      lengthSize: lenBlock.size,
      lengthEndian: lenBlock.endian,
      lengthAdjust: adj,
    };
    notes.push(
      `长度域在第 ${lenBlock.at} 字节（${lenBlock.size} 字节，${lenBlock.covers === "after" ? "数帧头之后的字节" : lenBlock.covers === "body" ? "含自身" : "数整帧"}）→ 总帧长 = 值 + ${adj}`,
    );
  } else {
    boundary = { mode: "fixedLength", headerBytes, fixedLength: frame.length, maxLength: Math.max(64, frame.length * 4) };
    if (lenBlock) {
      notes.push(
        `有长度域但没认出帧头：长度域当普通字段解析，帧长按这一帧定死为 ${frame.length} 字节`,
      );
    }
  }

  let checksum: ChecksumCfg | null = null;
  if (spec.checksum && spec.checksum.algo !== "none") {
    checksum = {
      algo: spec.checksum.algo,
      coverageStart: spec.checksum.coverageStart,
      coverageEnd: covEndToReceive(spec.checksum.coverageEnd),
      endian: checksumWireEndian(spec.checksum.algo, spec.checksum.crc),
      crc: spec.checksum.crc ?? null,
    };
    notes.push(
      `校验 ${spec.checksum.algo}：终点按解析侧口径换算成 ${checksum.coverageEnd}（发送侧含自身、解析侧不含，差一格）`,
    );
  }

  return {
    tpl: {
      id: opts.id,
      name: opts.name ?? `${spec.name}·解析`,
      color: opts.color || "#8a93a6",
      enabled: true,
      boundary,
      checksum,
      fields,
      fromSpecId: spec.id,
    },
    notes,
  };
}
