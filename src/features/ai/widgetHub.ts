import { onFrames } from "../../ipc/framesBus";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getProto } from "../protocol/templateStore";
import { listVars, getVar } from "../controls/variableStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import * as serialStore from "../serial/serialStore";

const CH = "vs-aiwidget-hub";
let channel: BroadcastChannel | null = null;
let unFrames: (() => void) | null = null;
let lastPush = 0;
let pendingRows: { fields: Map<string, number | string> } | null = null;
let started = false;

export interface WidgetSnap {
  status: string;
  port: string;
  fields: Record<string, number | string>;
}

export function buildSnap(): WidgetSnap {
  const s = getSerial();
  const proto = getProto();
  const fields: Record<string, number | string> = {};
  for (const t of proto.rules.templates) {
    if (!t.enabled) continue;
    for (const f of t.fields) {
      const v = getVar(f.name);
      if (v !== undefined) fields[f.name] = v;
    }
  }
  for (const def of listVars()) {
    const v = getVar(def.name);
    if (v !== undefined) fields[def.name] = v;
  }
  return {
    status: s.status,
    port: s.iface === "serial" ? `${s.config.port} @ ${s.config.baud}` : s.portName ?? "",
    fields,
  };
}

function broadcast(msg: Record<string, unknown>) {
  try {
    channel?.postMessage(msg);
  } catch {
    return;
  }
}

export function startWidgetHub() {
  if (started) return;
  started = true;
  try {
    const ch = new BroadcastChannel(CH);
    ch.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; reqId?: string; mode?: string; text?: string };
      if (d?.type !== "aiw:send-req") return;
      const reply = (extra: Record<string, unknown>) => {
        try {
          ch.postMessage({ type: "aiw:send-res", reqId: d.reqId, ...extra });
        } catch {
          return;
        }
      };
      const sendOk = getSettings().aiWidgetSend;
      if (!sendOk) {
        reply({ ok: false, err: "小部件发送权限未开启" });
        return;
      }
      const mode = d.mode === "hex" ? "hex" : "ascii";
      void serialStore
        .sendData(mode, String(d.text ?? ""))
        .then(() => reply({ ok: true }))
        .catch((err) => reply({ ok: false, err: String(err) }));
    };
    channel = ch;
  } catch {
    channel = null;
  }
  unFrames = onFrames((p) => {
    const now = Date.now();
    const fields = new Map<string, number | string>();
    for (const r of p.rows) {
      for (const f of r.fields) fields.set(f.name, f.text ?? f.value);
    }
    pendingRows = pendingRows
      ? { fields: new Map([...pendingRows.fields, ...fields]) }
      : { fields };
    if (now - lastPush < 500) return;
    lastPush = now;
    const snap = buildSnap();
    if (pendingRows) {
      for (const [k, v] of pendingRows.fields) snap.fields[k] = v;
      pendingRows = null;
    }
    broadcast({ type: "aiw:snap", snap });
  });
}

export function stopWidgetHub() {
  unFrames?.();
  unFrames = null;
  channel?.close();
  channel = null;
  started = false;
}

export function getChannelName() {
  return CH;
}

export function requestSendViaHub(
  mode: "ascii" | "hex",
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let ch: BroadcastChannel | null = null;
    const reqId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("发送请求超时（主窗口未响应）"));
    }, 5000);
    const cleanup = () => {
      window.clearTimeout(timer);
      if (ch) ch.onmessage = null;
      ch?.close();
    };
    try {
      ch = new BroadcastChannel(CH);
    } catch (e) {
      reject(new Error(String(e)));
      return;
    }
    ch.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; reqId?: string; ok?: boolean; err?: string };
      if (d?.type !== "aiw:send-res" || d.reqId !== reqId) return;
      cleanup();
      if (d.ok) resolve();
      else reject(new Error(d.err ?? "发送失败"));
    };
    ch.postMessage({ type: "aiw:send-req", reqId, mode, text });
  });
}
