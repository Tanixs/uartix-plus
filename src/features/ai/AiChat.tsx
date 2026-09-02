import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { useSettings } from "../settings/settingsStore";
import * as chatStore from "./chatStore";
import * as templateStore from "../protocol/templateStore";
import { collectContext, type ContextSelection } from "./contextCollector";
import type { AiScene } from "./prompts";
import { invokeOpenSettings, invokePop } from "./aiBus";
import {
  writeTemplateFromAiJson,
  writeCommandFromAiJson,
  writeCardFromAiJson,
} from "./aiActions";
import { addWidget, removeWidget, setOpen, useWidgets } from "./widgetStore";
import { applyAiTheme } from "./aiTheme";
import { resolveVars } from "../controls/variableStore";
import * as serialStore from "../serial/serialStore";
import { detectAnomalies, anomaliesToText, type Anomaly } from "./anomaly";
import { Markdown, CodeBlock, parseSegments } from "./markdown";
import { EmptyState } from "../../shared/EmptyState";
import {
  IconSend,
  IconStop,
  IconSparkle,
  IconTrash,
  IconChevron,
  IconDock,
  IconUpload,
  IconPop,
  IconPuzzle,
} from "../../shared/icons";

const BUG_ENDPOINT = "https://larix.teuioe.cn/api/bugreport.php";

const SCENE_HINT: Partial<Record<AiScene, string>> = {
  genCommand: "生成指令：描述你要发送的指令，如「把 roll 归零并每 100ms 上报一次」",
  genCard: "生成卡片：描述你要的控制卡片，如「一个控制电机转速的滑条，0-100」",
  diagnose: "诊断问题：描述你遇到的问题，如「收不到数据」",
};

const CONTEXT_LABELS: Record<keyof ContextSelection, string> = {
  conn: "连接配置",
  protocol: "协议摘要",
  samples: "数据样本",
  hex: "Hex 选区",
};

function ResultLine({ result }: { result: { ok: boolean; msg: string } }) {
  return <span className={result.ok ? "ai-tpl-ok" : "ai-tpl-err"}>{result.msg}</span>;
}

function TemplateWriteBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">候选协议模板</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          onClick={() => setResult(writeTemplateFromAiJson(code))}
        >
          写入协议模板
        </button>
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

function hasFormatPlaceholder(tpl: string): boolean {
  return /%\d*\.?\d*[dfsxXeEgG]/.test(tpl);
}

function CommandWriteBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(code) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const template = parsed && typeof parsed.template === "string" ? parsed.template : "";
  const script = parsed && typeof parsed.script === "string" ? parsed.script : "";
  const resolved = template ? resolveVars(template) : "";
  const directOk =
    template.length > 0 && !hasFormatPlaceholder(template) && !script;
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">生成的命令</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      {resolved && (
        <div className="ai-tpl-preview">
          预览发送内容：<code>{resolved}</code>
          {hasFormatPlaceholder(template) && (
            <span className="ai-tpl-note">
              （含 %d/%.2f 占位符，需在命令库/控制画布中配合输入值发送）
            </span>
          )}
        </div>
      )}
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCommandFromAiJson(code))}>
          加入命令库
        </button>
        <button
          className="btn"
          disabled={!directOk}
          title={
            directOk
              ? "不经命令库直接发送一次"
              : "模板含格式化占位符或脚本，需在命令库/控制画布中配合输入值发送"
          }
          onClick={() => {
            if (!directOk || !parsed) return;
            void serialStore.sendData(parsed.sendMode === "hex" ? "hex" : "ascii", template);
            setResult({ ok: true, msg: "已临时发送" });
          }}
        >
          临时发送
        </button>
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

function CardWriteBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">生成的控制卡片</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCardFromAiJson(code))}>
          写入控制画布
        </button>
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

function widgetName(code: string): string {
  const t = code.match(/<title>([^<]{1,40})<\/title>/i);
  if (t) return t[1].trim();
  const c = code.match(/(?:^|\n)\s*(?:<!--|\/\/|\/\*)\s*([^\n*\/]{2,40})/);
  if (c) return c[1].trim();
  return "AI 小部件";
}

function WidgetInstallBlock({ code }: { code: string }) {
  const settings = useSettings();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const name = widgetName(code);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">自定义小部件 · {name}</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          disabled={!settings.aiCreativity}
          title={
            settings.aiCreativity
              ? "安装到沙箱运行（安装后自动打开浮窗，可弹出为桌面挂件）"
              : "请先到 设置 → AI 服务 开启创造模式"
          }
          onClick={() => {
            addWidget(name, code);
            setResult({ ok: true, msg: "已安装并打开浮窗；可在挂件管理中弹出为桌面挂件" });
          }}
        >
          安装小部件
        </button>
        {!settings.aiCreativity && (
          <button className="btn" onClick={invokeOpenSettings}>
            去开启创造模式
          </button>
        )}
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

function ThemeApplyBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">自定义主题</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          onClick={() => {
            try {
              const vars = JSON.parse(code) as Record<string, string>;
              const ok = applyAiTheme(vars);
              setResult(
                ok
                  ? { ok: true, msg: "主题已即时应用；清除请到 设置 → AI 服务 → 重置 AI 创造内容" }
                  : { ok: false, msg: "主题变量不合法（需以 -- 开头且值无特殊字符）" },
              );
            } catch {
              setResult({ ok: false, msg: "JSON 解析失败" });
            }
          }}
        >
          应用主题
        </button>
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

function MessageBody({ content, scene }: { content: string; scene?: AiScene }) {
  const [saved, setSaved] = useState<string>("");
  const segs = parseSegments(content);
  const saveReport = async () => {
    const path = await save({
      title: "保存调试报告",
      defaultPath: `uartix-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content });
      setSaved("已保存");
    } catch (e) {
      setSaved(`保存失败：${e}`);
    }
    window.setTimeout(() => setSaved(""), 2600);
  };
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "code" ? (
          s.lang === "uartix-template" ? (
            <TemplateWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-command" ? (
            <CommandWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-card" ? (
            <CardWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-widget" ? (
            <WidgetInstallBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-theme" ? (
            <ThemeApplyBlock key={i} code={s.code ?? ""} />
          ) : (
            <CodeBlock key={i} lang={s.lang} code={s.code ?? ""} />
          )
        ) : (
          <Markdown key={i} text={s.text ?? ""} />
        ),
      )}
      {scene === "report" && (
        <div className="ai-tpl-actions" style={{ marginTop: 6 }}>
          <button className="btn" onClick={() => void saveReport()}>
            保存为 Markdown
          </button>
          {saved && <span className="ai-tpl-ok">{saved}</span>}
        </div>
      )}
    </>
  );
}

export function AiChat({ onDock }: { onDock?: () => void }) {
  const settings = useSettings();
  const chat = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  const proto = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AiScene>("qa");
  const [notice, setNotice] = useState("");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [anoms, setAnoms] = useState<Anomaly[]>([]);
  const [anomOpen, setAnomOpen] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [wmgrOpen, setWmgrOpen] = useState(false);
  const ws = useWidgets();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const configured =
    settings.aiPreset === "ollama" || settings.aiApiKey.trim().length > 0;

  useEffect(() => {
    void chatStore.init();
  }, []);

  useEffect(() => {
    const scan = () => setAnoms(detectAnomalies());
    scan();
    const t = window.setInterval(scan, 5000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const p = chat.pendingScene;
    if (!p) return;
    chatStore.consumeScene();
    void chatStore.runScene(p.scene, p.payload);
  }, [chat.pendingScene]);

  useEffect(() => {
    if (!notice && !uploadState) return;
    const t = window.setTimeout(() => {
      setNotice("");
      setUploadState("");
    }, 3000);
    return () => window.clearTimeout(t);
  }, [notice, uploadState]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, ctxOpen]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const doSend = () => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    const scene = mode;
    setMode("qa");
    setInput("");
    stickRef.current = true;
    void chatStore.sendText(text, scene);
  };

  const runScene = (scene: AiScene, payload?: Record<string, unknown>) => {
    if (chat.streaming) return;
    stickRef.current = true;
    void chatStore.runScene(scene, payload);
  };

  const quickPick = (scene: AiScene) => {
    if (!configured) return;
    if (scene === "protocol") {
      if (!proto.hexSelection || proto.hexSelection.bytes.length === 0) {
        setNotice("请先在 Hex 数据流中框选一段字节，再点「识别协议」");
        return;
      }
      const h = proto.hexSelection;
      runScene("protocol", { hex: h.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ") });
      return;
    }
    if (scene === "genCommand" || scene === "genCard" || scene === "diagnose") {
      setMode(scene);
      inputRef.current?.focus();
      return;
    }
    runScene(scene);
  };

  const uploadPatrol = async () => {
    const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
    if (!last || !last.content.includes("巡检发现")) {
      setUploadState("最近回复中没有巡检发现");
      return;
    }
    let ver = "";
    try {
      ver = await getVersion();
    } catch {
      ver = "";
    }
    try {
      const resp = await invoke<string>("ai_upload_report", {
        endpoint: BUG_ENDPOINT,
        proxy: settings.aiProxy,
        noProxy: settings.aiNoProxy,
        body: JSON.stringify({
          app: "uartix-plus",
          version: ver,
          ts: Date.now(),
          report: last.content.slice(-8000),
        }),
      });
      setUploadState(resp.includes("OK") ? "已上报，感谢反馈" : `服务器响应：${resp.slice(0, 80)}`);
    } catch (e) {
      setUploadState(`上报失败：${String(e).slice(0, 100)}`);
    }
  };

  const lastHasPatrol = [...chat.messages]
    .reverse()
    .find((m) => m.role === "assistant")
    ?.content.includes("巡检发现");

  const ctxBlocks = collectContext(chat.contextSel);

  if (!configured) {
    return (
      <div className="ai-chat">
        <div className="ai-empty-wrap">
          <EmptyState
            title="AI 助手尚未配置"
            hint={[
              "打开 设置 → AI 服务，选择服务商预设并填入 API Key",
              "支持 OpenAI 兼容 / DeepSeek / 通义千问 / 本地 Ollama",
              "Key 仅保存在本机，请求经本机程序转发，不经过第三方",
            ]}
          />
          <button className="btn primary" onClick={invokeOpenSettings}>
            打开设置
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-chat">
      <div className="ai-toolbar">
        <button
          className="ai-scene-btn"
          title="框选 Hex 字节后点击，AI 推断帧结构并生成模板"
          onClick={() => quickPick("protocol")}
        >
          识别协议
        </button>
        <button
          className="ai-scene-btn"
          title="根据最近帧数据概括设备状态与异常"
          onClick={() => quickPick("interpret")}
        >
          解读数据
        </button>
        <button
          className="ai-scene-btn"
          title="分析当前 2D 曲线各通道的统计特征与周期"
          onClick={() => quickPick("analyzeCurve")}
        >
          分析曲线
        </button>
        <button
          className="ai-scene-btn"
          title="描述需求，AI 生成命令模板或脚本"
          onClick={() => quickPick("genCommand")}
        >
          生成指令
        </button>
        <button
          className="ai-scene-btn"
          title="描述需求，AI 生成控制卡片并写入控制画布"
          onClick={() => quickPick("genCard")}
        >
          生成卡片
        </button>
        <button
          className="ai-scene-btn"
          title="描述问题，结合连接状态给出排查清单"
          onClick={() => quickPick("diagnose")}
        >
          诊断
        </button>
        <button
          className="ai-scene-btn"
          title="汇总本次会话生成 Markdown 调试报告"
          onClick={() => quickPick("report")}
        >
          调试报告
        </button>
        <div className="ai-toolbar-spacer" />
        <button
          className={`ai-icon-btn${ws.widgets.length ? " ai-patrol" : ""}`}
          title={settings.aiCreativity ? "已安装挂件管理" : "挂件管理（开启创造模式后可用）"}
          onClick={() => setWmgrOpen((v) => !v)}
        >
          <IconPuzzle />
        </button>
        {onDock ? (
          <button className="ai-icon-btn" title="停靠为面板：转为常规可停靠面板，适合大屏双栏" onClick={onDock}>
            <IconDock />
          </button>
        ) : (
          <button className="ai-icon-btn" title="弹出为浮窗（Ctrl+K 也可开关）" onClick={invokePop}>
            <IconPop />
          </button>
        )}
        <button
          className={`ai-icon-btn${lastHasPatrol ? " ai-patrol" : ""}`}
          title={lastHasPatrol ? "将最近回复中的「巡检发现」匿名上报，帮助改进软件" : "最近回复中没有巡检发现"}
          disabled={!lastHasPatrol}
          onClick={() => void uploadPatrol()}
        >
          <IconUpload />
        </button>
        <button className="ai-icon-btn" title="清空对话" onClick={() => chatStore.clearChat()}>
          <IconTrash />
        </button>
      </div>

      {anoms.length > 0 && (
        <div className="ai-anom">
          <button className="ai-anom-bar" onClick={() => setAnomOpen((v) => !v)}>
            <span className="ai-anom-dot" />
            发现 {anoms.length} 项异常
            <span className="ai-anom-chev">
              <IconChevron dir={anomOpen ? "down" : "right"} size={11} />
            </span>
          </button>
          {anomOpen && (
            <div className="ai-anom-list">
              {anoms.map((a) => (
                <div key={a.key} className="ai-anom-item">
                  <div className="ai-anom-title">{a.title}</div>
                  <div className="ai-anom-detail">{a.detail}</div>
                </div>
              ))}
              <button
                className="btn"
                disabled={chat.streaming}
                onClick={() =>
                  runScene("diagnose", {
                    text: `数据巡检发现以下异常，请结合当前连接与协议状态给出排查建议：\n${anomaliesToText(anoms)}`,
                  })
                }
              >
                让 AI 排查
              </button>
            </div>
          )}
        </div>
      )}

      {wmgrOpen && (
        <div className="ai-wmgr">
          <div className="ai-wmgr-head">
            已安装挂件（{ws.widgets.length}）
            <span className="ai-wmgr-cred">
              创造模式：{settings.aiCreativity ? "开" : "关"}
              {settings.aiCreativity && settings.aiWidgetSend ? " · 可发数据" : ""}
            </span>
            <button className="ai-mode-close" onClick={() => setWmgrOpen(false)}>
              收起
            </button>
          </div>
          {ws.widgets.length === 0 ? (
            <div className="ai-ctx-empty">
              暂无挂件。开启创造模式（设置 → AI 服务）后，让 AI 输出 uartix-widget 代码块即可安装；主题用 uartix-theme。
            </div>
          ) : (
            ws.widgets.map((w) => (
              <div key={w.id} className="ai-widget-row">
                <span className="ai-widget-name">{w.name}</span>
                <button className="btn" onClick={() => setOpen(w.id, !ws.openIds.includes(w.id))}>
                  {ws.openIds.includes(w.id) ? "收起" : "打开"}
                </button>
                <button
                  className="btn"
                  title="弹出为桌面置顶挂件"
                  onClick={async () => {
                    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                    setOpen(w.id, false);
                    new WebviewWindow(`aiwidget-${w.id.slice(0, 8)}`, {
                      url: `${location.origin}${location.pathname}#/aiwidget-desktop/${w.id}`,
                      title: w.name,
                      width: 280,
                      height: 240,
                      alwaysOnTop: true,
                      decorations: false,
                    });
                  }}
                >
                  桌面
                </button>
                <button className="btn" onClick={() => removeWidget(w.id)}>
                  删除
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="ai-msgs" ref={scrollRef} onScroll={onScroll}>
        {chat.messages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-title">
              <IconSparkle />
              AI 调试助手
            </div>
            <div className="ai-welcome-desc">
              框选 Hex 字节右键「AI 识别协议」；或用上方快捷按钮解读数据、分析曲线、生成指令、诊断问题。发送前可勾选随消息附带的软件内上下文。
            </div>
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-msg-bubble">
              {m.role === "user" ? (
                <div className="ai-msg-text">{m.content}</div>
              ) : (
                <>
                  {m.reasoning && (
                    <details className="ai-reasoning">
                      <summary>思考过程</summary>
                      <div className="ai-reasoning-body">{m.reasoning}</div>
                    </details>
                  )}
                  <MessageBody content={m.content} scene={m.scene} />
                  {m.aborted && <div className="ai-aborted">已停止生成</div>}
                  {m.error && <div className="ai-error">{m.error}</div>}
                </>
              )}
            </div>
            {m.role === "assistant" && m.contextTitles && m.contextTitles.length > 0 && (
              <div className="ai-msg-ctx">附加上下文：{m.contextTitles.join(" · ")}</div>
            )}
          </div>
        ))}
        {chat.streaming && (
          <div className="ai-msg assistant">
            <div className="ai-msg-bubble ai-streaming">
              <span className="ai-caret" />
            </div>
          </div>
        )}
      </div>

      {notice && <div className="ai-notice">{notice}</div>}
      {uploadState && <div className="ai-notice">{uploadState}</div>}

      <div className="ai-input-wrap">
        <div className="ai-ctx-bar">
          <button className="ai-ctx-toggle" onClick={() => setCtxOpen((v) => !v)}>
            <IconChevron dir={ctxOpen ? "down" : "right"} size={11} />
            本次发送的上下文（{ctxBlocks.length} 项）
          </button>
          {(Object.keys(CONTEXT_LABELS) as (keyof ContextSelection)[]).map((k) => (
            <label key={k} className="ai-ctx-check" title={`随下一条消息附带${CONTEXT_LABELS[k]}`}>
              <input
                type="checkbox"
                checked={chat.contextSel[k]}
                onChange={(e) =>
                  chatStore.setContextSel({ ...chat.contextSel, [k]: e.target.checked })
                }
              />
              {CONTEXT_LABELS[k]}
            </label>
          ))}
        </div>
        {ctxOpen && (
          <div className="ai-ctx-preview">
            {ctxBlocks.length === 0 ? (
              <div className="ai-ctx-empty">未勾选任何上下文项</div>
            ) : (
              ctxBlocks.map((b) => (
                <div key={b.key} className="ai-ctx-block">
                  <div className="ai-ctx-block-title">{b.title}</div>
                  <pre>{b.text}</pre>
                </div>
              ))
            )}
          </div>
        )}
        {SCENE_HINT[mode] && (
          <div className="ai-mode-chip">
            {SCENE_HINT[mode]}
            <button className="ai-mode-close" onClick={() => setMode("qa")}>
              取消
            </button>
          </div>
        )}
        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={
              chat.streaming
                ? "AI 正在回复…"
                : "输入问题，Enter 发送，Shift+Enter 换行"
            }
            rows={1}
            value={input}
            disabled={chat.streaming}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
          />
          {chat.streaming ? (
            <button className="ai-send stop" title="停止生成" onClick={() => chatStore.abort()}>
              <IconStop />
            </button>
          ) : (
            <button
              className="ai-send"
              title="发送（Enter）"
              disabled={!input.trim()}
              onClick={doSend}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
