/**
 * Modbus 模拟从站状态机（M2-c）。
 *
 * **刻意不做成面板内 hook**：面板有关闭生命周期门控（panelActivity.isOpen），
 * 若状态机随面板卸载，用户一关页签从站就不应答了——现场几乎无法排查。
 * 故本模块是模块级单例：start() 后独立运行，面板只是视图。
 *
 * 收发通路复用现有 IPC：rx 走 binbus.onRx（原始字节，不经协议引擎），
 * 应答走 serialStore.sendData("hex")——因此控制台/发送日志/录制都能看到本机应答，
 * 这是故意的：软件发出的每一帧都必须可观测。
 */

import { onRx } from "../../ipc/binbus";
import * as serialStore from "../serial/serialStore";
import {
  answerPdu,
  buildRtuResponse,
  exceptionPdu,
  exceptionText,
  fcLabel,
  parseRequestPdu,
  takeRtuFrame,
  type MbArea,
  type MbBanks,
  type MbOutcome,
} from "./mb";
import { makeBanks, rtuCrcOk } from "./mb";

export interface SlaveEvent {
  ts: number;
  /** in = 收到的请求，drop = 忽略/静默/注入丢弃（应答本身由 TX 日志呈现） */
  dir: "in" | "drop";
  text: string;
}

export interface SlaveCounters {
  requests: number;
  replies: number;
  exceptions: number;
  silents: number;
  ignored: number;
  /** CRC 不符 / 非帧首而被丢弃的字节数 */
  noise: number;
}

export type FaultMode = "none" | "noReply" | "exception" | "everyOther";

export interface SlaveState {
  running: boolean;
  /** 本机从站地址 */
  address: number;
  /** 应答总线上所有从站地址（多从站仿真时用） */
  anyAddress: boolean;
  /** 应答前延时，用来复现慢速从站造成的主站超时 */
  delayMs: number;
  fault: FaultMode;
  faultCode: number;
  /** 数据区容量（位 / 字） */
  bitSize: number;
  wordSize: number;
  counters: SlaveCounters;
  events: SlaveEvent[];
  /** 数据区内容版本号：typed array 不进快照，UI 读 banks 并靠它重渲染 */
  version: number;
}

const KEY = "vs.modbus.slave";
const EVENT_CAP = 120;

const listeners = new Set<() => void>();

let state: SlaveState = {
  running: false,
  address: 1,
  anyAddress: false,
  delayMs: 0,
  fault: "none",
  faultCode: 2,
  bitSize: 64,
  wordSize: 128,
  counters: { requests: 0, replies: 0, exceptions: 0, silents: 0, ignored: 0, noise: 0 },
  events: [],
  version: 0,
};

/** 数据区本体（typed array，不进快照，UI 直接读） */
export let banks: MbBanks = makeBanks(64, 128);

let unsub: (() => void) | null = null;
let rxBuf: number[] = [];
/** 本机最近发出的帧：半双工回显抑制，否则会被当成请求再次应答形成自答循环 */
let lastTx: number[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/* ================= 快照与订阅 ================= */

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): SlaveState {
  return state;
}

function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
  schedulePersist();
}

/* ================= 持久化 ================= */

interface Saved {
  address?: number;
  anyAddress?: boolean;
  delayMs?: number;
  fault?: FaultMode;
  faultCode?: number;
  bitSize?: number;
  wordSize?: number;
  banks?: { coils: number[]; discs: number[]; holding: number[]; input: number[] };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.round(v) : lo));

function copyInto(dst: Uint8Array | Uint16Array, src?: number[]) {
  if (!src) return;
  for (let i = 0; i < Math.min(dst.length, src.length); i++) dst[i] = src[i] ?? 0;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Saved;
    const bitSize = clamp(s.bitSize ?? 64, 8, 2048);
    const wordSize = clamp(s.wordSize ?? 128, 1, 4096);
    banks = makeBanks(bitSize, wordSize);
    if (s.banks) {
      copyInto(banks.coils, s.banks.coils);
      copyInto(banks.discs, s.banks.discs);
      copyInto(banks.holding, s.banks.holding);
      copyInto(banks.input, s.banks.input);
    }
    const faults: FaultMode[] = ["none", "noReply", "exception", "everyOther"];
    state = {
      ...state,
      bitSize,
      wordSize,
      address: clamp(s.address ?? state.address, 0, 247),
      anyAddress: !!s.anyAddress,
      delayMs: clamp(s.delayMs ?? 0, 0, 5000),
      fault: faults.includes(s.fault as FaultMode) ? (s.fault as FaultMode) : "none",
      faultCode: clamp(s.faultCode ?? 2, 1, 255),
      version: state.version + 1,
    };
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 无痕模式：忽略 */
    }
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 400);
}

/** 立即落盘（关窗前必须落一次，否则 400ms 防抖窗口内的编辑会丢） */
export function flush() {
  if (persistTimer) clearTimeout(persistTimer);
  persistNow();
}

function persistNow() {
  const s: Saved = {
    address: state.address,
    anyAddress: state.anyAddress,
    delayMs: state.delayMs,
    fault: state.fault,
    faultCode: state.faultCode,
    bitSize: state.bitSize,
    wordSize: state.wordSize,
    banks: {
      coils: [...banks.coils],
      discs: [...banks.discs],
      holding: [...banks.holding],
      input: [...banks.input],
    },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 配额或无痕：内存状态仍在，忽略 */
  }
}

/* ================= 运行控制 ================= */

/** 启动从站；返回错误文字（null = 成功）。未连接串口也能启动（只是收不到流） */
export function start(): string | null {
  if (state.running) return null;
  rxBuf = [];
  lastTx = [];
  unsub = onRx((p) => feedRx(p.bytes));
  state = { ...state, running: true };
  emit();
  pushEvent({
    dir: "drop",
    text: `从站 ${state.address} 已启动${state.anyAddress ? "（应答所有地址）" : ""}`,
  });
  return null;
}

export function stop() {
  if (!state.running) return;
  unsub?.();
  unsub = null;
  rxBuf = [];
  state = { ...state, running: false };
  emit();
  pushEvent({ dir: "drop", text: "从站已停止" });
}

export function isRunning(): boolean {
  return state.running;
}

export function patch(
  p: Partial<Pick<SlaveState, "address" | "anyAddress" | "delayMs" | "fault" | "faultCode">>,
) {
  state = {
    ...state,
    ...p,
    address: p.address !== undefined ? clamp(p.address, 0, 247) : state.address,
    delayMs: p.delayMs !== undefined ? clamp(p.delayMs, 0, 5000) : state.delayMs,
    faultCode: p.faultCode !== undefined ? clamp(p.faultCode, 1, 255) : state.faultCode,
  };
  emit();
}

/** 改容量会重建数据区（原内容尽量保留） */
export function resize(bitSize: number, wordSize: number) {
  const bits = clamp(bitSize, 8, 2048);
  const words = clamp(wordSize, 1, 4096);
  const next = makeBanks(bits, words);
  copyInto(next.coils, [...banks.coils]);
  copyInto(next.discs, [...banks.discs]);
  copyInto(next.holding, [...banks.holding]);
  copyInto(next.input, [...banks.input]);
  banks = next;
  state = { ...state, bitSize: bits, wordSize: words, version: state.version + 1 };
  emit();
}

export function resetCounters() {
  state = {
    ...state,
    counters: { requests: 0, replies: 0, exceptions: 0, silents: 0, ignored: 0, noise: 0 },
  };
  emit();
}

export function clearEvents() {
  state = { ...state, events: [] };
  emit();
}

/* ================= 数据区编辑 ================= */

function bump() {
  state = { ...state, version: state.version + 1 };
  emit();
}

function setBitSilent(bank: Uint8Array, i: number, on: boolean) {
  const byte = i >> 3;
  if (byte >= bank.length) return;
  if (on) bank[byte] = (bank[byte] | (1 << (i & 7))) & 0xff;
  else bank[byte] = bank[byte] & ~(1 << (i & 7)) & 0xff;
}

export function setBit(area: "coil" | "disc", index: number, on: boolean): boolean {
  const bank = area === "coil" ? banks.coils : banks.discs;
  if (index < 0 || index >= bank.length * 8) return false;
  setBitSilent(bank, index, on);
  bump();
  return true;
}

export function setWord(area: "holding" | "input", index: number, value: number): boolean {
  const bank = area === "holding" ? banks.holding : banks.input;
  if (index < 0 || index >= bank.length) return false;
  bank[index] = clamp(value, 0, 0xffff);
  bump();
  return true;
}

/** 批量填充：[from, to] 闭区间，same = 全部同一值，ramp = 按步长递增 */
export function fill(
  area: MbArea,
  from: number,
  to: number,
  mode: "same" | "ramp",
  start: number,
  step: number,
): number {
  const bit = area === "coil" || area === "disc";
  const cap = bit ? banks.coils.length * 8 : banks.holding.length;
  const lo = clamp(Math.min(from, to), 0, cap - 1);
  const hi = clamp(Math.max(from, to), 0, cap - 1);
  for (let i = lo; i <= hi; i++) {
    const v = mode === "same" ? start : start + (i - lo) * step;
    if (area === "coil") setBitSilent(banks.coils, i, !!v);
    else if (area === "disc") setBitSilent(banks.discs, i, !!v);
    else if (area === "holding") banks.holding[i] = clamp(v, 0, 0xffff);
    else banks.input[i] = clamp(v, 0, 0xffff);
  }
  bump();
  return hi - lo + 1;
}

/** 一键填成演示波形（无硬件时配合主站轮询看曲线） */
export function seedDemo(area: MbArea) {
  if (area === "coil") for (let i = 0; i < 64; i++) setBitSilent(banks.coils, i, i % 3 === 0);
  else if (area === "disc") for (let i = 0; i < 64; i++) setBitSilent(banks.discs, i, i % 2 === 0);
  else if (area === "holding")
    for (let i = 0; i < Math.min(banks.holding.length, 128); i++)
      banks.holding[i] = Math.round(2000 + 1500 * Math.sin(i / 5));
  else for (let i = 0; i < Math.min(banks.input.length, 128); i++) banks.input[i] = Math.round(3000 + 800 * Math.cos(i / 7));
  bump();
}

/* ================= 事件流 ================= */

function pushEvent(e: Omit<SlaveEvent, "ts">) {
  state = { ...state, events: [{ ...e, ts: Date.now() }, ...state.events].slice(0, EVENT_CAP) };
  listeners.forEach((l) => l());
}

/* ================= 收帧与应答 ================= */

function feedRx(bytes: Uint8Array) {
  if (!state.running) return;
  for (const b of bytes) rxBuf.push(b);
  for (;;) {
    let dropped = 0;
    const f = takeRtuFrame(rxBuf, "slave", (n) => {
      dropped = n;
    });
    if (dropped) {
      state = { ...state, counters: { ...state.counters, noise: state.counters.noise + dropped } };
      emit();
    }
    if (!f) break;
    if (rtuCrcOk(f.bytes)) handle(f.slave, f.pdu, f.bytes);
  }
  // 对端长时间不发完整帧时防止缓冲无限增长
  if (rxBuf.length > 4096) rxBuf.splice(0, rxBuf.length - 256);
}

function bumpCounter(key: keyof SlaveCounters) {
  state = { ...state, counters: { ...state.counters, [key]: state.counters[key] + 1 } };
  emit();
}

function handle(slave: number, pdu: number[], raw: number[]) {
  // 半双工回显：本机刚发出的帧会原样回到 rx，绝不能再应答一次
  if (lastTx.length && sameBytes(raw, lastTx)) {
    bumpCounter("ignored");
    return;
  }
  if (slave !== state.address && slave !== 0 && !state.anyAddress) {
    bumpCounter("ignored");
    pushEvent({ dir: "drop", text: `从站 ${slave} 的请求（非本机 ${state.address}），忽略` });
    return;
  }

  const req = parseRequestPdu(pdu);
  bumpCounter("requests");
  const detail =
    req.fn === 0x05
      ? req.qty === 0xff00
        ? "=闭合"
        : "=断开"
      : req.values.length
        ? `=[${req.values.slice(0, 8).join(",")}${req.values.length > 8 ? "…" : ""}]`
        : `×${req.qty}`;
  pushEvent({ dir: "in", text: `${fcLabel(req.fn)} @${req.addr} ${detail}` });

  if (state.fault === "noReply") {
    bumpCounter("silents");
    pushEvent({ dir: "drop", text: "故障注入：不回应答（用于复现主站超时）" });
    return;
  }
  const injected =
    state.fault === "exception" || (state.fault === "everyOther" && state.counters.requests % 2 === 0);
  const outcome: MbOutcome = injected
    ? { kind: "exception", code: state.faultCode }
    : answerPdu(banks, slave, pdu);

  const send = () => {
    if (!state.running) return;
    if (outcome.kind === "silent") {
      bumpCounter("silents");
      pushEvent({ dir: "drop", text: "广播请求：已执行，协议规定不应答" });
      return;
    }
    const frame = buildRtuResponse(
      slave,
      outcome.kind === "exception" ? exceptionPdu(req.fn, outcome.code) : outcome.pdu,
    );
    lastTx = frame;
    bumpCounter(outcome.kind === "exception" ? "exceptions" : "replies");
    void serialStore.sendData("hex", frame.map((b) => b.toString(16).padStart(2, "0")).join(" "));
    pushEvent({
      dir: "drop",
      text:
        outcome.kind === "exception"
          ? `回异常 ${outcome.code}·${exceptionText(outcome.code)}`
          : `回应答 ${frame.length} 字节`,
    });
  };
  if (state.delayMs > 0) setTimeout(send, state.delayMs);
  else send();
}

function sameBytes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

load();
// 关窗前把数据区落盘（寄存器表是用户手工配出来的，丢了要重配）
// 守卫：单测跑在 node 环境下没有 window
if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
