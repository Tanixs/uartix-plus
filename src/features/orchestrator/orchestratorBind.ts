/**
 * 自动编排器与外部世界的接线层（P74-2）。
 *
 * 职责（且仅此几件）：
 * 1. OrchDeps 的实现（发送 / 序列调用 / 等待帧 / 通道最新值 / 会话状态 / 通知 / 提示音）；
 * 2. 事件源：会话启停 / 帧流（stride 与匹配在引擎）/ 阈值差分 / 定时器 / 哨兵告警。
 *    varChanged 由引擎 setVar 内生派发；manual 由 UI ▶ 直调 runManual，不走这里。
 * 3. 面板生命周期：关闭「自动编排器」面板 → 停止全部实例 + 事件源静默
 *    （用户红线：关掉的面板绝不允许在后台跑自动化）。
 *
 * 模块级单例、首次 import 即生效（与 sequencerBind 同模式）。
 * 引擎（engine.ts）保持纯逻辑，CLI/测试直接 new OrchEngine 注入自己的 deps。
 */

import * as sequencerBind from "../sequencer/sequencerBind";
import * as sequencerStore from "../sequencer/sequencerStore";
import { testFrameMatch } from "../sequencer/runner";
import type { FrameMatch, ResolvedSend, SendPayload } from "../sequencer/types";
import { onFrames } from "../../ipc/framesBus";
import type { FrameRow, SerialStatus } from "../../ipc/types";
import { tx } from "../../i18n/strings";
import * as panelActivity from "../../panels/panelActivity";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "../controls/variableStore";
import * as commandStore from "../controls/commandStore";
import * as controlsStore from "../controls/controlsStore";
import * as plotStore from "../plot/plotStore";
import * as imageStore from "../ai/imageStore";
import * as sentinelStore from "../sentinel/sentinelStore";
import { playAlertTone } from "../sentinel/sentinelSound";
import { toast } from "../ai/extRuntime";
import { OrchEngine, type OrchDeps } from "./engine";
import { flowInterpolateHex, flowInterpolateText } from "./sendTpl";
import * as orchestratorStore from "./orchestratorStore";
import type { FlowDoc, FlowNode, FrameRowLite } from "./types";

const PANEL_ID = "orchestrator";

/** 事件源扫描节拍（定时器/阈值差分共用一个 interval，面板关闭时空转） */
const TICK_MS = 100;
/** 等待帧环形缓冲容量（与序列器 frameBufCap 同量级） */
const FRAME_BUF_CAP = 200;
/** 流判定：N ms 内有帧 = streaming，否则 open */
const STREAMING_MS = 2000;
/** 并发等待帧 waiter 上限 */
const WAITER_CAP = 32;
/** runSuite(wait) 轮询间隔 / 硬超时 */
const SUITE_POLL_MS = 150;
const SUITE_WAIT_CAP_MS = 30 * 60_000;

/* ================= deps ================= */

/** {var} 占位：编排器变量优先，控制画布变量兜底（resolveVars） */
function flowValue(name: string): number | string | boolean | undefined {
  return orchEngine.getVar(name);
}

function resolveSendOrch(payload: SendPayload): ResolvedSend | null {
  // cmd 分支自行处理：命令库模板的 {var} 先走编排器变量，再回落控制画布变量
  if (payload.type === "cmd") {
    const item = commandStore.getCommand(payload.cmdId);
    if (!item || !item.template.trim()) return null;
    return {
      mode: item.sendMode,
      text: variableStore.resolveVars(flowInterpolateText(item.template, flowValue)),
    };
  }
  const r = sequencerBind.resolveSend(payload);
  if (!r) return null;
  // B4e：factory 多帧逐帧插值透传
  if ("frames" in r) return { mode: "hex", frames: r.frames.map((f) => flowInterpolateHex(f, flowValue)) };
  return {
    mode: r.mode,
    text: r.mode === "hex" ? flowInterpolateHex(r.text, flowValue) : flowInterpolateText(r.text, flowValue),
  };
}

/** 序列器变量语义（number|string|undefined）：布尔折算 0/1 */
function gvForMatch(name: string): number | string | undefined {
  const v = orchEngine.getVar(name);
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

/** B4c：面板截图（deps.snapshotPanel 用）——通用 canvas 合成，按 data-panel 找可见画布 */
function capturePanelCanvas(panel: "plot2d" | "plot3d" | "spectrum"): string | null {
  const root = document.querySelector(`[data-panel="${panel}"]`);
  if (!root) return null;
  const canvases = Array.from(root.querySelectorAll("canvas")).filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && c.width > 0 && c.height > 0;
  });
  if (!canvases.length) return null;
  const base = canvases[0].getBoundingClientRect();
  const fullW = Math.min(Math.ceil(base.width), 2400);
  const fullH = Math.min(Math.ceil(base.height), 1600);
  const out = document.createElement("canvas");
  out.width = fullW;
  out.height = fullH;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  const bg = getComputedStyle(root).backgroundColor;
  ctx.fillStyle = bg && bg !== "transparent" ? bg : "#ffffff";
  ctx.fillRect(0, 0, fullW, fullH);
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const kx = fullW / base.width;
    const ky = fullH / base.height;
    ctx.drawImage(c, (r.left - base.left) * kx, (r.top - base.top) * ky, c.width * kx, c.height * ky);
  }
  return out.toDataURL("image/png");
}

const deps: OrchDeps = {
  now: () => Date.now(),
  resolveSend: resolveSendOrch,
  send: async (mode, text) => {
    await serialStore.sendData(mode, text);
  },
  runSuite: (suiteId, wait) => runSuiteById(suiteId, wait),
  waitFrame: waitFrameImpl,
  chanLatest: (chId) => {
    const d = plotStore.getChanData(chId);
    const n = d.v.length;
    return n > 0 ? d.v[n - 1] : null;
  },
  sessionState: () => {
    const st = serialStore.getSnapshot().status;
    if (st !== "connected") return "idle";
    return Date.now() - lastFrameTs < STREAMING_MS ? "streaming" : "open";
  },
  toast: (text) => toast(text),
  sound: (level) => playAlertTone(level, false, 70),
  // 持久变量值变动 → 防抖落盘（P74c A1 的「写」半边）
  onVarsChanged: () => orchestratorStore.scheduleVarsPersist(),

  /* ---------- B4c 新增钩子 ---------- */
  /** 写控制画布变量（运行时值，非配置；Operator 只读不拦） */
  writeControlVar: (name, value) => {
    if (variableStore.getVar(name) === undefined) return false;
    variableStore.setVar(name, value);
    return true;
  },
  /** 拨开关卡：按名在当前页优先、全页兜底查找 SwitchCard，写回卡配置（视图 useEffect 跟随） */
  setSwitchCard: (name, state) => {
    const snap = controlsStore.getSnapshot();
    const active = snap.pages.find((p) => p.id === snap.activePageId);
    const pages = [active, ...snap.pages];
    for (const p of pages) {
      if (!p) continue;
      const card = p.cards.find((c) => c.type === "switch" && c.name === name);
      if (card && card.type === "switch") {
        const cur = typeof card.state === "number" ? card.state : 0;
        const pos = Math.max(2, card.positions || 2);
        const next = state === "on" ? pos - 1 : state === "off" ? 0 : (cur + 1) % pos;
        controlsStore.patchCard(p.id, card.id, { state: next });
        return true;
      }
    }
    return false;
  },
  /** 面板截图 → 图片库（容量管理复用 ai/imageStore） */
  snapshotPanel: async (panel, note) => {
    const dataUrl = capturePanelCanvas(panel);
    if (!dataUrl) return false;
    try {
      await imageStore.saveImage(`orch-${note || panel}-${Date.now()}`, dataUrl);
      return true;
    } catch {
      return false;
    }
  },
  /** 通道数据导出 CSV（保存对话框；用户取消/无数据 = false） */
  exportCsv: async (chanId, lastN) => {
    const d = plotStore.getChanData(chanId);
    if (!d || d.t.length === 0) return false;
    const n = Math.min(lastN, d.t.length);
    const rows: string[] = ["time,value"];
    for (let i = d.t.length - n; i < d.t.length; i++) {
      rows.push(`${d.t[i]},${d.v[i]}`);
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({
        defaultPath: `orch-${chanId}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (typeof path !== "string") return false;
      await invoke("save_text_file", { path, content: "\uFEFF" + rows.join("\r\n") });
      return true;
    } catch {
      return false;
    }
  },
  stopSuite: () => sequencerBind.stopSuite(),
  /** 写剪贴板（WebView2 下无需用户手势也可写；拒绝 = false） */
  clipWrite: async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
};

/* ================= 引擎单例 ================= */

export const orchEngine = new OrchEngine(deps);

// 反向注入：store 落盘时向引擎要「持久变量现值」快照（store 不 import bind，防环）
orchestratorStore.setVarsProvider(() => orchEngine.persistVars());

let doc: FlowDoc | null = null;

/* ================= 等待帧（deps.waitFrame） ================= */

interface BufEntry {
  ts: number;
  row: FrameRowLite;
}

interface Waiter {
  match: FrameMatch;
  fromTs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(r: FrameRowLite | null): void;
}

/** 环形缓冲（head + len，避免逐条 shift） */
const frameBuf: (BufEntry | undefined)[] = new Array(FRAME_BUF_CAP);
let bufHead = 0;
let bufLen = 0;
const waiters = new Set<Waiter>();

function bufPush(e: BufEntry): void {
  if (bufLen < FRAME_BUF_CAP) {
    frameBuf[(bufHead + bufLen) % FRAME_BUF_CAP] = e;
    bufLen++;
  } else {
    frameBuf[bufHead] = e;
    bufHead = (bufHead + 1) % FRAME_BUF_CAP;
  }
}

function bufFind(pred: (e: BufEntry) => boolean): BufEntry | undefined {
  for (let i = 0; i < bufLen; i++) {
    const e = frameBuf[(bufHead + i) % FRAME_BUF_CAP];
    if (e && pred(e)) return e;
  }
  return undefined;
}

function waitFrameImpl(match: FrameMatch, timeoutMs: number, fromTs: number): Promise<FrameRowLite | null> {
  // 先查既有缓冲（实例开始后的帧即算数）
  const hit = bufFind((e) => e.ts >= fromTs && testFrameMatch(e.row as never, match, gvForMatch));
  if (hit) return Promise.resolve(hit.row);
  if (timeoutMs <= 0) return Promise.resolve(null);
  if (waiters.size >= WAITER_CAP) return Promise.resolve(null);
  return new Promise((resolve) => {
    const w: Waiter = {
      match,
      fromTs,
      timer: setTimeout(() => {
        waiters.delete(w);
        resolve(null);
      }, timeoutMs),
      resolve,
    };
    waiters.add(w);
  });
}

function flushWaiters(rows: BufEntry[]): void {
  if (waiters.size === 0 || rows.length === 0) return;
  for (const w of [...waiters]) {
    const hit = rows.find((e) => e.ts >= w.fromTs && testFrameMatch(e.row as never, w.match, gvForMatch));
    if (hit) {
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve(hit.row);
    }
  }
}

function clearWaiters(): void {
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
  waiters.clear();
}

/* ================= 事件源：帧流 ================= */

let lastFrameTs = 0;
/** 会话级已见帧型集合（B4d newTpl 用；session stop 清空，重连重新首见） */
const seenTpl = new Set<string>();
/** 有 newTpl 事件块才做 Set 查询（rebuildSources 置位，O(1) 判定） */
let needTplWatch = false;
/** 有 idle 事件块才做重武装（onFrames 热路径零成本） */
let needIdleArm = false;

/* ---------- B4d：通道变化 / 空闲检测器（tick 驱动，同 timer/threshold 模式） ---------- */

interface ChanWatchSrc {
  groupId: string;
  blockId: string;
  chId: string;
  tol: number;
  minIntervalMs: number;
  /** 上次**报出**的值（变化判定基准）；null = 未武装 */
  lastEmit: number | null;
  lastEmitTs: number;
}

interface IdleSrc {
  groupId: string;
  blockId: string;
  idleMs: number;
  /** 电平语义：一次空闲只报一次；再收帧由 onFrames 重新武装 */
  armed: boolean;
}

const chanWatch = new Map<string, ChanWatchSrc>();
const idleBlocks = new Map<string, IdleSrc>();
/**
 * 是否需要帧缓冲/投影（rebuildSources 计算，P74c C3）：
 * - 组事件槽有「帧命中」事件 → 需要（引擎按匹配判定）
 * - 任意位置有「等待帧」块 → 需要（deps.waitFrame 从环形缓冲里找已到达的帧）
 * 两者都没有时，每帧只更新 lastFrameTs（会话 streaming 判定），
 * 不再为 200Hz 流做 toLite 对象 + 字段数组分配。
 */
let needFrames = true;

function scanNeedFrames(): boolean {
  if (
    (doc?.groups ?? []).some((g) =>
      g.events.some((b) => b.kind === "frame" || b.kind === "frameError" || b.kind === "newTpl"),
    )
  )
    return true;
  let hit = false;
  const walk = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (hit) return;
      if (n.kind === "waitFrame") hit = true;
      else if (n.kind === "group") walk(n.children);
      else if (n.kind === "if") {
        walk(n.then);
        walk(n.els);
      } else if (n.kind === "loop") walk(n.body);
    }
  };
  for (const g of doc?.groups ?? []) walk(g.children);
  return hit;
}

function toLite(row: FrameRow): FrameRowLite {
  return {
    tplId: row.tplId,
    tplName: row.tplName,
    valid: row.valid,
    len: row.len,
    bytes: row.bytes,
    fields: row.fields.map((f) => ({ id: f.id, name: f.name, value: f.value, text: f.text })),
  };
}

onFrames((p) => {
  lastFrameTs = Date.now();
  if (!panelActivity.isOpen(PANEL_ID) || !doc) return; // 红线：面板关闭事件源静默
  if (needIdleArm) for (const s of idleBlocks.values()) s.armed = true; // 再收帧 → 重新武装
  if (!needFrames) return; // 无帧事件也无等待帧块 → 零分配（P74c C3）
  const rows = p.rows;
  if (rows.length === 0) return;
  const entries: BufEntry[] = [];
  for (const row of rows) {
    const e: BufEntry = { ts: row.tsMs, row: toLite(row) };
    bufPush(e);
    entries.push(e);
  }
  flushWaiters(entries);
  for (const e of entries) {
    orchEngine.emit({ kind: "frame", row: e.row }); // frame 与 frameError 块都吃这条
    if (needTplWatch && !seenTpl.has(e.row.tplId)) {
      seenTpl.add(e.row.tplId);
      orchEngine.emit({ kind: "newTpl", tplId: e.row.tplId, tplName: e.row.tplName, len: e.row.len });
    }
  }
});

/* ================= 事件源：会话启停 ================= */

let prevStatus: SerialStatus | null = null;

serialStore.subscribe(() => {
  const st = serialStore.getSnapshot().status;
  if (st === prevStatus) return;
  const prev = prevStatus;
  prevStatus = st;
  if (prev === null) return; // 首次同步不触发
  if (st === "disconnected") {
    // 会话停止：停实例 + 复位非持久变量（状态清理，不受面板门控）
    if (panelActivity.isOpen(PANEL_ID)) orchEngine.emit({ kind: "session", phase: "stop" });
    orchEngine.sessionStop();
    seenTpl.clear(); // B4d：新帧型记忆清空（重连重新首见）
  } else if (st === "connected" && panelActivity.isOpen(PANEL_ID) && doc) {
    orchEngine.emit({ kind: "session", phase: "start" });
  }
});

/* ================= 事件源：定时器 + 阈值差分（共用节拍） ================= */

interface TimerSrc {
  groupId: string;
  blockId: string;
  interval: number;
  next: number;
}

interface ThreshSrc {
  groupId: string;
  blockId: string;
  chId: string;
  op: "above" | "below";
  value: number;
  edge: "enter" | "exit";
  debounce: number;
  /** confirmed 状态 / pending 半确认状态 */
  cur: boolean;
  pending: boolean;
  pendingTs: number;
}

const timers = new Map<string, TimerSrc>();
const thresholds = new Map<string, ThreshSrc>();

/** 重建事件源注册表（applyDoc / 文档变更时调用）；跨文档保留 timer 相位防抖动 */
function rebuildSources(): void {
  needFrames = scanNeedFrames();
  const nextTimers = new Map<string, TimerSrc>();
  const nextThresholds = new Map<string, ThreshSrc>();
  const nextChanWatch = new Map<string, ChanWatchSrc>();
  const nextIdle = new Map<string, IdleSrc>();
  const now = Date.now();
  needTplWatch = false;
  needIdleArm = false;
  for (const g of doc?.groups ?? []) {
    for (const b of g.events) {
      if (b.kind === "timer") {
        const old = timers.get(b.id);
        const interval = Math.max(50, Math.round(b.intervalMs));
        // 同块保留相位（改参数不重置节拍）；新块从 now + interval 起跳
        nextTimers.set(b.id, {
          groupId: g.id,
          blockId: b.id,
          interval,
          next: old && old.interval === interval ? old.next : now + interval,
        });
      } else if (b.kind === "threshold") {
        const old = thresholds.get(b.id);
        nextThresholds.set(b.id, {
          groupId: g.id,
          blockId: b.id,
          chId: b.chId,
          op: b.op,
          value: b.value,
          edge: b.edge,
          debounce: Math.max(0, Math.round(b.debounceMs)),
          // 同块保留确认状态（参数微调不重置边沿）；新块从「区间外」起算
          cur: old && old.chId === b.chId && old.op === b.op && old.value === b.value ? old.cur : false,
          pending: false,
          pendingTs: now,
        });
      } else if (b.kind === "chanChanged") {
        // 同块同通道保留基准值（改容差/节流不重置）；新块从「未武装」起算（首值只记录不报）
        const old = chanWatch.get(b.id);
        nextChanWatch.set(b.id, {
          groupId: g.id,
          blockId: b.id,
          chId: b.chId,
          tol: Math.max(0, b.tol),
          minIntervalMs: Math.max(50, Math.round(b.minIntervalMs)),
          lastEmit: old && old.chId === b.chId ? old.lastEmit : null,
          lastEmitTs: now,
        });
      } else if (b.kind === "newTpl") {
        needTplWatch = true;
      } else if (b.kind === "idle") {
        needIdleArm = true;
        nextIdle.set(b.id, {
          groupId: g.id,
          blockId: b.id,
          idleMs: Math.max(1000, Math.round(b.idleMs)),
          armed: true, // 新块/改参数后视为已武装（空闲从现在起算）
        });
      }
    }
  }
  timers.clear();
  for (const [k, v] of nextTimers) timers.set(k, v);
  thresholds.clear();
  for (const [k, v] of nextThresholds) thresholds.set(k, v);
  chanWatch.clear();
  for (const [k, v] of nextChanWatch) chanWatch.set(k, v);
  idleBlocks.clear();
  for (const [k, v] of nextIdle) idleBlocks.set(k, v);
}

function tick(): void {
  if (!panelActivity.isOpen(PANEL_ID) || !doc) return;
  const now = Date.now();
  for (const t of timers.values()) {
    if (now < t.next) continue;
    t.next = Math.max(t.next + t.interval, now); // 防休眠唤醒后补偿轰炸
    orchEngine.emit({ kind: "timer", groupId: t.groupId, blockId: t.blockId });
  }
  for (const d of thresholds.values()) {
    const d0 = plotStore.getChanData(d.chId);
    const n = d0.v.length;
    if (n === 0) continue;
    const v = d0.v[n - 1];
    if (!Number.isFinite(v)) continue;
    const beyond = d.op === "above" ? v > d.value : v < d.value;
    if (beyond !== d.pending) {
      d.pending = beyond;
      d.pendingTs = now;
    }
    if (beyond !== d.cur && now - d.pendingTs >= d.debounce) {
      d.cur = beyond;
      const phase = beyond ? "enter" : "exit";
      if (phase === d.edge) {
        orchEngine.emit({ kind: "threshold", groupId: d.groupId, blockId: d.blockId, chId: d.chId, value: v, phase });
      }
    }
  }
  /* ---------- B4d：通道变化差分 + 会话空闲 ---------- */
  for (const w of chanWatch.values()) {
    const d0 = plotStore.getChanData(w.chId);
    const n = d0.v.length;
    if (n === 0) continue;
    const v = d0.v[n - 1];
    if (!Number.isFinite(v)) continue;
    if (w.lastEmit === null) {
      // 首值：只武装不报（无从谈「变化」）
      w.lastEmit = v;
      w.lastEmitTs = now;
      continue;
    }
    if (Math.abs(v - w.lastEmit) > w.tol && now - w.lastEmitTs >= w.minIntervalMs) {
      const old = w.lastEmit;
      w.lastEmit = v;
      w.lastEmitTs = now;
      orchEngine.emit({ kind: "chanChanged", groupId: w.groupId, blockId: w.blockId, chId: w.chId, old, new: v });
    }
  }
  for (const s of idleBlocks.values()) {
    // lastFrameTs=0 = 会话还没收过帧，不谈空闲；armed 电平语义（报一次即解除，onFrames 重武装）
    if (!s.armed || lastFrameTs === 0) continue;
    if (now - lastFrameTs >= s.idleMs) {
      s.armed = false;
      orchEngine.emit({ kind: "idle", groupId: s.groupId, blockId: s.blockId, idleMs: s.idleMs, lastTs: lastFrameTs });
    }
  }
}

setInterval(tick, TICK_MS);

/* ================= 事件源：哨兵告警 ================= */

let lastSentinelHead: string | null = null;

sentinelStore.subscribe(() => {
  const head = sentinelStore.getSnapshot().alerts[0];
  const headId = head?.id ?? null;
  if (headId === lastSentinelHead) return;
  const prevId = lastSentinelHead;
  lastSentinelHead = headId;
  // 面板关闭静默消费（重开不补发旧告警）；首帧快照不触发
  if (!panelActivity.isOpen(PANEL_ID) || !doc || prevId === null || !head) return;
  if (head.kind === "recover") return; // 恢复类不是告警
  if (head.level !== "warn" && head.level !== "crit") return;
  orchEngine.emit({ kind: "sentinel", level: head.level });
});

/* ================= deps.runSuite：调用现有测试序列器 ================= */

function runSuiteById(suiteId: string, wait: boolean): boolean | Promise<boolean> {
  const suite = sequencerStore.getSuite(suiteId);
  if (!suite || suite.steps.length === 0) return false;
  const err = sequencerBind.startSuite(suite);
  if (err) return false; // 互斥/启动失败
  if (!wait) return true;
  // 认领「我这一次运行」的 runId（startSuite 同步推过一条 running 进度）
  const myRunId = sequencerBind.getRunProgress()?.runId;
  if (myRunId === undefined) return true; // 极端：无进度事件 → 按已启动处理，不空等
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const cur = sequencerBind.getRunProgress();
      if (cur && cur.runId === myRunId && cur.status === "finished") {
        resolve(cur.result?.status === "done");
        return;
      }
      if (cur === null) {
        // 进度被清空（异常路径）：没有可认领的结果，立即结束而不是空等 30 分钟
        resolve(false);
        return;
      }
      if (Date.now() - t0 > SUITE_WAIT_CAP_MS) {
        // 只停「仍属于我这一次」的运行，避免误杀后来启动的序列
        if (sequencerBind.getRunProgress()?.runId === myRunId) sequencerBind.stopSuite();
        toast(tx(`序列 ${suite.name || suiteId} 等待超过 ${SUITE_WAIT_CAP_MS / 60000} 分钟，已放弃等待`, `Suite ${suite.name || suiteId} exceeded the ${SUITE_WAIT_CAP_MS / 60000} min wait cap`));
        resolve(false);
        return;
      }
      setTimeout(poll, SUITE_POLL_MS);
    };
    setTimeout(poll, SUITE_POLL_MS);
  });
}

/* ================= 面板生命周期 ================= */

// 关闭面板 → 停止全部实例 + 清等待（红线：关掉的面板不允许后台跑自动化）
panelActivity.subscribe(() => {
  if (panelActivity.isOpen(PANEL_ID)) return;
  orchEngine.stopAll();
  clearWaiters();
});

/* ================= store → 引擎同步 ================= */

/**
 * 编辑文档会停止在跑实例（防编辑竞态，简单可靠；变量同型保值）。
 * 注意：必须放在模块末尾——syncFromStore 会执行 rebuildSources，
 * 而它引用的 timers/thresholds 是 const（模块求值期未提升，提前调用即 TDZ 崩溃白屏）。
 */
let seeded = false;
let lastStopNoticeTs = 0;

/** 编辑导致在跑实例被中止 → 明确告知（否则用户会以为自动化卡死）；5s 节流防刷屏 */
function noticeEditStopped(n: number): void {
  const now = Date.now();
  if (now - lastStopNoticeTs < 5000) return;
  lastStopNoticeTs = now;
  toast(tx(`编辑编排文档，已中止 ${n} 个运行中的实例`, `Editing the flow stopped ${n} running instance(s)`));
}

function syncFromStore(): void {
  doc = orchestratorStore.getSnapshot().doc;
  // 首次装载才回填落盘的持久变量值：后续编辑不得把运行值拉回磁盘旧值（P74c A1）
  const wasRunning = orchEngine.runningCount();
  const changed = orchEngine.setDoc(doc, seeded ? undefined : orchestratorStore.getPersistVars());
  seeded = true;
  // 视图差异（折叠等）不动引擎也不清等待——P77 的「折叠不杀实例」依赖这里同步克制
  if (changed) {
    if (wasRunning > 0) noticeEditStopped(wasRunning);
    rebuildSources();
    clearWaiters();
  }
}

orchestratorStore.subscribe(syncFromStore);
syncFromStore();
