/**
 * Modbus 主站轮询表状态机（M2-d）。
 *
 * 同样是**模块级单例**：关掉页签继续轮询（自动化不能因为切走面板就断）。
 *
 * 半双工三条硬规则：
 *  1. 同一时刻只允许一条在途请求（RS-485 常识，也是慢从站跟得上的前提）
 *  2. 模拟从站运行中禁启轮询（自己问自己答会得出"假健康"）
 *  3. **传输层跟随当前接口**：串口 = RTU 帧（含 CRC），网络 = TCP 帧（MBAP）——
 *     不存在"用 RS-232 发 Modbus TCP"这种事，故不给每行单独选
 *
 * 响应解析在本模块完成（主站知道自己问了什么，期望长度是**算出来的**而不是猜的），
 * 值写进变量系统，曲线/表格/脚本直接引用，无需再配协议模板。
 */

import { onRx } from "../../ipc/binbus";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "../controls/variableStore";
import {
  buildRequestPdu,
  exceptionText,
  fcLabel,
  mbCrc,
  rtuCrcOk,
  type MbRequest,
} from "./mb";
import { isRunning as slaveRunning } from "./slaveStore";

export interface PollRow {
  id: string;
  enabled: boolean;
  /** 从站 / Unit ID */
  slave: number;
  fn: number;
  /** 起始地址（0 基址） */
  addr: number;
  qty: number;
  periodMs: number;
  /** 值写入变量系统的名字 */
  varName: string;
  /** 取响应里的第几个元素（qty>1 时一次读多个分别绑变量） */
  elem: number;
  scale: number;
  /* ---- 运行时统计（不持久化） ---- */
  ok: number;
  timeout: number;
  err: number;
  last: number | null;
  lastTs: number | null;
  latencyMs: number | null;
  nextTs: number;
}

export interface PollState {
  running: boolean;
  /**
   * 帧格式：**不能从接口反推**——RTU 跑在 TCP 隧道/串口服务器上极常见，
   * 反过来（MBAP 走 RS-232）不成立，故由用户显式选，启动时按接口校验。
   */
  transport: "rtu" | "tcp";
  rows: PollRow[];
  txns: number;
  timeouts: number;
  errs: number;
  lastError: string | null;
}

const KEY = "vs.modbus.poll";
/** 在途请求超时（ms）：超过记一次超时并放行下一条 */
const ACK_TIMEOUT = 1000;
/** 接收缓冲上限，防脏数据无限增长 */
const MAX_BUF = 4096;
/** 读功能码（轮询只用读） */
export const READ_FNS = [1, 2, 3, 4];

const listeners = new Set<() => void>();

let state: PollState = {
  running: false,
  transport: "rtu",
  rows: [],
  txns: 0,
  timeouts: 0,
  errs: 0,
  lastError: null,
};

let unsub: (() => void) | null = null;
let rxBuf: number[] = [];
let inflight: { id: string; expectEcho: number[]; wantLen: number; tSend: number } | null = null;
let ticker: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let tcpTxn = 0;
/** TCP 事务号 → 行 id（响应按事务号配对，乱序也认得） */
const txnRow = new Map<number, string>();

/* ================= 快照与订阅 ================= */

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): PollState {
  return state;
}

function emit() {
  state = { ...state, rows: state.rows.map((r) => ({ ...r })) };
  listeners.forEach((l) => l());
  schedulePersist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 300);
}

/** 立即落盘（关窗前必须落一次，否则防抖窗口内的编辑会丢） */
export function flush() {
  if (persistTimer) clearTimeout(persistTimer);
  persistNow();
}

function persistNow() {
  const slim = {
    transport: state.transport,
    rows: state.rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      slave: r.slave,
      fn: r.fn,
      addr: r.addr,
      qty: r.qty,
      periodMs: r.periodMs,
      varName: r.varName,
      elem: r.elem,
      scale: r.scale,
    })),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(slim));
  } catch {
    /* 无痕/配额：内存态照常用 */
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clampN = (v: unknown, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(num(v, d))));

function normalize(r: Partial<PollRow>, idx: number): PollRow {
  const fn = READ_FNS.includes(num(r.fn, 3)) ? num(r.fn, 3) : 3;
  const bit = fn === 1 || fn === 2;
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    enabled: r.enabled !== false,
    slave: clampN(r.slave, 1, 0, 247),
    fn,
    addr: clampN(r.addr, 0, 0, 0xffff),
    qty: clampN(r.qty, bit ? 16 : 2, 1, bit ? 2000 : 125),
    periodMs: clampN(r.periodMs, 500, 20, 60000),
    varName: (typeof r.varName === "string" && r.varName.trim() ? r.varName.trim() : `MB_${addrHint(fn, clampN(r.addr, 0, 0, 0xffff))}${idx}`).slice(0, 32),
    elem: clampN(r.elem, 0, 0, 124),
    scale: num(r.scale, 1) || 1,
    ok: 0,
    timeout: 0,
    err: 0,
    last: null,
    lastTs: null,
    latencyMs: null,
    nextTs: 0,
  };
}

/** 4x/3x/1x/0x 手册风格提示 */
function addrHint(fn: number, addr: number): string {
  if (fn === 1) return `0${String(addr).padStart(4, "0")}`;
  if (fn === 2) return `1${String(addr).padStart(4, "0")}`;
  if (fn === 4) return `3${String(addr).padStart(4, "0")}`;
  return `4${String(addr).padStart(4, "0")}`;
}

export function hintFor(fn: number, addr: number): string {
  return addrHint(fn, addr);
}

/* ================= 表编辑 ================= */

export function addRow(p: Partial<PollRow> = {}) {
  state = { ...state, rows: [...state.rows, normalize(p, state.rows.length)] };
  emit();
}

export function updateRow(id: string, p: Partial<PollRow>) {
  state = {
    ...state,
    rows: state.rows.map((r) => (r.id === id ? normalize({ ...r, ...p, id: r.id, varName: p.varName ?? r.varName }, 0) : r)),
  };
  emit();
}

export function removeRow(id: string) {
  state = { ...state, rows: state.rows.filter((r) => r.id !== id) };
  emit();
}

export function clearRows() {
  if (state.running) stop();
  state = { ...state, rows: [] };
  emit();
}

export function moveRow(id: string, dir: -1 | 1) {
  const i = state.rows.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.rows.length) return;
  const rows = [...state.rows];
  const t = rows[i];
  rows[i] = rows[j];
  rows[j] = t;
  state = { ...state, rows };
  emit();
}

export function resetStats() {
  state = {
    ...state,
    txns: 0,
    timeouts: 0,
    errs: 0,
    lastError: null,
    rows: state.rows.map((r) => ({ ...r, ok: 0, timeout: 0, err: 0, last: null, lastTs: null, latencyMs: null })),
  };
  emit();
}

/** 一键加一条演示轮询（读 1 号从站 40001 起 2 个寄存器） */
export function addDemoRow() {
  addRow({ slave: 1, fn: 3, addr: 0, qty: 2, varName: "MB_40001", periodMs: 500 });
}

/* ================= 运行控制 ================= */

/** 当前帧格式（用户显式选择，持久化） */
export function transport(): "rtu" | "tcp" {
  return state.transport;
}

export function setTransport(t: "rtu" | "tcp") {
  if (state.transport === t) return;
  if (state.running) return; // 跑着不许换帧格式
  state = { ...state, transport: t };
  emit();
}

const NET_IFACES = ["tcp-client", "tcp-server", "udp"];

export function blockReason(): string | null {
  if (slaveRunning()) return "模拟从站正在运行：自己问自己答会得出假健康，请先停掉从站";
  if (!state.rows.some((r) => r.enabled)) return "至少启用一个轮询项";
  const iface = serialStore.getSnapshot().iface;
  if (state.transport === "tcp" && !NET_IFACES.includes(iface)) {
    return "Modbus TCP 帧需要网络接口（TCP/UDP）；当前是串口——串口侧请用 RTU，或让串口服务器自己转 TCP";
  }
  return null;
}

export function start(): string | null {
  if (state.running) return null;
  const b = blockReason();
  if (b) return b;
  rxBuf = [];
  inflight = null;
  txnRow.clear();
  const now = Date.now();
  state = {
    ...state,
    running: true,
    lastError: null,
    rows: state.rows.map((r) => ({ ...r, nextTs: r.enabled ? now : Infinity })),
  };
  unsub = onRx((p) => feed(p.bytes));
  emit();
  tick();
  return null;
}

export function stop() {
  if (!state.running) return;
  unsub?.();
  unsub = null;
  if (ticker) clearTimeout(ticker);
  if (watchdog) clearTimeout(watchdog);
  ticker = null;
  watchdog = null;
  inflight = null;
  state = { ...state, running: false };
  emit();
}

/**
 * 节拍：总线空闲才发下一条，按各行 nextTs 到点触发。
 * 用 setTimeout 自递归而非 setInterval——从站慢或掉线时不会堆叠请求。
 */
function tick() {
  if (!state.running) return;
  const now = Date.now();
  if (!inflight) {
    const due = state.rows.filter((r) => r.enabled && r.nextTs <= now).sort((a, b) => a.nextTs - b.nextTs);
    if (due.length) send(due[0], now);
  }
  ticker = setTimeout(tick, 5);
}

function send(r: PollRow, now: number) {
  const req: MbRequest = { slave: r.slave, fn: r.fn, addr: r.addr, qty: r.qty };
  const pdu = buildRequestPdu(req);
  const bit = r.fn === 1 || r.fn === 2;
  const wantLen = r.fn === 3 || r.fn === 4 ? 5 + r.qty * 2 : bit ? 5 + Math.ceil(r.qty / 8) : 8;
  let frame: number[];
  if (transport() === "tcp") {
    tcpTxn = (tcpTxn + 1) & 0xffff;
    const txn = tcpTxn || 1;
    txnRow.set(txn, r.id);
    const len = pdu.length + 1;
    frame = [(txn >> 8) & 0xff, txn & 0xff, 0, 0, (len >> 8) & 0xff, len & 0xff, r.slave & 0xff, ...pdu];
    state = { ...state, txns: txn };
  } else {
    const body = [r.slave, ...pdu];
    const crc = mbCrc(body);
    frame = [...body, crc & 0xff, (crc >> 8) & 0xff];
  }
  r.lastTs = now;
  r.nextTs = now + r.periodMs;
  inflight = { id: r.id, expectEcho: frame, wantLen, tSend: now };
  void serialStore.sendData("hex", frame.map((b) => b.toString(16).padStart(2, "0")).join(" "));
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(onTimeout, ACK_TIMEOUT);
}

function onTimeout() {
  const cur = inflight;
  if (!cur) return;
  inflight = null;
  const r = state.rows.find((x) => x.id === cur.id);
  if (r) r.timeout++;
  state = { ...state, timeouts: state.timeouts + 1, lastError: `${r ? `从站 ${r.slave} ${fcLabel(r.fn)}` : "请求"} 无应答（超时）` };
  emit();
}

/* ================= 收响应 ================= */

function feed(bytes: Uint8Array) {
  if (!state.running) return;
  for (const b of bytes) rxBuf.push(b);
  if (rxBuf.length > MAX_BUF) rxBuf.splice(0, rxBuf.length - MAX_BUF);
  const cur = inflight;
  if (!cur) {
    rxBuf = []; // 不在轮询中到达的字节属于别人的流量（或回放），丢掉避免误配
    return;
  }
  if (transport() === "tcp") {
    takeTcpReply(cur);
    return;
  }
  takeRtuReply(cur);
}

/**
 * RTU：期望长度是算出来的，于是只需三种处理——
 * ① 头部正好是自己发出去的回显 → 跳过；② 收满 wantLen → 验 CRC；
 * ③ CRC 不符（线上别人的流量/坏帧）→ 前进 1 字节在窗口里找真正的响应。
 */
function takeRtuReply(cur: NonNullable<typeof inflight>) {
  for (;;) {
    if (rxBuf.length >= cur.expectEcho.length && startsWith(rxBuf, cur.expectEcho)) {
      rxBuf.splice(0, cur.expectEcho.length);
      continue;
    }
    // 异常响应恒 5 字节，比读响应的期望长度短——按功能码 bit7 就地改长度
    const want = rxBuf.length >= 2 && (rxBuf[1] & 0x80) !== 0 ? 5 : cur.wantLen;
    if (rxBuf.length < want) return;
    const bytes = rxBuf.slice(0, want);
    if (rtuCrcOk(bytes)) {
      rxBuf.splice(0, want);
      settle(cur, bytes);
      return;
    }
    rxBuf.splice(0, 1); // 噪声：前进一字节重找
  }
}

function takeTcpReply(cur: NonNullable<typeof inflight>) {
  for (;;) {
    if (rxBuf.length >= cur.expectEcho.length && startsWith(rxBuf, cur.expectEcho)) {
      rxBuf.splice(0, cur.expectEcho.length);
      continue;
    }
    if (rxBuf.length < 8) return;
    const len = (rxBuf[4] << 8) | rxBuf[5];
    const total = 6 + len;
    if (len < 2 || total > MAX_BUF) {
      rxBuf.splice(0, 1);
      continue;
    }
    if (rxBuf.length < total) return;
    const adu = rxBuf.splice(0, total);
    const txn = (adu[0] << 8) | adu[1];
    const id = txnRow.get(txn);
    txnRow.delete(txn);
    if (id !== cur.id) continue; // 不是本轮询的响应（迟到的旧事务）
    settle(cur, adu.slice(7), true);
    return;
  }
}

function settle(cur: NonNullable<typeof inflight>, bytesOrPdu: number[], isPdu = false) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  inflight = null;
  const r = state.rows.find((x) => x.id === cur.id);
  if (!r) return;
  r.latencyMs = Date.now() - cur.tSend;
  const pdu = isPdu ? bytesOrPdu : bytesOrPdu.slice(1, bytesOrPdu.length - 2);
  const fn = pdu[0] ?? 0;
  if ((fn & 0x80) !== 0) {
    r.err++;
    state = { ...state, errs: state.errs + 1, lastError: `从站 ${r.slave} 回异常：${exceptionText(pdu[1] ?? 0)}` };
    emit();
    return;
  }
  if (!isPdu && !rtuCrcOk(bytesOrPdu)) {
    r.err++;
    state = { ...state, errs: state.errs + 1, lastError: "响应 CRC 校验失败" };
    emit();
    return;
  }
  // PDU = [FC, 字节数, 数据…]：数据区从第 3 字节起（把字节数也算进数据是经典错读）
  const body = pdu.slice(2);
  let value: number | null = null;
  if (fn === 1 || fn === 2) {
    const i = r.elem;
    if (Math.floor(i / 8) < body.length) value = (body[Math.floor(i / 8)] >> (i % 8)) & 1;
  } else if (fn === 3 || fn === 4) {
    const i = r.elem * 2;
    if (i + 1 < body.length) value = ((body[i] << 8) | body[i + 1]) >>> 0;
  }
  if (value === null) {
    r.err++;
    state = { ...state, errs: state.errs + 1, lastError: "响应长度不足（数量与响应不匹配）" };
    emit();
    return;
  }
  const scaled = value * r.scale;
  variableStore.setVar(r.varName, scaled);
  r.last = scaled;
  r.ok++;
  emit();
}

function startsWith(buf: number[], head: number[]): boolean {
  if (buf.length < head.length) return false;
  return head.every((v, i) => buf[i] === v);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as { rows?: Partial<PollRow>[]; transport?: "rtu" | "tcp" };
    const t = s.transport === "tcp" || s.transport === "rtu" ? s.transport : "rtu";
    const rows = Array.isArray(s.rows) ? s.rows.map((r, i) => normalize(r, i)) : [];
    state = { ...state, transport: t, rows };
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 无痕模式：忽略 */
    }
  }
}

load();
// 关窗前把表落盘（防抖窗口只剩几百 ms，但脚本改完立刻关窗就会丢）
// 守卫：单测跑在 node 环境下没有 window
if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
