/**
 * P174-R12：**草稿预览**——转正之前先看一眼。
 *
 * 用户的原话："生成的内容必须要转正看一下，那有什么意义？" 这句是对的：
 * 草稿态的本意是"先看再决定"，而以前的草稿只能看到一堆文件名与权限清单，
 * 要看到长什么样就必须先转正、再过批准卡——顺序反了。
 *
 * 所以这一面把**看**和**给**分开：
 *  - 面板 / 小部件的 HTML 直接塞进与正式面板**同一个沙箱**（不透明源 iframe、同一份桥），
 *    差别只有一条：**不启动主进程**。`uartix.call` 会得到一句"预览里没有主进程"，而不是真的去跑；
 *    包内文件只读、且只能读这份草稿自己的目录；
 *  - 主题只做**配色/圆角速览**（把 theme.css 里的变量摊成色块），不改当前界面。
 *    真要整体看效果，用 AI 的 `theme_preview`（会话内借用，到期自动还原）。
 *
 * 三条底线，和"安装"那一侧完全一样，一条都没松：
 *  ① 不写账本、不进信任库、不进「+面板」；
 *  ② 不执行草稿里的任何代码（`main.mjs` 不跑）；
 *  ③ 沙箱与正式面板同一套（没有 same-origin、没有外链、没有宿主 DOM）。
 * 换句话说：**预览看到的是"界面长什么样"，不是"它拿到了什么权限"。**
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import { buildSrcdoc, PANEL_MSG_KEY, PANEL_PROTOCOL, parseBridgeMessage, resErr, resOk } from "./panelBridge";
import { draftPreviewTarget, readDraftFile, type DraftEntry } from "./draft";
import { getSnapshot } from "./pluginEngine";
import { varsFromThemeCss } from "./themeVars";

const COLORISH = /^(#|rgb|hsl|color-mix|oklch|lab\()/i;

export function DraftPreviewDialog(props: { appDir: string; name: string; entry: DraftEntry; onClose: () => void }) {
  useLocale();
  const target = useMemo(() => draftPreviewTarget(props.entry), [props.entry]);
  const [html, setHtml] = useState("");
  const [css, setCss] = useState("");
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
    if (!target) return;
    let alive = true;
    setErr("");
    readDraftFile(props.appDir, props.name, target.entry)
      .then((text) => {
        if (!alive) return;
        if (target.kind === "theme") setCss(text);
        else setHtml(text);
      })
      .catch((e) => {
        if (alive) setErr(String((e as Error)?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [props.appDir, props.name, target]);

  // 桥：和正式面板同一份协议；差别只在"不启动主进程"
  useEffect(() => {
    if (!html || !target || target.kind === "theme") return;
    const onMessage = (ev: MessageEvent) => {
      const self = frame.current;
      if (!self || ev.source !== self.contentWindow) return;
      const m = parseBridgeMessage(ev.data);
      if (!m || m.kind === "ready") return;
      const post = (out: unknown): void => {
        try {
          self.contentWindow?.postMessage({ ...(out as object), [PANEL_MSG_KEY]: PANEL_PROTOCOL }, "*");
        } catch {
          /* 预览已经关掉 */
        }
      };
      void (async () => {
        try {
          if (m.kind === "req") {
            post(resErr(m.reqId, "unsupported", "预览里不启动主进程：转正并批准之后，这些方法才有结果"));
            return;
          }
          if (m.kind === "host") {
            if (m.op === "workspace") {
              post(resOk(m.reqId, getSnapshot().workspaceRoot));
              return;
            }
            if (m.op === "bindRoot") {
              post(resErr(m.reqId, "unsupported", "预览里不能登记目录绑定：转正之后在 设置 → 插件管理 里选"));
              return;
            }
            const picked = await open({ directory: true, multiple: false });
            post(resOk(m.reqId, typeof picked === "string" ? picked : null));
            return;
          }
          if (m.op === "readText") {
            post(resOk(m.reqId, await readDraftFile(props.appDir, props.name, m.path)));
            return;
          }
          if (m.op === "list") {
            post(resErr(m.reqId, "unsupported", "预览里暂不支持列目录"));
            return;
          }
          post(resErr(m.reqId, "unsupported", "预览是只读的：草稿写不了任何文件"));
        } catch (e) {
          post(resErr(m.reqId, "internal", String((e as Error)?.message ?? e)));
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html, target, props.appDir, props.name]);

  const vars = useMemo(() => (target?.kind === "theme" ? varsFromThemeCss(css) : {}), [target, css]);
  const swatches = Object.entries(vars).filter(([, v]) => COLORISH.test(String(v)));
  const others = Object.entries(vars).filter(([, v]) => !COLORISH.test(String(v)));

  const head = tx("草稿预览", "Draft preview");
  return (
    <div
      role="presentation"
      className="plg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="plg-dialog" role="dialog" aria-modal="true" aria-label={head} style={{ width: "min(860px, calc(92vw / var(--zoom)))", height: "min(640px, calc(86vh / var(--zoom)))", display: "flex", flexDirection: "column" }}>
        <div className="plg-head">
          <span className="plg-title">{head}</span>
          <span className="plg-sub">
            {props.entry.title} · {props.name}
            {target ? ` · ${target.kind === "theme" ? tx("主题", "theme") : target.kind === "widget" ? tx("小部件", "widget") : tx("面板", "panel")}「${target.title}」` : ""}
          </span>
          <div className="plg-head-actions">
            <button className="btn" onClick={props.onClose}>
              {tx("关闭", "Close")}
            </button>
          </div>
        </div>

        <div style={{ padding: "var(--sp-1) var(--sp-3)", fontSize: "var(--fs-xs)", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
          {tx(
            "预览不安装、不写账本、不运行主进程；画面用完即弃，转正并批准之后它才真正生效。",
            "Preview installs nothing, writes no ledger, and starts no host process. Promote and approve it to make it real.",
          )}
        </div>

        {err ? <div style={{ padding: "var(--sp-2) var(--sp-3)", color: "var(--danger)", fontSize: "var(--fs-sm)" }}>{err}</div> : null}

        {!target ? (
          <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)", fontSize: "var(--fs-sm)", lineHeight: "var(--lh-read)" }}>
            {tx("这份草稿没有可预览的界面（面板 / 小部件 / 主题）。预设与任务模板是配置，不是画面。", "This draft has nothing visual to preview (panel / widget / theme). Presets and task templates are configuration, not UI.")}
          </div>
        ) : target.kind === "theme" ? (
          <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "var(--sp-3)" }}>
            {swatches.length ? (
              <>
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginBottom: 6 }}>{tx("配色（来自 theme.css 的令牌）", "Palette (tokens from theme.css)")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "var(--sp-2)" }}>
                  {swatches.map(([k, v]) => (
                    <div key={k} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                      <div style={{ height: 44, background: String(v) }} />
                      <div style={{ padding: "3px 6px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${k}: ${v}`}>
                        {k}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>{tx("这份 CSS 里没有可展示的配色令牌。", "No colour tokens in this CSS.")}</div>
            )}
            {others.length ? (
              <>
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", margin: "var(--sp-3) 0 6px" }}>{tx("尺寸与动效", "Sizes & motion")}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
                  {others.slice(0, 40).map(([k, v]) => (
                    <span key={k} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "2px 6px" }}>
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            <div style={{ marginTop: "var(--sp-3)", fontSize: "var(--fs-xs)", color: "var(--text-faint)", lineHeight: "var(--lh-read)" }}>
              {tx("要看整套界面的效果，让 AI 用 theme_preview 借画面演几秒（到期自动还原），或转正后在 设置 → 外观 里选它。", "To see it on the whole UI, ask the AI for theme_preview (temporary), or promote it and pick it under Settings → Appearance.")}
            </div>
          </div>
        ) : (
          <iframe
            ref={frame}
            title={`${props.entry.title} · ${target.title}`}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            referrerPolicy="no-referrer"
            srcDoc={html ? buildSrcdoc(html, { pluginId: `draft:${props.entry.id}`, panelId: target.id, title: target.title }) : ""}
            style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "none", background: target.kind === "widget" ? "transparent" : "var(--bg)" }}
          />
        )}
      </div>
    </div>
  );
}
