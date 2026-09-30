/**
 * P121-B · 发送谱的数据形状。
 *
 * 为什么要新建一个实体而不是复用 `FrameTemplate`：`templateStore` 会把全量 templates
 * `debounce → invoke("parser_set_rules")` 下发给 Rust 解析器（详设 §2 D1）。发送谱混进去，
 * 等于让解析器收到一批"没有 boundary、没有识别位、根本不能用来解析"的模板 ——
 * 轻则帧型页签长出假条目，重则整份规则集被 `validate()` 打回。
 *
 * 但**词汇只有一份**：`type` / `endian` / `role` 与字节宽表全部复用接收侧那几张
 * （`ipc/types.ts` 与 `protocol/fieldTypes.ts`）。这一条是本设计的全部价值所在——
 * 今天发送侧的 `UserSeg` 自有一套 `u8/u16/…/le:boolean`，比接收侧少了 f64/bcd/bits，
 * 字节序也只剩一个布尔，于是"能发出去却解不回来"和"能解出来却发不出去"两个方向都会发生。
 */
import type { ChecksumAlgo, Endian, FieldRole, FieldType } from "../../ipc/types";

/** 一个字段的可变来源。四种，且只有这四种（详设 D3：来源写在字段上，不散进字符串） */
export type SendSource =
  /** 固定字节：帧头、帧尾、写死的操作码 */
  | { kind: "const"; bytes: number[] }
  /** 参数：触发时可以改（参数条 / 控件卡片绑的就是它） */
  | { kind: "param"; paramId: string }
  /** 绑解析出的实时变量：与 `{变量}` 同一套名字，但这里是**取不到就报错**，不原样发出 */
  | { kind: "var"; name: string }
  /** 自增帧序号（D9）：step 默认 1，wrap 默认按位宽回绕 */
  | { kind: "seq"; step?: number; wrap?: number }
  /** 长度域（D1）：covers 决定它数的是谁 */
  | { kind: "len"; covers: "self" | "after" | "body"; adjust?: number };

export interface SendField {
  id: string;
  name: string;
  /** 与接收侧同一张枚举；`csv` 在发送侧暂不支持（编码器会明确报错，不静默出字节） */
  type: FieldType;
  /** 变长类型（ascii/bcd）的字节数；定长类型忽略它，宽度由 `type` 决定 */
  size?: number;
  endian: Endian;
  role: FieldRole;
  /** 位段：`(值 << index) & mask` 落在自己那一字节里，与 Rust `decode_fields` 的 bits 同式 */
  bits?: { index: number; count: number };
  source: SendSource;
  color?: string;
  locked?: boolean;
}

export type SendParamType = "int" | "uint" | "float" | "text" | "enum";

export interface SendParam {
  id: string;
  name: string;
  type: SendParamType;
  min?: number;
  max?: number;
  /** 默认值一律按字符串存：界面上填的就是字符串，按 type 校验后才变数 */
  def: string;
  /** enum：界面标签 → 要发的值（"启动" → "01"） */
  enumMap?: { label: string; value: string }[];
}

export interface SendTemplate {
  id: string;
  name: string;
  note: string;
  fields: SendField[];
  params: SendParam[];
  /** 覆盖范围与接收侧同语义：负数终点 = 距帧尾 */
  checksum: { algo: ChecksumAlgo; coverageStart: number; coverageEnd: number } | null;
  /**
   * 下一帧要用的自增序号（D9）。它**属于这张谱**而不是属于某个调用方：
   * 同一张谱可以从面板、命令库、卡片、序列器四处发，计数器若各存一份，
   * 设备看到的 seq 就会跳号——那正是我们做这个字段要解决的问题。
   */
  nextSeq: number;
  groupKey?: string;
  createdAt: number;
}

/**
 * 落点判定（半格吸附）：指针越过某块的中线才算"插到它后面"。
 * 空带 = 0；落在所有块右边 = `rects.length`（追加）。
 * 抽成纯函数是因为这台机器上进不去真实输入（CDP 的鼠标事件到不了页面），
 * 至少这条规则得有断言钉着。
 */
export function dropIndexAt(rects: { left: number; width: number }[], clientX: number): number {
  for (let i = 0; i < rects.length; i++) {
    if (clientX < rects[i].left + rects[i].width / 2) return i;
  }
  return rects.length;
}

/**
 * 带内换位的目标下标。
 * 往前挪（`from < index`）要让回一格：被拖的那块先被摘掉，后面的下标整体左移了一位；
 * 往后挪不用让。这条写错的症状是"往右拖一格却跳两格"。
 */
export function moveTargetIndex(from: number, index: number): number {
  return from < index ? index - 1 : index;
}

/** 字段宽度：定长类型查表，变长类型取 `size`（bcd 默认 2 字节，与 `fieldSize()` 同兜底） */
export function sendFieldWidth(f: SendField): number {
  switch (f.type) {
    case "ascii":
      return Math.max(1, f.size ?? 1);
    case "bcd":
      return Math.max(1, f.size ?? 2);
    case "csv":
      return Math.max(1, f.size ?? 1);
    default: {
      const w = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8, bits: 1 }[
        f.type
      ];
      return w;
    }
  }
}
