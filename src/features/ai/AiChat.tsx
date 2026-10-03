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
import { getSnapshot as getSettings, patch, useSettings } from "../settings/settingsStore";
import { activeRef, useAiProfiles } from "./aiProfileStore";
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
import { buildAgentHistory, budgetFor, HISTORY_CHAR_BUDGET, MIN_HISTORY_BUDGET, tightenHistoryBudget } from "../agent/sessionLog";
import { windowGauge } from "../agent/contextBudget";
import { AiModelChip } from "./AiModelPicker";
import { agentPayloadBytes, ctxGauge } from "../agent/context";
import {
  DOMAINS, DOMAIN_PRESETS, DOMAIN_TIP, DOMAIN_ZH, PRIMARY_TIERS, hasDomain, rememberTier, resolveTier, restoreTier, tierBadge, tierIdOf, type Domain,
} from "../agent/scopeTiers";
import * as agentRun from "../agent/agentRun";
import { isLiveRun, type RunScope } from "../agent/types";
import { Dropdown } from "../../shared/Dropdown";
import { PluginLibraryDialog } from "../plugins/PluginLibraryDialog";
import { resolveVars } from "../controls/variableStore";
import * as serialStore from "../serial/serialStore";
import { detectAnomalies, anomaliesToText, type Anomaly } from "./anomaly";
import { Markdown, CodeBlock, parseSegments } from "./markdown";
import { EmptyState } from "../../shared/EmptyState";
import { Glyph, IconChevron, IconClose, IconDock, IconPlus, IconPop, IconSend, IconSparkle, IconStop } from "../../shared/icons";
import { confirmDialog } from "../../shared/Dialog";
import { ErrorBoundary } from "../../shared/ErrorBoundary";
import { t, tx, useLocale } from "../../i18n/strings";
import { HelpHint } from "../../shared/HelpHint";

const BUG_ENDPOINT = "https://larix.teuioe.cn/api/bugreport.php";

/**
 * 「巡检发现」那一节的小节标题。**这不是界面文案，是提示词与回执之间的暗号**：
 * `prompts.ts` 要求模型在回答末尾用这一节列出发现的问题，本文件靠它判断"这次有没有可上报的东西"。
 * 换语言要两边一起换，而且换了之后**旧会话的历史回复**还是老标题，判据会漏 ——
 * 所以它留在这里不动，本批只翻它周围的句子。
 */
const PATROL_MARKER = "巡检发现";

/**
 * P88b-4 B：常用任务快捷入口（Agent 模式面板内，点击填入输入框；覆盖外观/诊断/插件典型场景）。
 *
 * 这几张表原来是**模块级常量**，现在改成"取的时候才拼"的函数：`goal` 会被填进输入框、
 * 成为任务气泡上那行字，`label / tip` 直接上屏 —— 在模块求值期翻一次就把语言钉死在那一刻了。
 * 翻的是**用户自己选的那条示例目标**（他打英文就会是英文），系统提示词那套在 `prompts.ts`，本批不动。
 */
const quickTasks = () => [
  {
    label: tx("大字号+减少动效", "Bigger text, less motion"),
    goal: tx(
      "把界面字号调大一档、动效放缓，满意后保存为插件并启用，告诉我怎么停用",
      "Raise the UI font one step and slow the motion down; once I like it, save it as a plugin and enable it, and tell me how to turn it off",
    ),
    tip: tx(
      "字号与动效配方：先预览，再自动保存为已启用插件（本卡或插件库可停用）",
      "Font and motion recipe: preview first, then auto-save as an enabled plugin (disable from this card or the plugin library)",
    ),
  },
  {
    label: tx("玻璃质感主题", "Glass theme"),
    goal: tx(
      "先用 theme_preset 的玻璃配方（glass）按当前主题派生整套外观：面板、嵌底、边框、文字、主色一起调，不要只改两三个 token；我看过效果后保存为「我的玻璃主题」并启用",
      "Start from the theme_preset glass recipe and derive the whole look from the current theme: panels, insets, borders, text and accent together, not just two or three tokens; after I see it, save it as “My Glass Theme” and enable it",
    ),
    tip: tx(
      "走内置玻璃配方（跟随当前主题色派生一组 token），保存后是一份完整主题插件，可随时停用",
      "Uses the built-in glass recipe (a token set derived from the current theme colors); saving yields a complete theme plugin you can disable any time",
    ),
  },
  {
    label: tx("只读诊断面板", "Read-only diagnostic panel"),
    goal: tx("分析当前曲线数据的异常区间，生成一个只读的诊断面板", "Analyse the current curve data for abnormal ranges and build a read-only diagnostic panel"),
    tip: tx("读取通道统计后生成卡片面板，不改数据", "Reads channel statistics, then builds a card panel; changes no data"),
  },
  {
    label: tx("面板另存紧凑版", "Save a compact copy"),
    goal: tx(
      "把当前面板的标题单位改成中文，另存一个紧凑版副本，不覆盖原版",
      "Change the current panel’s title units to Chinese, then save a compact copy without overwriting the original",
    ),
    tip: tx("修改后另存新插件，原版保持不变", "Saves the change as a new plugin; the original stays untouched"),
  },
];

const sceneHint = (scene: AiScene): string | undefined => {
  switch (scene) {
    case "genCommand":
      return tx(
        "生成指令：描述你要发送的指令，如「把 roll 归零并每 100ms 上报一次」",
        "Generate command: describe what to send, e.g. “zero the roll and report every 100ms”",
      );
    case "genCard":
      return tx(
        "生成卡片：描述你要的控制卡片，如「一个控制电机转速的滑条，0-100」",
        "Generate card: describe the control card you want, e.g. “a 0-100 slider for motor speed”",
      );
    case "create":
      return tx(
        "创造：描述你想要的主题/小部件/面板，我会引导你用 Agent 任务把它保存为插件并自动启用",
        "Create: describe the theme, widget or panel you want — I’ll walk you through saving it as a plugin via an Agent task, enabled automatically",
      );
    case "diagnose":
      return tx("诊断问题：描述你遇到的问题，如「收不到数据」", "Diagnose: describe what’s wrong, e.g. “no data coming in”");
    default:
      return undefined;
  }
};

/** 上下文那五格：键序是一件事（结构），标签是另一件事（文案），所以清单与 switch 分开放 */
const CONTEXT_KEYS: (keyof ContextSelection)[] = ["conn", "protocol", "protoFull", "samples", "hex"];

const contextLabel = (k: keyof ContextSelection): string => {
  switch (k) {
    case "conn":
      return tx("连接配置", "Connection config");
    case "protocol":
      return tx("协议清单", "Protocol list");
    case "protoFull":
      return tx("协议完整定义", "Full protocol definition");
    case "samples":
      return tx("数据样本", "Data samples");
    case "hex":
      return tx("Hex 选区", "Hex selection");
  }
};

/** P88e C1：可附加的文本类文件后缀（随消息以代码块形式发给模型） */
const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|log|ini|cfg|conf|xml|yaml|yml|toml|ts|tsx|js|jsx|py|c|h|cpp|hpp|rs|go|java|html|css|sql|bat|ps1|sh)$/i;

/** P88e C1：顶部工具栏收拢后「场景 ▾」下拉的场景项（与 quickPick 对接）。同样是取的时候才拼。 */
const sceneMenu = () => [
  { scene: "protocol" as const, label: tx("识别协议", "Detect protocol"), tip: tx("框选 Hex 字节后点击，AI 推断帧结构并生成模板", "Select Hex bytes first; the AI infers the frame layout and builds a template") },
  { scene: "interpret" as const, label: tx("解读数据", "Interpret data"), tip: tx("根据最近帧数据概括设备状态与异常", "Summarise device state and anomalies from recent frames") },
  { scene: "analyzeCurve" as const, label: tx("分析曲线", "Analyse curves"), tip: tx("分析当前 2D 曲线各通道的统计特征与周期", "Statistics and periodicity per channel of the current 2D curve") },
  { scene: "genCommand" as const, label: tx("生成指令", "Generate command"), tip: tx("描述需求，AI 生成命令模板或脚本", "Describe the need; the AI writes a command template or script") },
  { scene: "genCard" as const, label: tx("生成卡片", "Generate card"), tip: tx("描述需求，AI 生成控制卡片并写入控制画布", "Describe the need; the AI builds a control card on the control canvas") },
  { scene: "create" as const, label: tx("创造", "Create"), tip: tx("主题 / 小部件 / 面板（经 Agent 任务保存为插件并自动启用）", "Theme / widget / panel (saved as a plugin via an Agent task, auto-enabled)") },
  { scene: "diagnose" as const, label: tx("诊断", "Diagnose"), tip: tx("描述问题，结合连接状态给出排查清单", "Describe the problem; get a checklist against the current link state") },
  { scene: "report" as const, label: tx("调试报告", "Debug report"), tip: tx("汇总本次会话生成 Markdown 调试报告", "Sum up this session into a Markdown debug report") },
];

function ResultLine({ result }: { result: { ok: boolean; msg: string } }) {
  return <span className={result.ok ? "ai-tpl-ok" : "ai-tpl-err"}>{result.msg}</span>;
}

function TemplateWriteBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  return (
    <div className="ai-tpl-block">
      <div className="ai-tpl-head">{tx("候选协议模板", "Candidate protocol template")}</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button
          className="btn primary"
          onClick={() => setResult(writeTemplateFromAiJson(code))}
        >
          {tx("写入协议模板", "Save as protocol template")}
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
      <div className="ai-tpl-head">{tx("生成的命令", "Generated command")}</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      {resolved && (
        <div className="ai-tpl-preview">
          {tx("预览发送内容：", "Preview of what will be sent:")}
          <code>{resolved}</code>
          {hasFormatPlaceholder(template) && (
            <span className="ai-tpl-note">
              {tx(
                "（含 %d/%.2f 占位符，需在命令库/控制画布中配合输入值发送）",
                "(contains %d/%.2f placeholders — send it from the command library or a control card so values can be filled in)",
              )}
            </span>
          )}
        </div>
      )}
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCommandFromAiJson(code))}>
          {tx("加入命令库", "Add to command library")}
        </button>
        <button
          className="btn"
          disabled={!directOk}
          title={
            directOk
              ? tx("不经命令库直接发送一次", "Send once without going through the command library")
              : tx(
                  "模板含格式化占位符或脚本，需在命令库/控制画布中配合输入值发送",
                  "The template has format placeholders or a script; send it from the command library or a control card so values can be filled in",
                )
          }
          onClick={() => {
            if (!directOk || !parsed) return;
            void serialStore.sendData(parsed.sendMode === "hex" ? "hex" : "ascii", template);
            setResult({ ok: true, msg: tx("已临时发送", "Sent once") });
          }}
        >
          {tx("临时发送", "Send once")}
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
      <div className="ai-tpl-head">{tx("生成的控制卡片", "Generated control card")}</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCardFromAiJson(code))}>
          {tx("写入控制画布", "Place on the control canvas")}
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
      <div className="ai-tpl-head">{tx("自定义协议（指令工厂）", "Custom protocol (command factory)")}</div>
      <pre className="ai-tpl-pre">{code.length > 600 ? code.slice(0, 600) + "\n…" : code}</pre>
      <div className="ai-tpl-actions">
        <button className="btn primary" onClick={() => setResult(writeCodecFromAiJson(code))}>
          {tx("写入指令工厂", "Install into the command factory")}
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
    parseErr = tx("JSON 解析失败", "JSON parse failed");
  }
  /**
   * 回执原来是"一条字符串，靠 `startsWith("失败")` 判成败"。翻译之后那个判别就断了 ——
   * 英文界面下 `Failed: …` 不以"失败"开头，错的动作会被染成绿色当成成功。
   * 所以把成败存成结构，不藏在前缀里。
   */
  const [results, setResults] = useState<{ ok: boolean; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const destructive = actions?.some((a) => DESTRUCTIVE_ACTIONS.has(a.kind)) ?? false;

  const runAll = async () => {
    if (!actions || running) return;
    setRunning(true);
    const { runAppAction, actionDataText } = await import("./appActions");
    const out: { ok: boolean; text: string }[] = [];
    for (const a of actions) {
      try {
        const r = await runAppAction(a.kind, a.args ?? {}, { highPriv: true });
        out.push(r.ok ? { ok: true, text: actionDataText(r.data) } : { ok: false, text: tx(`失败：${r.err}`, `Failed: ${r.err}`) });
      } catch (e) {
        const why = String(e).slice(0, 100);
        out.push({ ok: false, text: tx(`失败：${why}`, `Failed: ${why}`) });
      }
    }
    setResults(out);
    setRunning(false);
  };

  if (!actions || actions.length === 0) {
    return (
      <div className="ai-tpl-block">
        <div className="ai-tpl-head">{tx("动作执行", "Action run")}</div>
        <div className="ai-tpl-err">{parseErr || tx("没有可执行的动作", "No actions to run")}</div>
      </div>
    );
  }
  return (
    <div className={`ai-tpl-block${destructive ? " ai-action-danger" : ""}`}>
      <div className="ai-ext-head">
        <span>{tx(`动作执行 · ${actions.length} 步`, `Action run · ${actions.length} step(s)`)}</span>
        {destructive && <span className="ai-ext-badge warn">{tx("含破坏性操作", "includes destructive actions")}</span>}
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
              <span className={results[i]!.ok ? "ai-tpl-ok" : "ai-tpl-err"}>
                {results[i]!.text}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="ai-tpl-actions">
        <button className="btn primary" disabled={running} onClick={() => void runAll()}>
          {running ? tx("执行中…", "Running…") : tx("执行", "Run")}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 消息渲染 ---------------- */

/** 思考耗时（秒）显示文本 */
function fmtThink(secs: number): string {
  const m = Math.floor(secs / 60);
  return secs >= 60 ? tx(`${m} 分 ${secs % 60} 秒`, `${m}m ${secs % 60}s`) : tx(`${secs} 秒`, `${secs}s`);
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
          {tx("等待思维链…", "Waiting for the chain of thought…")}
        </div>
      </div>
    ) : null;
  }
  if (!show) {
    return live ? (
      <div className="ai-think live collapsed">
        <div className="ai-think-head">
          <span className="ai-think-dot" />
          {tx(`思考中 · ${fmtThink(secs)}`, `Thinking · ${fmtThink(secs)}`)}
        </div>
      </div>
    ) : null;
  }
  return live ? (
    <div className="ai-think live">
      <div className="ai-think-head">
        <span className="ai-think-dot" />
        {tx(`思考中 · ${fmtThink(secs)}`, `Thinking · ${fmtThink(secs)}`)}
      </div>
      <div className="ai-reasoning-body">{text}</div>
      <span className="ai-caret" />
    </div>
  ) : (
    <details className="ai-think done">
      <summary>
        <span className="think-caret"><IconChevron dir="right" /></span> {tx(`已深度思考（${fmtThink(secs)}）`, `Thought for ${fmtThink(secs)}`)}
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
        <span>{tx("内容生成中…", "Generating…")}</span>
        <span className="ai-ext-badge">{tx("流式", "streaming")}</span>
      </div>
      <pre className="ai-tpl-pre">{code.length > 300 ? "…" + code.slice(-300) : code}</pre>
      <div className="ai-tpl-actions">
        <span className="ai-tpl-ok">{tx(`已生成 ${lines} 行，输出完成后自动出现安装/执行按钮`, `Generated ${lines} line(s); the install/run buttons appear when the output finishes`)}</span>
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
      title: tx("保存调试报告", "Save debug report"),
      defaultPath: `uartix-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof path !== "string") return;
    try {
      await invoke("save_text_file", { path, content });
      setSaved(tx("已保存", "Saved"));
    } catch (e) {
      setSaved(tx(`保存失败：${e}`, `Save failed: ${e}`));
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
            {tx("保存为 Markdown", "Save as Markdown")}
          </button>
          {saved && <span className="ai-tpl-ok">{saved}</span>}
        </div>
      )}
    </>
  );
}

/* ---------------- 会话侧栏 ---------------- */

/**
 * P109-A：预算的读法。0 = 不限制，写成 "0" 会被读成"预算是 0、任务该立刻停"——那是反的。
 * 用 `∞` 而不是"不限"这个词：`预算 不限 轮` 读不通，而 `∞` 与 `AgentInline` 里同一处同一记号，
 * 也不用翻。
 */
function capWord(n: number): string {
  return n === 0 ? "∞" : String(n);
}

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
  /** 会话没有标题时的那个兜底名，两处都要用（也为了 `tx()` 的参数里不套引号，见 .tools/check-i18n.cjs 头部） */
  const fallbackTitle = tx("新对话", "New chat");

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
          {tx("新对话", "New chat")}
        </button>
        <button className="ai-mode-close" onClick={onClose}>
          {tx("收起", "Collapse")}
        </button>
      </div>
      {/* P90 C5：抽屉顶部说明当前看的是哪个会话（切换后所见即所写） */}
      <div className="ai-side-cur">
        {tx(`当前会话：${active?.title || fallbackTitle}`, `Current session: ${active?.title || fallbackTitle}`)}
      </div>
      <input
        className="input ai-side-search"
        placeholder={tx("搜索历史消息…", "Search past messages…")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="ai-side-list">
        {q.trim() ? (
          hits.length === 0 ? (
            <div className="ai-ctx-empty">{tx("没有匹配的消息", "No matching messages")}</div>
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
                title={tx("单击切换 · 双击重命名", "Click to switch · double-click to rename")}
              >
                <span className="ai-side-title">{s.title || fallbackTitle}</span>
                <span className="ai-side-meta">
                  {fmtSessionTime(s.updatedAt)} · {tx(`${s.messages.length} 条`, `${s.messages.length} message(s)`)}
                </span>
                <button
                  className="ai-side-del"
                  title={tx("删除会话", "Delete session")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void (async () => {
                      const name = s.title || fallbackTitle;
                      if (
                        await confirmDialog({
                          message: tx(`删除会话「${name}」？不可恢复。`, `Delete session “${name}”? This cannot be undone.`),
                          danger: true,
                          okLabel: tx("删除", "Delete"),
                        })
                      ) {
                        chatStore.deleteSession(s.id);
                        notify(tx("会话已删除", "Session deleted"));
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
          {tx(`本会话 ${active?.usage.prompt ?? 0}/${active?.usage.completion ?? 0} tok`, `This session ${active?.usage.prompt ?? 0}/${active?.usage.completion ?? 0} tok`)}
        </div>
        <div className="ai-usage-line dim">
          {tx(`累计 ${totals.prompt}/${totals.completion} tok（输入/输出）`, `Total ${totals.prompt}/${totals.completion} tok (in/out)`)}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export function AiChat({ onDock }: { onDock?: () => void }) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
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
  // P111-E：上下文百分比点开的那一面（照 Qoder：常驻只有数字，细节在浮层里）
  const [meterOpen, setMeterOpen] = useState(false);
  const meterBtnRef = useRef<HTMLButtonElement>(null);
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
  const [tierRestore] = useState(() => restoreTier(getSettings().agentRestoreTier));
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
      ? tx("待批准", "awaiting approval")
      : sessionRun.status === "paused"
        ? tx("已暂停", "paused")
        : tx("运行中", "running")
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

  // P110-B1：配置态来自档案表。必须**订阅那张表**——只订 settingsStore 的话，
  // 在设置页加好供应商回到对话面板，这里不会刷新（旧的"未配置"空态就一直挂着）。
  const profiles = useAiProfiles();
  const configured = !!activeRef(profiles);

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
  // P110-B2：预算不再是"一个跟模型无关的 12000"。自动值 = 当前模型窗口 × 压缩阈值
  // （`aiCompactRatio`），并被传输保险丝封顶；手动压缩写进 `aiHistoryOverride` 并持久化。
  // 窗口改了而手动值还留着时以窗口为准（否则换了个 8k 的小模型，历史照旧堆 2 万字）。
  const aiProfilesForCtx = useAiProfiles();
  const activeForCtx = activeRef(aiProfilesForCtx);
  const autoBudget = budgetFor(activeForCtx?.model.contextTokens ?? 0, settings.aiCompactRatio);
  const ctxBudget = settings.aiHistoryOverride > 0 ? Math.min(settings.aiHistoryOverride, autoBudget) : autoBudget;
  // sessionRuns 每次 agentSnap 变化都是新数组 ⇒ 用"内容摘要"当实质依赖（写在数组外，规则才能静态检查）
  const runsWork = sessionRuns.reduce((n, r) => n + r.rounds + r.calls, 0);
  const ctxEstimate = useMemo(() => {
    const hist = buildAgentHistory(messages, sessionRuns, { budgetChars: ctxBudget });
    return { bytes: agentPayloadBytes(hist.messages), shadowed: hist.stats.shadowed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, ctxBudget, sessionRuns.length, runsWork]);
  const ctxMeter = ctxGauge(ctxEstimate.bytes);
  // P110-B4：**第二个分母**。`ctxGauge` 那条量的是传输保险丝（"这次请求会不会被宿主 2 MiB 撞断"），
  // 这一条量的是模型窗口（"历史到这儿就该折叠了"）。两条各管一件事，合成一条就会撒谎——
  // 旧版只有传输那条，于是出现过"仪表显示 1%、其实正在丢 36 条历史"（详设 §2.1）。
  const ctxWindow = windowGauge(ctxEstimate.bytes, activeForCtx?.model.contextTokens ?? 0, settings.aiCompactRatio);
  // P110-B3：**第二个分母** —— 已用占当前模型窗口的比例。两条线各管各的含义：传输那条说
  // "这次请求会不会被宿主 2 MiB 撞断"，窗口那条说"历史到这儿就该折叠了"。
  // 合成一个数就会撒谎：旧版只有传输那条，于是出现过"仪表显示 1%、其实正在丢 36 条历史"。
  const atBudgetFloor = ctxBudget <= MIN_HISTORY_BUDGET;
  const compressContext = () => {
    const next = tightenHistoryBudget(ctxBudget);
    if (next === ctxBudget) return; // 已到下限：按钮此时是禁用的，这里只是双保险不静默空转
    // 写进设置而不是 useState：切面板/重挂不丢，且"还原"有一个明确的可逆对象
    patch({ aiHistoryOverride: next });
    setNotice(tx(`已压缩：会话历史预算 ${ctxBudget} → ${next} 字，更早的工具回执只以摘要下发（台账一条不删）`, `Compressed: session history budget ${ctxBudget} → ${next} chars; older tool receipts now go as summaries (the ledger keeps every entry)`));
  };
  const resetContextBudget = () => {
    patch({ aiHistoryOverride: 0 });
    setNotice(tx("已恢复按模型窗口自动计算的历史预算", "History budget restored to the model-window default"));
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

  // P99a-D1b：任务模板「载入 AI 助手」——只填输入框，不代发（发不发、哪个授权档由用户决定）
  useEffect(() => {
    const d = chat.pendingDraft;
    if (d === null) return;
    chatStore.consumeDraft();
    setInput(d);
    inputRef.current?.focus();
  }, [chat.pendingDraft]);

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
      setNotice(tx("每条消息最多附带 4 张图片", "Up to 4 images per message"));
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
      setNotice(tx("每条消息最多附带 4 个文件", "Up to 4 files per message"));
      return;
    }
    for (const f of list) {
      if (!TEXT_FILE_RE.test(f.name)) {
        setNotice(tx(`暂不支持的文件类型：${f.name}（支持文本类：.txt/.md/.csv/.json/.log 等）`, `Unsupported file type: ${f.name} (text files work: .txt/.md/.csv/.json/.log and similar)`));
        continue;
      }
      if (f.size > 256 * 1024) {
        setNotice(tx(`文件过大（${f.name} 超过 256KB），请截取关键部分`, `${f.name} is over 256KB — trim it down to the relevant part`));
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
      setNotice(tx("已有 Agent 任务在运行，请先停止或等待完成", "An Agent task is already running — stop it or wait for it first"));
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
        message: tx(
          "清空当前对话的全部消息？不可恢复（Agent 任务台账在卡片上单独删除）。",
          "Clear every message in this conversation? This cannot be undone (Agent task ledgers are deleted from their own cards).",
        ),
        danger: true,
        okLabel: tx("清空", "Clear"),
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
        ? pendingFiles
            .map((f) =>
              tx(`【附加文件：${f.name}】\n\`\`\`\n${f.text}\n\`\`\``, `[Attached file: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``),
            )
            .join("\n\n") + "\n\n"
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
        setNotice(tx("请先在 Hex 数据流中框选一段字节，再点「识别协议」", "Select a byte range in the Hex stream first, then choose “Detect protocol”"));
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
    void navigator.clipboard.writeText(text).then(() => setNotice(tx("已复制", "Copied")));
  };

  const exportConversation = async () => {
    const path = await save({
      title: tx("导出对话", "Export conversation"),
      defaultPath: `uartix-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof path !== "string") return;
    try {
      // P133-I：把本会话的 Agent 任务一起交给导出器——导出的是现场，不是只有结果两段话
      await invoke("save_text_file", { path, content: chatStore.exportSessionMd(sessionRuns) });
      setNotice(tx("对话已导出", "Conversation exported"));
    } catch (e) {
      setNotice(tx(`导出失败：${String(e).slice(0, 80)}`, `Export failed: ${String(e).slice(0, 80)}`));
    }
  };

  const uploadPatrol = async () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last || !last.content.includes(PATROL_MARKER)) {
      setUploadState(tx("最近回复中没有巡检发现", "No patrol findings in the last reply"));
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
      setUploadState(
        resp.includes("OK")
          ? tx("已上报，感谢反馈", "Uploaded — thanks for the feedback")
          : tx(`服务器响应：${resp.slice(0, 80)}`, `Server response: ${resp.slice(0, 80)}`),
      );
    } catch (e) {
      setUploadState(tx(`上报失败：${String(e).slice(0, 100)}`, `Upload failed: ${String(e).slice(0, 100)}`));
    }
  };

  const lastHasPatrol = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")
    ?.content.includes(PATROL_MARKER);

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  // P94-G5：Agent 结论气泡的按钮语义是"按原目标重跑任务"，不是"把这句结论重说一遍"
  const lastAgentGoal = [...messages].reverse().find((m) => m.role === "user" && m.via === "agent");

  const ctxBlocks = collectContext(chat.contextSel);
  /** 「≈N tok」那个尾巴：单位是语言中性的，不套 tx()（套了反而要把表达式嵌进 tx 的参数里） */
  const ctxTokNote = ctxBlocks.length
    ? ` · ≈${estimateTokens(ctxBlocks.map((b) => b.text).join("\n")) + estimateTokens(input)} tok`
    : "";
  const checkedCtxCount = Object.values(chat.contextSel).filter(Boolean).length;

  if (!configured) {
    return (
      <div className="ai-chat">
        <div className="ai-empty-wrap">
          <EmptyState
            title={tx("AI 助手尚未配置", "The AI assistant isn't configured yet")}
            hint={[
              tx("选一个服务商预设、填入 API Key 就能用", "Pick a provider preset and drop in an API key"),
              tx("Key 只存在本机，请求由本机程序转发", "The key stays on this machine; requests are relayed by the app itself"),
            ]}
          />
          <HelpHint
            text={tx(
              "支持 OpenAI 兼容 / DeepSeek / 通义千问 / 本地 Ollama。",
              "Works with OpenAI-compatible / DeepSeek / Qwen / a local Ollama.",
            )}
          />
          <button className="btn primary" onClick={() => invokeOpenSettings()}>
            {tx("打开设置", "Open Settings")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-chat">
      <div className="ai-toolbar p-bar">
        <button
          className={`ai-icon-btn${sideOpen ? " on" : ""}`}
          title={tx("会话列表：多会话切换、搜索历史、双击重命名", "Session list: switch sessions, search history, double-click to rename")}
          onClick={() => setSideOpen((v) => !v)}
        >
          <Glyph><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="17" y2="18" /></Glyph>
        </button>
        {/* P90 C1：顶栏删「Agent 任务」钮——发送方式唯一入口在输入区 pill；
            P90 C2：场景下拉改浮层（portal + fixed），不再被工具栏 overflow-x 裁到只剩几像素 */}
        <button
          ref={sceneBtnRef}
          className={`ai-scene-btn${sceneMenuOpen ? " on" : ""}`}
          title={tx("分析 / 生成 / 报告等场景入口", "Scene shortcuts: analyse / generate / report")}
          aria-haspopup="menu"
          aria-expanded={sceneMenuOpen}
          onClick={() => setSceneMenuOpen((v) => !v)}
        >
          {tx("场景 ▾", "Scenes ▾")}
        </button>
        <Dropdown
          anchor={sceneBtnRef.current}
          open={sceneMenuOpen}
          onClose={() => setSceneMenuOpen(false)}
        >
          {sceneMenu().map((s) => (
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
          title={tx("更多：插件库 / 导出对话 / 巡检上报 / 清空", "More: plugin library / export chat / patrol report / clear")}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          {tx("更多 ▾", "More ▾")}
        </button>
        <Dropdown
          anchor={moreBtnRef.current}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          align="end"
        >
          <button className="ai-scene-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); setPlgLibOpen(true); }}>
            {tx("本地插件库", "Local plugin library")}
          </button>
          <button className="ai-scene-menu-item" role="menuitem"
            title={tx("含思维链、每次工具调用的参数与回执；API Key 一类秘密写出时会打码",
              "includes the thinking chain, every tool call's args and receipt; API keys are masked on the way out")}
            onClick={() => { setMoreOpen(false); void exportConversation(); }}>
            {tx("导出对话为 Markdown", "Export conversation as Markdown")}
          </button>
          <button
            className="ai-scene-menu-item"
            role="menuitem"
            disabled={!lastHasPatrol}
            title={
              lastHasPatrol
                ? tx("将最近回复中的「巡检发现」匿名上报，帮助改进软件", "Anonymously upload the “patrol findings” from the last reply to help improve the app")
                : tx("最近回复中没有巡检发现", "No patrol findings in the last reply")
            }
            onClick={() => { setMoreOpen(false); void uploadPatrol(); }}
          >
            {tx("上传巡检报告", "Upload patrol report")}
          </button>
          <div className="ai-menu-sep" />
          <button
            className="ai-scene-menu-item danger"
            role="menuitem"
            onClick={() => { setMoreOpen(false); void clearChatWithConfirm(); }}
          >
            {tx("清空当前对话", "Clear this conversation")}
          </button>
        </Dropdown>
        {onDock ? (
          <button className="ai-icon-btn" title={tx("停靠为面板：转为常规可停靠面板，适合大屏双栏", "Dock as panel: becomes a regular dockable panel — good for wide two-column layouts")} onClick={onDock}>
            <IconDock />
          </button>
        ) : (
          <button className="ai-icon-btn" title={tx("弹出为浮窗（Ctrl+K 也可开关）", "Pop out as a floating window (Ctrl+K toggles it too)")} onClick={invokePop}>
            <IconPop />
          </button>
        )}
      </div>

      {anoms.length > 0 && (
        <div className="ai-anom">
          <button className="ai-anom-bar" onClick={() => setAnomOpen((v) => !v)}>
            <span className="ai-anom-dot" />
            {tx(`发现 ${anoms.length} 项异常`, `Found ${anoms.length} anomalies`)}
            <span className="ai-anom-chev">
              <IconChevron dir={anomOpen ? "down" : "right"} size={12} />
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
                    text: tx(
                      `数据巡检发现以下异常，请结合当前连接与协议状态给出排查建议：\n${anomaliesToText(anoms)}`,
                      `The data patrol found these anomalies — give a troubleshooting plan based on the current link and protocol state:\n${anomaliesToText(anoms)}`,
                    ),
                  })
                }
              >
                {tx("让 AI 排查", "Ask the AI to investigate")}
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
                {tx("AI 助手", "AI assistant")}
              </div>
              <div className="ai-welcome-desc">
                {tx(
                  "框选 Hex 字节右键「AI 识别协议」；或点顶栏「场景 ▾」里的解读数据、分析曲线、生成指令、诊断问题。想做主题、小部件、面板？把输入区那颗「普通对话」切成「Agent 任务」，AI 会直接保存为插件并自动启用。发送前可勾选随消息附带的软件内上下文。",
                  "Select Hex bytes and choose “AI: detect protocol” from the context menu, or open “Scenes ▾” in the top bar to interpret data, analyse curves, generate commands and diagnose problems. Want a theme, widget or panel? Switch the “Plain chat” pill under the input to “Agent task” and the AI saves it as a plugin and enables it. Before sending you can tick which in-app context travels with the message.",
                )}
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
                          {chatStore.resendKindOf(m) === "agent" ? tx("保存并重发任务", "Save and resend task") : tx("保存并重发", "Save and resend")}
                        </button>
                        <button className="btn" onClick={() => setEditingId("")}>
                          {t("c.cancel")}
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
                      {m.aborted && <div className="ai-aborted">{tx("已停止生成", "Generation stopped")}</div>}
                      {m.error && <div className="ai-error">{m.error}</div>}
                    </>
                  )}
                </div>
                {!chat.streaming && editingId !== m.id && (
                  <div className="ai-msg-ops">
                    {m.role === "assistant" && !m.error && (
                      <button onClick={() => copyText(m.content)}>{t("c.copy")}</button>
                    )}
                    {canClip && (
                      <button
                        onClick={() => setExpanded((v) => ({ ...v, [m.id]: !v[m.id] }))}
                        title={expanded[m.id] ? tx("收拢这条长回复", "Collapse this long reply") : tx("展开查看完整内容", "Expand to read the full reply")}
                      >
                        {expanded[m.id] ? tx("收拢", "Collapse") : tx(`展开 ${m.content.length} 字`, `Expand ${m.content.length} chars`)}
                      </button>
                    )}
                    {m.role === "assistant" && m.id === lastAssistantId && m.fromRunId && lastAgentGoal && (
                      <button
                        onClick={() => commitResend(lastAgentGoal, lastAgentGoal.content)}
                        title={tx("按原目标重跑这个 Agent 任务（就地重发目标气泡，不重复堆一条）", "Re-run this Agent task with the same goal (the goal bubble is resent in place, not stacked again)")}
                      >
                        {tx("重跑任务", "Re-run task")}
                      </button>
                    )}
                    {m.role === "assistant" && m.id === lastAssistantId && !m.fromRunId && (
                      <button
                        onClick={() => void chatStore.regenerate()}
                        title={m.error ? tx("重试本次请求", "Retry this request") : tx("重新生成回复", "Regenerate the reply")}
                      >
                        {m.error ? tx("重试", "Retry") : tx("重新生成", "Regenerate")}
                      </button>
                    )}
                    {m.role === "user" && (
                      <>
                        <button onClick={() => copyText(m.content)}>{t("c.copy")}</button>
                        <button
                          onClick={() => {
                            setEditingId(m.id);
                            setEditText(m.content);
                          }}
                        >
                          {tx("编辑", "Edit")}
                        </button>
                        {chatStore.resendKindOf(m) === "agent" && (
                          <button
                            onClick={() => startAgentRun(m.content, { replaceMsgId: m.id })}
                            title={tx("截断此条之后的内容，以 Agent 任务重新发起", "Truncate everything after this message and start it again as an Agent task")}
                          >
                            {tx("重发任务", "Resend as task")}
                          </button>
                        )}
                      </>
                    )}
                    <button onClick={() => chatStore.deleteMsg(m.id)}>{t("c.delete")}</button>
                  </div>
                )}
                {m.role === "assistant" && m.contextTitles && m.contextTitles.length > 0 && (
                  <div className="ai-msg-ctx">
                    {tx(`附加上下文：${m.contextTitles.join(" · ")}`, `Attached context: ${m.contextTitles.join(" · ")}`)}
                  </div>
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
          <button className="ai-scroll-btn" title={tx("回到底部", "Back to the bottom")} onClick={scrollToBottom}>
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
              <span key={`${f.name}:${i}`} className="ai-attach-chip" title={tx(`附加文件 ${f.name}`, `Attached file ${f.name}`)}>
                {f.name}
                <button
                  className="ai-attach-del"
                  title={tx("移除文件", "Remove file")}
                  onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  <IconClose />
                </button>
              </span>
            ))}
            <button
              className={`ai-attach-chip as-btn${ctxOpen ? " on" : ""}`}
              title={tx("勾选随消息发送的上下文（连接配置 / 协议 / 数据样本 / Hex 选区）", "Tick what travels with the next message (connection config / protocols / data samples / Hex selection)")}
              onClick={() => setCtxOpen((v) => !v)}
            >
              {tx(`上下文 · 勾选 ${checkedCtxCount} · 附加 ${ctxBlocks.length}`, `Context · ${checkedCtxCount} ticked · ${ctxBlocks.length} attached`)}
              {ctxTokNote}
            </button>
          </div>
        )}
        {ctxOpen && (
          <div className="ai-ctx-panel">
            <div className="ai-ctx-checks">
              {CONTEXT_KEYS.map((k) => (
                <label key={k} className="ai-ctx-check" title={tx(`随下一条消息附带${contextLabel(k)}`, `Attach ${contextLabel(k)} to the next message`)}>
                  <input
                    type="checkbox"
                    checked={chat.contextSel[k]}
                    onChange={(e) =>
                      chatStore.setContextSel({ ...chat.contextSel, [k]: e.target.checked })
                    }
                  />
                  {contextLabel(k)}
                </label>
              ))}
              <span className="ai-ctx-note" title={tx("Hex 未框选字节、样本无数据时不产生附加块", "No block is attached when the Hex range is empty or there are no samples")}>
                {tx("勾选数与实际附加数可能不同", "Ticked count may differ from what actually attaches")}
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
          <div className="ai-agent-panel" role="group" aria-label={tx("Agent 工作方式与授权", "Agent mode and permissions")}>
            {/*
              P98-M3：面板拆成**两个轴**。旧版把「普通对话」和 7 个档位塞进同一个 radiogroup，
              于是"用不用 Agent"和"Agent 有多大权"这两件可以自由组合的事被排成了互斥单选，
              再叠上第 7 项就地长出的 8 个域勾选 —— 用户数出"8 个发送方式"、说"过于繁杂"就是这么来的。
              现在：第一层只有 工作方式(2) + 授权档(3)；具体授权域收进「高级」折叠区，
              原来的工作区写入/设备收发/本机全能力 降级为该区里的一键预设 chip（能力一个没少）。
            */}
            <div className="ai-agent-group">
              <div className="ai-agent-group-title">{tx("工作方式", "Mode")}</div>
              <div className="ai-agent-modes" role="radiogroup" aria-label={tx("工作方式", "Mode")}>
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
                  <span className="ai-agent-mode-name">{tx("普通对话", "Plain chat")}</span>
                  <span className="ai-agent-mode-desc">{tx("一问一答；不执行任何应用操作", "One question, one answer; runs no app actions")}</span>
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
                  <span className="ai-agent-mode-name">{tx("Agent 任务", "Agent task")}</span>
                  <span className="ai-agent-mode-desc">{tx("多轮自主执行，可读可写（下面选授权档）", "Multi-round autonomous run, reads and writes (pick a tier below)")}</span>
                </button>
              </div>
            </div>
            {agentMode && (
              <div className="ai-agent-group">
                <div className="ai-agent-group-title">{tx("授权档", "Permission tier")}</div>
                <div className="ai-agent-modes" role="radiogroup" aria-label={tx("授权档", "Permission tier")}>
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
                    {tx(
                      "高危档不跨重启记忆，已回落到「界面创造」——需要请在高级区重新勾上",
                      "High-risk tiers are never remembered across restarts — this fell back to UI authoring; re-tick it under Advanced if you need it",
                    )}
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
                  <span className="ai-agent-adv-title">{tx("高级 · 具体授权域", "Advanced · specific domains")}</span>
                  <span className="ai-agent-adv-sum">
                    {tierBadge(agentScope, agentAllowed)} · {tx(`${DOMAINS.filter((d) => hasDomain(agentScope, agentAllowed, d)).length} 项已授`, `${DOMAINS.filter((d) => hasDomain(agentScope, agentAllowed, d)).length} granted`)}
                  </span>
                  <span className="ai-agent-adv-caret">{advOpen ? tx("收起", "Less") : tx("展开", "More")}</span>
                </button>
                {advOpen && (
                  <>
                    <div className="ai-agent-presets" role="group" aria-label={tx("授权域预设", "Domain presets")}>
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
                      {tx(
                        "一项都不勾 = 按「界面创造」同权执行，不会选了却什么都改不动",
                        "Ticking none runs with UI-authoring rights — you can't end up with a custom tier that can't do anything",
                      )}
                    </span>
                  </>
                )}
              </div>
            )}
            {agentMode && !agentRunning && (
              <div className="ai-agent-group">
                <div className="ai-agent-group-title">{tx("常用任务", "Common tasks")}</div>
                <div className="ai-agent-quick" role="group" aria-label={tx("常用任务", "Common tasks")}>
                  {quickTasks().map((t) => (
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
                {/* P109-A：读**设置**，不再读常量。以前这里直接写 DEFAULT_BUDGET，
                    于是"设置改了、界面还报 24 轮"——一盏只能看的灯。 */}
                <span className="ai-agent-budget">
                  {tx(
                    `预算 ${capWord(settings.agentMaxRounds)} 轮 / ${capWord(settings.agentMaxCalls)} 次工具 / ${capWord(settings.agentTimeoutMins)} 分钟`,
                    `Budget ${capWord(settings.agentMaxRounds)} rounds / ${capWord(settings.agentMaxCalls)} tool calls / ${capWord(settings.agentTimeoutMins)} min`,
                  )}
                  {agentRunning ? tx("（运行中，设置已锁定）", "(running — settings locked)") : ""}
                </span>
              </div>
            )}
          </div>
          </Dropdown>
        )}
        {sceneHint(mode) && (
          <div className="ai-mode-chip">
            {sceneHint(mode)}
            <button className="ai-mode-close" onClick={() => setMode("qa")}>
              {tx("取消", "Cancel")}
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
                  title={tx("移除图片", "Remove image")}
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
              {tx("附加图片", "Attach image")}
              <span className="ai-plus-menu-note">{tx("截图 / 图片文件，最多 4 张", "Screenshots or image files, up to 4")}</span>
            </button>
            <button
              className="ai-plus-menu-item"
              role="menuitem"
              onClick={() => {
                setPlusOpen(false);
                fileInputRef.current?.click();
              }}
            >
              {tx("附加文件", "Attach file")}
              <span className="ai-plus-menu-note">{tx("文本类 ≤256KB，最多 4 个（.txt/.md/.csv/.json/.log 等）", "Text files ≤256KB, up to 4 (.txt/.md/.csv/.json/.log and similar)")}</span>
            </button>
            <button
              className="ai-plus-menu-item"
              role="menuitem"
              onClick={() => {
                setPlusOpen(false);
                setCtxOpen(true);
              }}
            >
              {tx("发送上下文", "Send context")}
              <span className="ai-plus-menu-note">{tx("连接配置 / 协议 / 数据样本 / Hex 选区", "Connection config / protocols / data samples / Hex selection")}</span>
            </button>
          </div>
          </Dropdown>
        )}
        <div className="ai-input-row">
          <button ref={plusBtnRef} className="ai-plus" title={tx("附加图片、文件或上下文", "Attach an image, a file or context")} onClick={() => setPlusOpen((v) => !v)} aria-haspopup="menu" aria-expanded={plusOpen}>
            <IconPlus />
          </button>
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={
              agentMode
                ? agentRunning
                  ? tx("Agent 任务运行中…可点右侧红色按钮停止后继续", "An Agent task is running… the red button on the right stops it")
                  : tx("描述目标，Enter 启动 Agent", "Describe the goal — Enter starts the Agent")
                : chat.streaming
                  ? tx("AI 正在回复…", "AI is replying…")
                  : tx("输入问题，Enter 发送", "Ask something — Enter sends")
            }
            /* 键位与粘贴能力从 placeholder 搬到这里：placeholder 是"该做什么"，
               说明书不该占着它（用户判"整那么多文字"就是这两句各 20~30 字）。 */
            title={tx("Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片", "Enter sends · Shift+Enter adds a line · images can be pasted")}
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
              title={agentRunning ? tx("停止 Agent 任务", "Stop the Agent task") : tx("停止生成", "Stop generating")}
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
              title={tx("发送（Enter）", "Send (Enter)")}
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
            title={tx("选择工作方式与授权档：普通对话一问一答，Agent 任务多轮自主执行", "Choose the mode and permission tier: plain chat answers one question at a time, an Agent task runs many rounds on its own")}
            onClick={() => setModePanelOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={modePanelOpen}
          >
            {agentMode ? tx(`Agent 任务 · ${tierBadge(agentScope, agentAllowed)}`, `Agent task · ${tierBadge(agentScope, agentAllowed)}`) : tx("普通对话", "Plain chat")}
            {/* P109-D：`downgraded` 从 P98-M3 算到现在才第一次被显示——旧状态是"算了但没人看"，
                用户以为自己还在全权执行，实际已被降档。重新选到 custom 后这句自己消失
                （条件绑在 agentScope 上），不是一条会说谎的常驻文案。 */}
            {agentMode && tierRestore.downgraded && agentScope === "create" && (
              /* 这件事必须看得见（用户以为自己还在全权执行，实际已被降档），
                 但不该用一句 17 个字的话把 pill 撑爆：徽标 + tooltip 说同一件事。 */
              <span
                className="ai-pill-warn"
                title={tx("上次是全权执行，重启后已降到当前档", "The last session ran with full access; it was lowered to this tier after restart")}
              >
                {tx("降档", "lowered")}
              </span>
            )}
            {sessionBadge && (
              <span className={`agent-badge${sessionRun?.pending ? " warn" : ""}`}>{sessionBadge}</span>
            )}
            <IconChevron dir="down" size={12} />
          </button>
          {sessionRun && (
            <span className="ai-agent-prog">
              {tx(`第 ${sessionRun.rounds} 轮 · ${sessionRun.calls} 次工具`, `Round ${sessionRun.rounds} · ${sessionRun.calls} tool calls`)}
            </span>
          )}
          <span className="ai-toolbar-spacer" />
          {/*
            P111-E：这一行的常驻文字砍到只剩"谁"和"多少"。
            原来这里同时摆着 `模型 [DeepSeek · deepseek-v4-pro · 128k]`、
            `窗口 128k · 输出 8k · 历史预算 153600 字`、`窗口 16% · 传输 4%`、`已折 N`、
            `压缩`、`还原` 六段话 —— 用户判"好乱，干嘛整这么多字"。
            档案数字归「模型设置」，压缩/还原与双分母收进那枚百分比的浮层（照 Qoder）。
          */}
          {agentMode && (
            <>
              <button
                ref={meterBtnRef}
                type="button"
                className={`ai-ctx-chip${ctxMeter.level !== "ok" ? ` ${ctxMeter.level}` : ""}`}
                onClick={() => setMeterOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={meterOpen}
                title={tx(
                  "上下文用量：点开看窗口与传输两条分母，也能压缩更早的历史",
                  "Context usage: open for both denominators and the manual compaction",
                )}
              >
                <span className="ai-ctx-bar" aria-hidden="true">
                  <span className="ai-ctx-bar-fill" style={{ width: `${ctxMeter.pct}%` }} />
                </span>
                {ctxWindow.pct}%
              </button>
              <Dropdown anchor={meterBtnRef.current} open={meterOpen} onClose={() => setMeterOpen(false)} align="end">
                <div className="ai-ctx-pop">
                  <div className="ai-ctx-pop-head">
                    <span>{tx("上下文窗口", "Context window")}</span>
                    <span className="ai-ctx-pop-pct">{ctxWindow.pct}%</span>
                  </div>
                  <div className="ai-ctx-bar tall" aria-hidden="true">
                    <span className="ai-ctx-bar-fill" style={{ width: `${ctxWindow.pct}%` }} />
                  </div>
                  {/* 双分母不能丢：窗口那条说"历史到这儿该折了"，传输那条说"请求会不会撞宿主熔断"。
                      只报传输那条出现过"显示 1%、其实正在丢几十条历史"（详设 §2.1）。 */}
                  <div className="ai-ctx-pop-row">
                    {tx(`窗口 ${ctxWindow.pct}% · 传输 ${ctxMeter.pct}%`, `window ${ctxWindow.pct}% · transport ${ctxMeter.pct}%`)}
                  </div>
                  {ctxEstimate.shadowed > 0 && (
                    <div className="ai-ctx-pop-row">
                      {tx(`已折 ${ctxEstimate.shadowed} 条较早的工具回执（台账未删）`, `${ctxEstimate.shadowed} older tool receipts now go as summaries (the ledger is intact)`)}
                    </div>
                  )}
                  <div className="ai-ctx-pop-foot">
                    <button
                      className="btn sm"
                      disabled={atBudgetFloor || agentRunning}
                      title={
                        atBudgetFloor
                          ? tx("已到压缩下限：再小模型就没有上下文了。要彻底清空请新建会话", "At the compression floor: go smaller and the model has no context left. Start a new session to clear it fully")
                          : agentRunning
                            ? tx("任务运行中，等它结束再压缩", "A task is running — wait for it to finish before compressing")
                            : tx("把更早的会话历史收得更紧一些再发（台账一条不删）", "Fold older session history tighter before sending (the ledger keeps every entry)")
                      }
                      onClick={compressContext}
                    >
                      {tx("压缩上下文", "Compress context")}
                    </button>
                    {ctxBudget < HISTORY_CHAR_BUDGET && (
                      <button className="btn sm" onClick={resetContextBudget} title={tx("恢复完整历史预算", "Restore the full history budget")}>
                        {tx("恢复自动", "Restore auto")}
                      </button>
                    )}
                  </div>
                </div>
              </Dropdown>
            </>
          )}
          <AiModelChip />
        </div>
      </div>
      {/* P88d ③：活动任务不在当前会话视图时，右下角悬浮条一键切回 */}
      <AgentFloat sessionId={chat.activeId} onOpen={(id) => chatStore.switchSession(id)} />
      {plgLibOpen && (
        <ErrorBoundary label={tx("本地插件库", "Local plugin library")}>
          <PluginLibraryDialog onClose={() => setPlgLibOpen(false)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
