import { onFrames } from "../../ipc/framesBus";
import { getSnapshot as getSerial } from "../serial/serialStore";
import { getSnapshot as getProto } from "../protocol/templateStore";
import { listVars, getVar } from "../controls/variableStore";
import { getSnapshot as getSettings, subscribe as subSettings } from "../settings/settingsStore";
import { subscribe as subExts } from "./extensionStore";
import { collectThemeVars } from "./extRuntime";
import * as serialStore from "../serial/serialStore";
import { getChatFeed, broadcastChatFeed } from "./aiChatFeed";

const CH = "vs-aiwidget-hub";
let channel: BroadcastChannel | null = null;
let unFrames: (() => void) | null = null;
let unChat: (() => void) | null = null;
let unTheme: (() => void) | null = null;
let unExts: (() => void) | null = null;
let themeRaf = 0;
let lastPush = 0;
let pendingRows: { fields: Map<string, number | string> } | null = null;
let started = false;

/**
 * AI 对话 feed 订阅：chatStore 快照变化 → 更新 feed → phase/内容有变时广播。
 * 独立轻量节流（200ms），phase 变化即时。
 */
function subscribeChatFeed(cb: () => void): () => void {
  let lastPhase = "";
  let lastChatPush = 0;
  let timer: number | null = null;
  let unsub: (() => void) | null = null;
  const check = (force = false) => {
    const f = getChatFeed();
    if (force || f.phase !== lastPhase) {
      lastPhase = f.phase;
      lastChatPush = Date.now();
      timer = null;
      cb();
      return;
    }
    const now = Date.now();
    if (timer === null && now - lastChatPush >= 200) {
      lastChatPush = now;
      cb();
      return;
    }
    if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null;
        lastChatPush = Date.now();
        cb();
      }, 200);
    }
  };
  check(true);
  // chatStore 在主窗口；跨窗口时 storage 事件无快照，仅主窗口启用
  try {
    // 延迟 import 规避循环依赖（chatStore → widgetHub 不成立，但保持对称）
    void import("./chatStore").then((m) => {
      unsub = m.subscribe(() => {
        const s = m.getSnapshot();
        const msgs = s.sessions.find((x) => x.id === s.activeId)?.messages;
        const last = msgs && msgs.length ? msgs[msgs.length - 1] : undefined;
        // 思维链取「当前轮」尾部（多段思考时桌宠跟随最新一段）
        const rounds = last?.rounds;
        m.updateChatFeedBridge({
          streaming: s.streaming,
          lastMsg: last
            ? {
                role: last.role,
                content: last.content,
                reasoning: rounds?.length ? rounds[rounds.length - 1].r : last.reasoning,
                error: last.error,
              }
            : undefined,
        });
        check();
      });
    });
  } catch {
    /* 非 ESM 环境 */
  }
  return () => {
    if (timer !== null) window.clearTimeout(timer);
    unsub?.();
  };
}

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

/** 主题桥：广播当前主题变量与 data-theme（rAF 去抖，等样式落地后采集） */
export function broadcastTheme() {
  if (themeRaf) return;
  themeRaf = requestAnimationFrame(() => {
    themeRaf = 0;
    const { vars, theme } = collectThemeVars();
    broadcast({ type: "aiw:theme", vars, theme });
  });
}

export function startWidgetHub() {
  if (started) return;
  started = true;
  try {
    const ch = new BroadcastChannel(CH);
    ch.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; reqId?: string; mode?: string; text?: string };
      if (d?.type === "aiw:theme-req") {
        // 桌面窗小部件索取当前主题（init 时一次性）
        broadcastTheme();
        return;
      }
      const isAsk = d?.type === "aiw:ask-req";
      if (d?.type !== "aiw:send-req" && !isAsk) return;
      const reply = (extra: Record<string, unknown>) => {
        try {
          ch.postMessage({
            type: isAsk ? "aiw:ask-res" : "aiw:send-res",
            reqId: d.reqId,
            ...extra,
          });
        } catch {
          return;
        }
      };
      const sendOk = getSettings().aiWidgetSend;
      if (!sendOk) {
        reply({ ok: false, err: isAsk ? "小部件发送权限未开启（ask 需要该权限）" : "小部件发送权限未开启" });
        return;
      }
      if (isAsk) {
        const text = String(d.text ?? "").slice(0, 4000);
        if (!text.trim()) {
          reply({ ok: false, err: "提问内容为空" });
          return;
        }
        void import("./chatStore")
          .then((m) => {
            // 忙时入队（上限 3）；回答经 aiw:chat 广播回小部件
            const r = m.requestAsk(text);
            reply({ ok: r.ok, queued: r.queued, err: r.err });
          })
          .catch((err) => reply({ ok: false, err: String(err) }));
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
  // AI 对话状态：小部件感知思考中/输出中/完成（含思维链与正文尾部）
  unChat = subscribeChatFeed(() => {
    broadcastChatFeed(broadcast);
  });
  // 主题桥：换肤/主题扩展变化 → 广播变量给所有沙箱组件
  unTheme = subSettings(broadcastTheme);
  unExts = subExts(broadcastTheme);
}

export function stopWidgetHub() {
  unFrames?.();
  unFrames = null;
  unChat?.();
  unChat = null;
  unTheme?.();
  unTheme = null;
  unExts?.();
  unExts = null;
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
  return hubRequest("aiw:send-req", "aiw:send-res", { mode, text }, "发送请求超时（主窗口未响应）");
}

/** 桌面窗小部件 → 主窗口索取当前主题变量（一次性） */
export function requestThemeViaHub() {
  try {
    const ch = new BroadcastChannel(CH);
    ch.postMessage({ type: "aiw:theme-req" });
    window.setTimeout(() => ch.close(), 800);
  } catch {
    /* 忽略 */
  }
}

/** 桌面窗小部件 → 主窗口 AI 助手提问（回答经 aiw:chat 流式回传） */
export function requestAskViaHub(text: string): Promise<void> {
  return hubRequest("aiw:ask-req", "aiw:ask-res", { text }, "提问请求超时（主窗口未响应）");
}

function hubRequest(
  reqType: string,
  resType: string,
  payload: Record<string, unknown>,
  timeoutMsg: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let ch: BroadcastChannel | null = null;
    const reqId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMsg));
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
      if (d?.type !== resType || d.reqId !== reqId) return;
      cleanup();
      if (d.ok) resolve();
      else reject(new Error(d.err ?? "请求失败"));
    };
    ch.postMessage({ type: reqType, reqId, ...payload });
  });
}
