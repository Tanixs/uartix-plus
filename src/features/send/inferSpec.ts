/**
 * P121-E · 从收到的一帧反推一张发送谱（#92 剩下那块）。
 *
 * 这条功能只有一个立足点：**反推出来的谱，编回去必须逐字节等于这一帧**。
 * 所以结构上不是"先猜再补救"，而是**把候选从推得最多排到最不推，逐个整帧重编，
 * 第一个对得上的就是答案**，全不对上就退回"整段定长字节"（那是恒等变换，必然成立）。
 * 校验段同理：尾巴是不是某支算法算出来的，一次重算就能定，不猜。
 *
 * 为什么不复用 `xray/crackChecksum`：那是给同一种帧的 ≥8 条采样用的统计穷举
 * （它自己就写了行数不足直接返回空）。这里手上只有一帧，要的不是命中率，是"能不能复现"。
 */
import { CHECKSUM_WIDTHS, crc16, crc32, sum16, sum8, sumadd16, xor8 } from "../../shared/checksums";
import type { ChecksumAlgo, Endian, FieldRole } from "../../ipc/types";
import { encodeSend, SendEncodeError } from "./encodeSend";
import type { SendField, SendTemplate } from "./sendTypes";

/** 接收模板给出的字段边界：一帧这才切成有名字的块，而不是一整坨字节 */
export interface InferField {
  name: string;
  role: FieldRole;
  offset: number;
  size: number;
  endian?: Endian;
}

export interface InferOpts {
  name?: string;
  fields?: InferField[];
}

export interface InferResult {
  tpl: SendTemplate;
  /** 这张草稿替用户做了什么 / 哪一步退回了 —— 同时写进谱的备注 */
  notes: string[];
}

export class InferError extends Error {
  constructor(msg: string) {
    super(`反推失败：${msg}`);
    this.name = "InferError";
  }
}

/**
 * 校验段候选。`order` 是这支算法在 `encodeSend` 里的落帧字节序 —— 两边不一致，
 * 最后那道整帧重编的闸口就会不过，所以这条对齐由判据本身守着，不靠注释。
 */
const CK_CANDIDATES: { algo: ChecksumAlgo; calc: (b: number[]) => number; order: "lo" | "hi" }[] = [
  { algo: "sum8", calc: sum8, order: "lo" },
  { algo: "xor8", calc: xor8, order: "lo" },
  { algo: "sumadd", calc: sumadd16, order: "lo" },
  { algo: "sum16", calc: sum16, order: "lo" },
  { algo: "crc16_modbus", calc: (b) => crc16("modbus", b), order: "lo" },
  { algo: "crc16_x25", calc: (b) => crc16("x25", b), order: "lo" },
  { algo: "crc16_ccitt", calc: (b) => crc16("ccitt-false", b), order: "hi" },
  { algo: "crc32", calc: (b) => crc32(b) >>> 0, order: "hi" },
];

function layCk(v: number, size: number, order: "lo" | "hi"): number[] {
  const out: number[] = [];
  for (let i = size - 1; i >= 0; i--) out.push((v >>> (i * 8)) & 0xff);
  return order === "lo" ? out.reverse() : out;
}

/**
 * 尾巴是不是某支算法算出来的？是就给出算法名、字节数与覆盖起点。
 *
 * **这里必须排序，不能"第一个对上就走"**：单帧上"末尾这几个字节恰好等于某段的前缀和"
 * 是可以巧合成立的 —— 1 字节算法的偶然率约 1/256，而覆盖起点还有四种可试。
 * 所以取**最强证据**：字节数多的优先（4 ≫ 2 ≫ 1），同尺寸按现场常见度排，
 * 再同则取覆盖起点更小的（整帧覆盖比"跳过帧头"更常见）。
 * `alternatives` 是同样能对上、但更弱的解释个数，由调用处写进备注 —— 不确定性要交底。
 */
const ALGO_RANK: ChecksumAlgo[] = [
  "crc32",
  "crc16_modbus",
  "crc16_ccitt",
  "crc16_x25",
  "sumadd",
  "sum16",
  "sum8",
  "xor8",
];

export interface ChecksumHit {
  algo: ChecksumAlgo;
  size: number;
  covStart: number;
  /** 同样能复现这一帧的更弱解释有几支 */
  alternatives: number;
}

export function detectChecksum(bytes: number[]): ChecksumHit | null {
  const hits: { algo: ChecksumAlgo; size: number; covStart: number }[] = [];
  for (const covStart of [0, 1, 2, 3]) {
    for (const c of CK_CANDIDATES) {
      const size = CHECKSUM_WIDTHS[c.algo];
      if (!size || bytes.length <= covStart + size) continue;
      const want = layCk(c.calc(bytes.slice(covStart, bytes.length - size)), size, c.order);
      const got = bytes.slice(bytes.length - size);
      if (want.every((v, i) => v === got[i])) hits.push({ algo: c.algo, size, covStart });
    }
  }
  if (!hits.length) return null;
  hits.sort(
    (a, b) =>
      b.size - a.size ||
      ALGO_RANK.indexOf(a.algo) - ALGO_RANK.indexOf(b.algo) ||
      a.covStart - b.covStart,
  );
  const best = hits[0];
  // 同一支算法换个覆盖起点也能对上，不算"另一种解释"：那只是起点不同，不是证据不同
  const alternatives = new Set(hits.slice(1).map((h) => `${h.algo}:${h.size}`)).size;
  return { ...best, alternatives };
}

let uidSeed = 0;
const fid = () => `inf${++uidSeed}`;

function constField(name: string, role: FieldRole, bytes: number[], endian: Endian = "big"): SendField {
  return {
    id: fid(),
    name,
    type: bytes.length >= 4 ? "uint32" : bytes.length === 2 ? "uint16" : "uint8",
    size: bytes.length,
    endian,
    role,
    source: { kind: "const", bytes: [...bytes] },
  };
}

function ckField(name = "校验"): SendField {
  // 校验段的宽度由算法决定，来源必须是 const 且留空：编码器会按 checksumWidth 覆盖它
  return { id: fid(), name, type: "uint8", endian: "big", role: "checksum", source: { kind: "const", bytes: [] } };
}

function hexOf(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function blankTpl(name: string): SendTemplate {
  return { id: "draft", name, note: "", fields: [], params: [], checksum: null, nextSeq: 0, createdAt: Date.now() };
}

/** 整帧重编一遍，逐字节对得上才算这张候选成立 */
function roundTrips(tpl: SendTemplate, bytes: number[]): boolean {
  try {
    return encodeSend(tpl, { seq: tpl.nextSeq }).hex === hexOf(bytes);
  } catch (e) {
    if (!(e instanceof SendEncodeError)) throw e;
    return false;
  }
}

/**
 * 按边界把帧切成定长字节块。有空洞就补一个「未覆盖」块、有重叠就整个跳过那块 ——
 * 宁可名字难看，也不裁头去尾猜一个看起来整齐的布局。
 */
function blocksFromLayout(bytes: number[], fields: InferField[]): SendField[] | null {
  const sorted = [...fields].filter((f) => f.size > 0 && f.offset >= 0).sort((a, b) => a.offset - b.offset);
  const out: SendField[] = [];
  let cursor = 0;
  for (const f of sorted) {
    if (f.offset > bytes.length) break;
    if (f.offset < cursor) continue;
    if (f.offset > cursor) out.push(constField(`未覆盖${cursor}`, "data", bytes.slice(cursor, f.offset)));
    const size = Math.min(f.size, bytes.length - f.offset);
    const slice = bytes.slice(f.offset, f.offset + size);
    out.push(
      f.role === "checksum" || f.role === "checksum2"
        ? { ...ckField(f.name || "校验"), role: f.role }
        : constField(f.name || `字段${out.length + 1}`, f.role, slice, f.endian ?? "big"),
    );
    cursor = f.offset + size;
  }
  if (cursor < bytes.length) out.push(constField(`未覆盖${cursor}`, "data", bytes.slice(cursor)));
  return out.length ? out : null;
}

/**
 * 长度域的回填方式。`covers` 与 `adjust` 都不靠猜：每一种都是一个候选，
 * 由外层那道整帧重编闸口裁决。只有一块长度域时才做这件事 ——
 * 多块的时候组合数会长成"试"而不是"推"，那种谱不如交给用户摆。
 */
function lengthCombos(blocks: SendField[]): { covers: "self" | "after" | "body"; adjust: number }[] | null {
  const n = blocks.filter((f) => f.role === "length").length;
  if (n !== 1) return null;
  const out: { covers: "self" | "after" | "body"; adjust: number }[] = [];
  for (const covers of ["after", "self", "body"] as const) for (const adjust of [0, -1, 1, -2, 2]) out.push({ covers, adjust });
  return out;
}

function applyLength(blocks: SendField[], combo: { covers: "self" | "after" | "body"; adjust: number }): SendField[] {
  return blocks.map((f) =>
    f.role === "length" ? { ...f, source: { kind: "len" as const, covers: combo.covers, adjust: combo.adjust } } : f,
  );
}

/** 序号块：起点取这一帧里的值，第一次发原样复现、之后自己往上走 */
function applySeq(blocks: SendField[]): { fields: SendField[]; nextSeq: number; note: string } | null {
  const f = blocks.find((x) => x.role === "seq");
  if (!f || f.source.kind !== "const") return null;
  const v = f.source.bytes.reduce((a, b) => ((a << 8) | b) >>> 0, 0);
  return {
    fields: blocks.map((x) => (x === f ? { ...x, source: { kind: "seq" as const, step: 1 } } : x)),
    nextSeq: v,
    note: `序号域「${f.name}」起点取这一帧的 ${v}`,
  };
}

/** 长度域回填的文字说明（写进 notes，也写进谱的备注） */
function lengthNote(blocks: SendField[], combo: { covers: string; adjust: number }): string {
  const f = blocks.find((x) => x.role === "length");
  return `长度域「${f?.name ?? "?"}」按长度回填（${combo.covers}${combo.adjust ? ` 调整 ${combo.adjust > 0 ? "+" : ""}${combo.adjust}` : ""}）`;
}

/**
 * 反推入口。产出的谱一定满足 `encodeSend(谱).hex === 这一帧`，否则这里就抛错，
 * 而不是交出一张"看着像"的草稿。
 */
export function inferSendSpec(bytes: number[], opts: InferOpts = {}): InferResult {
  if (!bytes.length) throw new InferError("这一帧是空的");
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new InferError("字节里有不在 0~255 的整数");
  const notes: string[] = [];
  const ck = detectChecksum(bytes);
  const tpl = blankTpl(opts.name?.trim() || `照帧起的谱 ${new Date().toLocaleTimeString()}`);
  if (ck) {
    tpl.checksum = { algo: ck.algo, coverageStart: ck.covStart, coverageEnd: -ck.size };
    notes.push(`尾部 ${ck.size} 字节是 ${ck.algo}（覆盖自第 ${ck.covStart} 字节起，不含校验段本身）`);
    if (ck.size === 1) {
      notes.push("只有 1 字节的校验证据：单帧上偶然率约 1/256，这一帧若本来没校验，把校验段删掉即可");
    }
    if (ck.alternatives) notes.push(`另有 ${ck.alternatives} 支更弱的算法也能复现这帧的尾巴，取了最强的那个`);
  } else {
    notes.push("尾巴上没有能验出的校验段：草稿不带校验，要就在面板里加");
  }

  const body = ck ? bytes.slice(0, bytes.length - ck.size) : bytes;
  const laid = opts.fields?.length ? blocksFromLayout(body, opts.fields) : null;

  // 候选从"推得最多"到"最不推"。校验段那一块补在末尾（布局里已经有校验域的就不补）
  const withCk = (fields: SendField[]): SendField[] =>
    ck && !fields.some((f) => f.role === "checksum" || f.role === "checksum2") ? [...fields, ckField()] : fields;
  type Cand = { fields: SendField[]; nextSeq: number; note?: string; kind: "inferred" | "const" | "blob" };
  const candidates: Cand[] = [];
  if (laid) {
    const base = withCk(laid);
    const combos = lengthCombos(base);
    const seq = applySeq(base);
    if (combos) {
      for (const c of combos) {
        if (seq) {
          const s = applySeq(applyLength(base, c));
          if (s) candidates.push({ fields: s.fields, nextSeq: s.nextSeq, note: `${seq.note}；${lengthNote(base, c)}`, kind: "inferred" });
        }
        candidates.push({ fields: applyLength(base, c), nextSeq: 0, note: lengthNote(base, c), kind: "inferred" });
      }
    }
    if (seq) candidates.push({ fields: seq.fields, nextSeq: seq.nextSeq, note: seq.note, kind: "inferred" });
    candidates.push({ fields: base, nextSeq: 0, kind: "const" });
  }
  candidates.push({ fields: withCk(body.length ? [constField("帧体", "data", body)] : []), nextSeq: 0, kind: "blob" });

  for (const c of candidates) {
    const trial: SendTemplate = { ...tpl, fields: c.fields, nextSeq: c.nextSeq };
    if (!roundTrips(trial, bytes)) continue;
    if (c.note) notes.push(c.note);
    if (c.kind === "const") notes.push("长度域/序号怎么回填都对不上这一帧，已按定长字节放");
    if (c.kind === "blob" && laid) notes.push("字段边界对不上这一帧，整帧按一段定长字节放");
    const out = notes.filter(Boolean);
    trial.note = out.join("；");
    return { tpl: trial, notes: out };
  }
  throw new InferError("所有候选都编不回这一帧");
}
