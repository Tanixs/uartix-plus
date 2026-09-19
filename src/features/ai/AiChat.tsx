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
import {
  writeTemplateFromAiJson,
  writeCommandFromAiJson,
  writeCardFromAiJson,
  writeCodecFromAiJson,
} from "./aiActions";
import { AgentInline, AgentFloat } from "../agent/AgentInline";
import * as agentRun from "../agent/agentRun";
import { PluginLibraryDialog } from "../plugins/PluginLibraryDialog";
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
  IconClose,
  IconDock,
  IconUpload,
  IconPop,
  IconPlus,
} from "../../shared/icons";
import { confirmDialog } from "../../shared/Dialog";
import { ErrorBoundary } from "../../shared/ErrorBoundary";

const BUG_ENDPOINT = "https://larix.teuioe.cn/api/bugreport.php";

/** P88b-4 B：常用任务快捷入口（Agent 模式面板内，点击填入输入框；覆盖外观/诊断/插件典型场景） */
const QUICK_TASKS: { label: string; goal: string; tip: string }[] = [
  {
    label: "大字号+减少动效",
    goal: "把界面字号调大一档、动效放缓，完成后告诉我怎么一步撤销",
    tip: "字号与动效配方，会话级预览、一次撤销恢复",
  },
  {
    label: "玻璃质感主题",
    goal: "用玻璃质感调整面板外观，我看过效果满意后保存为「我的玻璃主题」",
    tip: "玻璃配方按当前主题色派生，可保存为主题扩展",
  },
  {
    label: "只读诊断面板",
    goal: "分析当前曲线数据的异常区间，生成一个只读的诊断面板",
    tip: "读取通道统计后生成卡片面板，不改数据",
  },
  {
    label: "面板另存紧凑版",
    goal: "把当前面板的标题单位改成中文，另存一个紧凑版副本，不覆盖原版",
    tip: "修改后另存新插件，原版保持不变",
  },
];

const SCENE_HINT: Partial<Record<AiScene, string>> = {
  genCommand: "生成指令：描述你要发送的指令，如「把 roll 归零并每 100ms 上报一次」",
  genCard: "生成卡片：描述你要的控制卡片，如「一个控制电机转速的滑条，0-100」",
  create: "创造：描述你想要的主题/小部件/面板，我会引导你用 Agent 任务把它保存为插件并自动启用",
  diagnose: "诊断问题：描述你遇到的问题，如「收不到数据」",
};

const CONTEXT_LABELS: Record<keyof ContextSelection, string> = {
  conn: "连接配置",
  protocol: "协议清单",
  protoFull: "协议完整定义",
  samples: "数据样本",
  hex: "Hex 选区",
};

/** P88e C1：可附加的文本类文件后缀（随消息以代码块形式发给模型） */
const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|log|ini|cfg|conf|xml|yaml|yml|toml|ts|tsx|js|jsx|py|c|h|cpp|hpp|rs|go|java|html|css|sql|bat|ps1|sh)$/i;

/** P88e C1：Agent 档位中文名（模式 pill 与发送方式面板共用） */
const SCOPE_ZH: Record<"preview" | "create" | "custom", string> = {
  preview: "仅预览",
  create: "常规创造",
  custom: "自定义",
};

/** P88e C1：顶部工具栏收拢后「场景 ▾」下拉的场景项（与 quickPick 对接） */
const SCENE_MENU: { scene: AiScene; label: string; tip: string }[] = [
  { scene: "protocol", label: "识别协议", tip: "框选 Hex 字节后点击，AI 推断帧结构并生成模板" },
  { scene: "interpret", label: "解读数据", tip: "根据最近帧数据概括设备状态与异常" },
  { scene: "analyzeCurve", label: "分析曲线", tip: "分析当前 2D 曲线各通道的统计特征与周期" },
  { scene: "genCommand", label: "生成指令", tip: "描述需求，AI 生成命令模板或脚本" },
  { scene: "genCard", label: "生成卡片", tip: "描述需求，AI 生成控制卡片并写入控制画布" },
  { scene: "create", label: "创造", tip: "主题 / 小部件 / 面板（经 Agent 任务保存为插件并自动启用）" },
  { scene: "diagnose", label: "诊断", tip: "描述问题，结合连接状态给出排查清单" },
  { scene: "report", label: "调试报告", tip: "汇总本次会话生成 Markdown 调试报告" },
];

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
    const { runAppAction, actionDataText } = await import("./appActions");
    const out: (string | null)[] = [];
    for (const a of actions) {
      try {
        const r = await runAppAction(a.kind, a.args ?? {}, { highPriv: true });
        out.push(r.ok ? actionDataText(r.data) : `失败：${r.err}`);
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
  const secs = live
    ? Math.max(1, Math.floor((Date.now() - (startAt ?? mountRef.current)) / 1000))
    : Math.max(1, ms);
  if (!text) {
    // 无思维链内容：流式进行中显示等待占位；流式结束仍无内容则不渲染
    return live && show ? (
      <div className="ai-think live collapsed">
        <div className="ai-think-head">
          <span className="ai-think-dot" />
          等待思维链…
        </div>
      </div>
    ) : null;
  }
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
        <span className="think-caret"><IconChevron dir="right" /></span> 已深度思考（{fmtThink(secs)}）
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
          ) : s.lang === "uartix-template" ? (
            <TemplateWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-command" ? (
            <CommandWriteBlock key={i} code={s.code ?? ""} />
          ) : s.lang === "uartix-card" ? (
            <CardWriteBlock key={i} code={s.code ?? ""} />
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
                    void (async () => {
                      if (
                        await confirmDialog({
                          message: `删除会话「${s.title || "新对话"}」？不可恢复。`,
                          danger: true,
                          okLabel: "删除",
                        })
                      ) {
                        chatStore.deleteSession(s.id);
                        notify("会话已删除");
                      }
                    })();
                  }}
                >
                  <IconClose />
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
  // P88e C1：输入区 Zcode 化——＋附件菜单 / 任务模式面板 / 场景下拉，全部默认收起
  const [plusOpen, setPlusOpen] = useState(false);
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; text: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [anoms, setAnoms] = useState<Anomaly[]>([]);
  const [anomOpen, setAnomOpen] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [sideOpen, setSideOpen] = useState(false);
  // P88d ③：Agent 集成进对话——agentMode=输入框走 Agent 任务而非问答；档位/授权域内联选择
  const [agentMode, setAgentMode] = useState(false);
  const [agentScope, setAgentScope] = useState<"preview" | "create" | "custom">("create");
  const [agentAllowed, setAgentAllowed] = useState<string[]>(["config", "plugins"]);
  const agentSnap = useSyncExternalStore(agentRun.subscribe, agentRun.getSnapshot);
  const agentActive = agentSnap.runs.find((r) => r.runId === agentSnap.activeRunId) ?? null;
  const agentPending = Boolean(agentActive?.pending);
  const agentRunning = agentActive?.status === "running";
  const agentBadge = agentPending ? "待批准" : agentRunning ? "运行中" : null;
  const [plgLibOpen, setPlgLibOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editText, setEditText] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const imgInputRef = useRef<HTMLInputElement>(null);
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

  /** 图片压缩：长边压到 1024px 内、JPEG 0.85——控制多模态请求体积（每张 ~100-300KB） */
  const addImages = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const room = 4 - pendingImages.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (list.length === 0) {
      setNotice("每条消息最多附带 4 张图片");
      return;
    }
    for (const f of list) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(img.width * scale));
          cv.height = Math.max(1, Math.round(img.height * scale));
          cv.getContext("2d")?.drawImage(img, 0, 0, cv.width, cv.height);
          const url = scale < 1 ? cv.toDataURL("image/jpeg", 0.85) : String(reader.result);
          setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, url]));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(f);
    }
  };

  /** P88e C1：附加文本文件（≤256KB、最多 4 个），内容以代码块形式随消息发给模型。
   *  用途示例：把文本日志/配置/导出的 JSON 直接喂给 AI 分析。 */
  const addFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const room = 4 - pendingFiles.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (list.length === 0) {
      setNotice("每条消息最多附带 4 个文件");
      return;
    }
    for (const f of list) {
      if (!TEXT_FILE_RE.test(f.name)) {
        setNotice(`暂不支持的文件类型：${f.name}（支持文本类：.txt/.md/.csv/.json/.log 等）`);
        continue;
      }
      if (f.size > 256 * 1024) {
        setNotice(`文件过大（${f.name} 超过 256KB），请截取关键部分`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () =>
        setPendingFiles((prev) =>
          prev.length >= 4 || prev.some((p) => p.name === f.name)
            ? prev
            : [...prev, { name: f.name, text: String(reader.result ?? "") }],
        );
      reader.readAsText(f);
    }
  };

  const doSend = () => {
    const text = input.trim();
    const fileBlock =
      pendingFiles.length > 0
        ? pendingFiles.map((f) => `【附加文件：${f.name}】\n\`\`\`\n${f.text}\n\`\`\``).join("\n\n") + "\n\n"
        : "";
    if ((!text && pendingImages.length === 0) || chat.streaming) return;
    // P88d ③：Agent 模式——目标文本直接启动任务（归属当前会话），不走问答链路
    if (agentMode) {
      if (agentRunning) {
        setNotice("已有 Agent 任务在运行，请先停止或等待完成");
        return;
      }
      if (!text) return;
      setInput("");
      setPendingFiles([]);
      void agentRun
        .startRun({
          goal: fileBlock + text,
          scope: agentScope,
          sessionId: chat.activeId,
          ...(agentScope === "custom" ? { allowed: agentAllowed } : {}),
        })
        .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
      return;
    }
    const scene = mode;
    const imgs = pendingImages.length ? pendingImages : undefined;
    setMode("qa");
    setInput("");
    setPendingImages([]);
    setPendingFiles([]);
    stickRef.current = true;
    void chatStore.sendText(fileBlock + text, scene, undefined, imgs);
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
    let ver: string;
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
          className={`ai-scene-btn${agentMode ? " on" : ""}`}
          title="Agent 任务模式：输入一句话目标，AI 连续调用工具完成主题/协议/分析等多步任务（成果可保存为插件）"
          onClick={() => {
            setAgentMode((v) => !v);
            inputRef.current?.focus();
          }}
        >
          Agent 任务
          {agentBadge && <span className={`agent-badge${agentPending ? " warn" : ""}`}>{agentBadge}</span>}
        </button>
        <button
          className={`ai-icon-btn${sideOpen ? " on" : ""}`}
          title="会话列表：多会话切换、搜索历史、双击重命名"
          onClick={() => setSideOpen((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="17" y2="18" /></svg>
        </button>
        {/* P88e C1：8 个场景按钮收进「场景 ▾」下拉，工具栏只留高频入口 */}
        <button
          className={`ai-scene-btn${sceneMenuOpen ? " on" : ""}`}
          title="分析 / 生成 / 报告等场景入口"
          onClick={() => setSceneMenuOpen((v) => !v)}
        >
          场景 ▾
        </button>
        {sceneMenuOpen && (
          <div className="ai-scene-menu" role="menu">
            {SCENE_MENU.map((s) => (
              <button
                key={s.scene}
                className="ai-scene-menu-item"
                title={s.tip}
                role="menuitem"
                onClick={() => {
                  setSceneMenuOpen(false);
                  if (s.scene === "protocol") {
                    quickPick("protocol");
                    return;
                  }
                  quickPick(s.scene);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <div className="ai-toolbar-spacer" />
        <button
          className="ai-icon-btn"
          title="本地插件库：启停/配置/版本/回滚/导入导出"
          onClick={() => setPlgLibOpen(true)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></svg>
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
                框选 Hex 字节右键「AI 识别协议」；或用上方快捷按钮解读数据、分析曲线、生成指令、诊断问题。想做主题、小部件、面板？用「Agent 任务」让 AI 直接保存为插件并自动启用。发送前可勾选随消息附带的软件内上下文。
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
                    <>
                      {m.images && m.images.length > 0 && (
                        <div className="ai-msg-imgs">
                          {m.images.map((u, i) => (
                            <img key={i} src={u} className="ai-msg-img" alt="" />
                          ))}
                        </div>
                      )}
                      <div className="ai-msg-text">{m.content}</div>
                    </>
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
          {/* P88d ③：本会话的 Agent 任务内联活动流（目标/时间线/审批/终态） */}
          <AgentInline sessionId={chat.activeId} />
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
        {/* P88e C1：附加内容 chips——仅有附加内容时出现，默认不见；点上下文 chip 展开勾选面板 */}
        {(pendingFiles.length > 0 || checkedCtxCount > 0 || ctxOpen) && (
          <div className="ai-attach-row">
            {pendingFiles.map((f, i) => (
              <span key={`${f.name}:${i}`} className="ai-attach-chip" title={`附加文件 ${f.name}`}>
                {f.name}
                <button
                  className="ai-attach-del"
                  title="移除文件"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  <IconClose />
                </button>
              </span>
            ))}
            <button
              className={`ai-attach-chip as-btn${ctxOpen ? " on" : ""}`}
              title="勾选随消息发送的上下文（连接配置 / 协议 / 数据样本 / Hex 选区）"
              onClick={() => setCtxOpen((v) => !v)}
            >
              上下文 · 勾选 {checkedCtxCount} · 附加 {ctxBlocks.length}
              {ctxBlocks.length > 0
                ? ` · ≈${estimateTokens(ctxBlocks.map((b) => b.text).join("\n")) + estimateTokens(input)} tok`
                : ""}
            </button>
          </div>
        )}
        {ctxOpen && (
          <div className="ai-ctx-panel">
            <div className="ai-ctx-checks">
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
              <span className="ai-ctx-note" title="Hex 未框选字节、样本无数据时不产生附加块">
                勾选数与实际附加数可能不同
              </span>
            </div>
            {ctxBlocks.length > 0 && (
              <div className="ai-ctx-preview">
                {ctxBlocks.map((b) => (
                  <div key={b.key} className="ai-ctx-block">
                    <div className="ai-ctx-block-title">{b.title}</div>
                    <pre>{b.text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* P88e C1：「发送方式」面板——普通对话与三档 Agent 档位统一在此选择，默认收起 */}
        {modePanelOpen && (
          <div className="ai-agent-panel" role="group" aria-label="发送方式设置">
            <div className="ai-agent-modes" role="radiogroup" aria-label="发送方式">
              {([
                ["chat", "普通对话", "一问一答；不执行任何应用操作"],
                ["preview", "Agent · 仅预览", "读上下文、生成草稿、验证，不改动当前工作区"],
                ["create", "Agent · 常规创造", "新建草稿与可撤销修改自动执行；删除/覆盖/设备下发仍需批准"],
                ["custom", "Agent · 自定义", "按勾选的授权域自动执行；未勾选域逐项批准"],
              ] as const).map(([k, label, tip]) => (
                <button
                  key={k}
                  className={`ai-agent-mode${(k === "chat" ? !agentMode : agentMode && agentScope === k) ? " on" : ""}`}
                  title={tip}
                  disabled={agentRunning}
                  onClick={() => {
                    if (k === "chat") setAgentMode(false);
                    else {
                      setAgentMode(true);
                      setAgentScope(k);
                    }
                    setModePanelOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {agentMode && agentScope === "custom" && (
              <div className="ai-agent-domains">
                {([
                  ["config", "配置写入", "设置与工作区配置的新建/修改（删除/覆盖仍需批准）"],
                  ["plugins", "插件库", "保存新插件并启用纯 UI 插件"],
                  ["device", "设备发送", "仿真环境自动发送；实车/未知设备仍逐次批准"],
                  ["files", "文件读取", "读取/列出「Agent 文件白名单」内的本地文件（设置 → AI 服务）"],
                  ["network", "网络访问", "抓取公网网页与搜索（自动拒绝内网地址）"],
                  ["shell", "命令行", "执行 shell 命令：需设置页总开关 + 每次逐条批准"],
                ] as const).map(([k, label, tip]) => (
                  <label key={k} className="ai-agent-domain" title={tip}>
                    <input
                      type="checkbox"
                      disabled={agentRunning}
                      checked={agentAllowed.includes(k)}
                      onChange={(e) =>
                        setAgentAllowed(e.target.checked ? [...agentAllowed, k] : agentAllowed.filter((x) => x !== k))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {agentMode && !agentRunning && (
              <div className="ai-agent-quick" role="group" aria-label="常用任务">
                {QUICK_TASKS.map((t) => (
                  <button key={t.label} className="ai-agent-quick-chip" title={t.tip} onClick={() => setInput(t.goal)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {agentMode && (
              <span className="ai-agent-budget">预算 24 轮 / 64 次工具 / 10 分钟{agentRunning ? "（运行中，设置已锁定）" : ""}</span>
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
        {pendingImages.length > 0 && (
          <div className="ai-img-strip">
            {pendingImages.map((u, i) => (
              <div key={i} className="ai-img-thumb">
                <img src={u} alt="" />
                <button
                  className="ai-img-del"
                  title="移除图片"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={imgInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addImages(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {/* P88e C1：＋菜单——图片 / 文件 / 上下文三入口，默认收起 */}
        {plusOpen && (
          <div className="ai-plus-menu" role="menu">
            <button
              className="ai-plus-menu-item"
              role="menuitem"
              onClick={() => {
                setPlusOpen(false);
                imgInputRef.current?.click();
              }}
            >
              附加图片
              <span className="ai-plus-menu-note">截图 / 图片文件，最多 4 张</span>
            </button>
            <button
              className="ai-plus-menu-item"
              role="menuitem"
              onClick={() => {
                setPlusOpen(false);
                fileInputRef.current?.click();
              }}
            >
              附加文件
              <span className="ai-plus-menu-note">文本类 ≤256KB，最多 4 个（.txt/.md/.csv/.json/.log 等）</span>
            </button>
            <button
              className="ai-plus-menu-item"
              role="menuitem"
              onClick={() => {
                setPlusOpen(false);
                setCtxOpen(true);
              }}
            >
              发送上下文
              <span className="ai-plus-menu-note">连接配置 / 协议 / 数据样本 / Hex 选区</span>
            </button>
          </div>
        )}
        <div className="ai-input-row">
          <button className="ai-plus" title="附加图片、文件或上下文" onClick={() => setPlusOpen((v) => !v)} aria-haspopup="menu" aria-expanded={plusOpen}>
            <IconPlus />
          </button>
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={
              agentMode
                ? agentRunning
                  ? "Agent 任务运行中…可停止后继续"
                  : "用一句话描述目标，Enter 启动 Agent 任务（AI 连续调用工具完成）"
                : chat.streaming
                  ? "AI 正在回复…"
                  : "输入问题，Enter 发送，Shift+Enter 换行；可粘贴/附加图片"
            }
            rows={1}
            value={input}
            disabled={chat.streaming || (agentMode && agentRunning)}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
            }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (imgs.length > 0) {
                e.preventDefault();
                addImages(imgs);
              }
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
              disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
              onClick={doSend}
            >
              <IconSend />
            </button>
          )}
        </div>
        {/* P88e C1：工具条行——发送方式 pill（默认收起，点开面板）+ Agent 运行进度 */}
        <div className="ai-tools-row">
          <button
            className={`ai-mode-pill${agentMode ? " on" : ""}`}
            title="选择发送方式：普通对话，或 Agent 任务的执行档位"
            onClick={() => setModePanelOpen((v) => !v)}
            aria-expanded={modePanelOpen}
          >
            {agentMode ? `Agent 任务 · ${SCOPE_ZH[agentScope]}` : "普通对话"}
            <IconChevron dir="down" size={12} />
          </button>
          {agentMode && agentRunning && (
            <span className="ai-agent-prog">
              第 {agentActive?.rounds ?? 0} 轮 · {agentActive?.calls ?? 0} 次工具{agentPending ? " · 待批准" : ""}
            </span>
          )}
        </div>
      </div>
      {/* P88d ③：活动任务不在当前会话视图时，右下角悬浮条一键切回 */}
      <AgentFloat sessionId={chat.activeId} onOpen={(id) => chatStore.switchSession(id)} />
      {plgLibOpen && (
        <ErrorBoundary label="本地插件库">
          <PluginLibraryDialog onClose={() => setPlgLibOpen(false)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
