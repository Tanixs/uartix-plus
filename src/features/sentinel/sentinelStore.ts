import { onFrames } from "../../ipc/framesBus";
import * as panelActivity from "../../panels/panelActivity";
import { getSnapshot as getSerial, subscribe as subSerial } from "../serial/serialStore";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { requestClosePanel, requestOpenPanel } from "../ai/appBus";
import { invokeAiScene } from "../ai/aiBus";
import { runScene } from "../ai/chatStore";
import { toast, collectThemeVars } from "../ai/extRuntime";
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
      autoDiag: typeof p.autoDiag === "boolean" ? p.autoDiag : false,
      diagCooldownMin: typeof p.diagCooldownMin === "number" ? Math.min(60, Math.max(1, Math.round(p.diagCooldownMin))) : 5,
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
  // 自动 AI 诊断：新 crit 上头 + 开关 + 冷却（P68）
  maybeAutoDiag(head, prevHead?.id);
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

export function setAutoDiag(b: boolean): void {
  patchCfg({ autoDiag: b });
}

export function setDiagCooldownMin(n: number): void {
  patchCfg({ diagCooldownMin: Math.min(60, Math.max(1, Math.round(n))) });
}

// ---- AI 诊断（P68）----

/** 自动诊断上次发起时刻（冷却用） */
let lastAutoDiagTs = 0;

const IFACE_LABEL: Record<string, string> = {
  serial: "串口",
  "tcp-client": "TCP 客户端",
  "tcp-server": "TCP 服务端",
  udp: "UDP",
  ble: "BLE",
};

/** 构建结构化诊断证据文本（喂给 AI diagnose 场景；中文——AI 提示词同语种） */
export function buildEvidence(trigger?: string): string {
  const s = engine.snapshot();
  const se = getSerial();
  const lines: string[] = [];
  const desc =
    se.status === "connected"
      ? `${IFACE_LABEL[se.iface] ?? se.iface} ${se.portName ?? ""} 已连接`
      : `${IFACE_LABEL[se.iface] ?? se.iface} 未连接`;
  lines.push(`连接状态：${desc}`);
  if (trigger) lines.push(`触发原因：${trigger}`);
  lines.push(
    `健康度 ${s.health}/100（活跃异常：严重 ${s.activeCrit} · 警告 ${s.activeWarn}）` +
      (s.learning ? "（学习期，基线建立中）" : ""),
  );
  lines.push(
    `统计：帧 ${s.totals.frames} · 错误帧 ${s.totals.errors}` +
      (s.totals.frames > 0 ? `（错误率 ${((s.totals.errors / s.totals.frames) * 100).toFixed(1)}%）` : "") +
      (s.conn && s.silenceMs >= 0 ? ` · 距上一帧 ${(s.silenceMs / 1000).toFixed(1)}s` : ""),
  );
  const act = s.alerts.filter((a) => a.kind !== "recover").slice(0, 10);
  if (act.length) {
    lines.push("近期报警（新→旧）：");
    for (const a of act) {
      lines.push(
        `  - [${a.level === "crit" ? "严重" : a.level === "warn" ? "警告" : "信息"}] ${a.msg}${a.count > 1 ? `（×${a.count}）` : ""}`,
      );
    }
  } else {
    lines.push("近期报警：无");
  }
  const bad = s.chans.filter((c) => c.level !== "ok").slice(0, 8);
  if (bad.length) {
    lines.push("异常通道（评分降序）：");
    for (const c of bad) {
      lines.push(`  - ${c.name}：${c.level === "crit" ? "严重" : "警告"} · 当前 ${c.last} · 突变评分 ${c.score.toFixed(1)}σ`);
    }
  }
  if (s.frameTypes.length) {
    lines.push(
      `帧型：${s.frameTypes.slice(0, 8).map((t) => `${t.name}×${t.count}${t.isNew ? "（新）" : ""}`).join("、")}`,
    );
  }
  return lines.join("\n");
}

/** 手动诊断：打开 AI 并携带哨兵证据发起 diagnose 场景 */
export function diagnoseNow(trigger?: string): void {
  invokeAiScene("diagnose", { text: buildEvidence(trigger) });
}

/**
 * 自动诊断（emitNow 内新 crit 上头时调用）：
 * 开关 + 冷却 + AI 已配置三重门禁；直接写入 AI 会话（不弹浮窗，不抢焦点）。
 */
function maybeAutoDiag(head: SentinelAlert | undefined, prevHeadId: string | undefined): void {
  if (!cfg.autoDiag || !head) return;
  if (head.level !== "crit" || head.kind === "recover") return;
  if (head.id === prevHeadId) return;
  const now = Date.now();
  if (now - lastAutoDiagTs < cfg.diagCooldownMin * 60_000) return;
  const st = getSettings();
  if (!st.aiBaseUrl) {
    toast("哨兵自动诊断：未配置 AI 服务（设置 → AI 服务）");
    return;
  }
  lastAutoDiagTs = now;
  void runScene("diagnose", { text: buildEvidence(`严重报警自动触发：${head.msg}`) }).catch(() => {
    /* 发送失败已在会话内落错误消息 */
  });
  toast(`哨兵已自动发起 AI 诊断（${cfg.diagCooldownMin} 分钟内不重复）`);
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
