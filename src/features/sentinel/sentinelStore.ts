import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";
import { getSnapshot as getSerial, subscribe as subSerial } from "../serial/serialStore";
import { requestClosePanel, requestOpenPanel } from "../ai/appBus";
import { collectThemeVars } from "../ai/extRuntime";
import { playAlertTone } from "./sentinelSound";
import {
  broadcastWidgetState,
  broadcastWidgetTheme,
  startSentinelHub,
  WIDGET_POS_KEY,
  type WidgetState,
} from "./sentinelHub";
import {
  DEFAULT_CONFIG,
  SentinelEngine,
  type ChanStat,
  type FrameTypeStat,
  type SentinelAlert,
  type SentinelConfig,
  type Sensitivity,
} from "./sentinelEngine";

/**
 * 哨兵 store（P62）——引擎生命周期门控 + 配置持久化 + React 快照桥。
 *
 * 门控（用户决议：不做全局后台监测）：
 *   面板在布局中 或 最小化浮球激活 → 引擎运行；面板 × 关闭且无浮球 → 引擎停止。
 * emit 门控：面板可见 或 浮球激活（后台标签组不重渲染，恢复可见时补 emit）。
 */

const CFG_KEY = "vs.sentinel";
const FLOAT_KEY = "vs.sentinel.float";

export interface StoreSnapshot {
  running: boolean;
  learning: boolean;
  alerts: SentinelAlert[];
  unack: number;
  health: number;
  chans: ChanStat[];
  chanTotal: number;
  frameTypes: FrameTypeStat[];
  lastFrameTs: number;
  silenceMs: number;
  conn: boolean;
  totals: { frames: number; errors: number };
  activeCrit: number;
  activeWarn: number;
  cfg: SentinelConfig;
  floating: boolean;
}

function loadCfg(): SentinelConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const p = JSON.parse(raw) as Partial<SentinelConfig>;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : true,
      sensitivity: p.sensitivity === "low" || p.sensitivity === "high" ? p.sensitivity : "mid",
      silenceSec: typeof p.silenceSec === "number" ? Math.min(30, Math.max(1, p.silenceSec)) : 3,
      errRatePct: typeof p.errRatePct === "number" ? Math.min(100, Math.max(1, p.errRatePct)) : 10,
      mutedKeys: Array.isArray(p.mutedKeys) ? p.mutedKeys.filter((x): x is string => typeof x === "string") : [],
      sound: typeof p.sound === "boolean" ? p.sound : true,
      volume: typeof p.volume === "number" ? Math.min(100, Math.max(0, p.volume)) : 70,
      alertCap: typeof p.alertCap === "number" ? Math.min(2000, Math.max(20, Math.round(p.alertCap))) : DEFAULT_CONFIG.alertCap,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function loadFloat(): boolean {
  try {
    return localStorage.getItem(FLOAT_KEY) === "1";
  } catch {
    return false;
  }
}

let cfg: SentinelConfig = loadCfg();
let floating = loadFloat();
let startedAt = 0;

const engine = new SentinelEngine(cfg.alertCap);

const listeners = new Set<() => void>();

function buildSnap(): StoreSnapshot {
  const s = engine.snapshot();
  return { ...s, cfg, floating };
}

let snap: StoreSnapshot = buildSnap();

function emitNow(): void {
  const prevHead = snap.alerts[0];
  snap = buildSnap();
  const head = snap.alerts[0];
  // 提示音只对「新条目上头」响：冷却合并（同 id ×N）不重复轰炸；recover 走柔音
  if (head && head.id !== prevHead?.id && cfg.sound && cfg.enabled) {
    playAlertTone(head.level, head.kind === "recover");
  }
  // 挂件广播（频道不存在时 post 内部静默）
  const ws: WidgetState = {
    health: snap.health,
    unack: snap.unack,
    activeCrit: snap.activeCrit,
    activeWarn: snap.activeWarn,
    enabled: cfg.enabled,
    running: snap.running,
    alerts: snap.alerts.slice(0, 3).map((a) => ({ key: a.key, level: a.level, msg: a.msg, ts: a.ts })),
    ts: Date.now(),
  };
  broadcastWidgetState(ws);
  listeners.forEach((l) => l());
}

function panelInLayout(): boolean {
  return panelActivity.isOpen("sentinel");
}

function wantRunning(): boolean {
  return cfg.enabled && (panelInLayout() || floating);
}

function shouldEmit(): boolean {
  return panelActivity.isVisible("sentinel") || floating;
}

/** 依据门控重新评估引擎启停 */
function evaluate(): void {
  const want = wantRunning();
  if (want && !snap.running) {
    startedAt = Date.now();
    engine.start(startedAt);
    engine.setConn(getSerial().status === "connected", startedAt);
    emitNow();
  } else if (!want && snap.running) {
    engine.stop();
    emitNow();
  }
}

let inited = false;

export function init(): void {
  if (inited) return;
  inited = true;
  engine.configure(cfg);
  // 帧数据入口：引擎未运行时 ingest 直接 return（零开销）
  onFrames((p) => engine.ingest(p));
  // 连接态桥
  subSerial(() => {
    engine.setConn(getSerial().status === "connected", Date.now());
  });
  // 面板开/关/可见性变化 → 重估门控；恢复可见补 emit
  panelActivity.subscribe(() => {
    evaluate();
    if (shouldEmit()) emitNow();
  });
  // 1s 评估周期（引擎未运行时 tick 空转返回 false，emit 也被门控）
  window.setInterval(() => {
    engine.tick(Date.now());
    if (shouldEmit()) emitNow();
  }, 1000);
  // 桌面挂件桥：挂件请求开面板/确认/静音/主题
  startSentinelHub({
    open: () => {
      if (floating) restoreFromFloat();
      else requestOpenPanel("sentinel");
    },
    ackAll,
    mute,
    theme: collectThemeVars,
  });
  // 主题切换 → 挂件跟随（轻量：仅在桥存在时 post）
  void import("../settings/settingsStore").then((m) => {
    m.subscribe(() => broadcastWidgetTheme(collectThemeVars()));
  });
  evaluate();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): StoreSnapshot {
  return snap;
}

function persistCfg(): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* 配额满：仅内存生效 */
  }
}

function patchCfg(next: Partial<SentinelConfig>): void {
  cfg = { ...cfg, ...next };
  engine.configure(cfg);
  if (next.alertCap !== undefined) engine.setCap(cfg.alertCap);
  persistCfg();
  evaluate();
  emitNow();
}

// ---- 配置动作 ----

export function setEnabled(b: boolean): void {
  patchCfg({ enabled: b });
}

export function setSensitivity(s: Sensitivity): void {
  patchCfg({ sensitivity: s });
}

export function setSilenceSec(n: number): void {
  patchCfg({ silenceSec: Math.min(30, Math.max(1, Math.round(n))) });
}

export function setErrRatePct(n: number): void {
  patchCfg({ errRatePct: Math.min(100, Math.max(1, Math.round(n))) });
}

export function setSound(b: boolean): void {
  patchCfg({ sound: b });
}

export function setVolume(n: number): void {
  patchCfg({ volume: Math.min(100, Math.max(0, Math.round(n))) });
}

export function setAlertCap(n: number): void {
  patchCfg({ alertCap: Math.min(2000, Math.max(20, Math.round(n))) });
}

// ---- 报警操作 ----

export function ack(id: string): void {
  engine.ack(id);
  emitNow();
}

export function ackAll(): void {
  engine.ackAll();
  emitNow();
}

export function clearAlerts(): void {
  engine.clear();
  emitNow();
}

export function mute(key: string): void {
  if (cfg.mutedKeys.includes(key)) return;
  patchCfg({ mutedKeys: [...cfg.mutedKeys, key] });
}

export function unmute(key: string): void {
  if (!cfg.mutedKeys.includes(key)) return;
  patchCfg({ mutedKeys: cfg.mutedKeys.filter((k) => k !== key) });
}

// ---- 浮球（最小化）----

function persistFloat(): void {
  try {
    localStorage.setItem(FLOAT_KEY, floating ? "1" : "0");
  } catch {
    /* 仅内存 */
  }
}

/** 面板顶栏「最小化」：浮球接管监测驻留，面板从布局移除 */
export function minimizeToFloat(): void {
  if (floating) return;
  floating = true;
  persistFloat();
  requestClosePanel("sentinel");
  evaluate();
  emitNow();
}

/** 点浮球：重新打开面板（浮球收起） */
export function restoreFromFloat(): void {
  if (!floating) return;
  floating = false;
  persistFloat();
  requestOpenPanel("sentinel");
  evaluate();
  emitNow();
}

/** 浮球上直接「停止监测」：清浮球态（面板也未开 → 引擎停） */
export function dismissFloat(): void {
  if (!floating) return;
  floating = false;
  persistFloat();
  evaluate();
  emitNow();
}

/** 弹出独立桌面挂件窗（无边框置顶；已存在则唤回；位置持久化） */
export function popWidget(): void {
  void (async () => {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = "sentinel-widget";
    const exist = await WebviewWindow.getByLabel(label).catch(() => null);
    if (exist) {
      await exist.unminimize().catch(() => undefined);
      await exist.show().catch(() => undefined);
      await exist.setFocus().catch(() => undefined);
      return;
    }
    let pos: { x: number; y: number } | null = null;
    try {
      const raw = localStorage.getItem(WIDGET_POS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { x?: number; y?: number };
        if (typeof p.x === "number" && typeof p.y === "number" && p.x > -2000 && p.y > -2000 && p.x < 99999 && p.y < 99999) {
          pos = { x: p.x, y: p.y };
        }
      }
    } catch {
      /* 默认居中 */
    }
    new WebviewWindow(label, {
      url: `${location.origin}${location.pathname}#/sentinel-widget`,
      title: "哨兵",
      width: 236,
      height: 208,
      minWidth: 200,
      minHeight: 160,
      alwaysOnTop: true,
      decorations: false,
      shadow: true,
      resizable: true,
      ...(pos ? { x: pos.x, y: pos.y } : {}),
    });
  })();
}
