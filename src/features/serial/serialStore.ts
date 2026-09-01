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

export type IfaceKind = "serial" | "tcp-client" | "tcp-server" | "udp";

export interface IfaceNetConfig {
  remoteHost: string;
  remotePort: number;
  localPort: number;
  /** 服务端监听地址（tcp-server 用，默认 0.0.0.0） */
  localHost: string;
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
    set({ status: e.payload.status, error: e.payload.error });
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
  set({ iface });
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
  try {
    if (snapshot.iface === "serial") {
      if (!snapshot.config.port) throw new Error("请先选择串口");
      await invoke("open_port", { config: snapshot.config });
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
  if (snapshot.iface === "serial") {
    await invoke("close_port");
  } else {
    await invoke("close_net");
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
