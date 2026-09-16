import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { clampFlyoutMenu } from "../../shared/Flyout";
import { HelpHint } from "../../shared/HelpHint";
import { invoke } from "@tauri-apps/api/core";
import type { Endian, FieldDef, FieldRole, FieldType, FrameTemplate } from "../../ipc/types";
import { ENDIAN_LABEL } from "../../ipc/types";
import * as fcStore from "./frameStore";
import * as serialStore from "../serial/serialStore";
import * as sessionStore from "../session/sessionStore";
import { toast } from "../ai/extRuntime";
import * as templateStore from "../protocol/templateStore";
import * as telemetryStore from "../protocol/telemetryStore";
import { fieldSize, PALETTE, CHECKSUM_SIZES } from "../protocol/templateStore";
import { groupDisplayName, presetGroupKey } from "./presets";
import { parseHexBytes } from "../../shared/hexBytes";
import { labeledValue } from "../../shared/valueLabels";
import { getLocale, tx, useLocale } from "../../i18n/strings";
import {
  PAD_T,
  BLOK_PAD,
  footerTail,
  reservedTail,
  skeletonLen,
  buildBlocks,
  layoutBlocks,
  coverageRuns,
  effRange,
  type Blk,
  type Layout,
} from "./frameLayout";

const MONO = '"Cascadia Mono", Consolas, monospace';
const GAP = 2;
const ANIM_MS = 220;
const SCROLL_W = 14;

const fsvg = (children: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconSave = () => fsvg(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>);
const IconUndo = () => fsvg(<><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></>);
const IconRedo = () => fsvg(<><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></>);
const IconTrash = () => fsvg(<><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
const IconPrev = () => fsvg(<polyline points="15 18 9 12 15 6" />);
const IconNext = () => fsvg(<polyline points="9 18 15 12 9 6" />);
const IconFollow = ({ on }: { on: boolean }) =>
  fsvg(on ? <><circle cx="12" cy="12" r="3" fill="currentColor" /><circle cx="12" cy="12" r="8" /></> : <><polygon points="6 4 20 12 6 20" /></>);
const IconCheck = () => fsvg(<polyline points="20 6 9 17 4 12" />);
const IconAlert = () => fsvg(<><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>);
const IconFolder = () => fsvg(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />);
const IconPlay = () => fsvg(<polygon points="6 4 20 12 6 20" />);
const IconPause = () => fsvg(<><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></>);
const IconStop = () => fsvg(<rect x="6" y="6" width="12" height="12" rx="1" />);
const IconPlug = () => fsvg(<><path d="M9 7V2M15 7V2" /><path d="M6 7h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V7z" /><line x1="12" y1="17" x2="12" y2="22" /></>);
const IconFlag = () => fsvg(<><path d="M5 21V4" /><path d="M5 4h13l-3 4 3 4H5" /></>);
const IconDiff = () => fsvg(<><polyline points="8 7 3 12 8 17" /><polyline points="16 7 21 12 16 17" /><line x1="3" y1="12" x2="21" y2="12" /></>);
const IconX = () => fsvg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
const IconLock = () => fsvg(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>);
const IconUnlock = () => fsvg(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>);
const IconInsBefore = () => fsvg(<><rect x="3" y="4" width="4" height="16" rx="1" /><path d="M21 12H11" /><path d="m15 8-4 4 4 4" /></>);
const IconInsAfter = () => fsvg(<><rect x="17" y="4" width="4" height="16" rx="1" /><path d="M3 12h10" /><path d="m7 8 4 4-4 4" /></>);

/** 会话回放 transport（16.2 P2）：打开 / 播放-暂停 / 速度档 / 进度条 / 停止 / 时间。
 *  独立叶子订阅 sessionStore（10Hz 进度只重渲染本组，不惊动画布主组件）。
 *  进度条 v1 语义：点选比例 → 清空 hex 环与帧归档 → Rust 全速快进到目标点 → 恢复节奏。 */
function SessionTransport() {
  const s = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const anns = useSyncExternalStore(sessionStore.subscribe, sessionStore.getAnnotations);
  useLocale();
  const [spd, setSpd] = useState<number | "max">(1);
  const [annoOpen, setAnnoOpen] = useState(false);
  const annoRef = useRef<HTMLDivElement>(null);
  const loaded = s.state === "recorded" || s.state === "playing" || s.state === "paused";
  const busy = s.state === "playing" || s.state === "paused";
  const speedNum = () => (spd === "max" ? 0 : spd);
  const onPlay = async () => {
    const st = serialStore.getSnapshot();
    if (st.status !== "disconnected") {
      toast(tx("回放前请先断开连接（避免双源混淆）", "Disconnect before replay (avoid mixed sources)"));
      return;
    }
    try {
      if (await invoke<boolean>("demo_running")) {
        toast(tx("回放前请先停止演示数据源", "Stop the demo source before replay"));
        return;
      }
    } catch {
      /* 查询失败不阻塞，Rust 侧仍会把关 */
    }
    // 播放前清帧归档：避免回放数据叠在旧时间轴上
    fcStore.clearArchive();
    await sessionStore.play(speedNum());
  };
  const onSeek = (ratio: number) => {
    fcStore.clearArchive();
    void sessionStore.seek(ratio, speedNum());
  };
  const promptAnnotate = () => {
    const text = window.prompt(
      tx(
        "标注文本（记录此时刻的事件，如「按键」「数据跳变」）",
        "Annotation text (record the event at this moment, e.g. \"key press\")",
      ),
      "",
    );
    if (text === null) return;
    void sessionStore.annotate(text);
  };
  // 快捷键 M：录制/回放中打标注（输入框聚焦时不抢键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (s.state !== "recording" && s.state !== "playing" && s.state !== "paused") return;
      e.preventDefault();
      promptAnnotate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
     
  }, [s.state]);
  // 标注弹层外点关闭（项目红线：浮层必须可外点关闭）
  useEffect(() => {
    if (!annoOpen) return;
    const onDown = (e: PointerEvent) => {
      if (annoRef.current && !annoRef.current.contains(e.target as Node)) setAnnoOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnnoOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [annoOpen]);
  return (
    <div className="fc-transport">
      <button
        className="btn sm icon"
        disabled={busy}
        onClick={() => void sessionStore.openSession()}
        title={tx("打开会话录制文件（.usess）", "Open session recording (.usess)")}
      >
        <IconFolder />
      </button>
      {loaded ? (
        <>
          <button
            className="btn sm icon primary"
            onClick={() => {
              if (s.state === "playing") void sessionStore.pause();
              else if (s.state === "paused") void sessionStore.resume();
              else void onPlay();
            }}
            title={
              s.state === "playing"
                ? tx("暂停回放", "Pause replay")
                : s.state === "paused"
                  ? tx("继续回放", "Resume replay")
                  : tx("从头回放会话", "Replay session from the start")
            }
          >
            {s.state === "playing" ? <IconPause /> : <IconPlay />}
          </button>
          <select
            className="fc-spd"
            value={String(spd)}
            onChange={(e) => setSpd(e.target.value === "max" ? "max" : Number(e.target.value))}
            disabled={!loaded}
            title={tx("回放速度（MAX=去节奏全速）", "Replay speed (MAX = no pacing)")}
          >
            <option value="0.25">0.25×</option>
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="max">MAX</option>
          </select>
          <input
            type="range"
            className="fc-progress"
            min={0}
            max={1000}
            disabled={s.state !== "playing" && s.state !== "paused" && s.durationMs <= 0}
            value={s.durationMs > 0 ? Math.min(1000, Math.round((s.posMs / s.durationMs) * 1000)) : 0}
            onPointerUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              onSeek(v / 1000);
            }}
            onKeyDown={(e) => {
              if (e.key === "Home") onSeek(0);
              else if (e.key === "End") onSeek(1);
            }}
            title={tx(
              "点选跳转：全速快进到目标点后继续回放",
              "Click to seek: fast-forward to the target, then resume playback",
            )}
          />
          <button
            className="btn sm icon"
            onClick={() => void sessionStore.stopPlay()}
            title={tx("停止回放（可再次播放）", "Stop replay (can play again)")}
          >
            <IconStop />
          </button>
          <button
            className={`btn sm icon${s.bridgeListening ? " primary" : ""}`}
            disabled={!loaded}
            onClick={() => {
              if (s.bridgeListening) {
                void sessionStore.bridgeStop();
                return;
              }
              const raw = window.prompt(
                tx(
                  "桥接监听端口（外部工具连入此端口接收数据流）",
                  "Bridge listen port (external tools connect here to receive the stream)",
                ),
                "9001",
              );
              if (raw === null) return;
              const p = Number(raw);
              if (!Number.isInteger(p) || p < 1 || p > 65535) {
                toast(tx("端口需为 1~65535 的整数", "Port must be an integer in 1~65535"));
                return;
              }
              void sessionStore.bridgeStart(p);
            }}
            title={
              s.bridgeListening
                ? tx(
                    `桥接中 :${s.bridgePort}（${s.bridgeClients} 个客户端），点击关闭桥`,
                    `Bridging :${s.bridgePort} (${s.bridgeClients} clients), click to close`,
                  )
                : tx(
                    "开桥（虚拟设备）：外部工具经 TCP 连入即收到与真机同节奏的原始数据流；先开桥等客户端连入、再点播放",
                    "Open bridge (virtual device): external tools receive the raw stream over TCP at real-device pacing; open the bridge, wait for clients, then play",
                  )
            }
          >
            <IconPlug />
          </button>
          {s.bridgeListening && (
            <span
              className="fc-playtime"
              title={tx(
                "桥接监听端口 / 已连入客户端数",
                "Bridge listen port / connected clients",
              )}
            >
              {`:${s.bridgePort}·${s.bridgeClients}`}
            </span>
          )}
          <div className="fc-anno-wrap" ref={annoRef}>
            <button
              className={`btn sm icon${anns.length > 0 ? " primary" : ""}`}
              disabled={!loaded && s.state !== "recording"}
              onClick={() => setAnnoOpen((v) => !v)}
              title={tx(
                "时间轴标注列表（录制/回放中按 M 快捷打标）",
                "Annotation list (press M while recording/replaying to add)",
              )}
            >
              <IconFlag />
              {anns.length > 0 && <span className="fc-anno-badge">{anns.length > 99 ? "99+" : anns.length}</span>}
            </button>
            {annoOpen && (
              <div className="fc-anno-pop">
                <div className="fc-anno-head">
                  {tx("时间轴标注", "Timeline annotations")}
                  {(s.state === "recording" || s.state === "playing" || s.state === "paused") && (
                    <button className="fc-anno-add" onClick={promptAnnotate}>
                      {tx("在此刻添加", "Add at this moment")}
                    </button>
                  )}
                </div>
                {anns.length === 0 ? (
                  <div className="fc-anno-empty">
                    {tx("暂无标注；录制/回放中按 M 添加", "No annotations yet; press M while recording/replaying")}
                  </div>
                ) : (
                  <div className="fc-anno-list">
                    {anns.map((a, i) => (
                      <button
                        key={`${a.ts}-${i}`}
                        className="fc-anno-item"
                        onClick={() => {
                          onSeek(sessionStore.annotationRatio(a.ts));
                          setAnnoOpen(false);
                        }}
                        title={tx(
                          "跳转到此标注时刻",
                          "Seek to this annotation",
                        )}
                      >
                        <span className="fc-anno-ts">{sessionStore.fmtDur(a.ts - s.firstTs)}</span>
                        <span className="fc-anno-text">{a.text}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <span
            className="fc-playtime"
            title={tx("回放进度 / 会话总时长", "Replay position / session duration")}
          >
            {sessionStore.fmtDur(s.posMs)}/{sessionStore.fmtDur(s.durationMs)}
          </span>
        </>
      ) : null}
    </div>
  );
}

function ArchStat() {
  const meta = useSyncExternalStore(fcStore.subscribe, fcStore.getMeta);
  useLocale();
  return (
    <span className="fc-stat" title={tx("归档的有效帧数与字节数；已过滤为剔除的杂散/坏包字节", "Archived valid frames and bytes; flt = discarded stray/bad bytes")}>
      <b>{meta.frames}</b>{tx("帧", "fr")}<i>·</i>{fmtB(meta.bytes)}
      {meta.dropped > 0 ? <em className="fc-stat-warn">{tx("滤", "flt")}{fmtB(meta.dropped)}</em> : null}
    </span>
  );
}

function ArchEmptyGate({ children }: { children: React.ReactNode }) {
  const meta = useSyncExternalStore(fcStore.subscribe, fcStore.getMeta);
  return <>{meta.frames === 0 ? children : null}</>;
}

function CoverageStrip({
  tpl,
  frameLen,
  onPick,
}: {
  tpl: FrameTemplate | null;
  frameLen: number;
  onPick: (lo: number, size: number) => void;
}) {
  useLocale();
  if (!tpl || frameLen <= 0) return null;
  const runs = coverageRuns(tpl, frameLen);
  const gaps = runs.filter((r) => r.kind === "gap");
  const gapBytes = gaps.reduce((a, g) => a + g.len, 0);
  return (
    <div className="fc-covbar" title={tx("字段未覆盖的字节缺口 — 点击段直接定义字段", "Gaps not covered by fields — click a segment to define it")}>
      {runs.map((r, i) =>
        r.kind === "gap" ? (
          <button
            key={i}
            className="fc-cov-gap"
            style={{ width: `${(r.len / frameLen) * 100}%` }}
            title={tx(
              `缺口：字节 ${r.lo}~${r.lo + r.len - 1}（${r.len}B）· 点击定义字段`,
              `Gap ${r.lo}~${r.lo + r.len - 1} (${r.len}B) — click to define`,
            )}
            onClick={() => onPick(r.lo, r.len)}
          />
        ) : (
          <span key={i} className="fc-cov-seg" style={{ width: `${(r.len / frameLen) * 100}%` }} />
        ),
      )}
      <span className="fc-cov-info">
        {gapBytes > 0
          ? tx(`未覆盖 ${gapBytes}B`, `${gapBytes}B undefined`)
          : tx("结构完整", "fully covered")}
      </span>
    </div>
  );
}

const ROLE_META: Record<FieldRole, { zh: string; en: string; tag: string; chip: string }> = {
  header: { zh: "帧头", en: "Header", tag: "HDR", chip: "#e8a33d" },
  addr: { zh: "目标地址", en: "Address", tag: "ADR", chip: "#39c5cf" },
  id: { zh: "功能码", en: "Command ID", tag: "ID", chip: "#4e9cef" },
  seq: { zh: "序号", en: "Seq", tag: "SEQ", chip: "#f0883e" },
  length: { zh: "数据长度", en: "Length", tag: "LEN", chip: "#3fb950" },
  data: { zh: "数据内容", en: "Data", tag: "DATA", chip: "#bc8cff" },
  payload: { zh: "数据载荷", en: "Payload", tag: "PLD", chip: "#bc8cff" },
  checksum: { zh: "和校验", en: "Checksum", tag: "CK1", chip: "#d29922" },
  checksum2: { zh: "附加校验", en: "Checksum2", tag: "CK2", chip: "#e5534b" },
  footer: { zh: "帧尾", en: "Footer", tag: "FTR", chip: "#db61a2" },
};
const roleLabel = (r: FieldRole) => tx(ROLE_META[r].zh, ROLE_META[r].en);

const typeLabel = (t: FieldType) => (t === "csv" ? tx("csv·自适应", "csv·auto") : t);

const SIZE_TYPES: Record<number, FieldType[]> = {
  1: ["uint8", "int8"],
  2: ["uint16", "int16"],
  3: ["uint32", "int32"],
  4: ["float32", "uint32", "int32"],
  6: ["float64"],
  8: ["float64"],
};

const NAME_HINTS: Record<number, string[]> = {
  1: ["温度", "电压", "状态", "信号"],
  2: ["温度", "俯仰", "横滚", "偏航", "电流"],
  3: ["保留", "填充", "签名"],
  4: ["四元数W", "经度", "纬度", "速度"],
};
const NAME_HINTS_EN: Record<number, string[]> = {
  1: ["Temp", "Voltage", "Status", "Signal"],
  2: ["Temp", "Pitch", "Roll", "Yaw", "Current"],
  3: ["Reserved", "Padding", "Signature"],
  4: ["QuatW", "Longitude", "Latitude", "Speed"],
};
const nameHints = (size: number): string[] =>
  (getLocale() === "en" ? NAME_HINTS_EN[size] : NAME_HINTS[size]) ?? [];

const TYPE_ORDER: FieldType[] = [
  "uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "ascii", "bcd", "bits", "csv",
];

function hexA(hex: string, a: number): string {
  if (!hex.startsWith("#")) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bl = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${bl},${Math.max(0, Math.min(1, a))})`;
}

function mixC(a: string, b: string, t: number): string {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  return `rgb(${Math.round(parseInt(pa.slice(0, 2), 16) * t + parseInt(pb.slice(0, 2), 16) * (1 - t))},${Math.round(parseInt(pa.slice(2, 4), 16) * t + parseInt(pb.slice(2, 4), 16) * (1 - t))},${Math.round(parseInt(pa.slice(4, 6), 16) * t + parseInt(pb.slice(4, 6), 16) * (1 - t))})`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function rrLR(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rl: number,
  rv: number,
) {
  const m = Math.min(h / 2, w / 2);
  const l = Math.min(rl, m);
  const r = Math.min(rv, m);
  ctx.beginPath();
  ctx.moveTo(x + l, y);
  ctx.lineTo(x + w - r, y);
  if (r > 0) ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  if (r > 0) ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + l, y + h);
  if (l > 0) ctx.arcTo(x, y + h, x, y + h - l, l);
  ctx.lineTo(x, y + l);
  if (l > 0) ctx.arcTo(x, y, x + l, y, l);
  ctx.closePath();
}

function fmtB(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxW: number): string | null {
  if (maxW <= 0) return null;
  if (ctx.measureText(text).width <= maxW) return text;
  for (let n = text.length - 1; n > 0; n--) {
    const t = `${text.slice(0, n)}…`;
    if (ctx.measureText(t).width <= maxW) return t;
  }
  return ctx.measureText("…").width <= maxW ? "…" : null;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roleOf(f: FieldDef): FieldRole {
  return f.role;
}

function FrameCanvas() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const noframeRef = useRef<HTMLDivElement | null>(null);
  const menuElRef = useRef<HTMLDivElement | null>(null);
  // 本次会话内出现过实时帧的模板 id（徽标区分"从未匹配"与"回看历史"）
  const seenRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLSpanElement | null>(null);
  const sizeRef = useRef({ w: 600, h: 400, dpr: 1, zf: 1 });
  const cellRef = useRef(28);
  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef<{ live: boolean; fi: number }>({ live: true, fi: 0 });
  const tplSelRef = useRef<string | null>(null);
  const selRef = useRef<{ lo: number; hi: number } | null>(null);
  const selDragRef = useRef<{ anchor: number; downX: number; downY: number; moved: boolean } | null>(null);
  const hoverRef = useRef<{ off: number; x: number; y: number; blk?: Blk } | null>(null);
  const dragSbRef = useRef<{ grabY: number; grabScroll: number } | null>(null);
  const scrollRef = useRef(0);
  const dirtyRef = useRef(true);
  const protoRef = useRef(templateStore.getSnapshot());
  const teleRef = useRef(telemetryStore.getSnapshot());
  const animsRef = useRef<Map<string, number>>(new Map());
  const dlgRef = useRef<DlgInit | null>(null);
  const menuRef = useRef<
    | { kind: "sel"; tplId: string; lo: number; size: number }
    | { kind: "field"; tplId: string; fid: string; locked: boolean }
    | { kind: "hdr"; tplId: string; nbytes: number }
    | { kind: "ftr"; tplId: string; hasFB: boolean }
    | null
  >(null);
  const [cellSize, setCellSize] = useState(28);
  const diffBaseRef = useRef<{ seq: number; tplId: string; fi: number; bytes: Uint8Array } | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  const [dlg, setDlg] = useState<DlgInit | null>(null);
  const [menuState, setMenuState] = useState<{ x: number; y: number } | null>(null);
  const [tabRev, setTabRev] = useState(0);
  const [errOpen, setErrOpen] = useState(false);
  const [pending, setPending] = useState<{
    msg: string;
    apply?: () => void;
    applyLabel?: string;
    title?: string;
  } | null>(null);
  const [saveSt, setSaveSt] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const locale = useLocale();
  useEffect(() => {
    // 语言切换：画布文本在 paint 内即时取值，置 dirty 触发一次重绘
    dirtyRef.current = true;
  }, [locale]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSave = async () => {
    if (saveSt === "saving") return;
    setSaveSt("saving");
    const ok = await templateStore.saveNow();
    setSaveSt(ok ? "ok" : "err");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveSt("idle"), ok ? 1600 : 4000);
  };
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const serial = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  protoRef.current = proto;
  teleRef.current = telemetryStore.getSnapshot();
  cellRef.current = cellSize;

  const fcds = useMemo(
    () => proto.rules.templates,
    [proto.rules.templates],
  );
  const tabCounts = useMemo(
    () => fcStore.tplCounts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fcds],
  );
  const groups = useMemo(() => {
    const map = new Map<string, FrameTemplate[]>();
    for (const t of fcds) {
      const key = presetGroupKey(t) ?? t.id;
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()].map(([key, tpls]) => {
      return {
        key,
        label: groupDisplayName(key, tpls[0]),
        color: tpls[0].color,
        tpls,
        on: tpls.some((t) => t.enabled),
        cnt: tpls.reduce((a, t) => a + (tabCounts.get(t.id) ?? 0), 0),
      };
    });
  }, [fcds, tabCounts]);

  const curTpl = useMemo(() => {
    const id = tplSelRef.current;
    if (id) return proto.rules.templates.find((t) => t.id === id) ?? null;
    const g0 = groups[0]?.tpls ?? [];
    return g0.find((t) => t.enabled) ?? g0[0] ?? null;
  }, [proto.rules.templates, groups, tabRev]);
  tplSelRef.current = curTpl?.id ?? null;

  const resolved = useMemo(() => {
    const arch = fcStore.archiveRef();
    let fi = viewRef.current.fi;
    if (viewRef.current.live) {
      const tid = curTpl?.id;
      let found = -1;
      for (let i = arch.list.length - 1; i >= 0; i--) {
        if (!tid || arch.list[i].tplId === tid) {
          found = i;
          break;
        }
      }
      fi = found;
    }
    const fr = fi >= 0 && fi < arch.list.length ? arch.list[fi] : null;
    return { fi: Math.max(0, fi), fr };
  }, [tabRev, curTpl]);
  viewRef.current.fi = resolved.fi;
  const liveUI = viewRef.current.live;
  const resolvedRef = useRef(resolved);
  const curRef = useRef(curTpl);
  resolvedRef.current = resolved;
  curRef.current = curTpl;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const zf = r.width > 0 && el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      sizeRef.current = {
        w: r.width / zf,
        h: r.height / zf,
        dpr: (window.devicePixelRatio || 1) * zf,
        zf,
      };
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mo = new MutationObserver(() => {
      dirtyRef.current = true;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    dirtyRef.current = true;
  }, [proto, cellSize]);

  useEffect(() => {
    const unsub = fcStore.subscribe(() => {
      dirtyRef.current = true;
    });
    return () => {
      unsub();
    };
  }, []);

  const drawGapBg = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dark: boolean) => {
    ctx.fillStyle = dark ? "rgba(128,128,160,0.05)" : "rgba(120,124,148,0.06)";
    rr(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = dark ? "rgba(140,144,170,0.30)" : "rgba(104,110,132,0.32)";
    ctx.setLineDash([3, 3]);
    rr(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1), 4);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h, dpr } = sizeRef.current;
    if (w < 10 || h < 10) return;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const cs = getComputedStyle(document.documentElement);
    const dark = document.documentElement.dataset.theme !== "light";
    const cPanel = cs.getPropertyValue("--bg-panel").trim() || "#161a20";
    const cFg = cs.getPropertyValue("--text").trim() || "#d7dde7";
    const cAcc = cs.getPropertyValue("--accent").trim() || "#4e9cef";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cPanel;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${Math.max(8, Math.min(Math.round(cellRef.current * 0.36), 13))}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let real = resolvedRef.current.fr;
    if (viewRef.current.live) {
      const tid = curRef.current?.id;
      const lr = tid ? fcStore.lastOf(tid) : null;
      if (lr) {
        real = lr;
        viewRef.current.fi = fcStore.lastIndexOf(tid!);
      }
    }
    const tplD = curRef.current;
    const db = diffBaseRef.current;
    let diffBytes: Uint8Array | null = null;
    let diffCount = 0;
    if (db && real && tplD && db.tplId === tplD.id) {
      diffBytes = db.bytes;
      const cur = real.bytes;
      const L = Math.max(real.len, cur ? cur.length : 0, db.bytes.length);
      for (let i = 0; i < L; i++) {
        const a = cur && i < cur.length ? cur[i] : -1;
        const b = i < db.bytes.length ? db.bytes[i] : -1;
        if (a !== b) diffCount++;
      }
    }
    if (navRef.current) {
      navRef.current.textContent = real
        ? `#${viewRef.current.fi} · ${real.len}B · ${real.tplName}${
            diffBytes
              ? ` · ${tx(`对比基线 #${db!.fi}`, `base #${db!.fi}`)} Δ${diffCount}`
              : ""
          }`
        : tplD
          ? tx("骨架编辑 · 未收流", "Skeleton edit · no stream")
          : "";
    }
    const draftLen = !real && tplD ? skeletonLen(tplD) : 0;
    const fr =
      real ??
      (draftLen > 0
        ? {
            tplId: tplD!.id,
            tplName: tplD!.name,
            color: tplD!.color,
            tsMs: 0,
            seq: 0,
            len: draftLen,
            valid: true,
            error: null,
            fields: [],
            bytes: [] as number[],
          }
        : null);
    if (!fr) {
      const tpl = curRef.current;
      if (tpl) {
        const bx = "0x" + tpl.boundary.headerBytes.map((b) => b.toString(16).padStart(2, "0")).join(" ").toUpperCase();
        ctx.fillStyle = dark ? "#5b6371" : "#98a0ab";
        ctx.font = `12px system-ui,sans-serif`;
        ctx.fillText(
          tx(`暂无「${tpl.name}」的帧数据 — 连接设备或打开演示源`, `No frames of "${tpl.name}" yet — connect the device or open the demo source`),
          w / 2,
          h / 2 - 10,
        );
        ctx.fillText(
          tx(`帧头 ${bx} · 启用的模板正在过滤数据流`, `Header ${bx} · enabled templates are filtering the stream`),
          w / 2,
          h / 2 + 12,
        );
      }
      if (noframeRef.current) noframeRef.current.hidden = true;
      return;
    }
    const isDraft = !real;
    if (!isDraft && tplD) seenRef.current.add(tplD.id);
    // 骨架态徽标：模板已定义但一帧未匹配（DOM 直写，不进 React state）
    if (noframeRef.current) {
      noframeRef.current.hidden = !isDraft;
      noframeRef.current.classList.toggle("live", !!tplD && !seenRef.current.has(tplD.id));
    }
    const frLen = fr.len;

    const s = cellRef.current;
    const rowsTotal0 = 0;
    void rowsTotal0;
    const sbW = SCROLL_W;
    const fldMap = new Map((tplD?.fields ?? []).map((f) => [f.id, f]));
    const pieces = buildBlocks(curRef.current, frLen);
    const first0 = layoutBlocks(pieces, s, w);
    const sbReserve = first0.rows.length > Math.max(1, Math.floor((h - PAD_T - 6) / first0.rowH)) ? sbW : 0;
    const { rows, rowH } = layoutBlocks(pieces, s, w - sbReserve);
    layoutRef.current = { rows, rowH, s, frLen };

    const sel = selRef.current;
    const hv = hoverRef.current;
    // P85a：高亮环走渲染块本身——负偏移/锚定字段 findFieldAt 旧实现命不中环
    let hoverFldKey: string | null = null;
    if (hv && hv.blk?.kind === "fld") hoverFldKey = hv.blk.key;
    const now = Date.now();
    const rowsTotal = rows.length;
    const visRows = Math.max(1, Math.floor((h - PAD_T - 6) / rowH));
    scrollRef.current = Math.min(Math.max(0, scrollRef.current), Math.max(0, rowsTotal - visRows));
    const r0 = Math.floor(scrollRef.current);
    const r1 = Math.min(rowsTotal, r0 + visRows + 1);

    for (let r = r0; r < r1; r++) {
      const row = rows[r];
      if (row.y + rowH > h + 4) break;
      const yTop = row.y - r0 * rowH;
      for (const it of row.items) {
        const blk = it.blk;
        const x0 = it.x0;
        const x1 = it.x1;
        const wRun = x1 - x0;
        const rl = it.p0 ? 0 : 4;
        const rv = it.p1 ? 0 : 4;
        const itemSel = sel && sel.lo <= it.g1 && sel.hi >= it.g0;
        let hoverHit = false;
        if (hv && blk.kind === "fld" && hv.off >= blk.start && hv.off < blk.start + blk.len) {
          hoverHit = true;
        }
        if (blk.kind === "hdr") {
          ctx.fillStyle = hexA("#e8a33d", dark ? 0.96 : 0.92);
          rrLR(ctx, x0 - 1, yTop, wRun + 2, s, rl, rv);
          ctx.fill();
        } else if (blk.kind === "ftr") {
          ctx.fillStyle = hexA(blk.color, dark ? 0.45 : 0.38);
          rrLR(ctx, x0, yTop, wRun, s, rl, rv);
          ctx.fill();
          ctx.strokeStyle = hexA(blk.color, 0.8);
          rrLR(ctx, x0 + 0.5, yTop + 0.5, wRun - 1, s - 1, rl, rv);
          ctx.stroke();
        } else if (blk.kind === "fld") {
          const animKey = `${curRef.current?.id}:${blk.fid}`;
          const until = animsRef.current.get(animKey);
          let pulse = 0;
          if (until && now < until) {
            const p = 1 - (until - now) / ANIM_MS;
            pulse = (1 - p) * 0.7;
          }
          ctx.fillStyle = hexA(blk.color, (dark ? 0.46 : 0.38) + pulse);
          rrLR(ctx, x0, yTop, wRun, s, rl, rv);
          ctx.fill();
          ctx.strokeStyle = hexA(blk.color, (dark ? 0.9 : 0.82) + pulse);
          rrLR(ctx, x0 + 0.5, yTop + 0.5, wRun - 1, s - 1, rl, rv);
          ctx.stroke();
          if (blk.locked) {
            ctx.fillStyle = hexA(blk.color, 0.95);
            ctx.fillRect(x0 + 2, yTop + s - 3, 4, 3);
            ctx.beginPath();
            ctx.arc(x0 + 4, yTop + s - 5.5, 2.2, Math.PI, 0);
            ctx.fill();
          }
        } else {
          drawGapBg(ctx, x0, yTop, wRun, s, dark);
        }

        if (blk.kind !== "gap") {
          const tplBT = curRef.current;
          for (let g = it.g0; g <= it.g1 && g < frLen; g++) {
            let bb: number | undefined;
            if (!isDraft) {
              bb = fr.bytes![g];
            } else if (tplBT) {
              if (blk.kind === "hdr" && g < tplBT.boundary.headerBytes.length) {
                bb = tplBT.boundary.headerBytes[g];
              } else if (blk.kind === "ftr" && tplBT.boundary.mode === "footer" && tplBT.boundary.footerBytes?.length) {
                const fb = tplBT.boundary.footerBytes;
                const fStart = frLen - fb.length;
                if (g >= fStart) bb = fb[g - fStart];
              }
            }
            if (bb === undefined && blk.kind === "fld" && blk.fid) {
              const fd = fldMap.get(blk.fid);
              const di = fd ? g - fd.offset : -1;
              if (fd?.disc?.length && di >= 0 && di < fd.disc.length) {
                bb = fd.disc[di];
              }
            }
            const cx = x0 + (g - it.g0) * s + s / 2;
            const txtC =
              blk.kind === "hdr"
                ? "#ffffff"
                : blk.kind === "fld"
                  ? (dark ? mixC(cFg, blk.color, 0.68) : mixC("#000000", blk.color, 0.6))
                  : dark ? mixC(cFg, blk.color, 0.78) : mixC("#000000", blk.color, 0.6);
            if (
              diffBytes &&
              bb !== undefined &&
              bb !== (g < diffBytes.length ? diffBytes[g] : -1)
            ) {
              ctx.fillStyle = "#e5534b";
              ctx.beginPath();
              ctx.moveTo(x0 + (g - it.g0) * s + 1, yTop + 1);
              ctx.lineTo(x0 + (g - it.g0) * s + 6, yTop + 1);
              ctx.lineTo(x0 + (g - it.g0) * s + 1, yTop + 6);
              ctx.closePath();
              ctx.fill();
            }
            ctx.fillStyle = txtC;
            ctx.fillText(bb === undefined ? "--" : bb.toString(16).toUpperCase().padStart(2, "0"), cx, yTop + s / 2 + 1);
          }
        } else {
          for (let g = it.g0; g <= it.g1 && g < frLen; g++) {
            const bb = isDraft ? undefined : fr.bytes![g];
            const cx = x0 + (g - it.g0) * s + s / 2;
            ctx.fillStyle = dark ? "#5b6371" : "#9aa2ad";
            ctx.fillText(bb === undefined ? "··" : bb.toString(16).toUpperCase().padStart(2, "0"), cx, yTop + s / 2 + 1);
            if (
              diffBytes &&
              bb !== undefined &&
              bb !== (g < diffBytes.length ? diffBytes[g] : -1)
            ) {
              ctx.fillStyle = "#e5534b";
              ctx.beginPath();
              ctx.moveTo(x0 + (g - it.g0) * s + 1, yTop + 1);
              ctx.lineTo(x0 + (g - it.g0) * s + 6, yTop + 1);
              ctx.lineTo(x0 + (g - it.g0) * s + 1, yTop + 6);
              ctx.closePath();
              ctx.fill();
              ctx.fillStyle = dark ? "#5b6371" : "#9aa2ad";
              ctx.fillText(bb.toString(16).toUpperCase().padStart(2, "0"), cx, yTop + s / 2 + 1);
            }
          }
        }
        if (it.ax && blk.kind === "fld" && blk.label) {
          const fd = curRef.current?.fields.find((f) => f.id === blk.fid);
          const lv = fd ? teleRef.current.latest[fd.id] : null;
          ctx.font = `9.5px system-ui,sans-serif`;
          ctx.textAlign = "right";
          if (wRun >= 100) {
            const valTxt =
              lv && lv.valid
                ? lv.text ?? (fd ? labeledValue(fd.labels, lv.value, (n) => String(round4(n))) : String(round4(lv.value)))
                : null;
            if (valTxt && ctx.measureText(valTxt).width <= wRun - 10) {
              ctx.fillStyle = hexA(blk.color, dark ? 0.95 : 0.88);
              ctx.fillText(valTxt, x1 - 5, yTop + 9);
            }
          }
          if (wRun >= 34) {
            const shown = fitLabel(ctx, blk.label, wRun - 10);
            if (shown) {
              ctx.fillStyle = dark ? mixC(cFg, blk.color, 0.66) : mixC("#000000", blk.color, 0.55);
              ctx.fillText(shown, x1 - 5, yTop + s - 4);
            }
          }
          ctx.textAlign = "center";
          ctx.font = `${Math.max(8, Math.min(Math.round(s * 0.36), 13))}px ${MONO}`;
        }
        if (it.p1 && blk.kind !== "gap") {
          ctx.strokeStyle = hoverHit ? cAcc : hexA(blk.kind === "hdr" ? "#e8a33d" : blk.color, 0.32);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0 + 2, yTop + s + GAP + 0.8);
          ctx.lineTo(x1 - 2, yTop + s + GAP + 0.8);
          ctx.stroke();
        }
        if (itemSel) {
          const a = Math.max(sel.lo, it.g0);
          const b = Math.min(sel.hi, it.g1);
          const sx = x0 + (a - it.g0) * s;
          const sw = x0 + (b - it.g0) * s + s - sx;
          ctx.fillStyle = hexA(cAcc, 0.18);
          rr(ctx, sx, yTop, sw, s, 3);
          ctx.fill();
          if (!hoverHit) {
            ctx.strokeStyle = cAcc;
            ctx.lineWidth = 1.4;
            rr(ctx, sx + 0.6, yTop + 0.6, sw - 1.2, s - 1.2, 3);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
          if (selDragRef.current) {
            ctx.font = `9px ${MONO}`;
            ctx.fillStyle = dark ? "#5b6371" : "#9aa2ad";
            ctx.textAlign = "left";
            ctx.fillText(`${b - a + 1}B`, sx + sw + 6, yTop + s - 3);
            ctx.font = `${Math.max(8, Math.min(Math.round(s * 0.36), 13))}px ${MONO}`;
            ctx.textAlign = "center";
          }
        }
      }
      if (hoverFldKey) {
        const segs: { x: number; y: number; w: number; first: boolean; last: boolean }[] = [];
        for (let r = r0; r < r1; r++) {
          for (const it of rows[r].items) {
            if (it.blk.key !== hoverFldKey) continue;
            segs.push({
              x: it.x0,
              y: rows[r].y - r0 * rowH,
              w: it.x1 - it.x0,
              first: !it.p0,
              last: !it.p1,
            });
          }
        }
        ctx.fillStyle = hexA(cAcc, 0.06);
        for (const sg of segs) {
          rr(ctx, sg.x - 2, sg.y - 2, sg.w + 4, s + 4, 6);
          ctx.fill();
        }
        ctx.strokeStyle = cAcc;
        ctx.lineWidth = 2;
        for (const sg of segs) {
          ctx.beginPath();
          rrLR(
            ctx,
            sg.x - 2,
            sg.y - 2,
            sg.w + 4,
            s + 4,
            sg.first ? 6 : 0,
            sg.last ? 6 : 0,
          );
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }
      if (rowsTotal > visRows) {
        ctx.strokeStyle = dark ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.06)";
        ctx.strokeRect(0, yTop + rowH + 0.5, w, 1);
      }
    }
    if (rowsTotal > visRows) {
      const trackX = w - SCROLL_W - 2;
      const trackH = h - 10;
      ctx.fillStyle = dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)";
      rr(ctx, trackX, 5, SCROLL_W, trackH, 5);
      ctx.fill();
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      const frac = rowsTotal > visRows ? scrollRef.current / (rowsTotal - visRows) : 0;
      ctx.fillStyle = dragSbRef.current
        ? dark ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.42)"
        : dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.26)";
      rr(ctx, trackX + 2, 5 + frac * (trackH - th), SCROLL_W - 4, th, 4);
      ctx.fill();
    }
    ctx.restore();
    updateTooltip();
  }, []);

  function updateTooltip() {
    const tip = tipRef.current;
    const hv = hoverRef.current;
    if (!tip || !hv || dragSbRef.current || selDragRef.current) {
      if (tip) tip.style.display = "none";
      return;
    }
    const tpl = curRef.current;
    const { fr } = resolvedRef.current;
    const frBytes = fr?.bytes;
    const live = !!(frBytes && hv.off < frBytes.length);
    const b = live ? frBytes[hv.off] : null;
    const blkKind = hv.blk?.kind ?? "gap";
    const blkFid = hv.blk?.kind === "fld" ? hv.blk.fid : null;
    let field: FieldDef | null = null;
    if (tpl && blkFid) {
      field = tpl.fields.find((f) => f.id === blkFid) ?? null;
    }
    if (tpl && !field) {
      const fl0 = fr?.len ?? 0;
      for (const f of tpl.fields) {
        const er = effRange(tpl, f, fl0);
        if (er && er.len > 0 && hv.off >= er.start && hv.off < er.start + er.len) {
          field = f;
          break;
        }
      }
    }
    let cat: string;
    const isFtrTail = tpl ? footerTail(tpl) > 0 : false;
    if (blkKind === "hdr") cat = tx("帧头（保留区）", "Header (reserved)");
    else if (blkKind === "ftr") {
      cat = isFtrTail
        ? tx("帧尾（保留区）", "Footer (reserved)")
        : `${tx("校验域", "Checksum area")}${tpl?.checksum ? ` · ${tpl.checksum.algo}` : ""}`;
    } else if (field) {
      const rm = roleOf(field);
      cat = `${roleLabel(rm)}${field.locked ? ` ${tx("（已锁定）", "(locked)")}` : ""}`;
    } else cat = tx("未定义字节（帧长未被子字段覆盖）", "Undefined bytes (not covered by sub-fields)");
    const roleChip = field ? ROLE_META[roleOf(field)].tag : "";
    const fieldLine = field
      ? `<div class="fc-tip-row"><span>${tx("字段", "Field")}</span><b>${field.name}${roleChip ? ` [${roleChip}]` : ""}</b></div>`
      : "";
    const endianTxt =
      field && ["uint16", "int16", "uint32", "int32", "float32", "float64"].includes(field.type)
        ? ` · ${ENDIAN_LABEL[field.endian] ?? "LE"}`
        : "";
    const scaleTxt = field?.scale != null ? ` × ${field.scale}` : "";
    const unitTxt = field?.unit ? ` ${field.unit}` : "";
    const typeLine = field
      ? `<div class="fc-tip-row"><span>${tx("类型", "Type")}</span><b>${typeLabel(field.type)}${endianTxt}${scaleTxt}${unitTxt}</b></div>`
      : "";
    const discLine =
      field && field.disc?.length && hv.off === field.offset
        ? `<div class="fc-tip-row"><span>${tx("识别", "Disc")}</span><b>${field.disc.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ")}</b></div>`
        : "";
    const spanLine =
      field && field.spanTail && (field.role === "data" || field.role === "payload")
        ? `<div class="fc-tip-row"><span>${tx("说明", "Note")}</span><b>${
            field.spanElem
              ? `${tx("自适应变长", "Adaptive span")} · ${field.spanElem.toUpperCase()}${
                  field.spanElem === "bit"
                    ? ` ${tx("低位在前", "LSB first")}`
                    : ` ${ENDIAN_LABEL[field.endian] ?? "LE"}`
                }`
              : tx("自适应变长 · 文本", "Adaptive span · text")
          }</b></div>`
        : "";
    let valLine = "";
    if (field && live && hv.off === field.offset) {
      const lv = teleRef.current.latest[field.id];
      if (lv && lv.valid) {
        valLine = `<div class="fc-tip-row"><span>${tx("数值", "Value")}</span><b>${
          lv.text ??
          labeledValue(field.labels, lv.value, (n) => String(round4(n)))
        }${field.unit ? ` ${field.unit}` : ""}</b></div>`;
      }
    }
    const ckLine =
      blkKind === "ftr" && !isFtrTail
        ? `<div class="fc-tip-row"><span>${tx("说明", "Note")}</span><b>${
            tpl?.checksum && tpl.checksum.algo !== "none"
              ? `${tx("校验", "Verify")} ${tpl.checksum.algo} · ${tx("覆盖", "coverage")} ${tpl.checksum.coverageStart}~${tpl.checksum.coverageEnd} · ${tx("点击修改", "click to change")}`
              : tx("未启用校验 · 点击配置算法", "Checksum not enabled · click to configure")
          }</b></div>`
        : "";
    const ck2Line =
      field?.role === "checksum2"
        ? `<div class="fc-tip-row"><span>${tx("说明", "Note")}</span><b>${tx("视觉标注位 · 与 CK1 一起由算法验证", "Visual marker · verified with CK1 by the algorithm")}</b></div>`
        : "";
    const ckVarLine =
      field?.role === "checksum" && tpl && tpl.boundary.mode !== "fixedLength"
        ? `<div class="fc-tip-row"><span>${tx("说明", "Note")}</span><b>${tx("变长帧 · 锚定帧尾（帧长−宽度−帧尾字）", "Variable frames · anchored to the tail")}</b></div>`
        : "";
    let head = "";
    if (live && b !== null) {
      const ascii = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "—";
      head =
        `<div class="fc-tip-hex">${b.toString(16).toUpperCase().padStart(2, "0")}h</div>` +
        `<div class="fc-tip-row"><span>${tx("十进制", "Decimal")}</span><b>${b}</b></div>` +
        `<div class="fc-tip-row"><span>ASCII</span><b>${ascii}</b></div>`;
    } else if (tpl && blkKind === "hdr" && hv.off < tpl.boundary.headerBytes.length) {
      const hb = tpl.boundary.headerBytes[hv.off];
      head =
        `<div class="fc-tip-hex">${hb.toString(16).toUpperCase().padStart(2, "0")}h</div>` +
        `<div class="fc-tip-row"><span>${tx("十进制", "Decimal")}</span><b>${hb}</b></div>`;
    } else if (blkKind !== "gap") {
      head = `<div class="fc-tip-hex">--</div>`;
    }
    tip.innerHTML =
      head +
      `<div class="fc-tip-row"><span>${tx("类别", "Category")}</span><b>${cat}</b></div>` +
      fieldLine +
      typeLine +
      discLine +
      spanLine +
      ck2Line +
      ckVarLine +
      valLine +
      ckLine +
      `<div class="fc-tip-row"><span>${tx("位置", "Position")}</span><b>${tx(`帧内 ${hv.off} B`, `frame +${hv.off} B`)}</b></div>`;
    tip.style.display = "block";
    tip.style.left = `${Math.min(hv.x + 14, sizeRef.current.w - tip.offsetWidth - 10)}px`;
    tip.style.top = `${Math.min(hv.y + 16, sizeRef.current.h - tip.offsetHeight - 10)}px`;
  }

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (animsRef.current.size > 0) dirtyRef.current = true;
      for (const [k, u] of animsRef.current) if (u < Date.now()) animsRef.current.delete(k);
      // 面板不在前台（堆叠后台页签的 DOM 被 dockview 摘除，clientWidth=0）
      // → 跳过重绘，dirty 保留到切回前台
      const canvas = canvasRef.current;
      if (dirtyRef.current && canvas && canvas.clientWidth > 0) {
        dirtyRef.current = false;
        paint();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paint]);

  const localXY = (ev: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const zf = sizeRef.current.zf || 1;
    return { lx: (ev.clientX - rect.left) / zf, ly: (ev.clientY - rect.top) / zf };
  };

  const hitOffset = (lx: number, ly: number): { off: number; blk: Blk } | null => {
    const lay = layoutRef.current;
    if (!lay) return null;
    const { rows, rowH, s } = lay;
    const r0 = Math.floor(scrollRef.current);
    const relRow = Math.floor((ly - PAD_T + r0 * rowH) / rowH);
    if (relRow < 0 || relRow >= rows.length) return null;
    const row = rows[relRow];
    for (const it of row.items) {
      const right = it.x0 + s * (it.g1 - it.g0 + 1) - BLOK_PAD;
      if (lx >= it.x0 && lx < right) {
        const ci = Math.min(Math.max(0, Math.floor((lx - it.x0) / s)), it.g1 - it.g0);
        return { off: it.g0 + ci, blk: it.blk };
      }
    }
    return null;
  };

  const onDown = (ev: React.MouseEvent) => {
    closeMenu();
    const { lx, ly } = localXY(ev);
    if (ev.button !== 0) return;
    if (lx >= sizeRef.current.w - SCROLL_W - 2) {
      const lay = layoutRef.current;
      if (!lay) return;
      const rowsTotal = lay.rows.length;
      const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
      if (rowsTotal <= visRows) return;
      const trackH = sizeRef.current.h - 10;
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      resizeSB(trackH, th, rowsTotal, visRows, ly);
      return;
    }
    const hit = hitOffset(lx, ly);
    selRef.current = null;
    if (!hit) return;
    selRef.current = { lo: hit.off, hi: hit.off };
    selDragRef.current = { anchor: hit.off, downX: lx, downY: ly, moved: false };
    dirtyRef.current = true;
  };

  function resizeSB(trackH: number, th: number, rowsTotal: number, visRows: number, ly: number) {
    const frac = rowsTotal > visRows ? scrollRef.current / (rowsTotal - visRows) : 0;
    const thumbY = 5 + frac * (trackH - th);
    if (ly >= thumbY && ly <= thumbY + th) {
      dragSbRef.current = { grabY: ly - thumbY, grabScroll: scrollRef.current };
    } else {
      dragSbRef.current = { grabY: th / 2, grabScroll: scrollRef.current };
      scrollRef.current = Math.min(
        Math.max(0, ((ly - PAD_T - th / 2) / Math.max(1, trackH - th)) * Math.max(0, rowsTotal - visRows)),
        Math.max(0, rowsTotal - visRows),
      );
      dirtyRef.current = true;
    }
  }

  const onMove = (ev: React.MouseEvent) => {
    if (dragSbRef.current) {
      const ly = localXY(ev).ly;
      const lay = layoutRef.current;
      if (!lay) return;
      const rowsTotal = lay.rows.length;
      const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
      const trackH = sizeRef.current.h - 10;
      const th = Math.max(26, Math.min(trackH, (visRows / rowsTotal) * trackH));
      const frac = (ly - PAD_T - dragSbRef.current.grabY) / Math.max(1, trackH - th);
      scrollRef.current = Math.min(
        Math.max(0, dragSbRef.current.grabScroll + frac * Math.max(0, rowsTotal - visRows)),
        Math.max(0, rowsTotal - visRows),
      );
      dirtyRef.current = true;
      return;
    }
    if (selDragRef.current) {
      const { lx, ly } = localXY(ev);
      const dx = lx - selDragRef.current.downX;
      const dy = ly - selDragRef.current.downY;
      if (Math.abs(dx) + Math.abs(dy) > 4) selDragRef.current.moved = true;
      const p = hitOffset(lx, ly);
      if (!p) {
        dirtyRef.current = true;
        return;
      }
      const lo = Math.min(selDragRef.current.anchor, p.off);
      const hi = Math.max(selDragRef.current.anchor, p.off);
      if (hi >= lo) selRef.current = { lo, hi };
      dirtyRef.current = true;
      return;
    }
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) {
      if (hoverRef.current) {
        hoverRef.current = null;
        if (tipRef.current) tipRef.current.style.display = "none";
        dirtyRef.current = true;
      }
      canvasRef.current!.style.cursor = "default";
      return;
    }
    const prev = hoverRef.current;
    hoverRef.current = { off: p.off, x: lx, y: ly, blk: p.blk };
    if (!prev || prev.off !== p.off) {
      dirtyRef.current = true;
      updateTooltip();
    }
    const bk = p.blk.kind;
    canvasRef.current!.style.cursor = bk === "fld" || bk === "hdr" || bk === "ftr"
      ? "pointer"
      : "crosshair";
  };

  const onUp = (ev: React.MouseEvent) => {
    dragSbRef.current = null;
    if (selDragRef.current) {
      const wasSel = selDragRef.current;
      selDragRef.current = null;
      dirtyRef.current = true;
      if (ev.button !== 2 && !wasSel.moved && selRef.current && selRef.current.hi >= selRef.current.lo) {
        const tpl = curRef.current;
        const { lx, ly } = localXY(ev);
        const hit = hitOffset(lx, ly);
        const blk = hit?.blk ?? null;
        if (tpl && blk?.kind === "fld" && blk.fid) {
          templateStore.setSelection({ kind: "field", templateId: tpl.id, fieldId: blk.fid });
        } else if (tpl && (blk?.kind === "hdr" || blk?.kind === "ftr")) {
          templateStore.setSelection({ kind: "template", templateId: tpl.id });
        } else {
          templateStore.setSelection(null);
        }
        selRef.current = null;
      }
    }
  };

  const findFieldAt = (tpl: FrameTemplate, off: number): FieldDef | null => {
    // P85a：按有效区间命中——负偏移/变长锚定校验字段同样可右键/可选中
    const fl = resolvedRef.current.fr?.len ?? 0;
    for (const f of tpl.fields) {
      const er = effRange(tpl, f, fl);
      if (er && er.len > 0 && off >= er.start && off < er.start + er.len) return f;
    }
    return null;
  };

  const onCtx = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) {
      closeMenu();
      return;
    }
    const tpl = curRef.current;
    if (!tpl) return;
    const sel = selRef.current;
    if (sel && sel.lo <= sel.hi && sel.hi > sel.lo && p.off >= sel.lo && p.off <= sel.hi) {
      menuRef.current = {
        kind: "sel",
        tplId: tpl.id,
        lo: sel.lo,
        size: sel.hi - sel.lo + 1,
      };
      openMenuAt(ev.clientX, ev.clientY);
      return;
    }
    selRef.current = { lo: p.off, hi: p.off };
    dirtyRef.current = true;
    const blk = p.blk;
    if (blk.kind === "fld" && blk.fid) {
      const fld = tpl.fields.find((f) => f.id === blk.fid) ?? null;
      if (fld) {
        menuRef.current = {
          kind: "field",
          tplId: tpl.id,
          fid: fld.id,
          locked: !!fld.locked,
        };
        openMenuAt(ev.clientX, ev.clientY);
        return;
      }
    }
    if (blk.kind === "hdr") {
      menuRef.current = { kind: "hdr", tplId: tpl.id, nbytes: tpl.boundary.headerBytes.length };
      openMenuAt(ev.clientX, ev.clientY);
      return;
    }
    if (blk.kind === "ftr") {
      const hasFB = tpl.boundary.mode === "footer";
      menuRef.current = { kind: "ftr", tplId: tpl.id, hasFB };
      openMenuAt(ev.clientX, ev.clientY);
      return;
    }
    menuRef.current = { kind: "sel", tplId: tpl.id, lo: p.off, size: 1 };
    openMenuAt(ev.clientX, ev.clientY);
  };

  const openMenuAt = (cx: number, cy: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    setMenuState({ x: cx - rect.left, y: cy - rect.top });
    dirtyRef.current = true;
  };
  useLayoutEffect(() => {
    if (!menuState) return;
    const el = menuElRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    clampFlyoutMenu(el, wrap, menuState.x, menuState.y);
  }, [menuState]);

  const rulesSigRef = useRef("");
  useEffect(() => {
    const check = () => {
      const sig = JSON.stringify(
        templateStore.getSnapshot().rules.templates.map((t) => [
          t.id,
          t.enabled,
          t.boundary,
          t.checksum,
          t.fields.map((f) => [
            f.id,
            f.offset,
            f.role,
            f.type,
            f.endian,
            f.size ?? null,
            f.bits ?? null,
            f.disc ?? null,
            f.spanTail ?? null,
            f.spanElem ?? null,
            f.csvDelim ?? null,
            f.csvType ?? null,
          ]),
        ]),
      );
      if (rulesSigRef.current && rulesSigRef.current !== sig) {
        fcStore.clearArchive();
        viewRef.current = { live: true, fi: 0 };
        dirtyRef.current = true;
      }
      rulesSigRef.current = sig;
    };
    check();
    return templateStore.subscribe(check);
  }, []);
  const closeMenu = () => {
    setMenuState(null);
    menuRef.current = null;
  };

  useEffect(() => {
    const up = () => {
      dragSbRef.current = null;
      if (selDragRef.current) {
        const a = selDragRef.current.anchor;
        selDragRef.current = null;
        selRef.current = { lo: a, hi: a };
        dirtyRef.current = true;
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onWheel = (ev: React.WheelEvent) => {
    const lay = layoutRef.current;
    if (!lay) return;
    const rowsTotal = lay.rows.length;
    const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
    const delta = Math.sign(ev.deltaY) * Math.max(1, Math.round(Math.abs(ev.deltaY) / 40)) * 2;
    scrollRef.current = Math.min(Math.max(0, scrollRef.current + delta), Math.max(0, rowsTotal - visRows));
    dirtyRef.current = true;
  };

  const doUndo = () => {
    templateStore.undo();
  };

  const doRedo = () => {
    templateStore.redo();
  };

  const toggleDiff = () => {
    if (diffBaseRef.current) {
      diffBaseRef.current = null;
      setDiffOn(false);
    } else {
      const fr = resolvedRef.current.fr;
      if (!fr || !fr.bytes || fr.bytes.length === 0) {
        toast(tx("当前视图没有实际帧可作基线（骨架态无字节）", "No real frame in view to use as baseline (skeleton has no bytes)"));
        return;
      }
      diffBaseRef.current = { seq: fr.seq, tplId: fr.tplId, fi: viewRef.current.fi, bytes: fr.bytes };
      setDiffOn(true);
      toast(
        tx(
          `基线 = #${viewRef.current.fi}，←/→ 翻帧看差异角标`,
          `Baseline = #${viewRef.current.fi}; step frames with ←/→ to see diff corners`,
        ),
      );
    }
    dirtyRef.current = true;
  };

  const defineGap = (lo: number, size: number) => {
    const tplD = curRef.current;
    if (!tplD) return;
    selRef.current = { lo, hi: lo + size - 1 };
    const t = protoRef.current.rules.templates.find((x) => x.id === tplD.id);
    dlgRef.current = {
      kind: "field",
      tplId: tplD.id,
      tplName: t?.name ?? "",
      mode: t?.boundary.mode ?? "fixedLength",
      ckAlgo: t?.checksum?.algo ?? null,
      frLen: resolvedRef.current.fr?.len ?? skeletonLen(tplD),
      lo,
      size,
      isAscii: false,
    };
    setDlg(dlgRef.current);
    dirtyRef.current = true;
  };

  const fireAnim = (key: string) => {
    animsRef.current.set(key, Date.now() + ANIM_MS);
    setTimeout(() => (dirtyRef.current = true), ANIM_MS + 20);
    dirtyRef.current = true;
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const tgt = ev.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) doRedo(); else doUndo();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      doRedo();
    } else if (ev.key === "Escape") {
      selRef.current = null;
      closeMenu();
      const sc = protoRef.current.selection;
      if (sc?.kind === "field") {
        templateStore.setSelection({ kind: "template", templateId: sc.templateId });
      }
      dirtyRef.current = true;
    } else if (ev.key === "ArrowLeft") {
      setViewF((f) => Math.max(0, f - 1));
    } else if (ev.key === "ArrowRight") {
      setViewF((f) => f + 1);
    }
  };

  const setViewF = (fn: (fi: number) => number) => {
    const arch = fcStore.archiveRef();
    if (arch.list.length === 0) return;
    const ni = Math.min(arch.list.length - 1, Math.max(0, fn(viewRef.current.fi)));
    viewRef.current = { live: false, fi: ni };
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
  };

  const setViewLive = () => {
    viewRef.current = { live: true, fi: 0 };
    dirtyRef.current = true;
  };

  const defineFromMenu = () => {
    const m = menuRef.current;
    closeMenu();
    if (!m || m.kind !== "sel") return;
    const tplDef = protoRef.current.rules.templates.find((t) => t.id === m.tplId);
    dlgRef.current = {
      kind: "field",
      tplId: m.tplId,
      tplName: tplDef?.name ?? "",
      mode: tplDef?.boundary.mode ?? "fixedLength",
      ckAlgo: tplDef?.checksum?.algo ?? null,
      frLen: resolvedRef.current.fr?.len ?? (tplDef ? skeletonLen(tplDef) : 0),
      lo: m.lo,
      size: m.size,
      isAscii: false,
    };
    setDlg(dlgRef.current);
  };

  const undefine = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!tpl || !fd) return;
    if (fd.locked) return;
    if (fd.role === "checksum" && tpl.checksum && tpl.checksum.algo !== "none") {
      setPending({
        title: tx("取消校验字段", "Remove checksum field"),
        msg: tx(
          `「${fd.name}」是校验字段：取消定义将同时停用校验（${tpl.checksum.algo}），此后该帧型的所有帧不再验证、直接放行。`,
          `"${fd.name}" is the checksum field: undefining it also disables the ${tpl.checksum.algo} check — frames will pass unverified.`,
        ),
        applyLabel: tx("取消定义并停用校验", "Remove & disable check"),
        apply: () => {
          templateStore.removeChecksumField(tplId, fid);
          fireAnim(`un:${fid}`);
          dirtyRef.current = true;
        },
      });
      return;
    }
    templateStore.removeField(tplId, fid);
    fireAnim(`un:${fid}`);
    dirtyRef.current = true;
  };

  const toggleLock = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!fd) return;
    templateStore.patchField(tplId, fid, { locked: !fd.locked });
    dirtyRef.current = true;
  };

  const editField = (tplId: string, fid: string) => {
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    const fd = tpl?.fields.find((f) => f.id === fid);
    if (!tpl || !fd) return;
    closeMenu();
    dlgRef.current = {
      kind: "field",
      tplId,
      tplName: tpl.name,
      mode: tpl.boundary.mode,
      ckAlgo: tpl.checksum?.algo ?? null,
      frLen: resolvedRef.current.fr?.len ?? skeletonLen(tpl),
      lo: fd.offset,
      size: fieldSize(fd),
      edit: true,
      field: fd,
      isAscii: fd.type === "ascii",
    };
    setDlg(dlgRef.current);
  };

  const openHdrDlg = (tplId: string) => {
    closeMenu();
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    if (!tpl) return;
    dlgRef.current = {
      kind: "hdr",
      tplId,
      tplName: tpl.name,
      bytes: [...tpl.boundary.headerBytes],
    };
    setDlg(dlgRef.current);
  };

  const openFtrDlg = (tplId: string) => {
    closeMenu();
    const tpl = protoRef.current.rules.templates.find((t) => t.id === tplId);
    if (!tpl) return;
    dlgRef.current = {
      kind: "ftr",
      tplId,
      tplName: tpl.name,
      bytes: [...(tpl.boundary.footerBytes ?? [])],
    };
    setDlg(dlgRef.current);
  };

  const onDblClick = (ev: React.MouseEvent) => {
    const { lx, ly } = localXY(ev);
    const p = hitOffset(lx, ly);
    if (!p) return;
    const tpl = curRef.current;
    const fr = resolvedRef.current.fr;
    if (!tpl || !fr || fr.len <= 0) return;
    if (p.off < tpl.boundary.headerBytes.length) {
      openHdrDlg(tpl.id);
      return;
    }
    const rt = reservedTail(tpl);
    if (rt > 0 && p.off >= fr.len - rt && !findFieldAt(tpl, p.off) && tpl.boundary.mode === "footer") {
      openFtrDlg(tpl.id);
    }
  };


  const enableGroup = (g: { key: string; label: string; tpls: FrameTemplate[] }) => {
    templateStore.setGroupEnabled(g.key, true, (t) => presetGroupKey(t) ?? t.id);
    toast(
      tx(
        `已启用「${g.label}」（${g.tpls.length} 帧型），开始按该协议筛选数据流`,
        `Enabled "${g.label}" (${g.tpls.length} frame type(s)) — filtering the stream now`,
      ),
    );
  };

  const renderTabs = () => (
    <div className="fc-tabs">
      <div className="fc-tabs-label">{tx("协议", "Protocol")}</div>
      {groups.map((g) => {
        const on = !!curTpl && g.tpls.some((t) => t.id === curTpl!.id);
        return (
          <div className={`fc-tabgrp${on ? " on" : ""}${g.on ? "" : " off"}`} key={g.key}>
            <button
              className="fc-tab"
              onClick={() => {
                if (!g.on) enableGroup(g);
                selectTab(g.tpls.some((t) => t.id === curTpl?.id) ? curTpl!.id : g.tpls[0].id);
              }}
              title={
                g.on
                  ? tx("点击切换到该协议", "Click to switch to this protocol")
                  : tx("未启用 · 点击启用并开始筛选数据流", "Disabled — click to enable and start filtering")
              }
            >
              <i style={{ background: g.color }} />
              {g.label}
              {!g.on && <em className="fc-tab-off">{tx("未启用", "off")}</em>}
              {g.on && <span className="fc-tab-cnt">{g.cnt}</span>}
            </button>
            {g.tpls.length > 1 && (
              <select
                className="fc-tabsub"
                value={curTpl && g.tpls.some((t) => t.id === curTpl!.id) ? curTpl.id : g.tpls[0].id}
                title={tx("选择帧型", "Select frame type")}
                onChange={(e) => selectTab(e.target.value)}
              >
                {g.tpls.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.enabled ? "" : ` ${tx("(停用)", "(off)")}`}
                    （{tabCounts.get(t.id) ?? 0}）
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );

  const selectTab = (tid: string) => {
    tplSelRef.current = tid;
    viewRef.current = { live: true, fi: 0 };
    selRef.current = null;
    scrollRef.current = 0;
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
    const cur = templateStore.getSnapshot().selection;
    if (!cur || cur.templateId !== tid) {
      templateStore.setSelection({ kind: "template", templateId: tid });
    }
  };
  void tabRev;

  useEffect(() => {
    const sel = proto.selection;
    if (!sel) return;
    if (tplSelRef.current === sel.templateId) return;
    tplSelRef.current = sel.templateId;
    viewRef.current = { live: true, fi: 0 };
    selRef.current = null;
    scrollRef.current = 0;
    dirtyRef.current = true;
    setTabRev((v) => v + 1);
  }, [proto.selection]);

  // P85b：属性面板/表 → 画布反向定位（滚动到字段所在行 + 选区 + 脉冲）
  useEffect(() => {
    const req = proto.revealReq;
    if (!req) return;
    if (tplSelRef.current !== req.tplId) selectTab(req.tplId);
    const t0 = setTimeout(() => {
      const lay = layoutRef.current;
      const tpl0 = curRef.current;
      if (!lay || !tpl0 || tpl0.id !== req.tplId) return;
      const fl = resolvedRef.current.fr?.len ?? 0;
      const f = tpl0.fields.find((x) => x.id === req.fieldId);
      if (!f) return;
      const er = effRange(tpl0, f, fl);
      if (!er || er.len <= 0) return;
      let rowIdx = -1;
      for (let r = 0; r < lay.rows.length && rowIdx < 0; r++) {
        for (const it of lay.rows[r].items) {
          if (it.blk.kind === "fld" && it.blk.fid === f.id) {
            rowIdx = r;
            break;
          }
        }
      }
      if (rowIdx < 0) return;
      const visRows = Math.max(1, Math.floor((sizeRef.current.h - PAD_T - 6) / lay.rowH));
      scrollRef.current = Math.max(0, Math.min(rowIdx - 1, lay.rows.length - visRows));
      selRef.current = { lo: er.start, hi: er.start + er.len - 1 };
      fireAnim(`${tpl0.id}:${f.id}`);
      dirtyRef.current = true;
      setTimeout(() => {
        selRef.current = null;
        dirtyRef.current = true;
      }, 900);
    }, 80);
    return () => clearTimeout(t0);
  }, [proto.revealReq]);

  return (
    <div className="fc-root" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="fc-toolbar">
        <button
          className={`btn sm icon${saveSt === "ok" ? " saved-ok" : ""}${saveSt === "err" ? " saved-err" : ""}${saveSt === "saving" ? " saving" : ""}`}
          onClick={doSave}
          title={
            saveSt === "err"
              ? tx("保存失败：模板格式未通过解析内核校验", "Save failed: template rejected by parser core")
              : saveSt === "ok"
                ? tx("已保存并同步到解析内核", "Saved & synced to parser core")
                : tx("保存协议模板（立即同步到本地与解析内核）", "Save template (syncs to local & parser core)")
          }
        >
          {saveSt === "ok" ? <IconCheck /> : saveSt === "err" ? <IconAlert /> : <IconSave />}
        </button>
        {proto.syncError ? (
          <span
            className={`fc-sync-warn${errOpen ? " open" : ""}`}
            title={proto.syncError}
            onClick={() => setErrOpen((v) => !v)}
          >
            {errOpen ? `${tx("校验未通过", "Validation failed")}: ${proto.syncError}` : tx("校验未通过（点击查看原因）", "Validation failed (click for reason)")}
          </span>
        ) : null}
        <ArchStat />
        <span className="fc-navinfo" ref={navRef} />
        {(() => {
          const sc = proto.selection;
          if (sc?.kind !== "field") return null;
          const t0 = proto.rules.templates.find((x) => x.id === sc.templateId);
          const f0 = t0?.fields.find((x) => x.id === sc.fieldId);
          if (!t0 || !f0) return null;
          return (
            <span className="fc-crumb" title={tx("Esc 返回模板属性", "Esc to go back to template properties")}>
              {t0.name} <i>›</i> {f0.name} <em>Esc</em>
            </span>
          );
        })()}
        <label className="fc-cellsz" title={tx("单元格尺寸", "Cell size")}>
          <input
            type="range"
            min={18}
            max={48}
            value={cellSize}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => setCellSize(Number(e.target.value))}
          />
          <b>{cellSize}</b>
        </label>
        <button className="btn sm icon" onClick={doUndo} title={tx("撤销 (Ctrl+Z)", "Undo (Ctrl+Z)")}>
          <IconUndo />
        </button>
        <button className="btn sm icon" onClick={doRedo} title={tx("重做 (Ctrl+Y)", "Redo (Ctrl+Y)")}>
          <IconRedo />
        </button>
        <SessionTransport />
        <div className="fc-toolbar-spacer" />
        <button className="btn sm icon nav" onClick={() => setViewF((f) => f - 1)} title={tx("上一帧 (←)", "Previous frame (←)")}>
          <IconPrev />
        </button>
        <button className={`btn sm icon${liveUI ? " primary" : ""}`} onClick={setViewLive} title={tx("跟随最新有效帧（页签切换即跟随该类型）", "Follow latest valid frame (tab switch follows that type)")}>
          <IconFollow on={liveUI} />
        </button>
        <button className="btn sm icon nav" onClick={() => setViewF((f) => f + 1)} title={tx("下一帧 (→)", "Next frame (→)")}>
          <IconNext />
        </button>
        <button className="btn sm icon" onClick={() => { fcStore.clearArchive(); diffBaseRef.current = null; setDiffOn(false); viewRef.current = { live: true, fi: 0 }; dirtyRef.current = true; }} title={tx("清空帧归档字节池", "Clear frame archive")}>
          <IconTrash />
        </button>
        <button className={`btn sm icon${diffOn ? " primary" : ""}`} onClick={toggleDiff} title={diffOn ? tx("退出帧对比（清除基线）", "Exit frame diff (clear baseline)") : tx("帧对比：把当前帧设为基线，翻帧看逐字节差异", "Frame diff: set current frame as baseline, then step frames to spot byte differences")}>
          <IconDiff />
        </button>
      </div>
      {renderTabs()}
      <CoverageStrip
        tpl={curTpl}
        frameLen={resolved.fr?.len ?? (curTpl ? skeletonLen(curTpl) : 0)}
        onPick={defineGap}
      />
      <div className="fc-body" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseDown={onDown}
          onMouseUp={onUp}
          onContextMenu={onCtx}
          onDoubleClick={onDblClick}
          onMouseLeave={() => {
            hoverRef.current = null;
            if (tipRef.current) tipRef.current.style.display = "none";
            dirtyRef.current = true;
          }}
          onWheel={onWheel}
        />
        <div className="fc-tip" ref={tipRef} />
        <div
          className="fc-noframe-badge"
          ref={noframeRef}
          hidden
          title={tx(
            "该协议已定义但尚未匹配到任何有效帧。排查：①串口/网络是否连接并有数据；②波特率是否匹配；③帧头字节与设备实际输出是否一致；④同簇其他帧型的识别位是否抢占。",
            "This protocol is defined but no valid frame matched yet. Check: 1) serial/network connected with data; 2) baud rate matches; 3) header bytes match device output; 4) sibling frame types in the cluster are not stealing the match.",
          )}
        >
          {tx("未见有效帧", "No valid frame yet")}
        </div>
        {menuState &&
          (() => {
            const m = menuRef.current;
            if (!m) return null;
            return (
              <>
                <div className="fc-menu-mask" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
                <div className="fc-menu" ref={menuElRef} style={{ left: menuState.x, top: menuState.y }}>
                  {m.kind === "sel" && (
                    <>
                      <button className="fc-menu-item primary" onClick={defineFromMenu}>
                        {tx("定义为字段…", "Define as field…")}
                        <span className="fc-menu-sub">{tx(`${m.size} 字节`, `${m.size} B`)}</span>
                      </button>
                      {(() => {
                        const tpl0 = curRef.current;
                        if (!tpl0) return null;
                        const fixed = tpl0.boundary.mode === "fixedLength";
                        const gEnd = m.lo + m.size - 1;
                        const why = !fixed
                          ? tx(
                              "变长帧帧长由长度域/帧尾决定——请到属性面板改截帧配置",
                              "Variable frames size by the length field/footer — edit framing in properties",
                            )
                          : m.size !== 1
                            ? tx("格操作仅支持单字节选区", "Cell ops work on a single-byte selection")
                            : null;
                        return (
                          <>
                            <button
                              className="fc-menu-item"
                              disabled={!!why}
                              title={why ?? tx("在此字节前插入 1 字节，其后字段自动右移（Ctrl+Z 撤销）", "Insert 1 byte before this cell; fields shift right (Ctrl+Z to undo)")}
                              onClick={() => {
                                const e2 = templateStore.insertFrameCell(m.tplId, m.lo);
                                closeMenu();
                                if (e2) setPending({ msg: e2 });
                                dirtyRef.current = true;
                              }}
                            >
                              <IconInsBefore />
                              {tx("在此格前插入（帧长 +1）", "Insert cell before (length +1)")}
                            </button>
                            <button
                              className="fc-menu-item"
                              disabled={!!why}
                              title={why ?? (m.lo === gEnd && tpl0.boundary.fixedLength != null && gEnd + 1 === tpl0.boundary.fixedLength
                                ? tx("在帧尾追加 1 字节（字段不动）", "Append 1 byte at the tail (fields unchanged)")
                                : tx("在此字节后插入 1 字节，其后字段自动右移（Ctrl+Z 撤销）", "Insert 1 byte after this cell; fields shift right (Ctrl+Z to undo)"))}
                              onClick={() => {
                                const e2 = templateStore.insertFrameCell(m.tplId, gEnd + 1);
                                closeMenu();
                                if (e2) setPending({ msg: e2 });
                                dirtyRef.current = true;
                              }}
                            >
                              <IconInsAfter />
                              {tx("在此格后插入（帧长 +1）", "Insert cell after (length +1)")}
                            </button>
                            <button
                              className="fc-menu-item danger"
                              disabled={!!why}
                              title={why ?? tx("删除此字节，其后字段自动左移（校验/帧尾区与字段占用会被拦截，Ctrl+Z 撤销）", "Delete this byte; following fields shift left (checksum/footer and field areas are blocked; Ctrl+Z to undo)")}
                              onClick={() => {
                                const e2 = templateStore.deleteFrameCell(m.tplId, m.lo);
                                closeMenu();
                                if (e2) setPending({ msg: e2 });
                                selRef.current = null;
                                dirtyRef.current = true;
                              }}
                            >
                              <IconTrash />
                              {tx("删除此格（帧长 −1）", "Delete this cell (length −1)")}
                            </button>
                          </>
                        );
                      })()}
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        {tx("取消选择 (Esc)", "Clear selection (Esc)")}
                      </button>
                    </>
                  )}
                  {m.kind === "field" && (
                    <>
                      <button
                        className="fc-menu-item"
                        onClick={() => {
                          closeMenu();
                          editField(m.tplId, m.fid);
                        }}
                      >
                        {tx("编辑字段…", "Edit field…")}
                      </button>
                      {(() => {
                        const tpl0 = curRef.current;
                        const fld0 = tpl0?.fields.find((f) => f.id === m.fid);
                        if (!tpl0 || !fld0) return null;
                        if (tpl0.boundary.mode !== "fixedLength" || fld0.offset < 0) return null;
                        if (fld0.offset < tpl0.boundary.headerBytes.length) return null;
                        return (
                          <button
                            className="fc-menu-item"
                            title={tx("在本字段前插入 1 字节，本字段及其后右移（Ctrl+Z 撤销）", "Insert 1 byte before this field; it and later fields shift right (Ctrl+Z to undo)")}
                            onClick={() => {
                              const e2 = templateStore.insertFrameCell(m.tplId, fld0.offset);
                              closeMenu();
                              if (e2) setPending({ msg: e2 });
                              dirtyRef.current = true;
                            }}
                          >
                            <IconInsBefore />
                            {tx("在此字段前插入格（帧长 +1）", "Insert cell before field (length +1)")}
                          </button>
                        );
                      })()}
                      <button
                        className="fc-menu-item danger"
                        disabled={m.locked}
                        onClick={() => {
                          closeMenu();
                          undefine(m.tplId, m.fid);
                        }}
                      >
                        <IconX />
                        {tx("取消字段定义", "Undefine field")}{m.locked ? tx("（已锁定）", " (locked)") : ""}
                      </button>
                      <button
                        className="fc-menu-item"
                        onClick={() => {
                          closeMenu();
                          toggleLock(m.tplId, m.fid);
                        }}
                      >
                        {m.locked ? <IconUnlock /> : <IconLock />}
                        {m.locked ? tx("解锁字段", "Unlock field") : tx("锁定字段", "Lock field")}
                      </button>
                    </>
                  )}
                  {m.kind === "hdr" && (
                    <>
                      <button className="fc-menu-item primary" onClick={() => openHdrDlg(m.tplId)}>
                        {tx("编辑帧头…", "Edit header…")}<span className="fc-menu-sub">{tx(`当前 ${m.nbytes} 字节`, `${m.nbytes} bytes now`)}</span>
                      </button>
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        {tx("取消选择 (Esc)", "Clear selection (Esc)")}
                      </button>
                    </>
                  )}
                  {m.kind === "ftr" && (
                    <>
                      {m.hasFB ? (
                        <button className="fc-menu-item primary" onClick={() => openFtrDlg(m.tplId)}>
                          {tx("编辑帧尾字节…", "Edit footer bytes…")}<span className="fc-menu-sub">{tx("双击亦可", "or double-click")}</span>
                        </button>
                      ) : (
                        <button
                          className="fc-menu-item"
                          disabled
                          title={tx("校验域宽度由算法决定（sum8=1B、CRC16=2B、CRC32=4B），在属性面板切换算法即可调整", "Checksum width follows the algorithm (1/2/4 B) — switch algorithms in properties")}
                        >
                          {tx("校验尾（长度由校验算法决定）", "Checksum tail (length set by algorithm)")}
                        </button>
                      )}
                      {(() => {
                        const t0 = protoRef.current.rules.templates.find((x) => x.id === m.tplId);
                        if (!t0 || !t0.checksum || t0.checksum.algo === "none") return null;
                        return (
                          <button
                            className="fc-menu-item danger"
                            title={tx("停用后该帧型的所有帧不再验证、直接放行（Ctrl+Z 撤销）", "All frames then pass unverified (Ctrl+Z to undo)")}
                            onClick={() => {
                              templateStore.setChecksumAlgo(m.tplId, "none");
                              closeMenu();
                              selRef.current = null;
                              dirtyRef.current = true;
                              toast(
                                tx(
                                  `校验已停用（${t0.checksum!.algo} → 无）——帧将全部放行`,
                                  `Checksum disabled (${t0.checksum!.algo} → none) — frames pass unverified`,
                                ),
                              );
                            }}
                          >
                            <IconX />
                            {tx("停用本帧型校验", "Disable checksum")}<span className="fc-menu-sub">{t0.checksum.algo}</span>
                          </button>
                        );
                      })()}
                      <button
                        className="fc-menu-item"
                        onClick={() => {
                          templateStore.setSelection({ kind: "template", templateId: m.tplId });
                          selRef.current = null;
                          closeMenu();
                          dirtyRef.current = true;
                        }}
                      >
                        {tx("配置校验…", "Configure checksum…")}<span className="fc-menu-sub">{tx("右侧属性面板「校验」区", "Checksum section in properties")}</span>
                      </button>
                      <button className="fc-menu-item" onClick={() => { selRef.current = null; closeMenu(); dirtyRef.current = true; }}>
                        {tx("取消选择 (Esc)", "Clear selection (Esc)")}
                      </button>
                    </>
                  )}
                </div>
              </>
            );
          })()}
        {pending && (
          <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={() => setPending(null)}>
            <div className="modal fc-confirm" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-title">{pending.title ?? tx("字段冲突", "Field conflict")}</div>
              <div className="fc-confirm-body">{pending.msg}</div>
              <div className="modal-foot">
                <span />
                <button className="btn" onClick={() => setPending(null)}>{tx("取消", "Cancel")}</button>
                {pending.apply && (
                  <button
                    className="btn primary"
                    onClick={() => {
                      pending.apply?.();
                      setPending(null);
                    }}
                  >
                    {pending.applyLabel ?? tx("覆盖并继续", "Overwrite & continue")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {dlg &&
          (dlg.kind === "field" ? (
            <FieldDialog
              init={dlg}
              onCancel={() => setDlg(null)}
              onOk={(f, ckAlgo) => {
                const applyIt = () => {
                  templateStore.upsertFieldLinked(
                    dlg.tplId,
                    f,
                    dlg.edit && dlg.field ? dlg.field.id : null,
                    ckAlgo,
                  );
                  fireAnim(`${dlg.tplId}:${dlg.field?.id ?? f.id}`);
                  setDlg(null);
                  selRef.current = null;
                  dirtyRef.current = true;
                };
                const base = dlg.edit && dlg.field ? dlg.field : f;
                const c = templateStore.fieldConflictInfo(
                  dlg.tplId,
                  base.id,
                  f.offset,
                  fieldSize({ ...base, ...f }),
                  { frameLen: dlg.frLen || 0, selfType: f.type, selfRole: f.role },
                );
                if (c.overFrame) {
                  setPending({
                    msg: tx(
                      `无法保存：${c.overFrame}。请先增大「总帧长/最大帧长」或缩小字段。`,
                      `Cannot save: ${c.overFrame}. Increase "total/max frame length" or shrink the field first.`,
                    ),
                  });
                  return;
                }
                if (c.overTail) {
                  if (c.overTail.kind === "checksum") {
                    setPending({
                      title: tx("与校验域冲突", "Checksum-area conflict"),
                      msg: tx(
                        `选区与帧尾校验域重叠 ${c.overTail.bytes} 字节——校验字节被字段占用后仍按原位置验证，但该区域将同时显示为字段。可直接取消校验后在此定义，或缩小选区避开帧尾。`,
                        `The selection overlaps the checksum tail by ${c.overTail.bytes} byte(s). You can remove the checksum and define here, or shrink the selection away from the tail.`,
                      ),
                      applyLabel: tx("取消校验并定义", "Drop checksum & define"),
                      apply: () => {
                        templateStore.setChecksumAlgo(dlg.tplId, "none");
                        applyIt();
                      },
                    });
                  } else {
                    setPending({
                      title: tx("与帧尾字节冲突", "Footer-area conflict"),
                      msg: tx(
                        `选区压住帧尾定界字节 ${c.overTail.bytes} B——帧尾是成帧符号，不能被字段占用。请左移选区，或在属性面板修改帧尾字节。`,
                        `The selection overlaps ${c.overTail.bytes} B of footer delimiter bytes — footers cannot be occupied by fields. Move the selection left or edit the footer bytes in properties.`,
                      ),
                    });
                  }
                  return;
                }
                if (c.overlapName) {
                  setPending({
                    msg:
                      tx("保存后将覆盖字段「", "Saving will overwrite the first ") +
                      String(c.overlapBytes ?? 0) +
                      tx(" 字节", " bytes") +
                      tx("，与字段「", " of the field \"") +
                      c.overlapName +
                      tx("」重叠。是否继续？", "\". Continue?"),
                    apply: applyIt,
                  });
                  return;
                }
                applyIt();
              }}
            />
          ) : (
            <HeadTailDialog
              init={dlg}
              onCancel={() => setDlg(null)}
              onSave={(bytes) => {
                if (dlg.kind === "hdr") {
                  const err2 = templateStore.setHeaderBytes(dlg.tplId, bytes);
                  setDlg(null);
                  selRef.current = null;
                  dirtyRef.current = true;
                  if (err2)
                    setPending({
                      title: tx("帧头未能修改", "Header not changed"),
                      msg: err2,
                    });
                } else {
                  templateStore.patchBoundary(dlg.tplId, { footerBytes: bytes });
                  setDlg(null);
                  selRef.current = null;
                  dirtyRef.current = true;
                }
              }}
            />
          ))}
        <ArchEmptyGate>
          {!curTpl && (
            <div className="fc-empty">
              <div className="fc-empty-title">{tx("等待有效帧…", "Waiting for a valid frame…")}</div>
              <div className="fc-empty-desc">
                {tx("这里只呈现通过「协议模板」校验的完整数据帧。", "Only complete frames that pass the protocol-template validation are shown here.")}
                {serial.status !== "connected" ? tx("可先连接设备或启动演示源；", "Connect a device or start the demo source;") : ""}
                {tx("添加预设协议请用左侧「＋ 预设」。", 'Add preset protocols with "+ Preset" on the left.')}
              </div>
            </div>
          )}
        </ArchEmptyGate>
      </div>
    </div>
  );
}


type DlgInit =
  | {
      kind: "field";
      tplId: string;
      tplName: string;
      mode: string;
      ckAlgo: string | null;
      frLen: number;
      lo: number;
      size: number;
      edit?: boolean;
      field?: FieldDef | null;
      isAscii: boolean;
    }
  | { kind: "hdr" | "ftr"; tplId: string; tplName: string; bytes: number[] };

function parseHex(text: string): number[] | null {
  return parseHexBytes(text);
}

function HeadTailDialog({
  init,
  onSave,
  onCancel,
}: {
  init: Extract<DlgInit, { kind: "hdr" | "ftr" }>;
  onSave: (bytes: number[]) => void;
  onCancel: () => void;
}) {
  const isHdr = init.kind === "hdr";
  const [text, setText] = useState(
    init.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
  );
  const [err, setErr] = useState<string | null>(null);
  const protoLive = useSyncExternalStore(
    templateStore.subscribe,
    templateStore.getSnapshot,
  );
  useEffect(() => {
    const t = protoLive.rules.templates.find((x) => x.id === init.tplId);
    if (!t) return;
    const live = isHdr
      ? t.boundary.headerBytes
      : t.boundary.footerBytes ?? [];
    const cur = parseHex(text);
    const same =
      cur !== null &&
      cur.length === live.length &&
      cur.every((b, i) => b === live[i]);
    if (!same) {
      setText(
        live.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
      );
    }
  }, [protoLive, init.tplId, isHdr]);
  const bump = (n: number) => {
    const cur = parseHex(text);
    if (!cur) return;
    if (n > 0) {
      setText(
        [...cur.map((b) => b.toString(16).toUpperCase().padStart(2, "0")), "00"].join(" "),
      );
    } else if (cur.length > 0) {
      const next = cur.slice(0, cur.length - 1);
      setText(next.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "));
    }
    setErr(null);
  };
  const save = () => {
    const ws = parseHex(text);
    if (ws === null) {
      setErr(tx("输入无效：仅接受 0–255 的十六进制字节，如 AA 55 0C", "Invalid input: only hex bytes 0–255, e.g. AA 55 0C"));
      return;
    }
    onSave(ws);
  };
  const curLen = parseHex(text)?.length ?? null;

  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div
        className="fc-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={tx("帧画布编辑对话框", "Frame canvas dialog")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <div className="fc-dlg-title">
          {isHdr ? tx("编辑帧头", "Edit header") : tx("编辑帧尾", "Edit footer")}{" "}
          <span className="fc-dlg-sub">
            {init.tplName} · {tx("十六进制字节序列", "hex byte sequence")}
          </span>
        </div>
        <div className="fc-dlg-row">
          <label className="fc-sb-l">{tx("字节", "Bytes")}</label>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") onCancel();
              e.stopPropagation();
            }}
            placeholder={isHdr ? tx("如 AA 55", "e.g. AA 55") : tx("如 0D 0A 或 2C", "e.g. 0D 0A or 2C")}
          />
        </div>
        <div className="fc-dlg-row fc-sb-row">
          <span className={`fc-sb-info${curLen === null ? " bad" : ""}`}>
            {curLen === null
              ? tx("解析失败", "Parse failed")
              : tx(`当前 ${text.trim() ? curLen : 0} 字节 · 空格/逗号分隔`, `${text.trim() ? curLen : 0} bytes now · space/comma separated`)}
          </span>
          <button className="btn sm" onClick={() => bump(-1)} disabled={!curLen || curLen <= 0} title={tx("去掉末尾一个字节", "Remove the last byte")}>
            {tx("−1 字节", "−1 byte")}
          </button>
          <button className="btn sm" onClick={() => bump(1)} title={tx("末尾追加一个 00 字节", "Append a 00 byte")}>
            {tx("+1 字节", "+1 byte")}
          </button>
        </div>
        {isHdr ? (
          <div className="fc-dlg-warn soft">
            {tx(
              "帧头可为空（从首字节直接收集）；无需帧头的帧请在属性面板将模式改为「固定帧尾」。增减帧头长度时，其后的字段、长度域与识别位会自动平移。",
              "The header may be empty (bytes collected from the first byte). For header-less frames, switch the mode to \"fixed footer\" in properties. Changing header length auto-shifts the fields, length domain and discriminators behind it.",
            )}
          </div>
        ) : (
          <div className="fc-dlg-warn soft">
            {tx("帧尾字节为空时，该模板将被引擎以「缺少帧尾字节」拒绝，需在属性面板补充帧尾或换用「长度字段」成帧方式。", "With an empty footer the engine rejects this template (missing footer bytes). Add footer bytes in the properties panel or switch to the \"length field\" framing mode.")}
          </div>
        )}
        {err && <div className="fc-dlg-warn">{err}</div>}
        <div className="fc-dlg-foot">
          <button className="btn" onClick={() => { setText(""); setErr(null); }}>{tx("清空", "Clear")}</button>
          <button className="btn" onClick={onCancel}>{tx("取消", "Cancel")}</button>
          <button className="btn primary" onClick={save}>{tx("保存生效", "Save")}</button>
        </div>
      </div>
    </div>
  );
}

const ROLE_GROUPS: { zh: string; en: string; roles: FieldRole[] }[] = [
  { zh: "帧结构", en: "Frame", roles: ["header", "footer"] },
  { zh: "控制", en: "Control", roles: ["addr", "id", "seq", "length"] },
  { zh: "数据", en: "Data", roles: ["data", "payload"] },
  { zh: "校验", en: "Checksum", roles: ["checksum", "checksum2"] },
];

function FieldDialog({
  init,
  onOk,
  onCancel,
}: {
  init: Extract<DlgInit, { kind: "field" }>;
  onOk: (f: FieldDef, ckAlgo: string | null) => void;
  onCancel: () => void;
}) {
  const recs = SIZE_TYPES[init.size] ?? [];
  useLocale();
  const defType: FieldType = recs[0] ?? "uint8";
  const defName = tx(`字段${init.lo}`, `Field ${init.lo}`);
  const [name, setName] = useState(nameHints(init.size)[0] ?? defName);
  const [type, setType] = useState<FieldType>(defType);
  const [endian, setEndian] = useState<Endian>("little");
  const [role, setRole] = useState<FieldRole>(init.field?.role ?? "data");
  const [scale, setScale] = useState("");
  const [unit, setUnit] = useState(init.field?.unit ?? "");
  const [color, setColor] = useState(init.field?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [csvDelim, setCsvDelim] = useState(init.field?.csvDelim ?? ",");
  const [csvType, setCsvType] = useState(init.field?.csvType ?? "float32");
  const [spanTail, setSpanTail] = useState(!!init.field?.spanTail);
  const [spanElem, setSpanElem] = useState<string>(
    init.field?.spanTail ? (init.field?.spanElem ?? "text") : "float32",
  );
  const [ckAlgo, setCkAlgo] = useState<string>(init.ckAlgo && init.ckAlgo !== "none" ? init.ckAlgo : "sum8");
  const [tail, setTail] = useState<boolean>(
    init.field
      ? init.field.offset < 0
      : init.mode !== "fixedLength" &&
          init.frLen > 0 &&
          init.lo >= 0 &&
          init.lo < init.frLen &&
          init.frLen - init.lo <= 8,
  );
  useEffect(() => {
    if (init.field && init.edit) {
      setType(init.field.type);
      setEndian(init.field.endian);
      setScale(init.field.scale != null ? String(init.field.scale) : "");
      if (init.field.csvDelim) setCsvDelim(init.field.csvDelim);
      if (init.field.csvType) setCsvType(init.field.csvType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lenRestricted = init.mode === "lengthField" && role === "length";
  useEffect(() => {
    if (lenRestricted && type !== "uint8" && type !== "uint16") setType("uint8");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lenRestricted]);
  useEffect(() => {
    if (role !== "checksum" || ckAlgo === "none") return;
    const want = CHECKSUM_SIZES[ckAlgo] ?? 1;
    const cur = fieldSize({ id: "", name: "", role: "checksum", offset: 0, type, endian, color: "" });
    if (cur !== want) {
      setType(want === 2 ? "uint16" : want === 4 ? "uint32" : want === 8 ? "float64" : "uint8");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, ckAlgo]);
  const spanElemNeedsEndian =
    spanTail &&
    spanElem !== "text" &&
    spanElem !== "bit" &&
    spanElem !== "uint8" &&
    spanElem !== "int8";
  const needsEndian = type === "uint16" || type === "int16" || type === "uint32" || type === "int32" || type === "float32" || type === "float64" || spanElemNeedsEndian;
  const fixedSize = fieldSize({ id: "", name: "", role: "data", offset: 0, type, endian, color: "" });
  const mismatched = init.isAscii ? false : recs.length > 0 && !recs.includes(type);
  // P85b：冲突实时预览——打开即算，随类型/角色/锚点变更即时刷新（保存仍是权威闸口）
  const protoLive = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const candOff = init.edit && init.field ? init.field.offset : tail ? init.lo - init.frLen : init.lo;
  const candSize = type === "ascii" || type === "bcd" ? init.size : fixedSize;
  const conflictLive = useMemo(
    () =>
      templateStore.fieldConflictInfo(
        init.tplId,
        init.edit && init.field ? init.field.id : "preview-new",
        candOff,
        candSize,
        { frameLen: init.frLen || 0, selfType: type, selfRole: role },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [protoLive, init.tplId, init.edit, init.field, candOff, candSize, type, role],
  );

  return (
    <div className="fc-dlg-mask" onMouseDown={onCancel}>
      <div
        className="fc-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={tx("帧画布编辑对话框", "Frame canvas dialog")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <div className="fc-dlg-title">
          {init.edit ? tx("编辑字段", "Edit field") : tx("定义字段", "Define field")}{" "}
          <span className="fc-dlg-sub">
            {init.tplName} ·{" "}
            {init.lo < 0
              ? tx(`距帧尾 ${-init.lo} · 长度 ${init.size}B`, `${-init.lo}B from tail · ${init.size}B`)
              : tx(`帧内偏移 ${init.lo} · 长度 ${init.size}B`, `frame +${init.lo} · ${init.size}B`)}
          </span>
        </div>
        {init.size !== fixedSize && (
          <div className="fc-dlg-warn">
            {tx(`所选类型占 ${fixedSize}B ≠ 选区 ${init.size}B — 请核对长度`, `Selected type occupies ${fixedSize}B ≠ ${init.size}B selection — check the length`)}
          </div>
        )}
        {mismatched && (
          <div className="fc-dlg-warn soft">{tx("智能推荐", "Suggested")}: {recs.map((r) => typeLabel(r)).join(" / ")}（{init.size}{tx("字节", "bytes")}）</div>
        )}
        {conflictLive.overFrame ? (
          <div className="fc-dlg-warn">{tx(`超出帧长——${conflictLive.overFrame}`, `Beyond frame length — ${conflictLive.overFrame}`)}</div>
        ) : conflictLive.overTail ? (
          <div className="fc-dlg-warn">
            {conflictLive.overTail.kind === "checksum"
              ? tx(
                  `选区与帧尾校验域重叠 ${conflictLive.overTail.bytes} B——保存时可一键「取消校验并定义」`,
                  `Overlaps the checksum tail by ${conflictLive.overTail.bytes} B — on save you can drop the checksum and define`,
                )
              : tx(
                  `选区与帧尾定界字节重叠 ${conflictLive.overTail.bytes} B——帧尾不能被字段占用`,
                  `Overlaps footer delimiter bytes by ${conflictLive.overTail.bytes} B — footers cannot be occupied`,
                )}
          </div>
        ) : conflictLive.overlapName ? (
          <div className="fc-dlg-warn soft">
            {tx(
              `将与字段「${conflictLive.overlapName}」重叠 ${conflictLive.overlapBytes} B——保存时二次确认`,
              `Will overlap "${conflictLive.overlapName}" by ${conflictLive.overlapBytes} B — confirmed on save`,
            )}
          </div>
        ) : null}
        <div className="fc-dlg-row">
          <label>{tx("名称", "Name")}</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("如 温度值", "e.g. Temperature")} />
        </div>
        <div className="fc-dlg-row">
          <label>{tx("位置锚点", "Anchor")}</label>
          <div
            className={`fc-seg${init.edit ? " dis" : ""}`}
            role="radiogroup"
            aria-label={tx("位置锚点", "Anchor")}
          >
            <button
              type="button"
              role="radio"
              aria-checked={!tail}
              className={tail ? "" : "on"}
              disabled={init.edit}
              title={
                init.edit
                  ? tx("编辑时不改变锚点", "Anchor cannot change while editing")
                  : tx("偏移自帧首起算（正数），定长帧最直观", "Offset counted from the frame start (positive)")
              }
              onClick={() => setTail(false)}
            >
              {tx("帧头起算", "From head")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={tail}
              className={tail ? "on" : ""}
              disabled={init.edit}
              title={
                init.edit
                  ? tx("编辑时不改变锚点", "Anchor cannot change while editing")
                  : tx("偏移记为负数（距帧尾），随每帧长度自适应", "Stored as a negative offset from the frame tail, adapting per frame")
              }
              onClick={() => setTail(true)}
            >
              {tx("帧尾起算", "From tail")}
            </button>
          </div>
        </div>
        {tail && (
          <div className="fc-dlg-hint">
            {tx(
              `将存为负偏移 ${init.edit && init.field ? init.field.offset : init.lo - init.frLen}：距帧尾 ${Math.abs(init.edit && init.field ? init.field.offset : init.lo - init.frLen)} 字节起算，实际位置 帧内 ${init.frLen + (init.edit && init.field ? init.field.offset : init.lo - init.frLen)} 起（帧长 ${init.frLen}）。`,
              `Stored as negative offset ${init.edit && init.field ? init.field.offset : init.lo - init.frLen}: starts ${Math.abs(init.edit && init.field ? init.field.offset : init.lo - init.frLen)} byte(s) before the tail (frame length ${init.frLen}).`,
            )}
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("协议角色", "Role")}</label>
          <div className="fc-dlg-roles">
            {ROLE_GROUPS.map((grp) => (
              <div className="fc-dlg-roles-g" key={grp.zh}>
                <span className="fc-dlg-roles-l">{tx(grp.zh, grp.en)}</span>
                {grp.roles.map((rl) => (
                  <button
                    key={rl}
                    className={`fc-role-chip${role === rl ? " on" : ""}`}
                    style={{ "--chipc": ROLE_META[rl].chip } as React.CSSProperties}
                    onClick={() => setRole(rl)}
                  >
                    <i />
                    {roleLabel(rl)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {role === "checksum" && (
          <>
            <div className="fc-dlg-row">
              <label>{tx("校验算法", "Algorithm")}</label>
              <select value={ckAlgo} onChange={(e) => setCkAlgo(e.target.value)}>
                <option value="sum8">{tx("和校验 sum8（字节累加）", "sum8 (byte sum)")}</option>
                <option value="xor8">{tx("异或 xor8", "XOR8")}</option>
                <option value="sumadd">{tx("SC+AC（和 + 0xAA 累加）", "SC+AC")}</option>
                <option value="crc16_modbus">CRC16 Modbus</option>
                <option value="crc16_ccitt">CRC16 CCITT-FALSE</option>
                <option value="crc32">CRC32</option>
                <option value="none">{tx("不校验（仅标注）", "No verification (marker only)")}</option>
              </select>
            </div>
            <div className="fc-dlg-warn soft">
              {ckAlgo === "none"
                ? tx(
                    "仅作视觉标注，引擎不验证。要启用校验请选择算法。",
                    "Visual marker only, no verification. Pick an algorithm to enable it.",
                  )
                : tx(
                    `保存即启用 ${ckAlgo}：覆盖范围=帧首至校验域前（可在属性面板改），校验不过的帧会被过滤。字段宽度已自动匹配算法（${CHECKSUM_SIZES[ckAlgo] ?? 1} B）。`,
                    `Saves with ${ckAlgo} enabled: coverage = frame start to before this field (editable in properties); failing frames are filtered. Field width auto-matches the algorithm (${CHECKSUM_SIZES[ckAlgo] ?? 1} B).`,
                  )}
            </div>
            <div className="fc-dlg-hint">
              {init.mode === "fixedLength"
                ? tx(
                    `当前偏移 ${init.lo}（帧内第 ${init.lo + 1} 字节）。校验域通常紧贴帧尾（偏移 = 帧长 − 校验宽度）；拖到哪个字节就固定在哪个字节，改位置请在属性面板改偏移或重新框选。`,
                    `Current offset ${init.lo} (byte ${init.lo + 1} of the frame). Checksums normally sit at the tail; wherever you dragged is where it stays — adjust via properties or re-select.`,
                  )
                : tx(
                    `变长帧的校验域自动锚定帧尾（帧长 − 宽度 − 帧尾字），固定偏移 ${init.lo} 仅作画布标注，无需修改。`,
                    `Variable-length frames anchor the checksum to the tail automatically; the fixed offset ${init.lo} is a canvas marker only.`,
                  )}
            </div>
          </>
        )}
        {role === "checksum2" && (
          <div className="fc-dlg-warn soft">
            {tx(
              "CK2 为视觉标注位：与 CK1 一起由校验算法一次验证，不单独校验。",
              "CK2 is a visual marker: verified together with CK1 by the algorithm, never separately.",
            )}
          </div>
        )}
        <div className="fc-dlg-row">
          <label>{tx("数据类型", "Data type")}</label>
          <select value={type} onChange={(e) => setType(e.target.value as FieldType)}>
            {(lenRestricted
              ? TYPE_ORDER.filter((t) => t === "uint8" || t === "uint16")
              : recs.length
                ? [...recs, ...TYPE_ORDER.filter((t) => !recs.includes(t))]
                : TYPE_ORDER
            ).map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
                {!lenRestricted && recs.includes(t) ? ` ${tx("推荐", "suggested")}` : ""}
              </option>
            ))}
          </select>
          {lenRestricted && (
            <div className="fc-dlg-hint">
              {tx(
                "长度域仅支持 1/2 字节：选择后此字段自动作为帧的长度域（偏移与宽度同步到截帧配置）。",
                "The length domain supports 1/2 bytes: this field doubles as the frame length field (offset & width sync to the framing config).",
              )}
            </div>
          )}
        </div>
        <div className="fc-dlg-row">
          <label>{tx("字节序", "Endianness")}</label>
          <select value={endian} onChange={(e) => setEndian(e.target.value as "little" | "big")} disabled={!needsEndian}>
            <option value="little">{tx("小端 LE（低前）", "Little-endian LE")}</option>
            <option value="big">{tx("大端 BE（高前）", "Big-endian BE")}</option>
          </select>
        </div>
        {(role === "data" || role === "payload") && type !== "csv" && !tail && (
          <>
            <div className="fc-dlg-row">
              <label>{tx("变长载荷", "Variable span")}</label>
              <div className="fc-dlg-inline">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={spanTail}
                    onChange={(e) => setSpanTail(e.target.checked)}
                  />
                  <span>{tx("延伸至载荷尾（自适应变长）", "Extend to payload end (adaptive)")}</span>
                </label>
                <HelpHint
                  text={tx(
                    "本字段从自身偏移一直覆盖到校验/帧尾之前，随每帧实际长度自适应。元素类型为文本时输出一个文本变量（ASCII 输出文本、其余输出 HEX）；为数值类型时按字节序逐元素解析（缩放/单位逐元素生效），输出 名称1…名称N 动态数值变量——可绘图、可脚本引用，上限 64 元素。",
                    "This field stretches from its offset to just before the checksum/footer, adapting per frame. Text emits one text variable; numeric element types parse element by element (scale/unit per element) and emit Name1…NameN dynamic numeric variables — plottable and scriptable, max 64.",
                  )}
                />
              </div>
            </div>
            {spanTail && (
              <>
                <div className="fc-dlg-row">
                  <label>{tx("元素类型", "Element type")}</label>
                  <select value={spanElem} onChange={(e) => setSpanElem(e.target.value)}>
                    <option value="text">{tx("文本（HEX/ASCII 一整串）", "Text (one HEX/ASCII string)")}</option>
                    <option value="bit">{tx("位（0/1，低位在前）", "Bit (0/1, LSB first)")}</option>
                    <option value="uint8">uint8</option>
                    <option value="int8">int8</option>
                    <option value="uint16">uint16</option>
                    <option value="int16">int16</option>
                    <option value="uint32">uint32</option>
                    <option value="int32">int32</option>
                    <option value="float32">float32</option>
                    <option value="float64">float64</option>
                  </select>
                </div>
                <div className="fc-dlg-warn soft">
                  {spanElem === "text"
                    ? tx("输出 1 个文本变量，随每帧实际长度自适应。", "Emits one text variable, adapting to each frame's length.")
                    : tx(
                        `按 ${spanElem} ${endian === "big" ? "大端" : "小端"} 逐元素解析，输出 名称1…N 动态数值变量（上限 64），随帧长自适应。`,
                        `Parsed element-wise as ${spanElem} (${endian === "big" ? "BE" : "LE"}), emitting Name1…N numeric variables (max 64), adapting per frame.`,
                      )}
                </div>
              </>
            )}
          </>
        )}
        {type === "csv" && (
          <>
            <div className="fc-dlg-warn soft">
              {tx("自适应分隔数值（JustFloat 式）：覆盖本字段区到校验/帧尾前，按每帧实际段数动态输出 通道1…通道N（上限 64）。", "Auto delimiter values (JustFloat style): covers from this field up to the checksum/footer and emits Channel 1…N per frame based on the actual segment count (max 64).")}
            </div>
            <div className="fc-dlg-row">
              <label>{tx("分隔符", "Delimiter")}</label>
              <input
                value={csvDelim}
                onChange={(e) => setCsvDelim(e.target.value)}
                placeholder={tx("如 , 或 \\ 或 ;", "e.g. , or \\ or ;")}
                style={{ width: 90 }}
              />
            </div>
            <div className="fc-dlg-row">
              <label>{tx("元素类型", "Element type")}</label>
              <select value={csvType} onChange={(e) => setCsvType(e.target.value)}>
                <option value="float32">{tx("float（小数）", "float (decimal)")}</option>
                <option value="uint8">uint8</option>
                <option value="int8">int8</option>
                <option value="uint16">uint16</option>
                <option value="int16">int16</option>
                <option value="uint32">uint32</option>
                <option value="int32">int32</option>
                <option value="float64">float64</option>
              </select>
            </div>
          </>
        )}
        <div className="fc-dlg-row">
          <label>{tx("缩放倍率", "Scale")}</label>
          <input value={scale} onChange={(e) => setScale(e.target.value)} placeholder={tx("如 0.01 或 100", "e.g. 0.01 or 100")} />
        </div>
        <div className="fc-dlg-row">
          <label>{tx("单位", "Unit")}</label>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={tx("如 °C", "e.g. °C")} />
        </div>
        <div className="fc-dlg-row">
          <label>{tx("颜色", "Color")}</label>
          <div className="fc-dlg-colors">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="fc-color-picker"
              title={tx("自由取色", "Custom color")}
            />
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`fc-color-chip${color === c ? " on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <div className="fc-dlg-foot">
          <button className="btn" onClick={onCancel}>{tx("取消", "Cancel")}</button>
          <button
            className="btn primary"
            onClick={() =>
              onOk({
                id: init.field?.id ?? crypto.randomUUID(),
                name: name.trim() || defName,
                role,
                offset:
                  init.edit && init.field
                    ? init.field.offset
                    : tail
                      ? init.lo - init.frLen
                      : init.lo,
                type,
                endian,
                scale: scale.trim() ? Number(scale) : null,
                unit: unit.trim() || null,
                color,
                size: type === "ascii" || type === "bcd" ? init.size : null,
                bits: init.field?.bits ?? null,
                locked: init.field?.locked ?? false,
                csvDelim: type === "csv" ? csvDelim || "," : null,
                csvType: type === "csv" ? csvType : null,
                spanTail:
                  (role === "data" || role === "payload") && type !== "csv"
                    ? spanTail
                    : null,
                spanElem:
                  (role === "data" || role === "payload") &&
                  type !== "csv" &&
                  spanTail &&
                  spanElem !== "text"
                    ? spanElem
                    : null,
              }, role === "checksum" ? ckAlgo : null)
            }
          >
            {init.edit ? tx("保存修改", "Save changes") : tx("确认定义", "Confirm definition")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FrameCanvas;
