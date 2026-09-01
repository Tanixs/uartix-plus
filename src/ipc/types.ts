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
  | "video";

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
export type Endian = "little" | "big";
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
}

export interface Boundary {
  mode: BoundaryMode;
  headerBytes: number[];
  fixedLength?: number | null;
  lengthOffset?: number | null;
  lengthSize?: number | null;
  lengthEndian?: Endian | null;
  lengthAdjust?: number | null;
  footerBytes?: number[] | null;
  maxLength: number;
  discOffset?: number | null;
  discValue?: number[] | null;
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
