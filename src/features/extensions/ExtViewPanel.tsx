/**
 * P174-A7：插件自己的面板（iframe 宿主）。
 *
 * 这一层只做四件事：把包内那个 HTML 读出来、塞进一个**不透明源**的 iframe、把两边的消息接起来、
 * 在面板开着的时候让宿主进程活着。
 *
 * 三条都是从 A5/A6 学来的：
 *
 * 1. **不透明源**（`sandbox="allow-scripts"`，不给 `allow-same-origin`）。iframe 里跑的是
 *    用户装的代码，它不该能碰宿主的 DOM、localStorage 或别的插件。代价是它没有自己的存储、
 *    也没有相对路径——所以资源要经 `uartix.readText()` 显式取（那条路径在宿主这边是有据可查的）。
 *
 * 2. **面板开着就续租**。A5 定的规矩是"关掉面板 60 秒后回收"，那隐含"开着就是在用"。
 *    所以挂载期间每 20 秒 `touch` 一次；否则用户盯着一个正在跑训练的面板看，20 秒没点，
 *    宿主就把插件杀了。
 *
 * 3. **插件没了要说清楚**。面板可以被留在布局里，而插件可能已经被卸载——那时这个面板
 *    不该是一片空白，也不该报"加载失败"，它该说"这个插件已经不在了"。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../i18n/strings";
import {
  callExt,
  ensureLoaded,
  getSnapshot,
  listInExt,
  onPanelEvent,
  readInExt,
  start,
  subscribe,
  touch,
  writeInExt,
} from "./extStore";
import { canStart, phaseLabel } from "./extRuntime";
import {
  buildSrcdoc,
  eventMsg,
  PANEL_MSG_KEY,
  PANEL_PROTOCOL,
  parseBridgeMessage,
  resErr,
  resOk,
  type BridgeOut,
} from "./panelBridge";

/** 面板开着时的心跳间隔。比宿主 60 秒的回收线短得多，所以"开着"永远不会被判空闲。 */
const TOUCH_EVERY_MS = 20_000;

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && c ? c : "internal";
}

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export function ExtViewPanel(props: { params?: { extId?: string; panelId?: string } }) {
  useLocale();
  const extId = props.params?.extId ?? "";
  const panelId = props.params?.panelId ?? "";
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const entry = repo.entries.find((e) => e.id === extId);
  const def = entry?.manifest.contributes.panels?.find((p) => p.id === panelId);

  const [html, setHtml] = useState("");
  const [err, setErr] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void ensureLoaded();
  }, []);

  // 插件在跑，面板才有意义：没跑就拉起来（`canStart` 挡住"正在启动"时重复拉起）
  const phase = entry?.phase;
  useEffect(() => {
    if (!entry) return;
    if (canStart(entry.phase)) void start(entry.id);
  }, [entry, entry?.phase]);

  // 开着就续租：见文件头第 2 条
  useEffect(() => {
    if (!entry) return;
    const t = window.setInterval(() => void touch(extId), TOUCH_EVERY_MS);
    void touch(extId);
    return () => window.clearInterval(t);
  }, [extId, entry]);

  // 读入口 HTML。依赖用 **id 字符串**而不是 entry 对象：store 每次 patch（每来一行日志）
  // 都会产生新对象，依赖对象就等于"每行日志重读一次 HTML"。
  const entryPath = def?.entry ?? "";
  const entryId = entry?.id ?? "";
  useEffect(() => {
    if (!entryId || !entryPath) return;
    let alive = true;
    setErr("");
    readInExt(extId, entryPath)
      .then((t) => {
        if (alive) setHtml(t);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [extId, entryPath, entryId]);

  /** 往 iframe 回一条消息。iframe 是不透明源，目标源只能是 `*`。 */
  function post(out: BridgeOut): void {
    const w = frame.current?.contentWindow;
    if (!w) return;
    try {
      w.postMessage({ ...out, [PANEL_MSG_KEY]: PANEL_PROTOCOL }, "*");
    } catch {
      /* iframe 已经没了 */
    }
  }

  // 桥：iframe → 宿主
  useEffect(() => {
    if (!html) return;

    const onMessage = (ev: MessageEvent) => {
      // 只认这一个 iframe 说的话。不校验 origin：不透明源的父窗口源是 "null"，没得比。
      const self = frame.current;
      if (!self || ev.source !== self.contentWindow) return;
      const m = parseBridgeMessage(ev.data);
      if (!m || m.kind === "ready") return;

      void (async () => {
        try {
          if (m.kind === "req") {
            // 前缀在宿主这边拼：插件里注册的是 `ctx.panels.register(panelId, { method })`
            const data = await callExt(extId, `panel.${panelId}.${m.method}`, m.args);
            if (mounted.current) post(resOk(m.reqId, data));
            return;
          }
          if (m.kind === "host") {
            if (m.op === "workspace") {
              if (mounted.current) post(resOk(m.reqId, getSnapshot().workspaceRoot));
              return;
            }
            // pickFolder：**对话框由宿主弹**，插件拿不到"静默选目录"的能力——
            // 那正是这个 API 存在的意义（选目录必须是用户做的动作，不是插件做的）。
            const picked = await open({ directory: true, multiple: false });
            if (mounted.current) post(resOk(m.reqId, typeof picked === "string" ? picked : null));
            return;
          }
          if (m.op === "readText") {
            const text = await readInExt(extId, m.path);
            if (mounted.current) post(resOk(m.reqId, text));
            return;
          }
          if (m.op === "list") {
            const items = await listInExt(extId, m.path);
            if (mounted.current) post(resOk(m.reqId, items));
            return;
          }
          await writeInExt(extId, m.path, m.content ?? "");
          if (mounted.current) post(resOk(m.reqId, null));
        } catch (e) {
          if (mounted.current) post(resErr(m.reqId, errCode(e), errText(e)));
        }
      })();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html, extId, panelId]);

  // 桥：插件 emit → iframe
  useEffect(() => {
    return onPanelEvent((p) => {
      if (p.extId !== extId || p.panelId !== panelId) return;
      post(eventMsg(p.event, p.payload));
      // post 只读 ref，不需要进依赖（规则也这么认，所以这里没有 disable 注释）
    });
  }, [extId, panelId]);

  const label = phaseLabel(phase ?? "idle");

  if (!entry || !def) {
    return (
      <div style={{ padding: "var(--sp-4)", color: "var(--text-dim)", lineHeight: "var(--lh-read)" }}>
        {tx(
          "这个面板所属的插件已经不在了（可能被卸载了）。关闭这个页签即可。",
          "The extension that owns this panel is gone (probably uninstalled). You can close this tab.",
        )}
        <div style={{ marginTop: "var(--sp-1)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
          {extId}:{panelId}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "0 var(--sp-3)",
          height: "var(--ctl-h-2)",
          flex: "0 0 auto",
          borderBottom: "1px solid var(--border)",
          fontSize: "var(--fs-xs)",
          color: "var(--text-dim)",
        }}
      >
        <span style={{ color: "var(--text)" }}>{def.title}</span>
        <span
          style={{
            color: phase === "failed" ? "var(--danger)" : phase === "running" ? "var(--ok)" : "var(--text-faint)",
          }}
        >
          {tx(label.zh, label.en)}
        </span>
        <div style={{ flex: "1 1 auto" }} />
        {err ? <span style={{ color: "var(--danger)" }}>{err}</span> : null}
        {entry.error ? <span style={{ color: "var(--danger)" }}>{entry.error}</span> : null}
      </div>
      <iframe
        ref={frame}
        title={`${entry.manifest.name} · ${def.title}`}
        // 只给脚本：不给 allow-same-origin ⇒ 不透明源（它碰不到宿主与别的插件）
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        referrerPolicy="no-referrer"
        srcDoc={html ? buildSrcdoc(html, { extId, panelId, title: def.title }) : ""}
        style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "none", background: "var(--bg)" }}
      />
    </div>
  );
}
