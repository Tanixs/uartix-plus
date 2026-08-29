import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnStatePayload,
  PortInfo,
  SerialConfig,
  SerialStatus,
} from "../../ipc/types";

export type IfaceKind = "serial" | "tcp-client" | "tcp-server" | "udp";

export interface IfaceNetConfig {
  remoteHost: string;
  remotePort: number;
  localPort: number;
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
  await listen<{ bytes: number[] }>("serial:rx", (e) => {
    rxWindow.push({ t: Date.now(), n: e.payload.bytes.length });
    setSilent({ rxTotal: snapshot.rxTotal + e.payload.bytes.length });
  });
  await listen<{ bytes: number[] }>("serial:tx", (e) => {
    setSilent({ txTotal: snapshot.txTotal + e.payload.bytes.length });
  });

  setInterval(() => {
    if (countersDirty) {
      countersDirty = false;
      listeners.forEach((l) => l());
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
      listeners.forEach((l) => l());
    }
  }, 500);

  set({ ports: await invoke<PortInfo[]>("list_ports") });
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
