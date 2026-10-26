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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import { EmptyState } from "../../../shared/EmptyState";
import { requestOpenSettings } from "../../ai/appBus";
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

  const unfiltered = useMemo(() => {
    const nameOf = (id: string) => repo.entries.find((e) => e.id === id)?.manifest.name ?? id;
    return channel === "host" ? hostLinesOfAll(repo.entries) : ledgerLinesOf(repo.journal, nameOf);
  }, [repo.entries, repo.journal, channel]);

  const lines = useMemo(() => {
    const f: OutputFilter = { channel, pluginId, minLevel, query };
    return filterLines(unfiltered, f).filter((l) => l.at >= clearedAt);
  }, [unfiltered, channel, pluginId, minLevel, query, clearedAt]);

  const status = useMemo(() => statusOf(repo.entries), [repo.entries]);
  const errorCount = channel === "host" ? status.errored : unfiltered.filter((l) => l.level === "error").length;

  // 复制/存文件/打开目录的回执是一次性的；留太久会像一条过期的状态条。
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(""), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

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

  function resetFilters(): void {
    setQuery("");
    setPluginId("");
    setMinLevel(null);
    setClearedAt(0);
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

  return (
    <div className="log-page">
      <div className="log-head">
        <div className="log-tabs" role="tablist" aria-label={tx("日志通道", "Log channels")}>
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={channel === c.id}
              className={`log-tab${channel === c.id ? " on" : ""}`}
              onClick={() => {
                setChannel(c.id);
                setClearedAt(0);
              }}
            >
              {tx(c.zh, c.en)}
            </button>
          ))}
        </div>

        <div className="log-tools">
          <select className="input log-filter" value={pluginId} onChange={(e) => setPluginId(e.target.value)} aria-label={tx("按插件筛", "Filter by plugin")}>
            <option value="">{tx("全部插件", "All plugins")}</option>
            {repo.entries.map((e) => (
              <option key={e.id} value={e.id}>{e.manifest.name}</option>
            ))}
          </select>
          <select
            className="input log-filter"
            value={minLevel ?? ""}
            onChange={(e) => setMinLevel((e.target.value || null) as PluginLogLevel | null)}
            aria-label={tx("按级别筛", "Filter by level")}
          >
            <option value="">{tx("全部级别", "All levels")}</option>
            {HOST_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <input
            className="input log-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx("搜索文本或插件", "Search text or plugin")}
            aria-label={tx("搜索日志", "Search log")}
          />
        </div>

        <div className="log-actions">
          <button
            className={`btn sm${follow ? " on" : ""}`}
            aria-pressed={follow}
            onClick={() => setFollow((v) => !v)}
            title={tx("新行来了就滚到底", "Scroll to the newest line")}
          >
            {tx("跟随", "Follow")}
          </button>
          <button className="btn sm" onClick={() => setClearedAt(Date.now())} title={tx("只影响这一面的显示，不清内存也不清盘", "View only: clears neither the buffer nor the file")}>
            {tx("清屏", "Clear view")}
          </button>
          <button className="btn sm" onClick={() => void doCopy()} disabled={!lines.length}>
            {tx("复制", "Copy")}
          </button>
          <button className="btn sm" onClick={() => void doSave()} disabled={!lines.length}>
            {tx("存文件", "Save")}
          </button>
          {channel === "host" ? (
            <button className="btn sm" onClick={() => void doOpenDir()} disabled={!selectedEntry} title={tx("打开这个插件的日志目录", "Open this plugin's log folder")}>
              {tx("日志目录", "Log folder")}
            </button>
          ) : null}
          <button className="btn sm" onClick={() => void reload()} title={tx("重新读盘（账本与插件清单）", "Re-read the disk (ledger and plugin index)")}>
            {tx("刷新", "Refresh")}
          </button>
        </div>
      </div>

      <div className="log-status">
        {channel === "host" ? (
          status.running.length ? (
            status.running.map((r) => (
              <button
                key={r.id}
                className="log-chip"
                onClick={() => {
                  setPluginId(r.id);
                  setMinLevel(null);
                  setQuery("");
                }}
                title={tx(`只看「${r.name}」的日志`, `Show only ${r.name}`)}
              >
                <span className="dot" />
                <span className="nm">{r.name}{r.pid ? ` · pid ${r.pid}` : ""}</span>
              </button>
            ))
          ) : (
            <span className="log-muted">{tx("暂无运行中的插件", "No plugins running")}</span>
          )
        ) : (
          <span className="log-muted">{tx(`操作账本 · ${unfiltered.length} 条`, `Ledger · ${unfiltered.length} event(s)`)}</span>
        )}
        {errorCount ? (
          <button
            className="log-chip err"
            onClick={() => {
              setPluginId("");
              setMinLevel("error");
              setQuery("");
              setClearedAt(0);
            }}
            title={tx("只看错误行", "Show error lines only")}
          >
            {tx(`${errorCount} 条错误`, `${errorCount} error line(s)`)}
          </button>
        ) : null}
        <span className="log-muted">{tx(`显示 ${lines.length} 行`, `Showing ${lines.length}`)}</span>
        {lines.length !== unfiltered.length ? <span className="log-muted">{tx(`共 ${unfiltered.length} 行`, `${unfiltered.length} total`)}</span> : null}
        <span className="log-spacer" />
        {channel === "host" && selectedEntry ? (
          <>
            <span className="log-muted">{selectedEntry.manifest.name} · {tx(phaseLabel(selectedEntry.phase).zh, phaseLabel(selectedEntry.phase).en)}</span>
            <button className="btn sm" disabled={!canStart(selectedEntry.phase)} onClick={() => void doStart()}>
              {tx("启动", "Start")}
            </button>
            <button className="btn sm" disabled={!canStop(selectedEntry.phase)} onClick={() => void doStop()}>
              {tx("停止", "Stop")}
            </button>
          </>
        ) : null}
      </div>

      {msg ? <div className="log-note">{msg}</div> : null}
      {issues.length ? (
        <div className="log-issue">
          {tx("日志落盘出过问题（内存里的那份仍然完整）：", "Writing logs to disk hit a problem (the in-memory copy is intact):")}
          {issues.join("\n")}
        </div>
      ) : null}

      <div ref={box} className="log-body">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className="log-line" style={{ color: LEVEL_COLORS[l.level] }}>
              <span className="log-time">{hhmmss(l.at)}</span>
              {l.pluginName ? <span className="log-src"> · {l.pluginName}</span> : null}
              {" "}
              {l.text}
            </div>
          ))
        ) : (
          <div className="log-empty-wrap">
            {unfiltered.length && clearedAt ? (
              <EmptyState
                title={tx("已清屏", "View cleared")}
                hint={[tx("新的日志会继续显示；清屏只影响这一面的视图。", "New lines keep arriving; clearing only affects this view.")]}
                actions={[{ label: tx("显示清屏前", "Show cleared lines"), onClick: () => setClearedAt(0) }]}
              />
            ) : unfiltered.length ? (
              <EmptyState
                title={tx("没有匹配的日志", "No matching lines")}
                hint={[tx("当前筛选没有命中，清除筛选看看全部。", "Nothing matches the current filters; clear them to see everything.")]}
                actions={[{ label: tx("清除筛选", "Clear filters"), primary: true, onClick: resetFilters }]}
              />
            ) : channel === "host" ? (
              <EmptyState
                title={tx("还没有宿主输出", "No host output yet")}
                hint={[tx("启用并打开一个插件的面板，进程日志会滚到这里；每行也会写入磁盘。", "Enable a plugin and open its panel; its process log lands here and is also written to disk.")]}
                actions={[
                  { label: tx("打开插件管理", "Open plugin management"), primary: true, onClick: () => requestOpenSettings("plugins") },
                  { label: tx("日志目录", "Log folder"), disabled: !selectedEntry, onClick: () => void doOpenDir() },
                ]}
              />
            ) : (
              <EmptyState
                title={tx("操作账本还是空的", "The action ledger is empty")}
                hint={[tx("安装、批准或启用一个插件后，这里会留下可重放的记录。", "Install, approve or enable a plugin and a replayable record will appear here.")]}
                actions={[{ label: tx("打开插件管理", "Open plugin management"), primary: true, onClick: () => requestOpenSettings("plugins") }]}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
