import {
  Fragment,
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
import type { ChatMsg, ReasonRound } from "./chatStore";
import * as templateStore from "../protocol/templateStore";
import { collectContext, estimateTokens, type ContextSelection } from "./contextCollector";
import type { AiScene } from "./prompts";
import { invokeOpenSettings, invokePop } from "./aiBus";
import { openExtPanel } from "./extBus";
import {
  writeTemplateFromAiJson,
  writeCommandFromAiJson,
  writeCardFromAiJson,
  writeCodecFromAiJson,
} from "./aiActions";
import {
  addExt,
  setEnabled,
  setOpen,
  useExtensions,
  EXT_TYPE_LABEL,
  PERM_LABEL,
  permsForType,
  widgetChromeFromHtml,
  importAll,
  type ExtType,
} from "./extensionStore";
import { applyStyleExts, previewCss } from "./extRuntime";
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
  create: "创造扩展：描述你想要的主题/样式/小部件/面板/脚本，如「做一个电池电压仪表盘面板」",
  diagnose: "诊断问题：描述你遇到的问题，如「收不到数据」",
};

const CONTEXT_LABELS: Record<keyof ContextSelection, string> = {
  conn: "连接配置",
  protocol: "协议清单",
  protoFull: "协议完整定义",
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

/** uartix-codec：指令工厂自定义协议安装块 */
function CodecWriteBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">自定义协议（指令工厂）</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCodecFromAiJson(code))}>
          写入指令工厂
        </button>
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

/** uartix-action：动作执行块（一键执行软件操作） */
const DESTRUCTIVE_ACTIONS = new Set([
  "clearPage",
  "removeCard",
  "removeProtocol",
  "removeCommand",
  "removeCodec",
  "removeWidget",
]);

interface ActionItem {
  kind: string;
  args?: Record<string, unknown>;
}

function ActionBlock({ code }: { code: string }) {
  let actions: ActionItem[] | null = null;
  let parseErr = "";
  try {
    const obj = JSON.parse(code) as { actions?: unknown } | unknown[];
    const list = Array.isArray(obj) ? obj : (obj.actions as unknown[]);
    if (Array.isArray(list)) {
      actions = list
        .filter((x): x is ActionItem => !!x && typeof x === "object" && typeof (x as ActionItem).kind === "string")
        .slice(0, 16);
    }
  } catch {
    parseErr = "JSON 解析失败";
  }
  const [results, setResults] = useState<(string | null)[]>([]);
  const [running, setRunning] = useState(false);
  const destructive = actions?.some((a) => DESTRUCTIVE_ACTIONS.has(a.kind)) ?? false;

  const runAll = async () => {
    if (!actions || running) return;
    setRunning(true);
    const { runAppAction } = await import("./appActions");
    const out: (string | null)[] = [];
    for (const a of actions) {
      try {
        const r = await runAppAction(a.kind, a.args ?? {}, { highPriv: true });
        out.push(r.ok ? String(r.data ?? "完成") : `失败：${r.err}`);
      } catch (e) {
        out.push(`失败：${String(e).slice(0, 100)}`);
      }
    }
    setResults(out);
    setRunning(false);
  };

  if (!actions || actions.length === 0) {
    return (
      <div className="ai-tpl-block">
        <div className="ai-tpl-head">动作执行</div>
        <div className="ai-tpl-err">{parseErr || "没有可执行的动作"}</div>
      </div>
    );
  }
  return (
    <div className={`ai-tpl-block${destructive ? " ai-action-danger" : ""}`}>
      <div className="ai-ext-head">
        <span>动作执行 · {actions.length} 步</span>
        {destructive && <span className="ai-ext-badge warn">含破坏性操作</span>}
      </div>
      <ul className="ai-action-list">
        {actions.map((a, i) => (
          <li key={i}>
            <code className={DESTRUCTIVE_ACTIONS.has(a.kind) ? "danger" : ""}>
              {a.kind}
            </code>
            <span className="ai-action-args">
              {a.args && Object.keys(a.args).length > 0 ? JSON.stringify(a.args) : ""}
            </span>
            {results[i] && (
              <span className={results[i]!.startsWith("失败") ? "ai-tpl-err" : "ai-tpl-ok"}>
                {results[i]}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="ai-tpl-actions">
        <button className="btn primary" disabled={running} onClick={() => void runAll()}>
          {running ? "执行中…" : "执行"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 扩展安装块 ---------------- */

function widgetName(code: string): string {
  const t = code.match(/<title>([^<]{1,40})<\/title>/i);
  if (t) return t[1].trim();
  const c = code.match(/(?:^|\n)\s*(?:<!--|\/\/|\/\*)\s*([^\n*\/]{2,40})/);
  if (c) return c[1].trim();
  return "AI 小部件";
}

function styleName(css: string): string {
  const m = css.match(/^\s*(?:\/\*+\s*([^\n*/]{2,40})\s*\*+\/|\/\/\s*([^\n]{2,40}))/);
  return (m?.[1] ?? m?.[2] ?? "AI 样式").trim();
}

function scriptName(code: string): string {
  const m = code.match(/^\s*\/\/\s*([^\n]{2,40})/);
  return (m?.[1] ?? "AI 脚本").trim();
}

function PermList({ type }: { type: ExtType }) {
  return (
    <ul className="ai-ext-perms">
      {permsForType(type).map((p) => (
        <li key={p}>{PERM_LABEL[p]}</li>
      ))}
    </ul>
  );
}

/** 沙箱小部件 / 自定义面板安装块（同格式 HTML） */
function ExtInstallBlock({ code, type }: { code: string; type: "widget" | "panel" }) {
  const settings = useSettings();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [installedId, setInstalledId] = useState<string>("");
  const name = widgetName(code);
  const chrome = type === "widget" ? widgetChromeFromHtml(code) : undefined;
  const disabled = !settings.aiCreativity;
  const typeLabel = type === "widget" ? "沙箱小部件" : "自定义面板";
  return (
    <div className="ai-tpl-block">
      <div className="ai-ext-head">
        <span>
          {typeLabel} · {name}
        </span>
        {chrome === "none" && <span className="ai-ext-badge bare">无边框形态</span>}
        <span className="ai-ext-badge">{EXT_TYPE_LABEL[type]}扩展</span>
      </div>
      <ul className="ai-ext-perms">
        {permsForType(type).map((p) => (
          <li key={p}>{PERM_LABEL[p]}</li>
        ))}
      </ul>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          disabled={disabled}
          title={
            disabled
              ? "请先到 设置 → AI 服务 开启创造模式"
              : type === "widget"
                ? "安装到沙箱运行（安装后自动打开浮窗，可弹出为桌面挂件）"
                : "安装后可在扩展管理中「加入工作区」"
          }
          onClick={() => {
            const id = addExt({ type, name, html: code, chrome });
            setInstalledId(id);
            if (type === "widget") setOpen(id, true);
            setResult({
              ok: true,
              msg:
                type === "widget"
                  ? chrome === "none"
                    ? "已安装并打开无边框浮窗：按住任意处拖动，右键唤出菜单，可弹出为独立桌面小窗"
                    : "已安装并打开浮窗；可在扩展管理中弹出为桌面挂件"
                  : "已安装；可在扩展管理中「加入工作区」",
            });
          }}
        >
          确认安装
        </button>
        {installedId && type === "panel" && (
          <button className="btn" onClick={() => openExtPanel(installedId)}>
            加入工作区
          </button>
        )}
        {disabled && (
          <button className="btn" onClick={() => invokeOpenSettings()}>
            去开启创造模式
          </button>
        )}
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

/** 主题包安装块：兼容旧版纯 vars 格式与新版 {name,desc,vars,css} */
function ThemeExtBlock({ code }: { code: string }) {
  const settings = useSettings();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  let parsed: { name?: string; desc?: string; vars?: Record<string, string>; css?: string } | null =
    null;
  let parseErr = "";
  try {
    const obj = JSON.parse(code) as Record<string, unknown>;
    const looksNew = "vars" in obj || "css" in obj || "name" in obj;
    if (looksNew) {
      parsed = {
        name: typeof obj.name === "string" ? obj.name : undefined,
        desc: typeof obj.desc === "string" ? obj.desc : undefined,
        vars:
          obj.vars && typeof obj.vars === "object"
            ? (obj.vars as Record<string, string>)
            : undefined,
        css: typeof obj.css === "string" ? obj.css : undefined,
      };
    } else {
      parsed = { vars: obj as Record<string, string> };
    }
  } catch {
    parseErr = "JSON 解析失败";
  }
  const disabled = !settings.aiCreativity;
  const name = parsed?.name ?? "AI 主题";
  return (
    <div className="ai-tpl-block">
      <div className="ai-ext-head">
        <span>主题包 · {name}</span>
        <span className="ai-ext-badge">主题扩展</span>
      </div>
      {parsed?.desc && <div className="ai-tpl-preview">{parsed.desc}</div>}
      <PermList type="theme" />
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          disabled={disabled || !parsed}
          title={disabled ? "请先到 设置 → AI 服务 开启创造模式" : "应用配色与整页样式（可在扩展管理停用）"}
          onClick={() => {
            if (!parsed?.vars && !parsed?.css) return;
            const id = addExt({
              type: "theme",
              name,
              desc: parsed.desc,
              vars: parsed.vars,
              css: parsed.css,
            });
            setEnabled(id, true);
            applyStyleExts();
            setResult({ ok: true, msg: "主题已启用并生效；可在扩展管理中停用或删除" });
          }}
        >
          确认安装
        </button>
        {disabled && (
          <button className="btn" onClick={() => invokeOpenSettings()}>
            去开启创造模式
          </button>
        )}
        {result && <ResultLine result={result} />}
        {!result && parseErr && <ResultLine result={{ ok: false, msg: parseErr }} />}
      </div>
    </div>
  );
}

/** 样式层安装块：纯 CSS，支持先预览再安装 */
function StyleExtBlock({ code }: { code: string }) {
  const settings = useSettings();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const name = styleName(code);
  const disabled = !settings.aiCreativity;
  useEffect(() => {
    return () => {
      if (previewing) previewCss(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="ai-tpl-block">
      <div className="ai-ext-head">
        <span>样式层 · {name}</span>
        <span className="ai-ext-badge">样式扩展</span>
      </div>
      <PermList type="style" />
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        {!previewing ? (
          <button
            className="btn"
            disabled={disabled}
            title="临时应用样式（不安装），不满意可撤销"
            onClick={() => {
              previewCss(code);
              setPreviewing(true);
            }}
          >
            预览
          </button>
        ) : (
          <>
            <button
              className="btn primary"
              onClick={() => {
                const id = addExt({ type: "style", name, css: code });
                setEnabled(id, true);
                previewCss(null);
                setPreviewing(false);
                applyStyleExts();
                setResult({ ok: true, msg: "样式已保留并生效" });
              }}
            >
              保留
            </button>
            <button
              className="btn"
              onClick={() => {
                previewCss(null);
                setPreviewing(false);
              }}
            >
              撤销预览
            </button>
          </>
        )}
        <button
          className="btn primary"
          disabled={disabled}
          title="直接安装并应用（可在扩展管理停用）"
          onClick={() => {
            const id = addExt({ type: "style", name, css: code });
            setEnabled(id, true);
            applyStyleExts();
            setResult({ ok: true, msg: "样式已安装并生效" });
          }}
        >
          确认安装
        </button>
        {disabled && (
          <button className="btn" onClick={() => invokeOpenSettings()}>
            去开启创造模式
          </button>
        )}
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

/** 行为脚本安装块：高权限，需双重确认 */
function ScriptExtBlock({ code }: { code: string }) {
  const settings = useSettings();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const name = scriptName(code);
  const off = !settings.aiCreativity;
  const needScriptPerm = settings.aiCreativity && !settings.aiScript;
  return (
    <div className="ai-tpl-block">
      <div className="ai-ext-head">
        <span>行为脚本 · {name}</span>
        <span className="ai-ext-badge warn">高权限</span>
      </div>
      <PermList type="script" />
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          disabled={off || needScriptPerm}
          title={
            off
              ? "请先到 设置 → AI 服务 开启创造模式"
              : needScriptPerm
                ? "请先到 设置 → AI 服务 → 创造模式 开启「允许行为脚本」"
                : "安装为停用状态，在扩展管理中启用时还需确认"
          }
          onClick={() => {
            if (
              !confirm(
                `安装脚本「${name}」？\n\n该脚本将在主界面执行 JS，可读取数据快照、发送数据（受全局发送权限限制）。\n安装后默认停用，启用时还会再次确认。`,
              )
            )
              return;
            addExt({ type: "script", name, code });
            setResult({ ok: true, msg: "脚本已安装（停用）；到扩展管理中启用" });
          }}
        >
          确认安装
        </button>
        {off && (
          <button className="btn" onClick={() => invokeOpenSettings()}>
            去开启创造模式
          </button>
        )}
        {needScriptPerm && (
          <button className="btn" onClick={() => invokeOpenSettings()}>
            去开启脚本权限
          </button>
        )}
        {result && <ResultLine result={result} />}
      </div>
    </div>
  );
}

/* ---------------- 消息渲染 ---------------- */

/** 思考耗时（秒）显示文本 */
function fmtThink(secs: number): string {
  return secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
}

/** DeepSeek 风格思维链：每轮思考独立成框、按序排列；当前活跃框流式直显 + 计时，正文开始后自动折叠 */
function ThinkBox({
  text,
  ms,
  startAt,
  live,
  show,
}: {
  text: string;
  ms: number;
  startAt?: number;
  live: boolean;
  show: boolean;
}) {
  const [, tick] = useState(0);
  const mountRef = useRef(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [live]);
  if (!text) return null;
  const secs = live
    ? Math.max(1, Math.floor((Date.now() - (startAt ?? mountRef.current)) / 1000))
    : Math.max(1, ms);
  if (!show) {
    return live ? (
      <div className="ai-think live collapsed">
        <div className="ai-think-head">
          <span className="ai-think-dot" />
          思考中 · {fmtThink(secs)}
        </div>
      </div>
    ) : null;
  }
  return live ? (
    <div className="ai-think live">
      <div className="ai-think-head">
        <span className="ai-think-dot" />
        思考中 · {fmtThink(secs)}
      </div>
      <div className="ai-reasoning-body">{text}</div>
      <span className="ai-caret" />
    </div>
  ) : (
    <details className="ai-think done">
      <summary>
        <span className="ai-think-chev">▸</span> 已深度思考（{fmtThink(secs)}）
      </summary>
      <div className="ai-reasoning-body">{text}</div>
    </details>
  );
}

function StreamBody({
  content,
  reasoning,
  rounds,
  scene,
  streaming,
}: {
  content: string;
  reasoning?: string;
  rounds?: ReasonRound[];
  scene?: AiScene;
  streaming: boolean;
}) {
  const settings = useSettings();
  const [shown, setShown] = useState({ content, reasoning, rounds });
  const lastRef = useRef(0);

  useEffect(() => {
    const flush = () => {
      lastRef.current = Date.now();
      setShown({ content, reasoning, rounds });
    };
    if (Date.now() - lastRef.current >= 150) {
      flush();
      return;
    }
    const t = window.setTimeout(flush, 150);
    return () => window.clearTimeout(t);
  }, [content, reasoning, rounds]);

  const showThinking = settings.showThinking !== false;
  // 统一渲染模型：多轮 rounds；旧消息无 rounds 时退化为单轮
  const rs: ReasonRound[] = shown.rounds?.length
    ? shown.rounds
    : [{ r: shown.reasoning ?? "", c: shown.content, ms: 0 }];
  const lastIdx = rs.length - 1;
  const nothing = rs.every((r) => !r.r && !r.c);

  return (
    <>
      {rs.map((rd, i) => (
        <Fragment key={i}>
          <ThinkBox
            text={rd.r}
            ms={rd.ms}
            startAt={rd.t0}
            live={streaming && i === lastIdx && !rd.c}
            show={showThinking}
          />
          {rd.c ? (
            <MessageBody content={rd.c} scene={i === lastIdx ? scene : undefined} live={streaming} />
          ) : null}
        </Fragment>
      ))}
      {nothing && streaming && <span className="ai-caret" />}
    </>
  );
}

/** 流式期间未闭合的 uartix-* 代码块：只读预览，安装/执行待围栏闭合 */
function PendingBlock({ code }: { code: string }) {
  const lines = code ? code.split("\n").length : 0;
  return (
    <div className="ai-tpl-block ai-tpl-pending">
      <div className="ai-ext-head">
        <span>内容生成中…</span>
        <span className="ai-ext-badge">流式</span>
      </div>
      <pre className="ai-tpl-pre">{code.length > 300 ? "…" + code.slice(-300) : code}</pre>
      <div className="ai-tpl-actions">
        <span className="ai-tpl-ok">已生成 {lines} 行，输出完成后自动出现安装/执行按钮</span>
      </div>
    </div>
  );
}

/** AI 扩展分享包（uartix-extensions JSON）→ 一键导入卡 */
function ExtPackImportBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  let count = 0;
  let bad = "";
  try {
    const p = JSON.parse(code) as { kind?: string; data?: unknown[] };
    if (p.kind !== "uartix-extensions" || !Array.isArray(p.data)) bad = "不是有效的扩展分享包（缺 kind/data 字段）";
    else count = p.data.length;
  } catch {
    bad = "JSON 解析失败";
  }
  return (
    <div className="ai-tpl-block">
      <div className="ai-ext-head">
        <span>AI 扩展分享包</span>
        <span className="ai-ext-badge">{bad ? "无效" : `${count} 个扩展`}</span>
      </div>
      {bad ? (
        <div className="ai-error">{bad}</div>
      ) : (
        <div className="ai-tpl-actions">
          <button className="btn primary" onClick={() => setResult(importAll(code))}>
            导入分享包
          </button>
          {result && <ResultLine result={result} />}
        </div>
      )}
    </div>
  );
}

function MessageBody({
  content,
  scene,
  live,
}: {
  content: string;
  scene?: AiScene;
  live?: boolean;
}) {
  const [saved, setSaved] = useState<string>("");
  // 展示层剔除技术标记（正常流程已在续写时移除，兜底）
  const clean = content.replace(/\[\[\s*need\s*:\s*[a-z]+\s*\]\]/gi, "").trimStart();
  const segs = parseSegments(clean);
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
          s.closed === false && s.lang?.startsWith("uartix-") && live ? (
            <PendingBlock key={i} code={s.code ?? ""} />
          ) : (s.lang === "json" || !s.lang) && s.closed !== false && (s.code ?? "").includes('"uartix-extensions"') ? (
            <ExtPackImportBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-template" ? (
            <TemplateWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-command" ? (
            <CommandWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-card" ? (
            <CardWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-widget" || s.lang === "uartix-panel" ? (
            <ExtInstallBlock key={i} code={s.code ?? ""} type={s.lang === "uartix-panel" ? "panel" : "widget"} />
          ) : s.lang === "uartix-theme" ? (
            <ThemeExtBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-style" ? (
            <StyleExtBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-script" ? (
            <ScriptExtBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-codec" ? (
            <CodecWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-action" ? (
            <ActionBlock key={i} code={s.code ?? ""} />
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

/* ---------------- 会话侧栏 ---------------- */

function fmtSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return sameDay
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

function SessionSidebar({
  onClose,
  notify,
}: {
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const chat = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const totals = chatStore.usageTotals();
  const active = chat.sessions.find((s) => s.id === chat.activeId);

  const hits = chatStore.searchSessions(q);

  return (
    <div className="ai-side">
      <div className="ai-side-head">
        <button
          className="btn primary"
          onClick={() => {
            chatStore.newSession();
            onClose();
          }}
        >
          新对话
        </button>
        <button className="ai-mode-close" onClick={onClose}>
          收起
        </button>
      </div>
      <input
        className="input ai-side-search"
        placeholder="搜索历史消息…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="ai-side-list">
        {q.trim() ? (
          hits.length === 0 ? (
            <div className="ai-ctx-empty">没有匹配的消息</div>
          ) : (
            hits.map((h) => (
              <button
                key={h.msg.id}
                className={`ai-side-item${h.sessionId === chat.activeId ? " on" : ""}`}
                onClick={() => {
                  chatStore.switchSession(h.sessionId);
                  setQ("");
                  onClose();
                }}
              >
                <span className="ai-side-title">{h.title}</span>
                <span className="ai-side-snippet">
                  {h.msg.content.replace(/\s+/g, " ").slice(0, 60)}
                </span>
              </button>
            ))
          )
        ) : (
          chat.sessions.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="ai-side-item editing">
                <input
                  className="input"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      chatStore.renameSession(s.id, editTitle);
                      setEditingId("");
                    } else if (e.key === "Escape") {
                      setEditingId("");
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={s.id}
                className={`ai-side-item${s.id === chat.activeId ? " on" : ""}`}
                onClick={() => {
                  chatStore.switchSession(s.id);
                  onClose();
                }}
                onDoubleClick={() => {
                  setEditingId(s.id);
                  setEditTitle(s.title);
                }}
                title="单击切换 · 双击重命名"
              >
                <span className="ai-side-title">{s.title || "新对话"}</span>
                <span className="ai-side-meta">
                  {fmtSessionTime(s.updatedAt)} · {s.messages.length} 条
                </span>
                <button
                  className="ai-side-del"
                  title="删除会话"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (confirm(`删除会话「${s.title || "新对话"}」？不可恢复。`)) {
                      chatStore.deleteSession(s.id);
                      notify("会话已删除");
                    }
                  }}
                >
                  ×
                </button>
              </div>
            ),
          )
        )}
      </div>
      <div className="ai-side-foot">
        <div className="ai-usage-line">
          本会话 {active?.usage.prompt ?? 0}/{active?.usage.completion ?? 0} tok
        </div>
        <div className="ai-usage-line dim">
          累计 {totals.prompt}/{totals.completion} tok（输入/输出）
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

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
  const [sideOpen, setSideOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editText, setEditText] = useState("");
  const ws = useExtensions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const configured =
    settings.aiPreset === "ollama" || settings.aiApiKey.trim().length > 0;

  const sess = chat.sessions.find((s) => s.id === chat.activeId) ?? chat.sessions[0];
  const messages = sess?.messages ?? [];

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

  // 依赖 chat 快照引用：流式期间 chatStore 原地修改消息内容并 emit 新快照，
  // 该 effect 随每次 flush 触发，保证 stick 状态下始终跟随最新输出
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, ctxOpen, chat]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = bottom;
    setAtBottom(bottom);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
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
    if (
      scene === "genCommand" ||
      scene === "genCard" ||
      scene === "create" ||
      scene === "diagnose"
    ) {
      setMode(scene);
      inputRef.current?.focus();
      return;
    }
    runScene(scene);
  };

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice("已复制"));
  };

  const exportConversation = async () => {
    const path = await save({
      title: "导出对话",
      defaultPath: `uartix-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content: chatStore.exportSessionMd() });
      setNotice("对话已导出");
    } catch (e) {
      setNotice(`导出失败：${String(e).slice(0, 80)}`);
    }
  };

  const uploadPatrol = async () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
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

  const lastHasPatrol = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")
    ?.content.includes("巡检发现");

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  const ctxBlocks = collectContext(chat.contextSel);
  const checkedCtxCount = Object.values(chat.contextSel).filter(Boolean).length;

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
          <button className="btn primary" onClick={() => invokeOpenSettings()}>
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
          className={`ai-icon-btn${sideOpen ? " on" : ""}`}
          title="会话列表：多会话切换、搜索历史、双击重命名"
          onClick={() => setSideOpen((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="17" y2="18" /></svg>
        </button>
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
          title="引导式创造：主题 / 样式 / 小部件 / 面板 / 脚本"
          onClick={() => quickPick("create")}
        >
          创造扩展
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
          className={`ai-icon-btn${ws.exts.length ? " ai-patrol" : ""}`}
          title={settings.aiCreativity ? "扩展管理：启停/删除/导入导出" : "扩展管理（开启创造模式后可用）"}
          onClick={() => invokeOpenSettings("ext")}
        >
          <IconPuzzle />
        </button>
        <button
          className="ai-icon-btn"
          title="导出当前对话为 Markdown"
          onClick={() => void exportConversation()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 19h16" /></svg>
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
        <button className="ai-icon-btn" title="清空当前对话" onClick={() => chatStore.clearChat()}>
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

      <div className="ai-msgs-wrap">
        {sideOpen && (
          <SessionSidebar onClose={() => setSideOpen(false)} notify={setNotice} />
        )}
        <div className="ai-msgs" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 && (
            <div className="ai-welcome">
              <div className="ai-welcome-title">
                <IconSparkle />
                AI 调试助手
              </div>
              <div className="ai-welcome-desc">
                框选 Hex 字节右键「AI 识别协议」；或用上方快捷按钮解读数据、分析曲线、生成指令、诊断问题。开启创造模式后可用「创造扩展」让 AI 生成主题、样式、小部件、面板与脚本。发送前可勾选随消息附带的软件内上下文。
              </div>
            </div>
          )}
          {messages.map((m: ChatMsg, idx: number) => {
            const isLast = idx === messages.length - 1;
            const isStreamingMsg = isLast && chat.streaming && m.role === "assistant";
            // 流式期间最后一条 assistant 若完全为空，由下方 ai-streaming-only 兜底块统一显示光标，跳过避免双气泡
            if (isStreamingMsg && !m.content && !m.reasoning) return null;
            return (
              <div key={m.id} className={`ai-msg ${m.role}`}>
                <div className="ai-msg-bubble">
                  {editingId === m.id ? (
                    <div className="ai-edit-wrap">
                      <textarea
                        className="input ai-edit-input"
                        value={editText}
                        rows={3}
                        autoFocus
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const t = editText.trim();
                            setEditingId("");
                            if (t) void chatStore.editResend(m.id, t);
                          } else if (e.key === "Escape") {
                            setEditingId("");
                          }
                        }}
                      />
                      <div className="ai-tpl-actions">
                        <button
                          className="btn primary"
                          onClick={() => {
                            const t = editText.trim();
                            setEditingId("");
                            if (t) void chatStore.editResend(m.id, t);
                          }}
                        >
                          保存并重发
                        </button>
                        <button className="btn" onClick={() => setEditingId("")}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : m.role === "user" ? (
                    <div className="ai-msg-text">{m.content}</div>
                  ) : isStreamingMsg ? (
                    <StreamBody
                      content={m.content}
                      reasoning={m.reasoning}
                      rounds={m.rounds}
                      streaming
                    />
                  ) : (
                    <>
                      <StreamBody
                        content={m.content}
                        reasoning={m.reasoning}
                        rounds={m.rounds}
                        scene={m.scene}
                        streaming={false}
                      />
                      {m.aborted && <div className="ai-aborted">已停止生成</div>}
                      {m.error && <div className="ai-error">{m.error}</div>}
                    </>
                  )}
                </div>
                {!chat.streaming && editingId !== m.id && (
                  <div className="ai-msg-ops">
                    {m.role === "assistant" && !m.error && (
                      <button onClick={() => copyText(m.content)}>复制</button>
                    )}
                    {m.role === "assistant" && m.id === lastAssistantId && (
                      <button
                        onClick={() => void chatStore.regenerate()}
                        title={m.error ? "重试本次请求" : "重新生成回复"}
                      >
                        {m.error ? "重试" : "重新生成"}
                      </button>
                    )}
                    {m.role === "user" && (
                      <>
                        <button onClick={() => copyText(m.content)}>复制</button>
                        <button
                          onClick={() => {
                            setEditingId(m.id);
                            setEditText(m.content);
                          }}
                        >
                          编辑
                        </button>
                      </>
                    )}
                    <button onClick={() => chatStore.deleteMsg(m.id)}>删除</button>
                  </div>
                )}
                {m.role === "assistant" && m.contextTitles && m.contextTitles.length > 0 && (
                  <div className="ai-msg-ctx">附加上下文：{m.contextTitles.join(" · ")}</div>
                )}
              </div>
            );
          })}
          {chat.streaming && messages.length > 0 && messages[messages.length - 1].content === "" && !messages[messages.length - 1].reasoning && (
            <div className="ai-msg assistant ai-streaming-only">
              <div className="ai-msg-bubble ai-streaming">
                <span className="ai-caret" />
              </div>
            </div>
          )}
        </div>
        {!atBottom && messages.length > 0 && (
          <button className="ai-scroll-btn" title="回到底部" onClick={scrollToBottom}>
            <IconChevron dir="down" size={14} />
          </button>
        )}
      </div>

      {notice && <div className="ai-notice">{notice}</div>}
      {uploadState && <div className="ai-notice">{uploadState}</div>}

      <div className="ai-input-wrap">
        <div className="ai-ctx-bar">
          <button
            className="ai-ctx-toggle"
            title="勾选数与实际附加数可能不同：Hex 未框选字节、样本无数据时不产生附加块"
            onClick={() => setCtxOpen((v) => !v)}
          >
            <IconChevron dir={ctxOpen ? "down" : "right"} size={11} />
            本次发送的上下文（勾选 {checkedCtxCount} · 实际附加 {ctxBlocks.length}
            {ctxBlocks.length > 0
              ? ` · ≈${estimateTokens(ctxBlocks.map((b) => b.text).join("\n")) + estimateTokens(input)} tok`
              : ""}
            ）
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
              if (e.key === "Enter" && (e.shiftKey || e.ctrlKey)) {
                // Shift+Enter / Ctrl+Enter 换行（textarea 默认行为）
                return;
              }
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
