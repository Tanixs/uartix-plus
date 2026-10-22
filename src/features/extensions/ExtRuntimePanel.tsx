/**
 * P174-A5：扩展运行时面板 —— 纵向切片露在用户面前的那一端。
 *
 * 这一批只有内置示例（`demoExtension.ts`），但链路是完整的：
 * 打开面板 → 宿主进程起来 → 握手 → 日志一行行出现 → 关掉面板 60 秒后进程被回收。
 *
 * 三条刻意不做的决定：
 *
 * ① **关面板不停进程**。卸载时什么都不做，让宿主的空闲巡检去收（`ext_host.rs` 里那条
 *    `IDLE_TIMEOUT_MS = 60_000`）。理由是反过来做的后果很实在：面板切个分组、dockview
 *    重排一次布局都会卸载重挂，跟着停就等于"每次调整布局插件都要重启一遍、日志全丢"。
 *
 * ② **交互即续租**。`onPointerDown` / `onKeyDown` 打一次 `touch`。没有这一条，"用户正在
 *    盯着日志看、插件在等一个要 10 秒的操作"就会被判成空闲——人在用，进程却没了。
 *
 * ③ **样式全部走行内**。门 J 要求 TSX 里的静态类名必须在 CSS 里有定义，而这个面板的
 *    生命周期还没定（后面装包、批准卡、市场都会往这里长），现在往 theme.css 里写一批
 *    只有一个文件引用的类，删改时又是一笔死规则账。等形定了再抽类。
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { DEMO_EXT_ID } from "./demoExtension";
import { ensureDemo, getSnapshot, start, stop, subscribe, touch } from "./extStore";
import { canStart, canStop, phaseLabel, type ExtLogLevel } from "./extRuntime";

/** 日志级别 → 颜色。取的是语义键，不改写值：换主题时这里跟着变。 */
const LEVEL_COLOR: Record<ExtLogLevel, string> = {
  debug: "var(--text-faint)",
  info: "var(--text)",
  warn: "var(--warn)",
  error: "var(--danger)",
  raw: "var(--accent)",
};

const LEVEL_TAG: Record<ExtLogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
  raw: "RAW",
};

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ExtRuntimePanel(props: { params?: { extId?: string } }) {
  useLocale();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const extId = props.params?.extId || DEMO_EXT_ID;
  const rt = snap[extId];

  const logBox = useRef<HTMLDivElement>(null);
  const logCount = rt?.logs.length ?? 0;

  // 先把示例塞进状态表（幂等），再判断要不要拉起来。
  // 两个 effect 的顺序就是执行顺序，所以第二个 effect 读到的 snapshot 已经含示例了。
  useEffect(() => {
    ensureDemo();
  }, []);

  useEffect(() => {
    const cur = getSnapshot()[extId];
    if (cur && canStart(cur.phase)) void start(extId);
  }, [extId]);

  // 日志跟着走到底部。`logCount` 进依赖（不是 `logs` 数组）：
  // 环形缓冲到顶之后每次追加长度都停在 LOG_MAX，但每一次追加仍然要触发滚动。
  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logCount, rt?.phase]);

  const label = phaseLabel(rt?.phase ?? "idle");
  const running = rt ? !canStart(rt.phase) : false;
  const stoppable = rt ? canStop(rt.phase) : false;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg-panel)",
        color: "var(--text)",
        fontSize: "var(--fs-body)",
      }}
      onPointerDown={() => void touch(extId)}
      onKeyDown={() => void touch(extId)}
    >
      {/* 头：状态 + 身份 + 动作 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-3)",
          borderBottom: "1px solid var(--border)",
          flex: "0 0 auto",
        }}
      >
        <span style={{ fontWeight: 600 }}>{rt?.name ?? extId}</span>
        <span
          style={{
            padding: "0 var(--sp-2)",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--border)",
            color: rt?.phase === "failed" ? "var(--danger)" : running ? "var(--ok)" : "var(--text-dim)",
            fontSize: "var(--fs-xs)",
            lineHeight: "var(--ctl-h-1)",
          }}
          title={tx("插件宿主进程状态", "Extension host process state")}
        >
          {tx(label.zh, label.en)}
        </span>
        {rt?.pid ? (
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
            pid {rt.pid}
          </span>
        ) : null}
        {rt?.nodeVersion ? (
          <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-xs)" }}>
            node {rt.nodeVersion}
          </span>
        ) : null}

        <div style={{ flex: "1 1 auto" }} />

        <button
          className="btn"
          disabled={!rt || !canStart(rt.phase)}
          onClick={() => void start(extId)}
          title={tx("拉起宿主进程（面板打开时已自动拉起）", "Start the host process (already auto-started when the panel opens)")}
        >
          {tx("启动", "Start")}
        </button>
        <button
          className="btn"
          disabled={!stoppable}
          onClick={() => void stop(extId)}
          title={tx("先让插件跑清理钩子，再结束进程树", "Run the plugin disposer first, then kill the process tree")}
        >
          {tx("停止", "Stop")}
        </button>
      </div>

      {rt?.error ? (
        <div
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            color: "var(--danger)",
            borderBottom: "1px solid var(--border)",
            flex: "0 0 auto",
          }}
        >
          {rt.error}
        </div>
      ) : null}

      {/* 日志区 */}
      <div
        ref={logBox}
        tabIndex={0}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
          padding: "var(--sp-2) var(--sp-3)",
          background: "var(--bg-inset)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          lineHeight: "var(--lh-ui)",
        }}
      >
        {logCount === 0 ? (
          <div style={{ color: "var(--text-faint)" }}>
            {tx("（还没有输出）", "(no output yet)")}
          </div>
        ) : (
          rt?.logs.map((l, i) => (
            <div
              key={`${l.at}-${i}`}
              style={{
                display: "flex",
                gap: "var(--sp-2)",
                color: LEVEL_COLOR[l.level],
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: "var(--text-faint)", flex: "0 0 auto" }}>{hhmmss(l.at)}</span>
              <span style={{ flex: "0 0 auto", opacity: 0.7 }}>{LEVEL_TAG[l.level]}</span>
              {/* stderr 单独标一下：插件崩溃时真正的原因常常在这一路里 */}
              {l.stream === "stderr" ? (
                <span style={{ flex: "0 0 auto", color: "var(--warn)" }}>stderr</span>
              ) : null}
              <span style={{ flex: "1 1 auto" }}>{l.text}</span>
            </div>
          ))
        )}
      </div>

      <div
        style={{
          flex: "0 0 auto",
          padding: "var(--sp-1) var(--sp-3)",
          borderTop: "1px solid var(--border)",
          color: "var(--text-faint)",
          fontSize: "var(--fs-xs)",
        }}
      >
        {tx(
          "关掉面板不会立即停进程：宿主会在空闲 60 秒后回收，下次打开面板自动拉起。",
          "Closing the panel does not stop the process: the host reclaims it after 60s idle and restarts it next time the panel opens.",
        )}
      </div>
    </div>
  );
}
