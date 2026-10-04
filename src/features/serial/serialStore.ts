import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnStatePayload,
  PortInfo,
  SerialConfig,
  SerialStatus,
} from "../../ipc/types";
import { onRx, onTx } from "../../ipc/binbus";
import { recordIpcLatency } from "../../ipc/ipcLatency";
import { getSnapshot as getSettings } from "../settings/settingsStore";

export type IfaceKind = "serial" | "tcp-client" | "tcp-server" | "udp" | "ble";

export interface IfaceNetConfig {
  remoteHost: string;
  remotePort: number;
  localPort: number;
  /** 服务端监听地址（tcp-server 用，默认 0.0.0.0） */
  localHost: string;
}

/** BLE 扫描到的设备（ble:devices 事件全量推送） */
export interface BleDeviceInfo {
  id: string;
  name: string;
  rssi: number;
}

/** BLE 可交互特征（ble:chars 事件，连接成功后广播） */
export interface BleCharInfo {
  uuid: string;
  /** 属性摘要，如 "write writeNR notify" */
  kind: string;
}

export interface SerialSnapshot {
  ports: PortInfo[];
  config: SerialConfig;
  status: SerialStatus;
  error: string | null;
  rxTotal: number;
  txTotal: number;
  bps: number;
  iface: IfaceKind;
  net: IfaceNetConfig;
  /** 最近一次 serial:state 事件里的连接描述（串口名 或 网络地址） */
  portName: string | null;
  /** 本机网卡 IPv4 列表（服务端监听地址预设） */
  localAddrs: { name: string; ip: string }[];
  /** BLE 扫描结果（ble:devices 事件全量替换，按信号强度排序） */
  bleDevices: BleDeviceInfo[];
  /** 选中的 BLE 设备地址 */
  bleDeviceId: string;
  /** BLE 扫描进行中 */
  bleScanning: boolean;
  /** 最近一次连接的特征列表（ble:chars 事件，手动选择下拉用） */
  bleChars: BleCharInfo[];
  /** 手动选择的写/收特征 UUID（"" = 自动） */
  bleWriteChar: string;
  bleNotifyChar: string;
  /** 本次连接实际生效的写/收特征（auto 解析结果或显式指定） */
  bleActiveWrite: string;
  bleActiveNotify: string;
  /** P106 控制线：用户**显式**点过的电平。`null` = 从没碰过 —— 与 Rust 侧那份是同一件事的两面，
   *  施加/重连后复施加都由 Rust 负责，这里只负责"界面别再撒谎说现在是高电平"。 */
  ctrl: { dtr: boolean | null; rts: boolean | null };
  /** 四条只读 modem 线；整块 `null` = 还没读过，单条 `null` = 驱动读不到（界面画"未知"） */
  modem: ModemLines | null;
}

/** 与 Rust `ModemLines` 同形状（camelCase）。读不到的一律 null，不拿 false 糊过去。 */
export interface ModemLines {
  cts: boolean | null;
  dsr: boolean | null;
  ri: boolean | null;
  dcd: boolean | null;
}

const DEFAULT_CONFIG: SerialConfig = {
  port: "",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  // P107：与 P106 控制线同一套安全默认 —— 开串口不改变线路行为。
  // 流控选错的表现是安静地丢字节，所以它必须由用户明确打开，不能替用户猜。
  flow: "none",
};

/* ---------------- P115-F13：串口参数落盘（便利优先，用户 2026-09-28 裁决） ----------------
 * 以前这份 config 是纯模块内存：改好 921600/8N1，重启又回 115200/8N1。
 * 只持久化 config 六项；ctrl/modem 线状态是"这一次连接的事实"，不落盘。
 * 载入走单次清洗（枚举外/非法值一律落回默认），照 attitudeStore 的模式。 */

/** 波特率档位表的唯一出处（SerialParams 的菜单也从这里取，不再抄第二份） */
export const BAUD_RATES: readonly number[] = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
  1000000, 2000000, 3000000,
];

const SERIAL_CONFIG_KEY = "vs.serialConfig";
const PARITIES: readonly string[] = ["none", "even", "odd"];
const FLOWS: readonly string[] = ["none", "software", "hardware"];

/** 单次清洗：任何一项不认识都落回默认（半张坏表比默认值更危险——它会让人以为配置还在） */
export function sanitizeSerialConfig(raw: unknown): SerialConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const baud = typeof o.baud === "number" && Number.isFinite(o.baud) ? Math.round(o.baud) : DEFAULT_CONFIG.baud;
  return {
    port: typeof o.port === "string" ? o.port.slice(0, 64) : DEFAULT_CONFIG.port,
    baud: BAUD_RATES.includes(baud) ? baud : DEFAULT_CONFIG.baud,
    dataBits: o.dataBits === 7 || o.dataBits === 8 ? o.dataBits : DEFAULT_CONFIG.dataBits,
    parity: PARITIES.includes(o.parity as string) ? (o.parity as SerialConfig["parity"]) : DEFAULT_CONFIG.parity,
    stopBits: o.stopBits === 1 || o.stopBits === 2 ? o.stopBits : DEFAULT_CONFIG.stopBits,
    flow: FLOWS.includes(o.flow as string) ? (o.flow as SerialConfig["flow"]) : DEFAULT_CONFIG.flow,
  };
}

function loadPersistedConfig(): SerialConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(SERIAL_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return sanitizeSerialConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SERIAL_CONFIG_KEY, JSON.stringify(snapshot.config));
  } catch {
    /* 存不下（配额/隐私模式）：本次进程内的设置照常生效 */
  }
}

const DEFAULT_NET: IfaceNetConfig = {
  remoteHost: "127.0.0.1",
  remotePort: 1346,
  localPort: 1347,
  localHost: "0.0.0.0",
};

let snapshot: SerialSnapshot = {
  ports: [],
  // P115-F13：启动即恢复上次落盘的参数（端口不在枚举表里也保持选中，
  // 走既有的"口不存在"处理；绝不自动连接）
  config: loadPersistedConfig(),
  status: "disconnected",
  error: null,
  rxTotal: 0,
  txTotal: 0,
  bps: 0,
  iface: "serial",
  net: DEFAULT_NET,
  portName: null,
  localAddrs: [],
  bleDevices: [],
  bleDeviceId: "",
  bleScanning: false,
  bleChars: [],
  bleWriteChar: "",
  bleNotifyChar: "",
  bleActiveWrite: "",
  bleActiveNotify: "",
  ctrl: { dtr: null, rts: null },
  modem: null,
};

const listeners = new Set<() => void>();
const rxWindow: { t: number; n: number }[] = [];
let initialized = false;
let countersDirty = false;
let viewFrozen = false;

export function setViewFrozen(v: boolean) {
  viewFrozen = v;
}

export function isViewFrozen() {
  return viewFrozen;
}

function set(patch: Partial<SerialSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

function setSilent(patch: Partial<SerialSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  countersDirty = true;
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * 计数器专用监听（rxTotal/txTotal/bps，5Hz 批量通知）。
 * 全局 listeners 只在真正的状态变化时通知——否则高速收流时顶栏/工具栏/
 * 整个 App 会被计数器拖着 5Hz 全量重渲染。只有状态栏等计数器消费者订阅这里。
 */
const counterListeners = new Set<() => void>();

export function subscribeCounters(cb: () => void) {
  counterListeners.add(cb);
  return () => {
    counterListeners.delete(cb);
  };
}

function notifyCounters() {
  counterListeners.forEach((l) => l());
}

export function getSnapshot() {
  return snapshot;
}

export async function init() {
  if (initialized) return;
  initialized = true;

  await listen<PortInfo[]>("serial:ports-changed", (e) => {
    set({ ports: e.payload });
  });
  await listen<ConnStatePayload>("serial:state", (e) => {
    // port 事件带连接描述（串口名/网络地址/BLE 设备名），此前丢失导致状态栏描述为空
    // 断开就把 modem 线读数清掉（留着上一次的高电平读数是在撒谎）；
    // `ctrl` 故意不清：那是用户显式要过的电平，Rust 侧也记着，重连/重开由它复施加。
    set({
      status: e.payload.status,
      error: e.payload.error,
      portName: e.payload.port,
      modem: e.payload.status === "connected" ? snapshot.modem : null,
    });
    maybeAutoReconnect(e.payload.status);
  });
  await listen<BleDeviceInfo[]>("ble:devices", (e) => {
    set({ bleDevices: e.payload });
  });
  await listen<{ chars: BleCharInfo[]; write: string | null; notify: string | null }>(
    "ble:chars",
    (e) => {
      set({
        bleChars: e.payload.chars,
        bleActiveWrite: e.payload.write ?? "",
        bleActiveNotify: e.payload.notify ?? "",
      });
    },
  );
  // rx/tx 走二进制总线（binbus），不再监听 JSON 事件（监听常驻，随进程生命周期）
  onRx((p) => {
    recordIpcLatency(p.emitTs);
    const n = p.bytes.length;
    rxWindow.push({ t: Date.now(), n });
    setSilent({ rxTotal: snapshot.rxTotal + n });
  });
  onTx((p) => {
    setSilent({ txTotal: snapshot.txTotal + p.bytes.length });
  });

  setInterval(() => {
    if (countersDirty) {
      countersDirty = false;
      notifyCounters();
    }
  }, 200);

  setInterval(() => {
    const now = Date.now();
    while (rxWindow.length && now - rxWindow[0].t > 2000) rxWindow.shift();
    const bps = rxWindow
      .filter((w) => now - w.t <= 1000)
      .reduce((acc, w) => acc + w.n, 0);
    if (bps !== snapshot.bps) {
      snapshot = { ...snapshot, bps };
      notifyCounters();
    }
  }, 500);

  set({ ports: await invoke<PortInfo[]>("list_ports") });
  try {
    set({ localAddrs: await invoke<{ name: string; ip: string }[]>("list_local_addrs") });
  } catch {
    /* 枚举失败时下拉仅保留预设项 */
  }
}

/**
 * P115-F12：控制线记忆按端口名分档（进程级镜像，真身在 Rust 侧 Shared；绝不落盘）。
 * 旧实现整表一份：给 COM3 设过的 DTR 会在打开 COM4 时被 Rust 复施加——记忆串了端口。
 */
const ctrlByPort = new Map<string, { dtr: boolean | null; rts: boolean | null }>();

export function setConfig(patch: Partial<SerialConfig>) {
  if (patch.port !== undefined && patch.port !== snapshot.config.port) {
    // 换口 = 换一份记忆：界面 ctrl 跟着切到那个口名下的电平（没碰过就是 null/null），
    // 注释行才不会拿 COM3 的旧电平说 COM4 的事
    const mem = ctrlByPort.get(patch.port) ?? { dtr: null, rts: null };
    set({ config: { ...snapshot.config, ...patch }, ctrl: { ...mem } });
  } else {
    set({ config: { ...snapshot.config, ...patch } });
  }
  persistConfig();
}

export function setIface(iface: IfaceKind) {
  // 离开 BLE 接口时停掉扫描（避免后台空转 1Hz 全量推送）
  if (snapshot.bleScanning && iface !== "ble") {
    void invoke("ble_scan_stop").catch(() => {});
    set({ bleScanning: false, bleDevices: [], bleDeviceId: "" });
  }
  set({ iface });
}

export function setBleDevice(id: string) {
  // 换设备：旧特征列表/选择全部作废（新设备连接后重新广播）
  set({ bleDeviceId: id, bleChars: [], bleWriteChar: "", bleNotifyChar: "", bleActiveWrite: "", bleActiveNotify: "" });
}

export function setBleCharSel(patch: { bleWriteChar?: string; bleNotifyChar?: string }) {
  set(patch);
}

/** 连接中改选特征 → 断开重连使选择立即生效（未连接时仅保存，下次连接生效） */
export async function applyBleChars() {
  if (snapshot.iface !== "ble") return;
  if (snapshot.status === "connected" || snapshot.status === "reconnecting") {
    await closePort();
    await openPort();
  }
}

export async function bleScanStart() {
  set({ error: null });
  try {
    await invoke("ble_scan_start");
    set({ bleScanning: true });
  } catch (e) {
    set({ error: String(e) });
    throw e;
  }
}

export async function bleScanStop() {
  try {
    await invoke("ble_scan_stop");
  } finally {
    set({ bleScanning: false });
  }
}

export function setNet(patch: Partial<IfaceNetConfig>) {
  set({ net: { ...snapshot.net, ...patch } });
}

export function setError(msg: string | null) {
  set({ error: msg });
}

export function resetRx() {
  rxWindow.length = 0;
  setSilent({ rxTotal: 0, bps: 0 });
  notifyCounters();
}

export async function openPort() {
  set({ error: null });
  manualClose = false;
  retryN = 0;
  try {
    if (snapshot.iface === "serial") {
      if (!snapshot.config.port) throw new Error("请先选择串口");
      await invoke("open_port", { config: snapshot.config });
    } else if (snapshot.iface === "ble") {
      if (!snapshot.bleDeviceId) throw new Error("请先扫描并选择 BLE 设备");
      await invoke("ble_connect", {
        id: snapshot.bleDeviceId,
        writeChar: snapshot.bleWriteChar || null,
        notifyChar: snapshot.bleNotifyChar || null,
      });
    } else {
      await invoke("open_net", {
        config: {
          kind: snapshot.iface,
          remoteHost: snapshot.net.remoteHost,
          remotePort: snapshot.net.remotePort,
          localPort: snapshot.net.localPort,
          localHost: snapshot.net.localHost,
        },
      });
    }
  } catch (e) {
    set({ error: String(e) });
    throw e;
  }
}

export async function closePort() {
  manualClose = true;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
  }
  if (snapshot.iface === "serial") {
    await invoke("close_port");
  } else if (snapshot.iface === "ble") {
    await invoke("ble_disconnect");
  } else {
    await invoke("close_net");
  }
}

/* ---- 自动重连（P62b/P66-2；设置页 autoReconnect，默认关；意外断开 3s 重试×3） ---- */
let manualClose = false;
let everConnected = false;
let retryTimer = 0;
let retryN = 0;

function scheduleReconnect() {
  if (retryTimer || retryN >= 3) return;
  retryN += 1;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    if (manualClose || !getSettings().autoReconnect || snapshot.status === "connected") return;
    void openPort().catch(() => {
      // 设备仍未接上：openPort 直接 reject（无 state 事件），继续排下一次
      if (!manualClose && getSettings().autoReconnect && snapshot.status !== "connected") scheduleReconnect();
    });
  }, 3000);
}

/** 供 state 监听调用：意外断开且开启自动重连时安排一次 3s 后重试（最多 3 次）。
 *  BLE 依赖常驻 Adapter 的设备缓存直接重连（无需重新扫描），与串口/网络同策略。 */
function maybeAutoReconnect(status: SerialStatus) {
  if (status === "connected") {
    everConnected = true;
    retryN = 0;
    return;
  }
  if (
    status === "disconnected" &&
    everConnected &&
    !manualClose &&
    getSettings().autoReconnect
  ) {
    scheduleReconnect();
  }
}

export function sendData(mode: "ascii" | "hex", text: string) {
  return invoke("send_data", { mode, text });
}

export function startRecord(path: string) {
  return invoke("start_record", { path });
}

export function stopRecord() {
  return invoke("stop_record");
}

/* ---------------- P106 串口控制线（详设 docs/designs/P106-串口控制线-详设.md） ---------------- */

/** 置 DTR / RTS：只发用户点过的那条（两条都不发就是空操作，Rust 侧直接返回 Ok）。
 *  P115-F12：电平记到**当前口名下**（Rust 侧同口径），换口后界面 ctrl 随 setConfig 切档。 */
export async function setControlLines(patch: { dtr?: boolean; rts?: boolean }) {
  await invoke("set_control_lines", { dtr: patch.dtr ?? null, rts: patch.rts ?? null });
  const next = {
    dtr: patch.dtr ?? snapshot.ctrl.dtr,
    rts: patch.rts ?? snapshot.ctrl.rts,
  };
  if (snapshot.config.port) ctrlByPort.set(snapshot.config.port, { ...next });
  set({ ctrl: next });
}

/** 一次读四条（Rust 侧也是一次锁内读完）；调用方负责把失败画成"未知" */
export function readModemLines() {
  return invoke<ModemLines>("read_modem_lines");
}

export function setModemLines(m: ModemLines | null) {
  set({ modem: m });
}

/** 发 Break。省略 ms 用 Rust 侧的默认值（默认值只住一处，前端不抄） */
export function sendBreak(ms?: number) {
  return invoke("send_break", { ms: ms ?? null });
}
