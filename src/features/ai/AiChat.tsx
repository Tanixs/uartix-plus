import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { bubbleMode } from "./messageClip";
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
import { RunEntry, AgentFloat } from "../agent/AgentInline";
import { buildTimeline } from "../agent/timeline";
import { buildAgentHistory, HISTORY_CHAR_BUDGET, MIN_HISTORY_BUDGET, tightenHistoryBudget } from "../agent/sessionLog";
import { agentPayloadBytes, ctxGauge } from "../agent/context";
import {
  DOMAINS, DOMAIN_PRESETS, DOMAIN_TIP, DOMAIN_ZH, PRIMARY_TIERS, hasDomain, rememberTier, resolveTier, restoreTier, tierBadge, tierIdOf, type Domain,
} from "../agent/scopeTiers";
import * as agentRun from "../agent/agentRun";
import { isLiveRun, type RunScope } from "../agent/types";
import { DEFAULT_BUDGET } from "../agent/loop";
import { Dropdown } from "../../shared/Dropdown";
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
  IconChevron,
  IconClose,
  IconDock,
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
    goal: "把界面字号调大一档、动效放缓，满意后保存为插件并启用，告诉我怎么停用",
    tip: "字号与动效配方：先预览，再自动保存为已启用插件（本卡或插件库可停用）",
  },
  {
    label: "玻璃质感主题",
    goal:
      "先用 theme_preset 的玻璃配方（glass）按当前主题派生整套外观：面板、嵌底、边框、文字、主色一起调，" +
      "不要只改两三个 token；我看过效果后保存为「我的玻璃主题」并启用",
    tip: "走内置玻璃配方（跟随当前主题色派生一组 token），保存后是一份完整主题插件，可随时停用",
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
      {/* P90 C5：抽屉顶部说明当前看的是哪个会话（切换后所见即所写） */}
      <div className="ai-side-cur">当前会话：{active?.title || "新对话"}</div>
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
  // P90 C1：顶栏「更多 ▾」（插件库/导出/巡检上报/清空）
  const [moreOpen, setMoreOpen] = useState(false);
  const sceneBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const modePillRef = useRef<HTMLButtonElement>(null);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; text: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [anoms, setAnoms] = useState<Anomaly[]>([]);
  const [anomOpen, setAnomOpen] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [sideOpen, setSideOpen] = useState(false);
  // P88d ③：Agent 集成进对话——agentMode=输入框走 Agent 任务而非问答；档位/授权域内联选择
  // P98-M3（Q3 折中）：记住上次的授权档，但高危档不自动恢复（restoreTier 里回落并报 downgraded）
  const [tierRestore] = useState(restoreTier);
  const [agentMode, setAgentMode] = useState(false);
  const [agentScope, setAgentScope] = useState<RunScope>(tierRestore.scope);
  const [agentAllowed, setAgentAllowed] = useState<Domain[]>(tierRestore.allowed);
  // 具体授权域收进折叠区，默认不开——第一层只需要选档，勾域是少数人要做的事
  const [advOpen, setAdvOpen] = useState(false);
  useEffect(() => {
    rememberTier(agentScope, agentAllowed);
  }, [agentScope, agentAllowed]);
  const agentSnap = useSyncExternalStore(agentRun.subscribe, agentRun.getSnapshot);
  const agentActive = agentSnap.runs.find((r) => r.runId === agentSnap.activeRunId) ?? null;
  const agentRunning = agentActive?.status === "running";
  // P90 C1：pill 上的徽标只看**当前会话**的任务（跨会话由右下浮条承担），
  // 旧实现用全局 activeRunId → 在别的会话里也显示「运行中」，与浮条语义打架
  const sessionRun =
    agentSnap.runs.find((r) => r.sessionId === chat.activeId && isLiveRun(r.status)) ?? null;
  const sessionBadge = sessionRun
    ? sessionRun.pending
      ? "待批准"
      : sessionRun.status === "paused"
        ? "已暂停"
        : "运行中"
    : null;
  const [plgLibOpen, setPlgLibOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editText, setEditText] = useState("");
  /** P91 B3：长回复的展开态（按消息 id 记；会话切换不残留，因为 id 全局唯一） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const configured =
    settings.aiPreset === "ollama" || settings.aiApiKey.trim().length > 0;

  // P90 A3：Agent 模式没有目标文本就不能发（图片/文件是附加物，空发曾被静默丢弃）
  const canSend = agentMode
    ? input.trim().length > 0
    : input.trim().length > 0 || pendingImages.length > 0 || pendingFiles.length > 0;

  // P89 A5：不做 sessions[0] 显示兜底——失效 activeId 由 chatStore.getSnapshot 自愈，
  // 兜底会让"显示的会话"与"写入的会话"错位（新气泡接在旧记录里）。
  const sess = chat.sessions.find((s) => s.id === chat.activeId);
  const messages = sess?.messages ?? [];
  // P91 B1：消息与本会话 Agent 任务合成一条时间线——任务卡紧跟发起它的用户消息，
  // 不再当页脚（旧结构下任务永远沉底、新消息全叠在它上面）
  const timeline = buildTimeline(
    messages,
    agentSnap.runs.filter((r) => r.sessionId === chat.activeId),
  );
  const lastMsgId = messages.length ? messages[messages.length - 1].id : "";

  /**
   * P98-M4：上下文用量与手动压缩。
   * 数字口径 = **下一次真的会发出去的那份投影**（与发送路径同一个 buildAgentHistory），
   * 不是另算一份估算——否则"显示 30%、实际撞线"这种谎报迟早出现（§8-34 同源教训）。
   * 手动压缩也不新写算法：只把会话历史预算调小，让既有的遮蔽机制多折一些较早内容；
   * 台账事件一条不删，所以这是"少发给模型"，不是"忘掉"。
   */
  const sessionRuns = agentSnap.runs.filter((r) => r.sessionId === chat.activeId);
  const [ctxBudget, setCtxBudget] = useState(HISTORY_CHAR_BUDGET);
  // sessionRuns 每次 agentSnap 变化都是新数组 ⇒ 用"内容摘要"当实质依赖（写在数组外，规则才能静态检查）
  const runsWork = sessionRuns.reduce((n, r) => n + r.rounds + r.calls, 0);
  const ctxEstimate = useMemo(() => {
    const hist = buildAgentHistory(messages, sessionRuns, { budgetChars: ctxBudget });
    return { bytes: agentPayloadBytes(hist.messages), shadowed: hist.stats.shadowed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, ctxBudget, sessionRuns.length, runsWork]);
  const ctxMeter = ctxGauge(ctxEstimate.bytes);
  const atBudgetFloor = ctxBudget <= MIN_HISTORY_BUDGET;
  const compressContext = () => {
    const next = tightenHistoryBudget(ctxBudget);
    if (next === ctxBudget) return; // 已到下限：按钮此时是禁用的，这里只是双保险不静默空转
    setCtxBudget(next);
    setNotice(`已压缩：会话历史预算 ${ctxBudget} → ${next} 字，更早的工具回执只以摘要下发（台账一条不删，本会话内不可还原）`);
  };
  const resetContextBudget = () => {
    setCtxBudget(HISTORY_CHAR_BUDGET);
    setNotice("已恢复完整的会话历史预算");
  };

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
  // 该 effect 随每次 flush 触发，保证 stick 状态下始终跟随最新输出。
  // P90 A4：Agent 事件不写 messages，必须把 agentSnap 纳入依赖，否则运行中不跟随滚动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, ctxOpen, chat, agentSnap]);

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

  /** P90 A1/A3：发起 Agent 任务的唯一出口——先在会话里落一条用户气泡（只写原话），
   *  再把附件全文拼进 goal 交给模型；重发与首发共用这条路径。
   *  replaceMsgId=从某条消息重发：截断该条及其之后内容并就地改写，不重复堆气泡。 */
  const startAgentRun = (
    text: string,
    opts?: { fileBlock?: string; images?: string[]; replaceMsgId?: string },
  ) => {
    const brief = text.trim();
    if (!brief) return;
    if (agentRunning) {
      setNotice("已有 Agent 任务在运行，请先停止或等待完成");
      return;
    }
    stickRef.current = true;
    // P92 A2 / P94 G5：会话上下文快照要**先排除即将被截断的那条及其后**，再投影——
    // 旧实现在 rewriteForResend 之前算 history，模型会读到一批已被删掉的后续消息。
    const hist = buildAgentHistory(messages, agentSnap.runs.filter((r) => r.sessionId === chat.activeId), {
      ...(opts?.replaceMsgId ? { excludeFromMsgId: opts.replaceMsgId } : {}),
      // P98-M4：手动压缩过的会话要真的生效，得把预算带到发送路径上（与用量条同一个数）
      budgetChars: ctxBudget,
    });
    const history = hist.messages;
    if (opts?.replaceMsgId) {
      if (!chatStore.rewriteForResend(opts.replaceMsgId, brief)) return;
    } else {
      chatStore.appendUserMessage(brief, {
        via: "agent",
        ...(opts?.images?.length ? { images: opts.images } : {}),
      });
    }
    void agentRun
      .startRun({
        goal: (opts?.fileBlock ?? "") + brief,
        goalBrief: brief,
        scope: agentScope,
        sessionId: chat.activeId,
        ...(opts?.images?.length ? { images: opts.images } : {}),
        ...(history.length ? { history } : {}),
        // P95-H2：遮蔽数随任务传一次（派生值，不进台账）
        ...(hist.stats.shadowed ? { historyShadowed: hist.stats.shadowed } : {}),
        ...(agentScope === "custom" ? { allowed: agentAllowed } : {}),
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  };

  /** P90 裁决点1：在什么模式发的就按什么模式重发 */
  const commitResend = (m: ChatMsg, text: string) => {
    setEditingId("");
    const t = text.trim();
    if (!t) return;
    if (chatStore.resendKindOf(m) === "agent") startAgentRun(t, { replaceMsgId: m.id });
    else void chatStore.editResend(m.id, t);
  };

  /** P90 C5：清空对话补二次确认（与全库弹窗体系一致，原先一键即清） */
  const clearChatWithConfirm = async () => {
    if (
      !(await confirmDialog({
        message: "清空当前对话的全部消息？不可恢复（Agent 任务台账在卡片上单独删除）。",
        danger: true,
        okLabel: "清空",
      }))
    ) {
      return;
    }
    chatStore.clearChat();
  };

  const doSend = () => {
    const text = input.trim();
    const fileBlock =
      pendingFiles.length > 0
        ? pendingFiles.map((f) => `【附加文件：${f.name}】\n\`\`\`\n${f.text}\n\`\`\``).join("\n\n") + "\n\n"
        : "";
    if (!canSend || chat.streaming) return;
    // P88d ③：Agent 模式——目标文本启动任务（归属当前会话），不走问答链路
    if (agentMode) {
      const imgs = pendingImages.length ? pendingImages : undefined;
      setInput("");
      setPendingFiles([]);
      setPendingImages([]);
      startAgentRun(text, { fileBlock, images: imgs });
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

  // P94-G5：Agent 结论气泡的按钮语义是"按原目标重跑任务"，不是"把这句结论重说一遍"
  const lastAgentGoal = [...messages].reverse().find((m) => m.role === "user" && m.via === "agent");

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
        {/* P90 C1：顶栏删「Agent 任务」钮——发送方式唯一入口在输入区 pill；
            P90 C2：场景下拉改浮层（portal + fixed），不再被工具栏 overflow-x 裁到只剩几像素 */}
        <button
          ref={sceneBtnRef}
          className={`ai-scene-btn${sceneMenuOpen ? " on" : ""}`}
          title="分析 / 生成 / 报告等场景入口"
          aria-haspopup="menu"
          aria-expanded={sceneMenuOpen}
          onClick={() => setSceneMenuOpen((v) => !v)}
        >
          场景 ▾
        </button>
        <Dropdown
          anchor={sceneBtnRef.current}
          open={sceneMenuOpen}
          onClose={() => setSceneMenuOpen(false)}
        >
          {SCENE_MENU.map((s) => (
            <button
              key={s.scene}
              className="ai-scene-menu-item"
              title={s.tip}
              role="menuitem"
              onClick={() => {
                setSceneMenuOpen(false);
                quickPick(s.scene);
              }}
            >
              {s.label}
            </button>
          ))}
        </Dropdown>
        <div className="ai-toolbar-spacer" />
        <button
          ref={moreBtnRef}
          className={`ai-scene-btn${moreOpen ? " on" : ""}`}
          title="更多：插件库 / 导出对话 / 巡检上报 / 清空"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          更多 ▾
        </button>
        <Dropdown
          anchor={moreBtnRef.current}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          align="end"
        >
          <button className="ai-scene-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); setPlgLibOpen(true); }}>
            本地插件库
          </button>
          <button className="ai-scene-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); void exportConversation(); }}>
            导出对话为 Markdown
          </button>
          <button
            className="ai-scene-menu-item"
            role="menuitem"
            disabled={!lastHasPatrol}
            title={lastHasPatrol ? "将最近回复中的「巡检发现」匿名上报，帮助改进软件" : "最近回复中没有巡检发现"}
            onClick={() => { setMoreOpen(false); void uploadPatrol(); }}
          >
            上传巡检报告
          </button>
          <div className="ai-menu-sep" />
          <button
            className="ai-scene-menu-item danger"
            role="menuitem"
            onClick={() => { setMoreOpen(false); void clearChatWithConfirm(); }}
          >
            清空当前对话
          </button>
        </Dropdown>
        {onDock ? (
          <button className="ai-icon-btn" title="停靠为面板：转为常规可停靠面板，适合大屏双栏" onClick={onDock}>
            <IconDock />
          </button>
        ) : (
          <button className="ai-icon-btn" title="弹出为浮窗（Ctrl+K 也可开关）" onClick={invokePop}>
            <IconPop />
          </button>
        )}
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
          {timeline.map((item) => {
            if (item.kind === "run") return <RunEntry key={item.key} view={item.run} />;
            const m = item.msg;
            const isLast = m.id === lastMsgId;
            const isStreamingMsg = isLast && chat.streaming && m.role === "assistant";
            // 流式期间最后一条 assistant 若完全为空，由下方 ai-streaming-only 兜底块统一显示光标，跳过避免双气泡
            if (isStreamingMsg && !m.content && !m.reasoning) return null;
            // P91 B3 → P96-K2：判据抽成纯函数并对 user/assistant 同规则（旧实现写死 assistant，
            // 用户自己发的长文因此无限撑高整屏）
            const mode = bubbleMode(m, isStreamingMsg);
            const clip = mode === "clip" && !expanded[m.id];
            const canClip = mode === "clip";
            return (
              <div key={m.id} className={`ai-msg ${m.role}`}>
                <div className={`ai-msg-bubble${clip ? " clipped" : ""}`}>
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
                            commitResend(m, editText);
                          } else if (e.key === "Escape") {
                            setEditingId("");
                          }
                        }}
                      />
                      <div className="ai-tpl-actions">
                        <button
                          className="btn primary"
                          onClick={() => commitResend(m, editText)}
                        >
                          {chatStore.resendKindOf(m) === "agent" ? "保存并重发任务" : "保存并重发"}
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
                      {/* P91 B4：任务归属由时间线上紧跟其后的任务卡表达，不往气泡里塞说明行。
                          P96-K2：滚动只加在文本块上——附图留在限高容器之外，
                          否则"纯图长消息"也会被卷进去、缩略图把文字挤出可视区 */}
                      <div className={`ai-msg-text${mode === "scroll" ? " scroll" : ""}`}>{m.content}</div>
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
                    {canClip && (
                      <button
                        onClick={() => setExpanded((v) => ({ ...v, [m.id]: !v[m.id] }))}
                        title={expanded[m.id] ? "收拢这条长回复" : "展开查看完整内容"}
                      >
                        {expanded[m.id] ? "收拢" : `展开 ${m.content.length} 字`}
                      </button>
                    )}
                    {m.role === "assistant" && m.id === lastAssistantId && m.fromRunId && lastAgentGoal && (
                      <button
                        onClick={() => commitResend(lastAgentGoal, lastAgentGoal.content)}
                        title="按原目标重跑这个 Agent 任务（就地重发目标气泡，不重复堆一条）"
                      >
                        重跑任务
                      </button>
                    )}
                    {m.role === "assistant" && m.id === lastAssistantId && !m.fromRunId && (
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
                        {chatStore.resendKindOf(m) === "agent" && (
                          <button
                            onClick={() => startAgentRun(m.content, { replaceMsgId: m.id })}
                            title="截断此条之后的内容，以 Agent 任务重新发起"
                          >
                            重发任务
                          </button>
                        )}
                      </>
                    )}
                    <button onClick={() => chatStore.deleteMsg(m.id)}>删除</button>
                  </div>
                )}
                {m.role === "assistant" && m.contextTitles && m.contextTitles.length > 0 && (
                  <div className="ai-msg-ctx">附加上下文：{m.contextTitles.join(" · ")}</div>
                )}
                {/* P95-H4：系统替用户做过的取舍要说出来（不然就是"AI 怎么看不见我上一张图"） */}
                {m.role === "assistant" && m.notice && (
                  <div className="ai-msg-notice">{m.notice}</div>
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
          {/* P91 B1：Agent 任务卡已按时间插进上面的时间线，页脚位不再渲染任务流 */}
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
        {/* P90 C3：「发送方式」面板改为锚在 pill 上的浮层（原先在输入框上方、与触发器被 textarea 分到两侧） */}
        {modePanelOpen && (
          <Dropdown
            anchor={modePillRef.current}
            open={modePanelOpen}
            onClose={() => setModePanelOpen(false)}
            className="ai-agent-panel-drop"
          >
          <div className="ai-agent-panel" role="group" aria-label="Agent 工作方式与授权">
            {/*
              P98-M3：面板拆成**两个轴**。旧版把「普通对话」和 7 个档位塞进同一个 radiogroup，
              于是"用不用 Agent"和"Agent 有多大权"这两件可以自由组合的事被排成了互斥单选，
              再叠上第 7 项就地长出的 8 个域勾选 —— 用户数出"8 个发送方式"、说"过于繁杂"就是这么来的。
              现在：第一层只有 工作方式(2) + 授权档(3)；具体授权域收进「高级」折叠区，
              原来的工作区写入/设备收发/本机全能力 降级为该区里的一键预设 chip（能力一个没少）。
            */}
            <div className="ai-agent-group">
              <div className="ai-agent-group-title">工作方式</div>
              <div className="ai-agent-modes" role="radiogroup" aria-label="工作方式">
                <button
                  className={`ai-agent-mode${!agentMode ? " on" : ""}`}
                  role="radio"
                  aria-checked={!agentMode}
                  disabled={agentRunning}
                  onClick={() => {
                    setAgentMode(false);
                    setModePanelOpen(false);
                  }}
                >
                  <span className="ai-agent-mode-name">普通对话</span>
                  <span className="ai-agent-mode-desc">一问一答；不执行任何应用操作</span>
                </button>
                <button
                  className={`ai-agent-mode${agentMode ? " on" : ""}`}
                  role="radio"
                  aria-checked={agentMode}
                  disabled={agentRunning}
                  onClick={() => {
                    setAgentMode(true);
                    // 留在面板里：下一步就要选授权档，关掉等于逼用户再点开一次
                  }}
                >
                  <span className="ai-agent-mode-name">Agent 任务</span>
                  <span className="ai-agent-mode-desc">多轮自主执行，可读可写（下面选授权档）</span>
                </button>
              </div>
            </div>
            {agentMode && (
              <div className="ai-agent-group">
                <div className="ai-agent-group-title">授权档</div>
                <div className="ai-agent-modes" role="radiogroup" aria-label="授权档">
                  {PRIMARY_TIERS.map((t) => {
                    const on = tierIdOf(agentScope, agentAllowed) === t.id;
                    return (
                      <button
                        key={t.id}
                        className={`ai-agent-mode${on ? " on" : ""}`}
                        role="radio"
                        aria-checked={on}
                        disabled={agentRunning}
                        onClick={() => {
                          const r = resolveTier(t.id, agentAllowed);
                          setAgentScope(r.scope);
                          setAgentAllowed(r.allowed);
                          if (t.id === "read") setModePanelOpen(false);
                        }}
                      >
                        <span className="ai-agent-mode-name">{t.label}</span>
                        <span className="ai-agent-mode-desc">{t.desc}</span>
                      </button>
                    );
                  })}
                </div>
                {tierRestore.downgraded && agentMode && (
                  <span className="ai-agent-domains-empty">
                    上次这里是「全面放手 / 自定义勾选」。高危档不跨重启记忆（避免开机就带着满权限），
                    已回落到「放手改界面」——需要的话在上面的高级区重新勾上。
                  </span>
                )}
              </div>
            )}
            {agentMode && (
              <div className="ai-agent-group">
                <button
                  className="ai-agent-adv-head"
                  aria-expanded={advOpen}
                  disabled={agentRunning}
                  onClick={() => setAdvOpen((v) => !v)}
                >
                  <span className="ai-agent-adv-title">高级 · 具体授权域</span>
                  <span className="ai-agent-adv-sum">
                    {tierBadge(agentScope, agentAllowed)} · {DOMAINS.filter((d) => hasDomain(agentScope, agentAllowed, d)).length} 项已授
                  </span>
                  <span className="ai-agent-adv-caret">{advOpen ? "收起" : "展开"}</span>
                </button>
                {advOpen && (
                  <>
                    <div className="ai-agent-presets" role="group" aria-label="授权域预设">
                      {DOMAIN_PRESETS.map((p) => {
                        const on = tierIdOf(agentScope, agentAllowed) === p.id;
                        return (
                          <button
                            key={p.id}
                            className={`ai-agent-preset${on ? " on" : ""}`}
                            disabled={agentRunning}
                            title={p.desc}
                            onClick={() => {
                              const r = resolveTier(p.id, agentAllowed);
                              setAgentScope(r.scope);
                              setAgentAllowed(r.allowed);
                            }}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="ai-agent-domains">
                      {DOMAINS.map((k) => (
                        <label key={k} className="ai-agent-domain" title={DOMAIN_TIP[k]}>
                          <input
                            type="checkbox"
                            disabled={agentRunning}
                            checked={hasDomain(agentScope, agentAllowed, k)}
                            onChange={(e) => {
                              // **关键一步**：create 档下 allowed 是被 hasDomain 忽略的（它的域集是隐含的），
                              // 所以不先把 scope 抬到 custom 就直接改勾选，用户会看到"勾了没反应"。
                              // 这里以当前档的隐含域集为底再增删，勾选立刻就是真生效的那一份。
                              const base = resolveTier(
                                agentScope === "create" ? "create" : tierIdOf(agentScope, agentAllowed),
                                agentAllowed,
                              ).allowed;
                              const next = e.target.checked
                                ? [...new Set([...base, k])]
                                : base.filter((x) => x !== k);
                              setAgentScope("custom");
                              setAgentAllowed(next);
                            }}
                          />
                          {DOMAIN_ZH[k]}
                        </label>
                      ))}
                    </div>
                    <span className="ai-agent-domains-empty">
                      一项都不勾时按「放手改界面」同权执行（配置 + 插件库），不会出现"选了自定义却什么都改不动"。
                    </span>
                  </>
                )}
              </div>
            )}
            {agentMode && !agentRunning && (
              <div className="ai-agent-group">
                <div className="ai-agent-group-title">常用任务</div>
                <div className="ai-agent-quick" role="group" aria-label="常用任务">
                  {QUICK_TASKS.map((t) => (
                    <button
                      key={t.label}
                      className="ai-agent-quick-chip"
                      title={t.tip}
                      onClick={() => {
                        setInput(t.goal);
                        setModePanelOpen(false); // 与档位一致：选完即收，不留一个"点了不关"的异类
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {agentMode && (
              <div className="ai-agent-group ai-agent-group-meta">
                <span className="ai-agent-budget">
                  预算 {DEFAULT_BUDGET.maxRounds} 轮 / {DEFAULT_BUDGET.maxCalls} 次工具 / {Math.round(DEFAULT_BUDGET.timeoutMs / 60000)} 分钟
                  {agentRunning ? "（运行中，设置已锁定）" : ""}
                </span>
              </div>
            )}
          </div>
          </Dropdown>
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
        {/* P90 C2：＋菜单改浮层（原先是流内块，展开时把输入行整体顶下去） */}
        {plusOpen && (
          <Dropdown
            anchor={plusBtnRef.current}
            open={plusOpen}
            onClose={() => setPlusOpen(false)}
            className="ai-plus-drop"
          >
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
          </Dropdown>
        )}
        <div className="ai-input-row">
          <button ref={plusBtnRef} className="ai-plus" title="附加图片、文件或上下文" onClick={() => setPlusOpen((v) => !v)} aria-haspopup="menu" aria-expanded={plusOpen}>
            <IconPlus />
          </button>
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={
              agentMode
                ? agentRunning
                  ? "Agent 任务运行中…可点右侧红色按钮停止后继续"
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
          {chat.streaming || agentRunning ? (
            <button
              className="ai-send stop"
              title={agentRunning ? "停止 Agent 任务" : "停止生成"}
              onClick={() => {
                if (agentRunning && agentActive) agentRun.stopRun(agentActive.runId);
                else chatStore.abort();
              }}
            >
              <IconStop />
            </button>
          ) : (
            <button
              className="ai-send"
              title="发送（Enter）"
              disabled={!canSend}
              onClick={doSend}
            >
              <IconSend />
            </button>
          )}
        </div>
        {/* P90 C1/C3：发送方式唯一入口=这个 pill；运行徽标与进度按**当前会话**的任务显示 */}
        <div className="ai-tools-row">
          <button
            ref={modePillRef}
            className={`ai-mode-pill${agentMode ? " on" : ""}`}
            title="选择工作方式与授权档：普通对话一问一答，Agent 任务多轮自主执行"
            onClick={() => setModePanelOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={modePanelOpen}
          >
            {agentMode ? `Agent 任务 · ${tierBadge(agentScope, agentAllowed)}` : "普通对话"}
            {sessionBadge && (
              <span className={`agent-badge${sessionRun?.pending ? " warn" : ""}`}>{sessionBadge}</span>
            )}
            <IconChevron dir="down" size={12} />
          </button>
          {sessionRun && (
            <span className="ai-agent-prog">
              第 {sessionRun.rounds} 轮 · {sessionRun.calls} 次工具
            </span>
          )}
          {/*
            P98-M4：上下文用量条常驻在输入区（旧版只有跑起来之后、在任务卡里露一个
            「上下文 N KB」的细胶囊，既没有分母也没有百分比，用户判断不了还剩多少）。
            这里显示的是**下一次发送真正会带上的那份投影**，所以压缩按钮按下去数字就动。
          */}
          {agentMode && (
            <span className={`ai-ctx-meter${ctxMeter.level !== "ok" ? ` ${ctxMeter.level}` : ""}`}>
              <span className="ai-ctx-bar" aria-hidden="true">
                <span className="ai-ctx-bar-fill" style={{ width: `${ctxMeter.pct}%` }} />
              </span>
              <span className="ai-ctx-num">{ctxMeter.text}</span>
              {ctxEstimate.shadowed > 0 && (
                <span className="ai-ctx-shadowed" title="较早的工具回执已只以摘要下发（台账未删）">
                  已折 {ctxEstimate.shadowed}
                </span>
              )}
              <button
                className="ai-ctx-btn"
                disabled={atBudgetFloor || agentRunning}
                title={
                  atBudgetFloor
                    ? "已到压缩下限：再小模型就没有上下文了。要彻底清空请新建会话"
                    : agentRunning
                      ? "任务运行中，等它结束再压缩"
                      : "把更早的会话历史收得更紧一些再发（台账一条不删，本会话内不可还原）"
                }
                onClick={compressContext}
              >
                压缩
              </button>
              {ctxBudget < HISTORY_CHAR_BUDGET && (
                <button className="ai-ctx-btn ghost" onClick={resetContextBudget} title="恢复完整历史预算">
                  还原
                </button>
              )}
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
