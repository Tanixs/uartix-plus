export type PanelId =
  | "templates"
  | "hexview"
  | "properties"
  | "controls"
  | "console"
  | "table"
  | "plot2d"
  | "view3d"
  | "framecanvas"
  | "video"
  | "ai"
  | "xray"
  | "modbus"
  | "sequencer"
  | "sentinel";

export interface PanelMeta {
  id: PanelId;
  title: string;
  description: string;
  milestone: string;
}

export interface PortInfo {
  name: string;
  friendly: string;
}

export type ParityMode = "none" | "even" | "odd";

export interface SerialConfig {
  port: string;
  baud: number;
  dataBits: 7 | 8;
  parity: ParityMode;
  stopBits: 1 | 2;
}

export type SerialStatus = "disconnected" | "connected" | "reconnecting";

/** IPC 中的字节负载：热路径事件（frames/rx/tx）已改走二进制总线
 *  （src/ipc/binbus.ts），直接以 Uint8Array 交付，无 base64/JSON 开销。
 *  BytesB64 仅剩 hex_fetch 命令响应（HexSlice，低频）仍用 base64。 */
export type BytesB64 = string;

export function b64ToBytes(s: BytesB64): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ConnStatePayload {
  status: SerialStatus;
  port: string | null;
  error: string | null;
}

export interface RxEventPayload {
  bytes: Uint8Array;
  tsFirst: number;
  tsLast: number;
  /** Rust 侧发出事件的时刻（Date.now 基准），用于测量 IPC 投递延迟 */
  emitTs?: number;
}

export interface TxEventPayload {
  bytes: Uint8Array;
  ts: number;
}

export type BoundaryMode = "fixedLength" | "lengthField" | "footer";
/**
 * 字节序。后两档为 Modbus 等「32 位量占两个 16 位寄存器」协议的字序变体：
 * big=ABCD、little=DCBA、big-word-swap=CDAB、little-word-swap=BADC
 * （仅对 32/64 位类型生效，16 位类型下与 big/little 等价）。
 */
export type Endian = "little" | "big" | "big-word-swap" | "little-word-swap";
/** 字节序的中性简写（ABCD = MSB 在前），供帧画布提示等狭小空间显示 */
export const ENDIAN_LABEL: Record<Endian, string> = {
  little: "DCBA",
  big: "ABCD",
  "big-word-swap": "CDAB",
  "little-word-swap": "BADC",
};
export type ChecksumAlgo =
  | "none"
  | "sum8"
  | "sumadd"
  | "xor8"
  | "crc16_modbus"
  | "crc16_ccitt"
  | "crc32";
export type FieldType =
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "float32"
  | "float64"
  | "ascii"
  | "bcd"
  | "bits"
  | "csv";
export type FieldRole =
  | "header"
  | "addr"
  | "id"
  | "seq"
  | "length"
  | "data"
  | "payload"
  | "checksum"
  | "checksum2"
  | "footer";

export interface DiscSpec {
  offset: number;
  value: number[];
  /** 逐字节位掩码（与 value 等长；缺位按 0xFF 精确匹配）。0x00 = 该字节通配 */
  mask?: number[] | null;
}

export interface Boundary {
  mode: BoundaryMode;
  headerBytes: number[];
  /** 帧头逐字节位掩码：`(字节 & m) == (headerBytes & m)`。缺省 = 精确匹配（旧模板不变）。
   *  用于「任意从站地址」等通配场景；帧首字节被通配时引擎禁用帧中途重锚定。 */
  headerMask?: number[] | null;
  fixedLength?: number | null;
  lengthOffset?: number | null;
  lengthSize?: number | null;
  lengthEndian?: Endian | null;
  lengthAdjust?: number | null;
  /** 长度域倍率：总长 = ceil(长度值 × scale) + adjust。缺省 1；
   *  Modbus FC01/02 响应的长度域是「位数」→ 0.125 */
  lengthScale?: number | null;
  footerBytes?: number[] | null;
  maxLength: number;
  discOffset?: number | null;
  discValue?: number[] | null;
  discMask?: number[] | null;
  discs?: DiscSpec[] | null;
}

export interface ChecksumCfg {
  algo: ChecksumAlgo;
  coverageStart: number;
  coverageEnd: number;
  endian: Endian;
}

export interface BitsCfg {
  index: number;
  count: number;
}

/** 值标签（枚举注解）：解码值命中 v 时，显示层附一条文字说明 */
export interface ValueLabel {
  v: number;
  t: string;
}

export interface FieldDef {
  id: string;
  name: string;
  role: FieldRole;
  offset: number;
  type: FieldType;
  endian: Endian;
  size?: number | null;
  scale?: number | null;
  offsetValue?: number | null;
  unit?: string | null;
  color: string;
  bits?: BitsCfg | null;
  locked?: boolean | null;
  csvDelim?: string | null;
  csvType?: string | null;
  disc?: number[] | null;
  spanTail?: boolean | null;
  /** 数组区元素类型（uint8/int8/uint16/int16/uint32/int32/float32/float64）；
   *  特殊值 "bit" = 按位展开（一位一通道，低位在前），用于 Modbus FC01/02 线圈区 */
  spanElem?: string | null;
  /** 值标签（枚举注解）：解码值命中 v 时，表格/提示/导出在数字后附文字（如异常码 2 → 非法数据地址）。
   *  纯显示层能力：数值通道、变量、曲线仍用原始数字 */
  labels?: ValueLabel[] | null;
}

export interface FrameTemplate {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
  boundary: Boundary;
  checksum: ChecksumCfg | null;
  fields: FieldDef[];
  presetKey?: string | null;
  groupKey?: string | null;
}

export interface ParseRules {
  templates: FrameTemplate[];
}

export interface FieldOut {
  id: string;
  name: string;
  raw: number;
  value: number;
  text: string | null;
}

export interface FrameRow {
  tplId: string;
  tplName: string;
  color: string;
  tsMs: number;
  seq: number;
  len: number;
  valid: boolean;
  error: string | null;
  fields: FieldOut[];
  /** 原始帧字节（二进制总线直出的 Uint8Array 视图，无 base64） */
  bytes?: Uint8Array;
}

export interface FramesEventPayload {
  rows: FrameRow[];
  total: number;
  errors: number;
  dropped?: number;
  /** Rust 侧发出事件的时刻（Date.now 基准），用于测量 IPC 投递延迟 */
  emitTs?: number;
}

export interface SpanOut {
  start: number;
  len: number;
  tplId: string;
  valid: boolean;
}

export interface HexSlice {
  start: number;
  total: number;
  bytes: BytesB64;
  tsFirst: number;
  tsLast: number;
  spans: SpanOut[];
}

/** 会话录制的端口来源快照（仅展示用） */
export interface SessionPortInfo {
  kind: string;
  portName: string | null;
  baud: number | null;
}

/** .usess 文件 meta 段（Rust session.rs SessionMeta 同构） */
export interface SessionMeta {
  recordedAt: number;
  durationMs: number;
  frameCount: number;
  rxChunkCount: number;
  txChunkCount: number;
  port: SessionPortInfo;
  /** ParseRules 完整快照（P2 做导入防呆） */
  tplRules: ParseRules;
}

export type SessionPhase =
  | "idle"
  | "recording"
  | "recorded"
  | "playing"
  | "paused";

export interface SessionStatus {
  state: SessionPhase;
  frameCount: number;
  durationMs: number;
  posMs: number;
  frameIdx: number;
  fileName: string;
  /** 桥接服务端（P3a 虚拟设备） */
  bridgeListening: boolean;
  bridgePort: number;
  bridgeClients: number;
  /** 时间线首/末事件 ts（标注跳转 ratio 换算用） */
  firstTs: number;
  lastTs: number;
}

/** 时间轴标注（P3b） */
export interface AnnOut {
  ts: number;
  text: string;
}
