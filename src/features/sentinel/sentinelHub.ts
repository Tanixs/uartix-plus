import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 哨兵桌面挂件广播桥（P62-S2），BroadcastChannel("vs-sentinel-hub")。
 *
 * 消息流：
 * - 主窗 → 挂件：snt:state（1Hz 简化快照，ts 兼心跳）、snt:theme（主题变量集）
 * - 挂件 → 主窗：snt:req { type: theme-req | open | ackAll | mute }（mute 带 key）
 *
 * 依赖方向：store → hub（startSentinelHub 注册回调），hub 不 import store（防环）。
 */

export const SENTINEL_CH = "vs-sentinel-hub";

/** 挂件窗位置（逻辑像素）：挂件侧 onMoved 写入，主窗 popWidget 读取。放 hub 层避免挂件 import store */
export const WIDGET_POS_KEY = "vs.sentinel.widget.pos";

export interface WidgetState {
  health: number;
  unack: number;
  activeCrit: number;
  activeWarn: number;
  enabled: boolean;
  running: boolean;
  /** 最近 3 条非 info 报警（新→旧） */
  alerts: { key: string; level: "warn" | "crit" | "info"; msg: string; ts: number }[];
  ts: number;
}

export interface HubHandlers {
  open(): void;
  ackAll(): void;
  mute(key: string): void;
  theme(): { vars: Record<string, string>; theme: string };
}

let ch: BroadcastChannel | null = null;

function post(msg: Record<string, unknown>): void {
  try {
    ch?.postMessage(msg);
  } catch {
    /* 频道断开：下次广播再试 */
  }
}

/** 主窗启动桥（store.init 调一次）。挂件窗口不会调此函数。 */
export function startSentinelHub(h: HubHandlers): void {
  if (ch) return;
  try {
    ch = new BroadcastChannel(SENTINEL_CH);
  } catch {
    ch = null;
    return;
  }
  ch.onmessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; req?: string; key?: string };
    if (d?.type !== "snt:req") return;
    if (d.req === "theme-req") broadcastWidgetTheme(h.theme());
    else if (d.req === "open") {
      h.open();
      void getCurrentWindow().setFocus().catch(() => undefined);
    } else if (d.req === "ackAll") h.ackAll();
    else if (d.req === "mute" && typeof d.key === "string") h.mute(d.key);
  };
}

export function broadcastWidgetState(s: WidgetState): void {
  post({ type: "snt:state", s });
}

export function broadcastWidgetTheme(t: { vars: Record<string, string>; theme: string }): void {
  post({ type: "snt:theme", ...t });
}

// ---- 挂件窗口侧（独立根，只用频道） ----

export function widgetSubscribe(
  onState: (s: WidgetState) => void,
  onTheme: (t: { vars: Record<string, string>; theme: string }) => void,
): () => void {
  let c: BroadcastChannel | null = null;
  try {
    c = new BroadcastChannel(SENTINEL_CH);
  } catch {
    return () => undefined;
  }
  c.onmessage = (e: MessageEvent) => {
    const d = e.data as ({ type?: string; s?: WidgetState } & Record<string, unknown>) | null;
    if (d?.type === "snt:state" && d.s) onState(d.s);
    else if (d?.type === "snt:theme") onTheme({ vars: (d.vars as Record<string, string>) ?? {}, theme: String(d.theme ?? "dark") });
  };
  // 索取一次当前主题（状态广播 1Hz 自动到达；主窗在则即时回）
  try {
    c.postMessage({ type: "snt:req", req: "theme-req" });
  } catch {
    /* 忽略 */
  }
  return () => {
    c?.close();
  };
}

export function widgetReq(req: "open" | "ackAll" | { mute: string }): void {
  try {
    const c = new BroadcastChannel(SENTINEL_CH);
    if (typeof req === "string") c.postMessage({ type: "snt:req", req });
    else c.postMessage({ type: "snt:req", req: "mute", key: req.mute });
    window.setTimeout(() => c.close(), 400);
  } catch {
    /* 主窗未开 */
  }
}
