import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  FrameRow,
  FramesEventPayload,
  RxEventPayload,
  TxEventPayload,
} from "./types";

/**
 * 二进制 IPC 总线：替代 JSON 事件监听（parser:frames / serial:rx / serial:tx）。
 *
 * Rust 侧（src-tauri/src/busevt.rs）经 Tauri Channel 推送 InvokeResponseBody::Raw，
 * 本模块收到 ArrayBuffer 后按小端紧凑格式解码（字符串经每批字典去重），
 * 还原出与旧 JSON 事件完全相同的 payload 结构——订阅方接口不变。
 *
 * 相比旧链路（serde JSON + base64 + JSON.parse）：
 * - 无 base64（-33% 体积，省一次编解码）
 * - 无 JSON.parse（大批次字符串解析是主线程峰值来源）
 * - 模板名/颜色/字段名每批只传一次（旧行结构里每帧重复 10+ 份）
 */

type FramesH = (p: FramesEventPayload) => void;
type RxH = (p: RxEventPayload) => void;
type TxH = (p: TxEventPayload) => void;

const framesHandlers = new Set<FramesH>();
const rxHandlers = new Set<RxH>();
const txHandlers = new Set<TxH>();
let started = false;

const utf8 = new TextDecoder();

/** 小端顺序读取器 */
class Rd {
  private dv: DataView;
  private u8: Uint8Array;
  private o = 0;
  constructor(buf: ArrayBuffer) {
    this.u8 = new Uint8Array(buf);
    this.dv = new DataView(buf);
  }
  byte(): number {
    return this.u8[this.o++];
  }
  u16(): number {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64(): number {
    const v = this.dv.getBigUint64(this.o, true);
    this.o += 8;
    return Number(v);
  }
  f64(): number {
    const v = this.dv.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }
  bytes(len: number): Uint8Array {
    const v = this.u8.subarray(this.o, this.o + len);
    this.o += len;
    return v;
  }
  str(dict: string[]): string {
    return dict[this.u16()];
  }
  get pos(): number {
    return this.o;
  }
}

function decodeFrames(r: Rd): FramesEventPayload {
  const emitTs = r.u64();
  const total = r.u64();
  const errors = r.u64();
  const dropped = r.u64();
  const dc = r.u16();
  const dict: string[] = new Array(dc);
  for (let i = 0; i < dc; i++) {
    dict[i] = utf8.decode(r.bytes(r.u16()));
  }
  const rc = r.u32();
  const rows: FrameRow[] = new Array(rc);
  for (let i = 0; i < rc; i++) {
    const tplId = r.str(dict);
    const tplName = r.str(dict);
    const color = r.str(dict);
    const tsMs = r.u64();
    const seq = r.u64();
    const len = r.u32();
    const valid = r.byte() === 1;
    const errIdx = r.u16();
    const error = errIdx === 0xffff ? null : dict[errIdx];
    const hasBytes = r.byte() === 1;
    const bytes = hasBytes ? r.bytes(r.u32()) : undefined;
    const fc = r.u16();
    const fields = new Array(fc);
    for (let j = 0; j < fc; j++) {
      const id = r.str(dict);
      const name = r.str(dict);
      const raw = r.f64();
      const value = r.f64();
      const text = r.byte() === 1 ? dict[r.u16()] : null;
      fields[j] = { id, name, raw, value, text };
    }
    rows[i] = {
      tplId,
      tplName,
      color,
      tsMs,
      seq,
      len,
      valid,
      error,
      fields,
      ...(bytes ? { bytes } : {}),
    };
  }
  return { rows, total, errors, dropped, emitTs };
}

function decodeRx(r: Rd): RxEventPayload {
  const tsFirst = r.u64();
  const tsLast = r.u64();
  const emitTs = r.u64();
  const bytes = r.bytes(r.u32());
  return { bytes, tsFirst, tsLast, emitTs };
}

function decodeTx(r: Rd): TxEventPayload {
  const ts = r.u64();
  const bytes = r.bytes(r.u32());
  return { bytes, ts };
}

function dispatch(buf: ArrayBuffer) {
  try {
    const r = new Rd(buf);
    const t = r.byte();
    if (t === 1) {
      const p = decodeFrames(r);
      for (const h of Array.from(framesHandlers)) h(p);
    } else if (t === 2) {
      const p = decodeRx(r);
      for (const h of Array.from(rxHandlers)) h(p);
    } else if (t === 3) {
      const p = decodeTx(r);
      for (const h of Array.from(txHandlers)) h(p);
    }
  } catch (err) {
    console.error("binbus 解码失败", err);
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const ch = new Channel<unknown>();
    ch.onmessage = (raw) => {
      // Raw 通道消息：ArrayBuffer（tauri channel.rs 小包 eval/大包 fetch 均如此）
      if (raw instanceof ArrayBuffer) {
        dispatch(raw);
      } else if (raw instanceof Uint8Array) {
        dispatch(
          raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
            ? raw.buffer
            : raw.slice().buffer,
        );
      }
    };
    await invoke("ipc_subscribe", { channel: ch });
  } catch (err) {
    started = false;
    console.error("binbus 注册失败", err);
    throw err;
  }
}

export function onFrames(h: FramesH): () => void {
  framesHandlers.add(h);
  void ensureStarted();
  return () => {
    framesHandlers.delete(h);
  };
}

export function onRx(h: RxH): () => void {
  rxHandlers.add(h);
  void ensureStarted();
  return () => {
    rxHandlers.delete(h);
  };
}

export function onTx(h: TxH): () => void {
  txHandlers.add(h);
  void ensureStarted();
  return () => {
    txHandlers.delete(h);
  };
}
