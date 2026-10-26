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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import {
  callExt,
  ensureLoaded,
  ensureRunning,
  getEntry,
  getSnapshot,
  listInExt,
  onPanelEvent,
  readInExt,
  start,
  subscribe,
  touch,
  writeInExt,
} from "./pluginEngine";
import { canStart, phaseLabel } from "./runtime";
import { rootSpecDeclared, rootSpecWrites } from "./manifest";
import { panelEnabled } from "./repo";
import { clearRootBindsOf, requestRootBind } from "./rootRequests";
import { readHostTheme } from "./iframeTheme";
import { subscribeStyleApply } from "../../../styles/themeFacts";
import { toast } from "../../../shared/toast";
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

export function PluginViewPanel(props: {
  params?: { pluginId?: string; panelId?: string; kind?: "panel" | "widget" };
  /** 小部件：只要 iframe，不要面板头。 */
  bare?: boolean;
}) {
  useLocale();
  const pluginId = props.params?.pluginId ?? "";
  const panelId = props.params?.panelId ?? "";
  const repo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const entry = repo.entries.find((e) => e.id === pluginId);
  const kind = props.params?.kind ?? "panel";
  const def =
    kind === "widget"
      ? entry?.manifest.contributes.widgets?.find((w) => w.id === panelId)
      : entry?.manifest.contributes.panels?.find((p) => p.id === panelId);

  const [html, setHtml] = useState("");
  const [err, setErr] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);

  /** 把宿主当前主题送进 iframe：初始在 srcdoc 里，之后换主题/切预览时走这一条。 */
  const postTheme = useCallback(() => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    try {
      w.postMessage({ ...eventMsg("theme", readHostTheme()), [PANEL_MSG_KEY]: PANEL_PROTOCOL }, "*");
    } catch {
      /* iframe 已经没了 */
    }
  }, []);

  useEffect(() => {
    postTheme();
    return subscribeStyleApply(postTheme);
  }, [postTheme]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 面板没了，它挂起来的待确认绑定也该没：留着一张没有来源的确认条，
      // 用户会问"这条是谁要的"——而那个面板已经被关掉了。
      clearRootBindsOf(pluginId);
    };
  }, [pluginId]);

  useEffect(() => {
    void ensureLoaded();
  }, []);

  /**
   * 插件在跑，面板才有意义：没跑就拉起来。
   *
   * 两条例外，都是真机上炸出来的：
   * 1. **没有 main 的插件不起进程**——主题/小部件插件只有界面，宿主进程里没有它的代码。
   *    以前照样 start()，`hostPlan` 抛「这个插件没有 main」，phase 落到 failed，
   *    而下面这个 effect 依赖 phase ⇒ failed 又满足 canStart ⇒ 再 start ⇒ 再失败……
   *    500 行错误、四条 toast 一起刷屏，就是这么来的。
   * 2. **同一个版本只自动拉一次**：失败一次之后不再自动重试（重试是用户的动作，
   *    不是 effect 的副作用）。否则任何"起不来"的原因都会变成死循环。
   */
  const phase = entry?.phase;
  const startTried = useRef("");
  useEffect(() => {
    if (!entry) return;
    if (!entry.manifest.main) return;
    const key = `${entry.id}@${entry.version}`;
    if (startTried.current === key) return;
    if (!canStart(entry.phase)) return;
    startTried.current = key;
    void start(entry.id);
  }, [entry, entry?.phase]);

  // 开着就续租：见文件头第 2 条
  useEffect(() => {
    if (!entry) return;
    const t = window.setInterval(() => void touch(pluginId), TOUCH_EVERY_MS);
    void touch(pluginId);
    return () => window.clearInterval(t);
  }, [pluginId, entry]);

  // 读入口 HTML。依赖用 **id 字符串**而不是 entry 对象：store 每次 patch（每来一行日志）
  // 都会产生新对象，依赖对象就等于"每行日志重读一次 HTML"。
  const entryPath = def?.entry ?? "";
  const entryId = entry?.id ?? "";
  useEffect(() => {
    if (!entryId || !entryPath) return;
    let alive = true;
    setErr("");
    readInExt(pluginId, entryPath)
      .then((t) => {
        if (alive) setHtml(t);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [pluginId, entryPath, entryId]);

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
      if (!m) return;
      if (m.kind === "ready") {
        postTheme();
        return;
      }

      void (async () => {
        try {
          if (m.kind === "req") {
            // 面板一打开就在发第一句请求，那时宿主可能还在 spawn/握手（启用不等于"进程已就绪"）。
            // 先等它就绪再调：否则面板收到的是一句"插件还没在运行"，而它只在启动时读一次状态，
            // 用户看到的就是"启用了却用不了，得回插件详情再按一次启动"。判据没放松——
            // `ensureRunning` 走的就是 `start()` 那套（启用 + 批准 + 超时），错误照实回来。
            await ensureRunning(pluginId);
            // 前缀在宿主这边拼：插件里注册的是 `ctx.panels.register(panelId, { method })`
            const data = await callExt(pluginId, `panel.${panelId}.${m.method}`, m.args);
            if (mounted.current) post(resOk(m.reqId, data));
            return;
          }
          if (m.kind === "host") {
            if (m.op === "workspace") {
              if (mounted.current) post(resOk(m.reqId, getSnapshot().workspaceRoot));
              return;
            }
            if (m.op === "bindRoot") {
              // R7③：插件面板里的「选工作区 / 选目录」。三道闸，一道都不能少：
              //  ① 这条变量得在**清单里申请过**——绑定表是进程写笼子的来源，
              //     让插件想绑什么绑什么，等于给它开了第二个授权通道（清单才是给用户批的那份）；
              //  ② 插件得已启用且已批准；
              //  ③ 目录由**用户在系统对话框里**选，选完还要在宿主这边（设置 → 插件管理）再认一次才落登记表。
              const spec = m.spec ?? "";
              const cur = getEntry(pluginId);
              if (!cur) throw new Error(`没有这个插件：${pluginId}`);
              if (!rootSpecDeclared(cur.manifest, spec)) {
                throw new Error(`这个插件的清单里没有申请过 ${spec}：目录绑定不是第二个授权通道`);
              }
              if (!panelEnabled(cur)) {
                throw new Error("这个插件还没启用或权限没批准：先让它进入可用状态");
              }
              const wanted = await open({
                directory: true,
                multiple: false,
                title: tx(`为 ${spec} 选一个目录（选完还要在 设置 → 插件管理 里确认）`, `Pick a folder for ${spec} (then confirm it in Settings → Plugins)`),
              });
              if (typeof wanted !== "string" || !wanted) {
                // 用户关了对话框，没选：这不是拒绝，是"什么都没发生"
                if (mounted.current) post(resOk(m.reqId, null));
                return;
              }
              requestRootBind({
                pluginId,
                pluginName: cur.manifest.name,
                spec,
                path: wanted,
                forWrite: rootSpecWrites(cur.manifest, spec),
                at: Date.now(),
              });
              // 回一句"待确认"，别让插件的 Promise 悬着。**点头那一下不在这里**：
              // 确认条只长在 设置 → 插件管理 的「目录绑定」里（PluginRootsFold）。
              // 被授权的一方不能自己弹"您同意授权吗"，那条必须待在宿主的 DOM 里，也只能有一处。
              if (mounted.current) post(resOk(m.reqId, { pending: true, spec, path: wanted }));
              toast(
                tx(`已选 ${spec} → ${wanted}：请在 设置 → 插件管理 的「目录绑定」里确认这条绑定`, `Picked ${spec} → ${wanted}: confirm it under Settings → Plugins, Folder bindings`),
              );
              return;
            }
            // pickFolder：**对话框由宿主弹**，插件拿不到"静默选目录"的能力——
            // 那正是这个 API 存在的意义（选目录必须是用户做的动作，不是插件做的）。
            const picked = await open({ directory: true, multiple: false });
            if (mounted.current) post(resOk(m.reqId, typeof picked === "string" ? picked : null));
            return;
          }
          if (m.op === "readText") {
            const text = await readInExt(pluginId, m.path);
            if (mounted.current) post(resOk(m.reqId, text));
            return;
          }
          if (m.op === "list") {
            const items = await listInExt(pluginId, m.path);
            if (mounted.current) post(resOk(m.reqId, items));
            return;
          }
          await writeInExt(pluginId, m.path, m.content ?? "");
          if (mounted.current) post(resOk(m.reqId, null));
        } catch (e) {
          if (mounted.current) post(resErr(m.reqId, errCode(e), errText(e)));
        }
      })();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html, pluginId, panelId, postTheme]);

  // 桥：插件 emit → iframe
  useEffect(() => {
    return onPanelEvent((p) => {
      if (p.pluginId !== pluginId || p.panelId !== panelId) return;
      post(eventMsg(p.event, p.payload));
      // post 只读 ref，不需要进依赖（规则也这么认，所以这里没有 disable 注释）
    });
  }, [pluginId, panelId]);

  const label = phaseLabel(phase ?? "idle");

  if (props.bare && entry && def) {
    return (
      <iframe
        ref={frame}
        title={`${entry.manifest.name} · ${def.title}`}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        referrerPolicy="no-referrer"
        srcDoc={html ? buildSrcdoc(html, { pluginId, panelId, title: def.title, theme: readHostTheme(), paintPage: false }) : ""}
        onLoad={postTheme}
        style={{ width: "100%", height: "100%", border: "none", background: "transparent", display: "block" }}
      />
    );
  }

  if (!entry || !def) {
    return (
      <div style={{ padding: "var(--sp-4)", color: "var(--text-dim)", lineHeight: "var(--lh-read)" }}>
        {tx(
          "这个面板所属的插件已经不在了（可能被卸载了）。关闭这个页签即可。",
          "The extension that owns this panel is gone (probably uninstalled). You can close this tab.",
        )}
        <div style={{ marginTop: "var(--sp-1)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
          {pluginId}:{panelId}
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
        srcDoc={html ? buildSrcdoc(html, { pluginId, panelId, title: def.title, theme: readHostTheme() }) : ""}
        onLoad={postTheme}
        style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "none", background: "var(--bg)" }}
      />
    </div>
  );
}
