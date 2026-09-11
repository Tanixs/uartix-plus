/**
 * 哨兵检测引擎（P62）——纯逻辑，零 Tauri/React 依赖，时钟可注入。
 *
 * 三类检测：
 * - 通道突变：双 EMA z-score（fast/slow/sig 三个数，O(1)/字段/帧，无常驻原始数组）
 * - 新帧型：启动后 10s 学习期建立 tplId 基线，之后首见即报；另有错误帧率监测（1s 桶 ×60 环形）
 * - 通信静默：连接中且距上一帧超阈值 → crit，恢复收帧自动产生 recover
 *
 * 降噪：同 key 冷却期内合并为 ×N；报警环形缓冲 200 条（写指针覆盖，零 shift）。
 * 调用方（sentinelStore）负责：onFrames 轻量 handler → ingest()；1s interval → tick()。
 */

import type { FramesEventPayload } from "../../ipc/types";

// ---- 可调常量 ----
export const LEARN_MS = 10_000; // 新帧型学习期
export const COOLDOWN_MS = 10_000; // 同 key 报警冷却（合并为 ×N）
export const ALERT_CAP = 200; // 报警环形容量
export const MIN_SAMPLES = 10; // 通道突变判定最少样本数（帧）
export const TYPE_CAP = 32; // 快照帧型清单上限
export const CHAN_CAP = 100; // 快照通道清单上限（按 |score| 排序）
export const ERR_BUCKETS = 60; // 错误率环形桶（1s/桶）

export type Sensitivity = "low" | "mid" | "high";
/** 灵敏度 → z-score 阈值 K */
export const SENSITIVITY_K: Record<Sensitivity, number> = { low: 6, mid: 4, high: 2.5 };
/** 严重判定阈值（超过 K 的倍数） */
const CRIT_MULT = 1.6;

export interface SentinelConfig {
  enabled: boolean;
  sensitivity: Sensitivity;
  silenceSec: number;
  errRatePct: number;
  mutedKeys: string[];
  /** 报警提示音（Web Audio 合成，S2） */
  sound: boolean;
  /** 提示音音量 0-100 */
  volume: number;
  /** 报警历史容量（20~2000） */
  alertCap: number;
  /** 严重报警自动发起 AI 诊断（P68，冷却见 diagCooldownMin） */
  autoDiag: boolean;
  /** 自动诊断冷却（分钟，1~60） */
  diagCooldownMin: number;
}

export const DEFAULT_CONFIG: SentinelConfig = {
  enabled: true,
  sensitivity: "mid",
  silenceSec: 3,
  errRatePct: 10,
  mutedKeys: [],
  sound: true,
  volume: 70,
  alertCap: ALERT_CAP,
  autoDiag: false,
  diagCooldownMin: 5,
};

export type AlertKind = "spike" | "newframe" | "silence" | "errrate" | "recover";
export type AlertLevel = "warn" | "crit" | "info";

export interface SentinelAlert {
  id: string;
  ts: number;
  kind: AlertKind;
  level: AlertLevel;
  /** 聚合键：spike:<ch> / newframe:<tplId> / silence / errrate / recover:<key> */
  key: string;
  channel?: string;
  tplId?: string;
  msg: string;
  count: number;
  /** 用户已确认（不进未读徽章，仍显示在时间线） */
  acked: boolean;
  detail?: { from: number; to: number; score: number };
  /** spike：触发字段的 field id（与 tplId 一起定位到 2D 曲线） */
  fieldId?: string;
}

export type ChanLevel = "ok" | "warn" | "crit";
export interface ChanStat {
  name: string;
  score: number;
  level: ChanLevel;
  last: number;
  /** 最近一次出现的模板/字段 id（「定位到 2D 曲线」建通道用） */
  tplId: string;
  fieldId: string;
  /** 模板色（与帧画布/表格同色） */
  color: string;
}

export interface FrameTypeStat {
  id: string;
  name: string;
  count: number;
  firstTs: number;
  /** 学习期后新出现 */
  isNew: boolean;
}

export interface SentinelSnapshot {
  running: boolean;
  /** 本轮监测开始时刻（学习期基准） */
  startedAt: number;
  learning: boolean;
  /** 新 → 旧 */
  alerts: SentinelAlert[];
  unack: number;
  health: number;
  chans: ChanStat[];
  chanTotal: number;
  frameTypes: FrameTypeStat[];
  lastFrameTs: number;
  /** 连接中距上一帧的毫秒数；-1 = 无帧或未连接 */
  silenceMs: number;
  conn: boolean;
  totals: { frames: number; errors: number };
  /** 当前活跃异常计数（health 依据，头部徽章用） */
  activeCrit: number;
  activeWarn: number;
}

interface ChanState {
  fast: number;
  slow: number;
  sig: number;
  last: number;
  samples: number;
  hot: number; // 连续超阈的 tick 数
  level: ChanLevel;
  tplId: string;
  fieldId: string;
  color: string;
}

interface TypeState {
  name: string;
  count: number;
  firstTs: number;
  isNew: boolean;
}

interface ErrBucket {
  f: number;
  e: number;
}

const EPS = 1e-9;
const ema = (cur: number, v: number, a: number) => cur + a * (v - cur);
/** 突变评分：|fast-slow| / sig，分母带 |slow| 相对下限防常值信号 0/0 误报 */
function scoreOf(c: { fast: number; slow: number; sig: number }): number {
  return Math.abs(c.fast - c.slow) / (c.sig + Math.max(EPS, Math.abs(c.slow) * 1e-6));
}

// 双 EMA 系数：fast 紧跟当前值，slow 为近期基准，sig 为波动尺度（必须慢于 fast，
// 否则持续跳变时分母追平分子导致漏报）
const A_FAST = 0.3;
const A_SLOW = 0.02;
const A_SIG = 0.01;

export class SentinelEngine {
  private cfg: SentinelConfig = { ...DEFAULT_CONFIG };
  private running = false;
  private startedAt = 0;
  private now = 0;
  private conn = false;

  private chans = new Map<string, ChanState>();
  private types = new Map<string, TypeState>();
  private cap: number;
  private ring: (SentinelAlert | undefined)[];
  private ringHead = 0; // 下一写入位
  private ringLen = 0;
  private keyToId = new Map<string, string>(); // key → 最新报警 id（冷却合并用）
  private idToEntry = new Map<string, number>(); // id → 环位置（ack 用；覆盖写入时清除）

  private activeKeys = new Map<string, AlertLevel>(); // 未恢复异常（health 用）
  private armedSilence = true; // 静默报警武装位（报一次后卸膛，恢复后重装）
  private armedErr = true;

  private errBuckets: ErrBucket[] = Array.from({ length: ERR_BUCKETS }, () => ({ f: 0, e: 0 }));
  private errIdx = 0;
  private lastFrameTs = 0;
  private totals = { frames: 0, errors: 0 };
  private unack = 0;
  /** ingest 内产生的报警（newframe）在下一 tick 才反映给 UI：脏标记 */
  private dirty = false;

  constructor(alertCap = ALERT_CAP) {
    this.cap = Math.max(20, Math.min(2000, alertCap));
    this.ring = new Array(this.cap);
  }

  /** 调整报警容量（设置页可调）：保留最新 cap 条，多余旧条目丢弃 */
  setCap(n: number): void {
    const cap = Math.max(20, Math.min(2000, Math.round(n)));
    if (cap === this.cap) return;
    const keep = Array.from(this.iterRing()).slice(0, cap);
    this.cap = cap;
    this.ring = new Array(cap);
    this.ringHead = 0;
    this.ringLen = 0;
    this.keyToId.clear();
    this.idToEntry.clear();
    this.unack = 0;
    // 逆序写回（keep 是新→旧，逐个 pushAlert 会触发冷却合并——直接手工摆环）
    for (let i = keep.length - 1; i >= 0; i--) {
      const a = keep[i];
      this.ring[this.ringHead] = a;
      this.idToEntry.set(a.id, this.ringHead);
      this.keyToId.set(a.key, a.id);
      if (!a.acked) this.unack++;
      this.ringHead = (this.ringHead + 1) % cap;
    }
    this.ringLen = keep.length;
  }

  // ---- 生命周期 ----

  start(now: number): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = now;
    this.now = now;
    this.armedSilence = true;
    this.armedErr = true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.chans.clear();
    this.types.clear();
    this.ring.fill(undefined);
    this.ringHead = 0;
    this.ringLen = 0;
    this.keyToId.clear();
    this.idToEntry.clear();
    this.activeKeys.clear();
    this.errBuckets = Array.from({ length: ERR_BUCKETS }, () => ({ f: 0, e: 0 }));
    this.errIdx = 0;
    this.lastFrameTs = 0;
    this.totals = { frames: 0, errors: 0 };
    this.unack = 0;
  }

  configure(cfg: SentinelConfig): void {
    this.cfg = cfg;
  }

  setConn(conn: boolean, now: number): void {
    if (this.conn === conn) return;
    this.conn = conn;
    this.now = now;
    if (!conn) {
      // 断开不是异常：解除静默判定与未决报警状态
      this.armedSilence = true;
      if (this.activeKeys.delete("silence")) this.emitRecover("silence", "通信静默恢复（连接已断开）", now);
    }
  }

  // ---- 数据入口（framesBus handler 调用，必须轻量同步） ----

  ingest(p: FramesEventPayload): void {
    if (!this.running) return;
    const rows = p.rows;
    const n = rows.length;
    if (n === 0) return;
    this.lastFrameTs = rows[n - 1].tsMs || Date.now();
    this.totals.frames += n;
    const bk = this.errBuckets[this.errIdx];
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (!r.valid) {
        bk.e++;
        this.totals.errors++;
      }
      let t = this.types.get(r.tplId);
      if (!t) {
        t = { name: r.tplName || r.tplId, count: 0, firstTs: r.tsMs, isNew: !this.learning() };
        this.types.set(r.tplId, t);
        if (t.isNew && this.cfg.enabled) {
          this.pushAlert(
            {
              kind: "newframe",
              level: "warn",
              key: `newframe:${r.tplId}`,
              tplId: r.tplId,
              msg: `新帧型出现：${t.name}（${r.len} 字节）`,
            },
            r.tsMs,
          );
        }
      }
      t.count++;
      // 通道 EMA 更新（O(fields)）
      const fs = r.fields;
      for (let j = 0; j < fs.length; j++) {
        const f = fs[j];
        const v = f.value;
        if (!Number.isFinite(v)) continue;
        let c = this.chans.get(f.name);
        if (!c) {
          // 首见直接初始化在当前值上，避免预热误报
          c = { fast: v, slow: v, sig: Math.abs(v) * 0.1 + 1e-6, last: v, samples: 0, hot: 0, level: "ok", tplId: r.tplId, fieldId: f.id, color: r.color };
          this.chans.set(f.name, c);
        }
        c.fast = ema(c.fast, v, A_FAST);
        c.slow = ema(c.slow, v, A_SLOW);
        c.sig = ema(c.sig, Math.abs(v - c.slow), A_SIG);
        c.last = v;
        c.tplId = r.tplId;
        c.fieldId = f.id;
        c.color = r.color;
        if (c.samples < MIN_SAMPLES) c.samples++;
      }
    }
    bk.f += n;
  }

  private learning(): boolean {
    return this.now - this.startedAt < LEARN_MS;
  }

  // ---- 周期评估（store 1s interval 调用） ----

  /** @returns 快照是否有变化（决定是否 emit） */
  tick(now: number): boolean {
    if (!this.running) return false;
    const hadPending = this.dirty; // ingest 期报警（newframe）需随本 tick 一起发布
    this.dirty = false;
    this.now = now;
    // 错误率桶推进（1s/桶）
    this.errIdx = (this.errIdx + 1) % ERR_BUCKETS;
    this.errBuckets[this.errIdx] = { f: 0, e: 0 };

    if (!this.cfg.enabled) {
      // 总开关关闭：清空活跃异常但保留历史，通道评级复位
      if (this.activeKeys.size > 0) {
        this.activeKeys.clear();
        for (const c of this.chans.values()) c.level = "ok";
        return true;
      }
      return hadPending;
    }

    let changed = false;
    const k = SENSITIVITY_K[this.cfg.sensitivity];

    // 1) 通道突变（tick 时按 EMA 现值评分；需连续 2 个周期超阈）
    for (const [name, c] of this.chans) {
      const score = scoreOf(c);
      const key = `spike:${name}`;
      if (c.samples < MIN_SAMPLES) {
        if (c.level !== "ok") {
          c.level = "ok";
          changed = true;
        }
        continue;
      }
      if (score > k) {
        c.hot++;
        if (c.hot >= 2) {
          const crit = score > k * CRIT_MULT;
          const level: AlertLevel = crit ? "crit" : "warn";
          const nextLevel: ChanLevel = crit ? "crit" : "warn";
          if (c.level !== nextLevel) {
            c.level = nextLevel;
            changed = true;
          }
          if (c.hot === 2) {
            // 仅在进入超阈的第 2 个周期报一次（后续由冷却合并）
            this.pushAlert(
              {
                kind: "spike",
                level,
                key,
                channel: name,
                tplId: c.tplId,
                fieldId: c.fieldId,
                msg: `通道突变 ${name}：${fmtNum(c.slow)} → ${fmtNum(c.last)}（${score.toFixed(1)}σ）`,
                detail: { from: c.slow, to: c.last, score },
              },
              now,
            );
            changed = true;
          } else if (this.activeKeys.get(key) !== level && this.cfg.enabled) {
            // 持续异常但级别变化 → 升级条目
            this.activeKeys.set(key, level);
          }
        }
      } else {
        if (c.hot > 0) c.hot = 0;
        if (c.level !== "ok") {
          c.level = "ok";
          if (this.activeKeys.delete(key)) {
            this.emitRecover(key, `通道 ${name} 恢复正常（当前 ${fmtNum(c.last)}）`, now);
          }
          changed = true;
        }
      }
    }

    // 2) 通信静默
    const silenceMs = this.conn && this.lastFrameTs > 0 ? now - this.lastFrameTs : -1;
    if (silenceMs >= 0 && silenceMs > this.cfg.silenceSec * 1000) {
      if (this.armedSilence) {
        this.armedSilence = false;
        this.activeKeys.set("silence", "crit");
        this.pushAlert(
          {
            kind: "silence",
            level: "crit",
            key: "silence",
            msg: `通信静默 ${(silenceMs / 1000).toFixed(1)}s（阈值 ${this.cfg.silenceSec}s）`,
          },
          now,
        );
        changed = true;
      }
    } else if (this.activeKeys.has("silence") && this.armedSilence === false) {
      this.armedSilence = true;
      if (silenceMs >= 0) {
        this.activeKeys.delete("silence");
        this.emitRecover("silence", "通信恢复", now);
        changed = true;
      }
    }

    // 3) 错误帧率（近 3 桶滑窗）
    let f3 = 0;
    let e3 = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.errBuckets[(this.errIdx - i + ERR_BUCKETS) % ERR_BUCKETS];
      f3 += b.f;
      e3 += b.e;
    }
    const rate = f3 > 0 ? (e3 / f3) * 100 : 0;
    if (rate > this.cfg.errRatePct && f3 >= 10) {
      if (this.armedErr) {
        this.armedErr = false;
        this.activeKeys.set("errrate", "warn");
        this.pushAlert(
          {
            kind: "errrate",
            level: "warn",
            key: "errrate",
            msg: `错误帧率 ${rate.toFixed(0)}%（阈值 ${this.cfg.errRatePct}%，近 3s ${e3}/${f3}）`,
          },
          now,
        );
        changed = true;
      }
    } else if (!this.armedErr && rate <= this.cfg.errRatePct) {
      this.armedErr = true;
      if (this.activeKeys.delete("errrate")) {
        this.emitRecover("errrate", "错误帧率恢复正常", now);
        changed = true;
      }
    }

    return changed || hadPending;
  }

  // ---- 用户操作 ----

  ack(id: string): void {
    const idx = this.idToEntry.get(id);
    if (idx === undefined) return;
    const slot = this.ring[idx];
    if (!slot || slot.id !== id) return;
    if (!slot.acked) {
      slot.acked = true;
      this.unack = Math.max(0, this.unack - 1);
    }
  }

  ackAll(): void {
    for (const a of this.iterRing()) {
      if (!a.acked) {
        a.acked = true;
        this.unack = Math.max(0, this.unack - 1);
      }
    }
  }

  muteKey(key: string): void {
    if (!this.cfg.mutedKeys.includes(key)) this.cfg.mutedKeys.push(key);
  }

  unmuteKey(key: string): void {
    const i = this.cfg.mutedKeys.indexOf(key);
    if (i >= 0) this.cfg.mutedKeys.splice(i, 1);
  }

  clear(): void {
    this.ring.fill(undefined);
    this.ringHead = 0;
    this.ringLen = 0;
    this.keyToId.clear();
    this.idToEntry.clear();
    this.unack = 0;
  }

  // ---- 快照 ----

  snapshot(): SentinelSnapshot {
    const alerts = Array.from(this.iterRing());
    const chans: ChanStat[] = [];
    for (const [name, c] of this.chans) {
      chans.push({ name, score: scoreOf(c), level: c.level, last: c.last, tplId: c.tplId, fieldId: c.fieldId, color: c.color });
    }
    chans.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const types: FrameTypeStat[] = [];
    for (const [id, t] of this.types) {
      types.push({ id, name: t.name, count: t.count, firstTs: t.firstTs, isNew: t.isNew });
    }
    types.sort((a, b) => b.count - a.count);
    let health = 100;
    let activeCrit = 0;
    let activeWarn = 0;
    for (const lv of this.activeKeys.values()) {
      if (lv === "crit") activeCrit++;
      else if (lv === "warn") activeWarn++;
      health -= lv === "crit" ? 40 : 15;
    }
    const silenceMs = this.conn && this.lastFrameTs > 0 && this.running ? this.now - this.lastFrameTs : -1;
    return {
      running: this.running,
      startedAt: this.startedAt,
      learning: this.running && this.learning(),
      alerts,
      unack: this.unack,
      health: Math.max(0, health),
      chans: chans.slice(0, CHAN_CAP),
      chanTotal: chans.length,
      frameTypes: types.slice(0, TYPE_CAP),
      lastFrameTs: this.lastFrameTs,
      silenceMs,
      conn: this.conn,
      totals: { ...this.totals },
      activeCrit,
      activeWarn,
    };
  }

  // ---- 内部 ----

  private *iterRing(): IterableIterator<SentinelAlert> {
    for (let i = 0; i < this.ringLen; i++) {
      const idx = (this.ringHead - 1 - i + ALERT_CAP * 2) % ALERT_CAP;
      const a = this.ring[idx];
      if (a) yield a;
    }
  }

  private pushAlert(
    core: { kind: AlertKind; level: AlertLevel; key: string; channel?: string; tplId?: string; fieldId?: string; msg: string; detail?: { from: number; to: number; score: number } },
    ts: number,
  ): void {
    if (this.cfg.mutedKeys.includes(core.key)) return;
    // 冷却期内同 key：合并为 ×N 并刷新文案
    const existId = this.keyToId.get(core.key);
    if (existId) {
      const idx = this.idToEntry.get(existId);
      const slot = idx !== undefined ? this.ring[idx] : undefined;
      if (slot && slot.id === existId && ts - slot.ts < COOLDOWN_MS) {
        slot.count++;
        slot.ts = ts;
        slot.msg = core.msg;
        if (core.detail) slot.detail = core.detail;
        if (core.fieldId) slot.fieldId = core.fieldId;
        if (core.tplId) slot.tplId = core.tplId;
        this.dirty = true;
        return;
      }
    }
    const a: SentinelAlert = {
      id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ts,
      kind: core.kind,
      level: core.level,
      key: core.key,
      channel: core.channel,
      tplId: core.tplId,
      msg: core.msg,
      count: 1,
      acked: false,
      detail: core.detail,
      fieldId: core.fieldId,
    };
    const idx = this.ringHead;
    const old = this.ring[idx];
    if (old) {
      this.idToEntry.delete(old.id);
      if (!old.acked) this.unack = Math.max(0, this.unack - 1);
    }
    this.ring[idx] = a;
    this.ringHead = (idx + 1) % this.cap;
    if (this.ringLen < this.cap) this.ringLen++;
    this.idToEntry.set(a.id, idx);
    // 同 key 旧条目（冷却外）视为已恢复：activeKeys 由各检测器自行管理
    this.keyToId.set(core.key, a.id);
    if (core.level !== "info") this.unack++;
    if (core.kind !== "recover") this.activeKeys.set(core.key, core.level);
    this.dirty = true;
  }

  private emitRecover(key: string, msg: string, ts: number): void {
    this.pushAlert({ kind: "recover", level: "info", key: `recover:${key}`, msg }, ts);
  }
}

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
