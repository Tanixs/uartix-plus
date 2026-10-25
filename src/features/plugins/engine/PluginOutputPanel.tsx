/**
 * P174-R7②：「运行日志」——整个插件系统的**诊断面**。
 *
 * 为什么这一面存在：装完一个插件，"它到底在不在跑、刚才崩在哪一步、谁批准了哪一版"这三件事
 * 今天只有一个地方能看——那个 1330 行的插件管理面板。而它正在被合并进设置页（R7①），
 * 设置页是"改配置的地方"，不是一个你愿意一直开着盯滚动的地方。
 * 用户报的"启用后面板还是用不了"里有一半其实是"没人告诉他为什么没起来"。
 *
 * 两个通道，不是一条总线：
 *  - **宿主输出**：插件进程说的话（stdout/stderr + 协议层），内存环形缓冲 + 现在也落盘；
 *  - **操作账本**：应用对插件做过什么（装/批/启用/命令/场景），append-only、可重放校验。
 * 两者的寿命与可信度不同，混成一条流就等于把"插件说自己错了"和"用户让它做的"排在一起。
 *
 * 三条从旧批次学来的做法：
 *  1. **列表只读 store**（`useSyncExternalStore`），不自己攒一份副本——攒了就出现"界面与引擎各有一份日志"；
 *  2. **跟随滚动 + 暂停**是这一面的基本人权：训练日志滚起来时，人在往上翻，不能被硬拽回底部；
 *  3. **启停在这里，启用与批准绝不在这里**：前者是对进程的动作，后者是判据，判据只从设置详情走。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import {
  ensureLoaded,
  getSnapshot,
  hostLogIssue,
  pluginLogsDir,
  reload,
  start,
  stop,
  subscribe,
} from "./pluginEngine";
import { canStart, canStop, phaseLabel, type PluginLogLevel } from "./runtime";
import {
  CHANNELS,
  HOST_LEVELS,
  filterLines,
  hhmmss,
  hostLinesOfAll,
  ledgerLinesOf,
  renderText,
  statusOf,
  type OutputChannel,
  type OutputFilter,
} from "./outputModel";

const LEVEL_COLORS: Record<PluginLogLevel, string> = {
  debug: "var(--text-faint)",
  raw: "var(--text-dim)",
  info: "var(--text)",
  warn: "var(--warn)",
  error: "var(--danger)",
};

export function PluginOutputPanel() {
  useLocale();
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [channel, setChannel] = useState<OutputChannel>("host");
  const [pluginId, setPluginId] = useState("");
  const [minLevel, setMinLevel] = useState<PluginLogLevel | null>(null);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  /** 「清屏」是视图动作：记一个时间点，之后的行才显示。内存里那 500 行不该被界面按钮清掉。 */
  const [clearedAt, setClearedAt] = useState(0);
  const [msg, setMsg] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void ensureLoaded();
  }, []);

  const lines = useMemo(() => {
    const nameOf = (id: string) => repo.entries.find((e) => e.id === id)?.manifest.name ?? id;
    const all = channel === "host" ? hostLinesOfAll(repo.entries) : ledgerLinesOf(repo.journal, nameOf);
    const f: OutputFilter = { channel, pluginId, minLevel, query };
    return filterLines(all, f).filter((l) => l.at >= clearedAt);
  }, [repo.entries, repo.journal, channel, pluginId, minLevel, query, clearedAt]);

  const status = useMemo(() => statusOf(repo.entries), [repo.entries]);

  // 跟随：新行来了就贴到底。翻了上去就该停住——"我在看第 3 行，你把我拽回底部"是这一面最难忍的交互
  useEffect(() => {
    if (!follow) return;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const selectedEntry = repo.entries.find((e) => e.id === pluginId);
  const issues = repo.entries.map((e) => hostLogIssue(e.id)).filter((s) => s);

  async function doStart(): Promise<void> {
    if (!selectedEntry) return;
    setMsg("");
    await start(selectedEntry.id);
  }

  async function doStop(): Promise<void> {
    if (!selectedEntry) return;
    setMsg("");
    await stop(selectedEntry.id);
  }

  async function doCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(renderText(lines));
      setMsg(tx(`已复制 ${lines.length} 行`, `Copied ${lines.length} line(s)`));
    } catch {
      setMsg(tx("剪贴板没给权限", "Clipboard permission was refused"));
    }
  }

  async function doSave(): Promise<void> {
    const path = await save({
      defaultPath: channel === "host" ? "uartix-host.log" : "uartix-ledger.log",
      filters: [{ name: tx("日志文件", "Log files"), extensions: ["log", "txt"] }],
    });
    if (!path) return;
    setMsg(tx("日志已复制为文本（不含颜色与级别底色）", "Saved as plain text (no colours)"));
    const blob = new Blob([renderText(lines)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = path.split(/[\\/]/).pop() ?? "uartix.log";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doOpenDir(): Promise<void> {
    if (!selectedEntry) {
      setMsg(tx("先在上面选中一个插件", "Pick a plugin above first"));
      return;
    }
    const dir = pluginLogsDir(selectedEntry.id);
    if (!dir) {
      setMsg(tx("还没读到插件目录", "Plugin folder is not loaded yet"));
      return;
    }
    try {
      const m = await import("@tauri-apps/plugin-opener");
      await m.openPath(dir);
    } catch (e) {
      setMsg(`${tx("打不开日志目录：", "Could not open the log folder: ")}${String((e as Error)?.message ?? e)}`);
    }
  }

  const btnRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--sp-2)",
    padding: "var(--sp-2) var(--sp-3)",
    flexWrap: "wrap",
    borderBottom: "1px solid var(--border)",
    fontSize: "var(--fs-xs)",
  };
  const sel: CSSProperties = {
    background: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "3px 6px",
    fontSize: "var(--fs-xs)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <div style={btnRow}>
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            className={`btn${channel === c.id ? " primary" : ""}`}
            onClick={() => {
              setChannel(c.id);
              setClearedAt(0);
            }}
          >
            {tx(c.zh, c.en)}
          </button>
        ))}
        <select style={sel} value={pluginId} onChange={(e) => setPluginId(e.target.value)} aria-label={tx("按插件筛", "Filter by plugin")}>
          <option value="">{tx("全部插件", "All plugins")}</option>
          {repo.entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.manifest.name}
            </option>
          ))}
        </select>
        {channel === "host" ? (
          <select
            style={sel}
            value={minLevel ?? ""}
            onChange={(e) => setMinLevel((e.target.value || null) as PluginLogLevel | null)}
            aria-label={tx("按级别筛", "Filter by level")}
          >
            <option value="">{tx("全部级别", "All levels")}</option>
            {HOST_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : null}
        <input
          style={{ ...sel, flex: "1 1 120px", minWidth: 90 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tx("搜文本 / 插件名", "Search text / plugin name")}
          aria-label={tx("搜索日志", "Search log")}
        />
        <button className={`btn${follow ? " primary" : ""}`} onClick={() => setFollow((v) => !v)} title={tx("新行来了就滚到底", "Scroll to the newest line")}>
          {tx("跟随", "Follow")}
        </button>
        <button className="btn" onClick={() => setClearedAt(Date.now())} title={tx("只影响这一面的显示，不清内存也不清盘", "View only: clears neither the buffer nor the file")}>
          {tx("清屏", "Clear view")}
        </button>
        <button className="btn" onClick={() => void doCopy()} disabled={!lines.length}>
          {tx("复制", "Copy")}
        </button>
        <button className="btn" onClick={() => void doSave()} disabled={!lines.length}>
          {tx("存文件", "Save")}
        </button>
        <button className="btn" onClick={() => void doOpenDir()} title={tx("打开这个插件的日志目录", "Open this plugin's log folder")}>
          {tx("日志目录", "Log folder")}
        </button>
        <button className="btn" onClick={() => void reload()} title={tx("重新读盘（账本与插件清单）", "Re-read the disk (ledger and plugin index)")}>
          {tx("刷新", "Refresh")}
        </button>
      </div>

      <div style={{ ...btnRow, borderBottom: "1px solid var(--border)", color: "var(--text-dim)" }}>
        <span style={{ color: "var(--text)" }}>
          {status.running.length
            ? tx(`在跑：${status.running.map((r) => `${r.name}${r.pid ? ` (pid ${r.pid})` : ""}`).join("、")}`, `Running: ${status.running.map((r) => `${r.name}${r.pid ? ` (pid ${r.pid})` : ""}`).join(", ")}`)
            : tx("没有在跑的插件", "Nothing is running")}
        </span>
        <span style={{ color: status.errored ? "var(--danger)" : "var(--text-faint)" }}>
          {tx(`${status.errored} 行错误`, `${status.errored} error line(s)`)}
        </span>
        <span>{tx(`显示 ${lines.length} 行`, `Showing ${lines.length}`)}</span>
        <div style={{ flex: "1 1 auto" }} />
        {selectedEntry ? (
          <>
            <span>{selectedEntry.manifest.name} · {tx(phaseLabel(selectedEntry.phase).zh, phaseLabel(selectedEntry.phase).en)}</span>
            <button className="btn" disabled={!canStart(selectedEntry.phase)} onClick={() => void doStart()}>
              {tx("启动", "Start")}
            </button>
            <button className="btn" disabled={!canStop(selectedEntry.phase)} onClick={() => void doStop()}>
              {tx("停止", "Stop")}
            </button>
          </>
        ) : null}
      </div>

      {msg ? <div style={{ padding: "4px var(--sp-3)", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{msg}</div> : null}
      {issues.length ? (
        <div style={{ padding: "4px var(--sp-3)", fontSize: "var(--fs-xs)", color: "var(--warn)", whiteSpace: "pre-wrap" }}>
          {tx("日志落盘出过问题（内存里的那份仍然完整）：", "Writing logs to disk hit a problem (the in-memory copy is intact):")}
          {issues.join("\n")}
        </div>
      ) : null}

      <div ref={box} style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "var(--sp-2) var(--sp-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
        {lines.length ? (
          lines.map((l, i) => (
            <div key={`${l.at}-${i}`} style={{ color: LEVEL_COLORS[l.level], whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ color: "var(--text-faint)" }}>{hhmmss(l.at)}</span>
              {l.pluginName ? <span style={{ color: "var(--text-faint)" }}> · {l.pluginName}</span> : null}
              {" "}
              {l.text}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-dim)", lineHeight: "var(--lh-read)" }}>
            {channel === "host"
              ? tx(
                  "这里还没有宿主输出。启用并打开一个插件的面板，它的进程日志就会滚进来；每一行同时写到 plugins/<插件>/logs/host.log。",
                  "No host output yet. Enable a plugin and open its panel — its process log lands here, and in plugins/<id>/logs/host.log.",
                )
              : tx(
                  "操作账本是空的。装一次插件、批准一次权限，这里就会留下可重放的记录（谁、什么时候、给了哪些权限）。",
                  "The ledger is empty. Install or approve something and a replayable record appears here (who, when, which permissions).",
                )}
          </div>
        )}
      </div>
    </div>
  );
}
