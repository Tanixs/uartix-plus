import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { IconShield, IconBell, IconPulse, IconTrash, IconChevron, IconSparkle } from "../../shared/icons";
import * as store from "./sentinelStore";
import { playAlertTone } from "./sentinelSound";
import type { AlertKind, AlertLevel, SentinelAlert } from "./sentinelEngine";
import { requestOpenPanel } from "../ai/appBus";
import * as plotStore from "../plot/plotStore";
import { toast } from "../ai/extRuntime";

/**
 * 哨兵面板（P62）：静默异常监测的观测台。
 * 顶栏健康环 + 报警时间线（左）/ 通道·帧型（右）+ 底栏检测配置。
 * 「最小化」→ 面板从布局移除、右下角浮球驻留继续监测（引擎门控见 store）。
 */

const KIND_LABEL: Record<AlertKind, [string, string]> = {
  spike: ["通道突变", "Spike"],
  newframe: ["新帧型", "New frame type"],
  silence: ["通信静默", "Silence"],
  errrate: ["错误帧率", "Error rate"],
  recover: ["恢复", "Recovered"],
};

const LEVEL_LABEL: Record<AlertLevel, [string, string]> = {
  crit: ["严重", "critical"],
  warn: ["警告", "warning"],
  info: ["信息", "info"],
};

function fmtTs(ts: number): string {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtVal(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** 健康环：conic-gradient 36px，颜色随分数走 ok/warn/danger */
function HealthRing({ score, crit }: { score: number; crit: boolean }) {
  const color = score >= 80 ? "var(--ok, #3fb950)" : score >= 50 ? "var(--warn, #d29922)" : "var(--danger)";
  return (
    <div
      className={`snt-ring${crit ? " crit" : ""}`}
      style={{
        // 环底 8px：分数占比弧 + 底色弧
        background: `conic-gradient(${color} 0 ${score}%, var(--bg-inset) ${score}% 100%)`,
      }}
      role="img"
      aria-label={`${tx("健康度", "Health")} ${score}`}
    >
      <span className="snt-ring-num">{score}</span>
    </div>
  );
}

export function SentinelPanel() {
  useLocale();
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [q, setQ] = useState("");
  const [onlyAbn, setOnlyAbn] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(true);

  const chans = useMemo(() => {
    const k = q.trim().toLowerCase();
    return s.chans.filter(
      (c) => (!k || c.name.toLowerCase().includes(k)) && (!onlyAbn || c.level !== "ok"),
    );
  }, [s.chans, q, onlyAbn]);

  const addChanToPlot = (name: string, tplId: string, fieldId: string, color: string) => {
    const added = plotStore.addChannel({ tplId, fieldId, name, color });
    requestOpenPanel("plot2d");
    toast(added ? tx(`已把 ${name} 加入 2D 曲线`, `Added ${name} to 2D plot`) : tx("该通道已在 2D 曲线中", "Channel already on 2D plot"));
  };

  const locate = (a: SentinelAlert) => {
    if (!a.tplId || !a.fieldId || !a.channel) return;
    const ch = s.chans.find((c) => c.name === a.channel);
    addChanToPlot(a.channel, a.tplId, a.fieldId, ch?.color ?? "#4e9cef");
  };

  const alerting = s.activeCrit > 0 || s.activeWarn > 0;

  return (
    <div className={`snt${!s.cfg.enabled ? " off" : ""}`}>
      <div className="snt-head">
        <HealthRing score={s.health} crit={s.activeCrit > 0 && s.cfg.enabled} />
        <div className="snt-head-info">
          <div className="snt-head-title">
            {tx("系统健康", "System health")}
            {s.learning && <span className="snt-learn">{tx("学习中…", "learning…")}</span>}
            {!s.cfg.enabled && <span className="snt-paused">{tx("已停用", "paused")}</span>}
          </div>
          <div className="snt-head-sub">
            {s.activeCrit > 0 && <span className="snt-badge crit">{tx(`严重 ${s.activeCrit}`, `critical ${s.activeCrit}`)}</span>}
            {s.activeWarn > 0 && <span className="snt-badge warn">{tx(`警告 ${s.activeWarn}`, `warning ${s.activeWarn}`)}</span>}
            {s.activeCrit === 0 && s.activeWarn === 0 && (
              <span className="snt-badge ok">{tx("一切正常", "all clear")}</span>
            )}
            {s.unack > 0 && <span className="snt-badge unack">{tx(`${s.unack} 条未确认`, `${s.unack} unack`)}</span>}
          </div>
        </div>
        <div className="snt-head-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => store.diagnoseNow()}
            disabled={!s.running}
            title={tx("携带哨兵证据（健康度/报警/异常通道/统计）打开 AI 助手发起结构化诊断", "Open the AI assistant with sentinel evidence (health/alerts/channels/stats) for a structured diagnosis")}
          >
            <IconSparkle />
            {tx("AI 诊断", "AI Diagnose")}
          </button>
          <button type="button" className="btn sm" onClick={store.popWidget} title={tx("弹出桌面挂件（独立置顶小窗，跨应用驻留报警）", "Pop out a desktop widget (always-on-top mini window)")}>
            {tx("挂件", "Widget")}
          </button>
          {s.unack > 0 && (
            <button type="button" className="btn sm" onClick={store.ackAll} title={tx("全部确认", "Acknowledge all")}>
              {tx("全部确认", "Ack all")}
            </button>
          )}
          <button type="button" className="btn sm" onClick={store.minimizeToFloat} title={tx("缩成右下角浮球继续监测（关面板不关监测）", "Minimize to a floating ball; keeps monitoring after the panel closes")}>
            {tx("最小化", "Minimize")}
          </button>
          <button type="button" className="btn sm danger" onClick={store.clearAlerts} disabled={s.alerts.length === 0} title={tx("清空报警历史", "Clear alert history")}>
            <IconTrash />
          </button>
        </div>
      </div>

      <div className="snt-body">
        <div className="snt-feed" role="log" aria-label={tx("报警时间线", "Alert timeline")}>
          {s.alerts.length === 0 ? (
            <div className="snt-empty">
              <IconShield />
              <div className="snt-empty-title">
                {s.cfg.enabled ? tx("监测运行中，一切正常", "Monitoring — all clear") : tx("哨兵已停用", "Sentinel paused")}
              </div>
              <div className="snt-empty-hint">
                {s.cfg.enabled
                  ? tx("通道突变 / 新帧型 / 通信静默出现时，会在此列出并可在浮球上一眼看到", "Spikes, new frame types or link silence will appear here and on the floating ball")
                  : tx("在下方重新启用后开始监测", "Re-enable below to start monitoring")}
              </div>
            </div>
          ) : (
            s.alerts.map((a) => (
              <div key={a.id} className={`snt-card ${a.level}${a.acked ? " acked" : ""}${a.kind === "recover" ? " recover" : ""}`}>
                <div className="snt-card-top">
                  <span className="snt-card-kind">{tx(...KIND_LABEL[a.kind])}</span>
                  <span className={`snt-card-level ${a.level}`}>{tx(...LEVEL_LABEL[a.level])}</span>
                  {a.count > 1 && <span className="snt-card-x">×{a.count}</span>}
                  <span className="snt-card-ts">{fmtTs(a.ts)}</span>
                </div>
                <div className="snt-card-msg">{a.msg}</div>
                <div className="snt-card-acts">
                  {a.kind === "spike" && a.tplId && a.fieldId && (
                    <button type="button" className="btn xs" onClick={() => locate(a)} title={tx("在 2D 曲线中打开该通道", "Open this channel on the 2D plot")}>
                      {tx("定位", "Locate")}
                    </button>
                  )}
                  {a.kind !== "recover" && (
                    <button type="button" className="btn xs" onClick={() => store.mute(a.key)} title={tx("静音此类报警（本会话）", "Mute this alert kind")}>
                      {tx("静音", "Mute")}
                    </button>
                  )}
                  {!a.acked && (
                    <button type="button" className="btn xs" onClick={() => store.ack(a.id)} title={tx("确认（清除未读计数）", "Acknowledge (clear unread)")}>
                      ✓
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="snt-side">
          <div className="snt-side-head">
            <span className="snt-side-title">
              <IconPulse /> {tx("通道监测", "Channels")}
              <span className="snt-count">{s.chanTotal}</span>
            </span>
            <label className="snt-toggle" title={tx("只显示评级非正常的通道", "Show only flagged channels")}>
              <input type="checkbox" checked={onlyAbn} onChange={(e) => setOnlyAbn(e.target.checked)} />
              {tx("只看异常", "Issues only")}
            </label>
          </div>
          <input
            className="input snt-search"
            value={q}
            placeholder={tx("搜索通道…", "Search channels…")}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="snt-chans">
            {chans.length === 0 ? (
              <div className="snt-side-empty">
                {s.chanTotal === 0
                  ? tx("等待帧数据…（解码器出数后自动纳入监测）", "Waiting for frames… (channels join automatically)")
                  : tx("无匹配通道", "No matching channels")}
              </div>
            ) : (
              chans.map((c) => (
                <div
                  key={c.name}
                  className={`snt-chan ${c.level}`}
                  role="button"
                  tabIndex={0}
                  title={tx(`评分 ${c.score.toFixed(1)}σ · 点击加入 2D 曲线`, `score ${c.score.toFixed(1)}σ · click to add to 2D plot`)}
                  onClick={() => addChanToPlot(c.name, c.tplId, c.fieldId, c.color)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      addChanToPlot(c.name, c.tplId, c.fieldId, c.color);
                    }
                  }}
                >
                  <span className="snt-chan-dot" style={{ background: c.color }} />
                  <span className="snt-chan-name">{c.name}</span>
                  <span className="snt-chan-val">{fmtVal(c.last)}</span>
                  <span className="snt-chan-score">{c.score >= 10 ? c.score.toFixed(0) : c.score.toFixed(1)}</span>
                </div>
              ))
            )}
          </div>
          {s.frameTypes.length > 0 && (
            <>
              <div className="snt-side-title sub">
                {tx("帧型", "Frame types")}
                <span className="snt-count">{s.frameTypes.length}</span>
              </div>
              <div className="snt-types">
                {s.frameTypes.map((t) => (
                  <div key={t.id} className={`snt-type${t.isNew ? " new" : ""}`}>
                    <span className="snt-type-name" title={t.id}>{t.name}</span>
                    {t.isNew && <span className="snt-badge warn mini">{tx("新", "new")}</span>}
                    <span className="snt-type-count">{t.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="snt-foot">
        <button
          type="button"
          className={`btn sm${s.cfg.enabled ? " primary" : ""}`}
          onClick={() => store.setEnabled(!s.cfg.enabled)}
          aria-pressed={s.cfg.enabled}
          title={s.cfg.enabled ? tx("停用哨兵（停止全部检测）", "Pause the sentinel (all detection stops)") : tx("启用哨兵", "Enable the sentinel")}
        >
          <IconShield />
          {s.cfg.enabled ? tx("监测中", "Watching") : tx("已停用", "Paused")}
        </button>
        <button type="button" className="btn sm snt-fold" onClick={() => setCfgOpen((v) => !v)} title={tx("展开/收起检测参数", "Toggle detection settings")}>
          <IconChevron dir={cfgOpen ? "down" : "right"} size={12} />
          {tx("参数", "Settings")}
        </button>
        {cfgOpen && (
          <>
            <label className="snt-f">
              {tx("灵敏度", "Sensitivity")}
              <select className="input" value={s.cfg.sensitivity} onChange={(e) => store.setSensitivity(e.target.value as "low" | "mid" | "high")}>
                <option value="low">{tx("低（少误报）", "Low (fewer false alarms)")}</option>
                <option value="mid">{tx("中", "Medium")}</option>
                <option value="high">{tx("高（快检出）", "High (fast detection)")}</option>
              </select>
            </label>
            <label className="snt-f">
              {tx("静默阈值", "Silence")}
              <select className="input" value={s.cfg.silenceSec} onChange={(e) => store.setSilenceSec(Number(e.target.value))}>
                {[1, 2, 3, 5, 10, 15, 30].map((n) => (
                  <option key={n} value={n}>{n}s</option>
                ))}
              </select>
            </label>
            <label className="snt-f">
              {tx("错误帧率", "Error rate")}
              <select className="input" value={s.cfg.errRatePct} onChange={(e) => store.setErrRatePct(Number(e.target.value))}>
                {[5, 10, 20, 50].map((n) => (
                  <option key={n} value={n}>{n}%</option>
                ))}
              </select>
            </label>
            <label
              className="snt-f"
              title={tx("出现严重报警时自动携带哨兵证据发起 AI 诊断（受冷却限制）", "Auto-run an AI diagnosis with sentinel evidence when a critical alert appears (cooldown applies)")}
            >
              <input
                type="checkbox"
                checked={s.cfg.autoDiag}
                onChange={(e) => store.setAutoDiag(e.target.checked)}
              />
              {tx("自动 AI 诊断", "Auto AI diagnose")}
            </label>
            {s.cfg.autoDiag && (
              <label className="snt-f" title={tx("两次自动诊断的最小间隔", "Minimum interval between auto diagnoses")}>
                {tx("冷却", "Cooldown")}
                <select className="input" value={s.cfg.diagCooldownMin} onChange={(e) => store.setDiagCooldownMin(Number(e.target.value))}>
                  {[1, 2, 5, 10, 15, 30, 60].map((n) => (
                    <option key={n} value={n}>{n} min</option>
                  ))}
                </select>
              </label>
            )}
            {s.cfg.mutedKeys.length > 0 && (
              <div className="snt-muted">
                {tx("已静音", "Muted")}:
                {s.cfg.mutedKeys.map((k) => (
                  <button key={k} type="button" className="snt-mute-tag" onClick={() => store.unmute(k)} title={tx("点击取消静音", "Click to unmute")}>
                    {k} ×
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <button
          type="button"
          className={`btn sm snt-sound${s.cfg.sound ? " on" : ""}`}
          onClick={() => store.setSound(!s.cfg.sound)}
          aria-pressed={s.cfg.sound}
          title={s.cfg.sound ? tx("报警提示音：开（点击关闭）", "Alert sound: on (click to mute)") : tx("报警提示音：关（点击开启）", "Alert sound: off (click to enable)")}
        >
          <IconBell />
          {s.cfg.sound ? tx("提示音", "Sound") : tx("静音", "Muted")}
        </button>
        {s.cfg.sound && cfgOpen && (
          <label className="snt-f" title={tx("提示音音量", "Alert volume")}>
            {tx("音量", "Volume")}
            <input
              type="range"
              min={0}
              max={100}
              value={s.cfg.volume}
              onChange={(e) => store.setVolume(Number(e.target.value))}
              onMouseUp={() => playAlertTone("warn", false, s.cfg.volume)}
              style={{ width: 70, accentColor: "var(--accent)" }}
            />
          </label>
        )}
        <span className="snt-foot-info">
          {tx(`帧 ${s.totals.frames} · 错 ${s.totals.errors}`, `frames ${s.totals.frames} · errors ${s.totals.errors}`)}
          {s.conn && s.silenceMs >= 1000 && (
            <span className={alerting ? "" : "dim"}>
              {" · "}
              {tx(`上一帧 ${Math.max(1, Math.round(s.silenceMs / 1000))}s 前`, `last frame ${Math.max(1, Math.round(s.silenceMs / 1000))}s ago`)}
            </span>
          )}
          {!s.conn && <> · {tx("未连接", "disconnected")}</>}
        </span>
      </div>
    </div>
  );
}

/**
 * 最小化浮球（App 全局挂载）：右下角常驻（可拖拽，位置持久化），AI 浮球上方错位摆放。
 * 显示健康分与未确认徽章；crit 时呼吸描边。移动 <4px 视为点击（恢复面板）。
 */

const FLOAT_POS_KEY = "vs.sentinel.float.pos";
const BALL = 44;

function zoomFactor(): number {
  const z = parseFloat(document.documentElement.style.zoom || "100");
  return Number.isFinite(z) && z > 0 ? z / 100 : 1;
}

function loadFloatPos(): { right: number; bottom: number } {
  try {
    const raw = localStorage.getItem(FLOAT_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { right?: number; bottom?: number };
      if (typeof p.right === "number" && typeof p.bottom === "number") {
        return { right: Math.max(0, p.right), bottom: Math.max(0, p.bottom) };
      }
    }
  } catch {
    /* 默认位 */
  }
  return { right: 18, bottom: 96 };
}

export function SentinelFloat() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [pos, setPos] = useState(loadFloatPos);
  const posRef = useRef(pos);
  posRef.current = pos;
  const dragRef = useRef<{ sx: number; sy: number; or: number; ob: number; moved: boolean } | null>(null);
  /** 拖拽结束会先于 click 触发 pointerup：用它吞掉拖完误触的 click */
  const suppressClick = useRef(false);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const zf = zoomFactor();
      const dx = (e.clientX - d.sx) / zf;
      const dy = (e.clientY - d.sy) / zf;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      const vw = window.innerWidth / zf;
      const vh = window.innerHeight / zf;
      setPos({
        right: Math.min(Math.max(0, d.or - dx), Math.max(0, vw - BALL)),
        bottom: Math.min(Math.max(0, d.ob + dy), Math.max(0, vh - BALL)),
      });
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.moved) {
        try {
          localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(posRef.current));
        } catch {
          /* 仅内存 */
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  if (!s.floating) return null;
  const color = s.health >= 80 ? "var(--ok, #3fb950)" : s.health >= 50 ? "var(--warn, #d29922)" : "var(--danger)";
  return (
    <div className="snt-float-wrap" style={{ right: pos.right, bottom: pos.bottom }}>
      <button
        type="button"
        className={`snt-float${s.activeCrit > 0 && s.cfg.enabled ? " crit" : ""}`}
        style={{ background: s.cfg.enabled ? `conic-gradient(${color} 0 ${s.health}%, var(--bg-inset) ${s.health}% 100%)` : undefined }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragRef.current = { sx: e.clientX, sy: e.clientY, or: pos.right, ob: pos.bottom, moved: false };
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          store.restoreFromFloat();
        }}
        title={
          s.cfg.enabled
            ? tx(`哨兵监测中 · 健康 ${s.health}${s.unack ? ` · ${s.unack} 条未确认` : ""}（点击打开面板，拖动改位置）`, `Sentinel watching · health ${s.health}${s.unack ? ` · ${s.unack} unack` : ""} (click to open, drag to move)`)
            : tx("哨兵已停用（点击打开面板）", "Sentinel paused (click to open)")
        }
      >
        {s.cfg.enabled ? <IconBell /> : <IconShield />}
        {s.cfg.enabled && s.unack > 0 && <span className="snt-float-badge">{s.unack > 99 ? "99+" : s.unack}</span>}
        {!s.cfg.enabled && <span className="snt-float-off" />}
      </button>
      <button
        type="button"
        className="snt-float-x"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={store.dismissFloat}
        title={tx("收起浮球并停止监测", "Dismiss ball and stop monitoring")}
        aria-label={tx("停止监测", "Stop monitoring")}
      >
        ×
      </button>
    </div>
  );
}
