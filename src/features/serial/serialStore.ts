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
}

const DEFAULT_CONFIG: SerialConfig = {
  port: "",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
};

const DEFAULT_NET: IfaceNetConfig = {
  remoteHost: "127.0.0.1",
  remotePort: 1346,
  localPort: 1347,
  localHost: "0.0.0.0",
};

let snapshot: SerialSnapshot = {
  ports: [],
  config: DEFAULT_CONFIG,
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
    set({ status: e.payload.status, error: e.payload.error, portName: e.payload.port });
    maybeAutoReconnect(e.payload.status);
  });
  await listen<BleDeviceInfo[]>("ble:devices", (e) => {
    set({ bleDevices: e.payload });
  });
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

export function setConfig(patch: Partial<SerialConfig>) {
  set({ config: { ...snapshot.config, ...patch } });
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
  set({ bleDeviceId: id });
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
      await invoke("ble_connect", { id: snapshot.bleDeviceId });
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

/* ---- 自动重连（P62b；设置页 autoReconnect，默认关；BLE 需重扫选特征不参与） ---- */
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

/** 供 state 监听调用：意外断开且开启自动重连时安排一次 3s 后重试（最多 3 次） */
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
    snapshot.iface !== "ble" &&
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
