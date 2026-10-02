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
import type { ChecksumAlgo, CrcParams, Endian, FieldRole, FieldType } from "../../ipc/types";
import { widthOf } from "../protocol/fieldTypes";

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

/**
 * 发送谱上「一块」能标哪些角色。料板/属性行（`SendBuildPanel`）与 AI 产谱（`aiActions`）
 * 共用这一份，两边不许各持一张表。
 *
 * 刻意**不含 `checksum2`**：接收侧有附加校验，发送侧的编码器第三趟只 `find` 得到第一个
 * 校验段，第二个会留在 0x00——那是一扇看着能推、推开是空房间的门（与"缺值就报错不静默"
 * 这条编码器规矩同一路）。真要用两段校验（匿名 V7 的 SC+AC），得先把编码器补成按段各算。
 */
export const SEND_FIELD_ROLES: FieldRole[] = [
  "header",
  "addr",
  "id",
  "seq",
  "length",
  "data",
  "payload",
  "checksum",
  "footer",
];

/**
 * 字段类型 → 参数类型：u16 块不该自动长出一个带参数的有符号 int。
 * 组帧台（料板与参数行）与 AI 产谱共用这一份，两边不许各猜一张表。
 */
export const paramTypeOf = (t: FieldType): SendParamType =>
  t === "float32" || t === "float64" ? "float" : t.startsWith("u") ? "uint" : "int";

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

/** 档位表 → 编辑用的一行文本（`启动=01; 停止=00`），与 `parseEnumSpec` 往返一致 */
export const formatEnumSpec = (map: SendParam["enumMap"]): string =>
  (map ?? []).map((e) => `${e.label}=${e.value}`).join("; ");

/**
 * 一行 `启动=01; 停止=00` → 档位表。
 *
 * 为什么不照抄接收侧 `parseLabelSpec` 的"认不出来就跳过"：那是一张**注释**，跳掉一档只是少一行
 * 说明；这一张表决定发出去的字节。悄悄丢一档的症状是"我明明写了停止，按下去却报「不在档位里」"，
 * 而那句报错还是编码器说的实话——没人知道自己那一档是被界面弄丢的。所以坏条目原样交回界面点名
 * （`parseHexInput` 的 `bad` 同一路）。
 *
 * `dupes` 单独算：编码器按 `find` 取第一条，同名两档时后写的那档**永远发不出去**，
 * 而这件事不报错、不显眼 —— 正是这一族最贵的静默。
 */
export function parseEnumSpec(text: string): {
  map: { label: string; value: string }[];
  bad: string[];
  dupes: string[];
} {
  const map: { label: string; value: string }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[;；\r\n]/)) {
    const t = raw.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    const label = i > 0 ? t.slice(0, i).trim() : "";
    const value = i > 0 ? t.slice(i + 1).trim() : "";
    if (!label || !value) {
      bad.push(t);
      continue;
    }
    map.push({ label, value });
  }
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const e of map) {
    if (seen.has(e.label) && !dupes.includes(e.label)) dupes.push(e.label);
    seen.add(e.label);
  }
  return { map, bad, dupes };
}

export interface SendTemplate {
  id: string;
  name: string;
  note: string;
  fields: SendField[];
  params: SendParam[];
  /** 覆盖范围与接收侧同语义：负数终点 = 距帧尾 */
  checksum: { algo: ChecksumAlgo; coverageStart: number; coverageEnd: number; crc?: CrcParams | null } | null;
  /**
   * 下一帧要用的自增序号（D9）。它**属于这张谱**而不是属于某个调用方：
   * 同一张谱可以从面板、命令库、卡片、序列器四处发，计数器若各存一份，
   * 设备看到的 seq 就会跳号——那正是我们做这个字段要解决的问题。
   */
  nextSeq: number;
  groupKey?: string;
  /**
   * P122-B 来处标注：这张谱是从哪个**解析协议**起头的（照帧反推时记下那帧所属的模板）。
   * 只记录不同步；名字在渲染时按 id 查，不烘进数据里（改了名还能认得出，改了 id 就说已删除）。
   */
  fromTplId?: string;
  createdAt: number;
}

/**
 * 带内换位的目标下标。
 * 往前挪（`from < index`）要让回一格：被拖的那块先被摘掉，后面的下标整体左移了一位；
 * 往后挪不用让。这条写错的症状是"往右拖一格却跳两格"。
 */
export function moveTargetIndex(from: number, index: number): number {
  return from < index ? index - 1 : index;
}

/**
 * 字段宽度：与接收侧**同一张表**（`protocol/fieldTypes.widthOf`）。
 * 变长类型没声明长度 ⇒ 0 —— 编码器与网格都不再自己猜一个数（历史上发送按 1、接收按 4，
 * 两边各自猜就成了"能解出来却发不出去"的一类根因）。
 */
export function sendFieldWidth(f: SendField): number {
  return widthOf(f.type, f.size) ?? 0;
}
