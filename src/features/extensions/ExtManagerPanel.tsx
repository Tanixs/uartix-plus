/**
 * P174-A6：扩展面板 —— 装、批、跑、卸都在这一面里。
 *
 * A5 那版是"一个内置示例 + 一屏日志"。这一批换成真仓库：左列是**磁盘上真实存在的扩展**，
 * 右边是它的权限面、运行状态和日志。批准卡不再是弹窗，而是右列顶上的那一条——
 * 理由是它要展示的东西（权限清单 + 与上次的差异）本来就属于"这个扩展的详情"，
 * 弹窗会把它们放在脱离上下文的浮层里，用户看完还得回想自己在批哪一个。
 *
 * 三条延续 A5 的决定：
 * ① 关面板**不停**进程（切分组/拖布局都会卸载重挂，跟着停就是"每次调整布局插件重启一轮"）；
 * ② 交互即 `touch` 续租（人在看日志，插件就该活着）；
 * ③ 样式走行内（这个面的形还在长，现在往 theme.css 写类就是一笔等着删的死规则）。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../i18n/strings";
import {
  commitInstall,
  ensureLoaded,
  getSnapshot,
  planFolder,
  reload,
  start,
  stop,
  subscribe,
  touch,
  uninstall,
} from "./extStore";
import { canStart, canStop, phaseLabel, type ExtLogLevel } from "./extRuntime";
import { needsApproval, type InstallPlan } from "./install";

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

/** 权限行统一加个前缀点，让"要什么"和"说明"读起来不是一坨。 */
function PermList(props: { lines: string[] }) {
  if (!props.lines.length) {
    return (
      <div style={{ color: "var(--text-dim)" }}>
        {tx("这个扩展没有申请任何权限（它能做的事只有画自己的面板）", "This extension requests no permissions at all")}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-0)" }}>
      {props.lines.map((l) => (
        <div key={l} style={{ display: "flex", gap: "var(--sp-1)" }}>
          <span style={{ color: "var(--accent)", flex: "0 0 auto" }}>·</span>
          <span style={{ color: "var(--text)" }}>{l}</span>
        </div>
      ))}
    </div>
  );
}

export function ExtManagerPanel() {
  useLocale();
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [selected, setSelected] = useState<string>("");
  const [pending, setPending] = useState<InstallPlan | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState<string>("");
  /** 装成功但要说一句的话（目前只有"包里有符号链接被跳过"）。 */
  const [notice, setNotice] = useState<{ skippedLinks: number } | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string>("");

  const logBox = useRef<HTMLDivElement>(null);
  const entry = useMemo(() => repo.entries.find((e) => e.id === selected) ?? null, [repo.entries, selected]);
  const logCount = entry?.logs.length ?? 0;

  useEffect(() => {
    void ensureLoaded();
  }, []);

  // 第一次读到列表时默认选中第一个（空列表就保持空）
  useEffect(() => {
    if (!selected && repo.entries.length) setSelected(repo.entries[0].id);
  }, [repo.entries, selected]);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logCount, entry?.phase]);

  /** 选目录 → 算计划 → 信任就直接装，否则顶出批准条。 */
  async function pickAndInstall() {
    setErr("");
    setNotice(null);
    setBusy("pick");
    try {
      const dir = await open({ directory: true, multiple: false, title: tx("选择扩展目录（含 extension.json）", "Pick an extension folder (with extension.json)") });
      if (!dir || Array.isArray(dir)) return;
      setBusy("plan");
      const plan = await planFolder(dir, `draft-${Date.now().toString(36)}`);
      if (needsApproval(plan)) {
        setPending(plan);
        return;
      }
      setBusy("commit");
      const warn = await commitInstall(plan);
      setNotice(warn);
      setSelected(plan.id);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function approve() {
    if (!pending) return;
    setErr("");
    setBusy("commit");
    try {
      const warn = await commitInstall(pending);
      setNotice(warn);
      setSelected(pending.id);
      setPending(null);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function doUninstall(id: string) {
    if (confirmUninstall !== id) {
      setConfirmUninstall(id);
      return;
    }
    setErr("");
    setBusy("uninstall");
    try {
      await uninstall(id);
      setConfirmUninstall("");
      setSelected("");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  const running = entry ? !canStart(entry.phase) : false;
  const label = phaseLabel(entry?.phase ?? "idle");

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
      onPointerDown={() => entry && void touch(entry.id)}
      onKeyDown={() => entry && void touch(entry.id)}
    >
      {/* 工具条 */}
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
        <span style={{ fontWeight: 600 }}>{tx("扩展", "Extensions")}</span>
        <span style={{ color: "var(--text-dim)" }}>{repo.entries.length}</span>
        <div style={{ flex: "1 1 auto" }} />
        <button className="btn" disabled={!!busy} onClick={() => void pickAndInstall()} title={tx("从一个文件夹安装（选含 extension.json 的目录）", "Install from a folder containing extension.json")}>
          {busy === "pick" || busy === "plan" ? tx("正在读取…", "Reading…") : tx("安装…", "Install…")}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void reload()} title={tx("重新读盘", "Reload from disk")}>
          {tx("刷新", "Refresh")}
        </button>
      </div>

      {err ? (
        <div style={{ padding: "var(--sp-2) var(--sp-3)", color: "var(--danger)", borderBottom: "1px solid var(--border)" }}>
          {err}
        </div>
      ) : null}

      {repo.issues.length ? (
        <div
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            color: "var(--warn)",
            borderBottom: "1px solid var(--border)",
            fontSize: "var(--fs-xs)",
          }}
        >
          {repo.issues.map((s, i) => (
            <div key={`${i}-${s}`}>· {s}</div>
          ))}
        </div>
      ) : null}

      {notice && notice.skippedLinks > 0 ? (
        <div
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            color: "var(--warn)",
            borderBottom: "1px solid var(--border)",
            fontSize: "var(--fs-xs)",
          }}
        >
          ·{" "}
          {tx(
            `包里有 ${notice.skippedLinks} 个符号链接被跳过（不跟随链接复制）——如果插件用到它们，运行时会缺文件。`,
            `${notice.skippedLinks} symlink(s) in the package were skipped (links are not followed) — the extension may be missing files at runtime.`,
          )}
        </div>
      ) : null}

      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        {/* 左列：装过的扩展 */}
        <div
          style={{
            flex: "0 0 168px",
            overflow: "auto",
            borderRight: "1px solid var(--border)",
            background: "var(--bg-inset)",
          }}
        >
          {repo.loading ? (
            <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>{tx("正在读取…", "Reading…")}</div>
          ) : repo.entries.length === 0 ? (
            <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)", lineHeight: "var(--lh-read)" }}>
              {tx("还没装任何扩展。点上面的「安装…」选一个目录。", "Nothing installed yet. Use “Install…” above to pick a folder.")}
            </div>
          ) : (
            repo.entries.map((e) => {
              const on = e.id === selected;
              const warn = e.verdict !== "trusted";
              return (
                <button
                  key={e.id}
                  onClick={() => {
                    setSelected(e.id);
                    setConfirmUninstall("");
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "var(--sp-2) var(--sp-3)",
                    background: on ? "var(--bg-panel)" : "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: "var(--fs-body)",
                  }}
                  title={e.id}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)" }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        flex: "0 0 auto",
                        background:
                          e.phase === "running"
                            ? "var(--ok)"
                            : e.phase === "failed"
                              ? "var(--danger)"
                              : warn
                                ? "var(--warn)"
                                : "var(--text-faint)",
                      }}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.manifest.name}
                    </span>
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-xs)", paddingLeft: "var(--sp-2)" }}>
                    v{e.version}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 右列：详情 */}
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {pending ? (
            /* ---- 批准条：一个还没落盘的安装计划 ---- */
            <div style={{ padding: "var(--sp-3)", borderBottom: "1px solid var(--border)", overflow: "auto" }}>
              <div style={{ fontWeight: 600, marginBottom: "var(--sp-1)" }}>
                {pending.verdict === "changed"
                  ? tx(`「${pending.name}」的权限变了（v${pending.version}）`, `Permissions changed for “${pending.name}” (v${pending.version})`)
                  : tx(`要安装「${pending.name}」吗？（v${pending.version}）`, `Install “${pending.name}”? (v${pending.version})`)}
              </div>
              <div style={{ color: "var(--text-dim)", marginBottom: "var(--sp-2)", lineHeight: "var(--lh-read)" }}>
                {tx(
                  "它申请做下面这些事。装完之后它会以你的身份运行——只装你信得过的来源。",
                  "It asks to do the following. Once installed it runs with your privileges — only install sources you trust.",
                )}
              </div>
              <PermList lines={pending.permissions} />
              {pending.verdict === "changed" ? (
                <div style={{ marginTop: "var(--sp-2)", color: "var(--warn)" }}>
                  {pending.delta.added.length ? (
                    <div>
                      {tx("新增：", "Added: ")}
                      {pending.delta.added.join(tx("、", ", "))}
                    </div>
                  ) : null}
                  {pending.delta.removed.length ? (
                    <div>
                      {tx("不再需要：", "No longer needs: ")}
                      {pending.delta.removed.join(tx("、", ", "))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: "var(--sp-2)", marginTop: "var(--sp-3)" }}>
                <button className="btn" disabled={!!busy} onClick={() => void approve()}>
                  {busy === "commit" ? tx("正在安装…", "Installing…") : tx("批准并安装", "Approve and install")}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => setPending(null)}>
                  {tx("取消", "Cancel")}
                </button>
              </div>
              <div style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)", marginTop: "var(--sp-2)" }}>
                {tx("源目录：", "Source: ")}
                {pending.srcDir}
              </div>
            </div>
          ) : !entry ? (
            <div
              style={{
                flex: "1 1 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-dim)",
                padding: "var(--sp-5)",
                lineHeight: "var(--lh-read)",
              }}
            >
              {tx(
                "扩展是独立的 Node 程序：装箱子里是数据集拆分、训练、部署这类整条流程，装进来就有自己的面板。",
                "Extensions are standalone Node programs that can hold a whole workflow (dataset split, training, deploy) behind their own panel.",
              )}
            </div>
          ) : (
            <>
              {/* 头 */}
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
                <span style={{ fontWeight: 600 }}>{entry.manifest.name}</span>
                <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-xs)" }}>v{entry.version}</span>
                <span
                  style={{
                    padding: "0 var(--sp-2)",
                    borderRadius: "var(--radius-pill)",
                    border: "1px solid var(--border)",
                    color: entry.phase === "failed" ? "var(--danger)" : running ? "var(--ok)" : "var(--text-dim)",
                    fontSize: "var(--fs-xs)",
                    lineHeight: "var(--ctl-h-1)",
                  }}
                >
                  {tx(label.zh, label.en)}
                </span>
                {entry.pid ? (
                  <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
                    pid {entry.pid}
                  </span>
                ) : null}
                <div style={{ flex: "1 1 auto" }} />
                <button
                  className="btn"
                  disabled={!canStart(entry.phase) || !!busy}
                  onClick={() => void start(entry.id)}
                  title={tx("拉起宿主进程", "Start the host process")}
                >
                  {tx("启动", "Start")}
                </button>
                <button
                  className="btn"
                  disabled={!canStop(entry.phase) || !!busy}
                  onClick={() => void stop(entry.id)}
                  title={tx("先让插件跑清理钩子，再结束进程树", "Run the plugin disposer first, then kill the process tree")}
                >
                  {tx("停止", "Stop")}
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => void doUninstall(entry.id)}
                  title={tx("删除这个扩展的目录和账本条目", "Delete this extension's folder and ledger entry")}
                  style={confirmUninstall === entry.id ? { color: "var(--danger)" } : undefined}
                >
                  {confirmUninstall === entry.id ? tx("确认卸载？", "Confirm?") : tx("卸载", "Uninstall")}
                </button>
              </div>

              {/* 权限面：装过之后仍然要能查（"它当初要了什么"是会被忘掉的） */}
              <div
                style={{
                  padding: "var(--sp-2) var(--sp-3)",
                  borderBottom: "1px solid var(--border)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-dim)",
                  maxHeight: 120,
                  overflow: "auto",
                  flex: "0 0 auto",
                }}
              >
                <div style={{ marginBottom: "var(--sp-1)" }}>{tx("它申请了：", "It requests:")}</div>
                <PermList lines={entry.permissions} />
                <div style={{ marginTop: "var(--sp-1)", fontFamily: "var(--font-mono)" }}>{entry.dir}</div>
              </div>

              {entry.error ? (
                <div style={{ padding: "var(--sp-2) var(--sp-3)", color: "var(--danger)", borderBottom: "1px solid var(--border)" }}>
                  {entry.error}
                </div>
              ) : null}

              {/* 日志 */}
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
                  <div style={{ color: "var(--text-faint)" }}>{tx("（还没有输出）", "(no output yet)")}</div>
                ) : (
                  entry.logs.map((l, i) => (
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
                      {l.stream === "stderr" ? (
                        <span style={{ flex: "0 0 auto", color: "var(--warn)" }}>stderr</span>
                      ) : null}
                      <span style={{ flex: "1 1 auto" }}>{l.text}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
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
          "关掉面板不会立即停进程：宿主会在空闲 60 秒后回收，下次用到自动拉起。",
          "Closing the panel does not stop the process: the host reclaims it after 60s idle and restarts it when needed.",
        )}
      </div>
    </div>
  );
}
