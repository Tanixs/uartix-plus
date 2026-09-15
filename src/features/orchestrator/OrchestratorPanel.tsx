import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { tx, useLocale } from "../../i18n/strings";
import * as orchestratorStore from "./orchestratorStore";
import { BLOCK_REGISTRY, EVENT_REGISTRY } from "./blockRegistry";
import { ORCH_PRESETS } from "./orchestratorPresets";
import { requestAsk } from "../ai/chatStore";
import * as bind from "./orchestratorBind";
import * as sequencerStore from "../sequencer/sequencerStore";
import * as commandStore from "../controls/commandStore";
import * as plotStore from "../plot/plotStore";
import * as templateStore from "../protocol/templateStore";
import { Inspector, VarsEditor, type Sel } from "./OrchestratorInspector";
import { toast } from "../ai/extRuntime";
import { useListDrag, type DragPos } from "../../shared/useListDrag";
import { alertDialog, confirmDialog } from "../../shared/Dialog";
import { useOperator } from "../operator/operatorStore";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconCircle,
  IconClock,
  IconClose,
  IconCopy,
  IconDot,
  IconGrip,
  IconLock,
  IconLogs,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTune,
} from "../../shared/icons";
import type { FrameMatch, Suite } from "../sequencer/types";
import {
  ORCH_LIMITS,
  isManuallyTriggerable,
  type Cond,
  type EventBlock,
  type ExecBlock,
  type FlowDoc,
  type FlowNode,
  type GroupNode,
  type LogEntry,
  type LogPhase,
  type VarFrom,
} from "./types";

/**
 * 自动编排器面板（P74-4）。
 *
 * 面板只是视图：文档在 orchestratorStore（localStorage 持久化），执行在
 * engine/orchestratorBind（模块级，import 本面板即完成事件源接线）。
 * 拖拽沿用序列器 pointer 方案（WebView2 下 HTML5 DnD 不稳的既有结论）：
 * ghost 高亮落点 + 容器「进内」+ 画布边缘自动滚动；事件块落错位置直接拒绝。
 */

/** 拖拽落点决策数据（useListDrag.onFrame 产、onDrop 消，P75 B3） */
interface DropData {
  key: string; // 行 id / "__slot__:{gid}" / "ev:{evId}" / "__list__"
  pos: DragPos;
  /** 跨组落点：目标组 id（缺省 = 拖拽源组；块拖拽跨组卡时由 hover 行所在卡给出） */
  toGid?: string;
}

interface DragState {
  kind: "blk" | "ev";
  id: string;
  groupId: string;
}

/** 「＋ 添加」菜单的打开位置：if 有 then/els 两个子列表，which 必须参与判定，否则两菜单同开 */
interface AddAt {
  groupId: string;
  parentId: string | null;
  which?: "then" | "els" | "body";
  /** 触发按钮（弹层锚点；portal+fixed 渲染用，见 OrchDropdown） */
  anchor: HTMLElement;
}

/**
 * 下拉弹层：portal 到 body + fixed 定位（同 Flyout 思路）。
 * 组卡 overflow:hidden 与画布 overflow-y:auto 会裁掉容器内 absolute 弹层
 * （真机反馈：事件菜单「点不动」、添加块菜单被卡片底边截断），逃逸裁剪是唯一正解。
 * 定位直接写 DOM style，绝不 setState（Flyout 的无限重渲染教训）。
 * interactive：含输入控件的弹层（组设置）用——鼠标移出即关会丢正在编辑的草稿，
 * 改为点击外部/Esc 关闭。
 */
function OrchDropdown(props: { anchor: HTMLElement | null; onClose: () => void; cols?: boolean; interactive?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { anchor, interactive, onClose } = props;
  useLayoutEffect(() => {
    const el = ref.current;
    const a = props.anchor;
    if (!el || !a || !a.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;
    const ar = a.getBoundingClientRect();
    const zf = Number(getComputedStyle(document.documentElement).zoom) || 1;
    let left = ar.left;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    left = Math.max(8, left);
    let top = ar.bottom + 4;
    // 下方空间不足翻到上方（贴近画布底部的组卡是常态）
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, ar.top - r.height - 4);
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });
  useEffect(() => {
    if (!interactive) return;
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const t = e.target as Node;
      if (el && !el.contains(t) && !anchor?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [interactive, anchor, onClose]);
  if (!props.anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={`orch-pop orch-pop-fixed${props.cols ? " orch-pop-cols" : ""}`}
      style={{ left: -9999, top: -9999, visibility: "hidden" }}
      onMouseLeave={props.interactive ? undefined : props.onClose}
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </div>,
    document.body,
  );
}

type BlockGrp = "exec" | "logic" | "org";

const BLOCK_GRP_TITLE: Record<BlockGrp, { zh: string; en: string }> = {
  exec: { zh: "执行", en: "Actions" },
  logic: { zh: "逻辑", en: "Logic" },
  org: { zh: "组织", en: "Organize" },
};

/* B4a：菜单 = registry 的直接投影（声明顺序即展示顺序），文案/分组/色类单一真源 */
const BLOCK_MENU = (Object.keys(BLOCK_REGISTRY) as (keyof typeof BLOCK_REGISTRY)[]).map((k) => ({
  k,
  ...BLOCK_REGISTRY[k],
}));

const EVENT_MENU = (Object.keys(EVENT_REGISTRY) as (keyof typeof EVENT_REGISTRY)[]).map((k) => ({
  k,
  ...EVENT_REGISTRY[k],
}));

/** 满队列策略的人话说明（A3：与 Grafana/n8n 用语对齐，工程师零学习成本） */
const QUEUE_POLICY: { k: NonNullable<GroupNode["queuePolicy"]>; zh: string; en: string; tipZh: string; tipEn: string }[] = [
  { k: "dropNew", zh: "丢弃新触发", en: "Drop new", tipZh: "队列满（8 个）时丢弃新来的触发——宁可漏触发也不堆积（默认）", tipEn: "Drop the new trigger when the queue is full (8)" },
  { k: "dropOld", zh: "挤掉最旧排队", en: "Drop oldest queued", tipZh: "队列满时挤掉最旧的**排队项**（在跑的实例不受影响）", tipEn: "Evict the oldest queued instance when full" },
  { k: "stopOld", zh: "中止在跑的", en: "Stop running", tipZh: "只要有实例在跑就全部中止，新触发立即上位（永远只跑到最新一次）", tipEn: "Abort everything running; the newest trigger takes over" },
];

/** ▶ 不可用的原因（用于置灰 + tooltip；返回 null = 可用） */
function manualBlockReason(g: GroupNode, masterOn: boolean): string | null {
  if (!masterOn) return tx("总开关关闭：先打开左上角「编排中」", "Master switch is off — turn it on first");
  if (!g.enabled) return tx("本组已禁用（勾选左侧复选框启用）", "This group is disabled");
  if (!isManuallyTriggerable(g))
    return tx("本组只响应自动事件。如需手动运行，请在事件槽里挂一个「手动」事件块", "This group only responds to auto events. Attach a Manual event block to enable the Run button");
  return null;
}

function matchDesc(m: FrameMatch): string {
  if (m.by === "raw") return `含 ${m.hex || "?"}`;
  if (m.by === "tpl") return `模板 ${m.tplId}`;
  const e = typeof m.expected === "number" ? String(m.expected) : `$${m.expected.var}`;
  return `${m.fieldName} ${m.op} ${e}`;
}

/** id→名称解析（P82④：摘要不再裸显 UUID——通道来自 2D 图例，模板来自协议面板；
 *  通道/模板被删时回退「已删除 · 前8位」，摘要仍可读可定位 */
function chanName(id: string): string {
  if (!id) return "?";
  const ch = plotStore.getSnapshot().channels.find((c) => c.id === id);
  if (ch) return ch.name;
  return tx(`已删除通道 ${id.slice(0, 8)}…`, `deleted channel ${id.slice(0, 8)}…`);
}

function tplName(id: string): string {
  if (!id) return "?";
  const t = templateStore.getSnapshot().rules.templates.find((x) => x.id === id);
  return t ? t.name : tx(`已删除模板 ${id.slice(0, 8)}…`, `deleted template ${id.slice(0, 8)}…`);
}

function condDesc(c: Cond): string {
  switch (c.k) {
    case "chan": return `通道 ${chanName(c.chId)} ${c.op} ${c.value}${c.tol ? `±${c.tol}` : ""}`;
    case "var": return `${c.name} ${c.op} ${String(c.value)}${c.tol ? `±${c.tol}` : ""}`;
    case "expr": return c.src || "(空)";
    case "evtField": return `evt.${c.field} ${c.op} ${String(c.value)}`;
    case "session": return `会话=${c.state}`;
  }
}

function varFromDesc(f: VarFrom): string {
  switch (f.k) {
    case "const": return String(f.value);
    case "chan": return `通道 ${chanName(f.chId)}`;
    case "expr": return f.src || "(空)";
    case "evtField": return `evt.${f.field}`;
  }
}

/** 摘要拆成「说明文字 + 参数 chips」：chips 用胶囊底色渲染，一眼看出哪些是可编辑参数 */
interface SummaryParts {
  pre: string;
  chips: string[];
  /** chips 间连接词（if/loop 多条件用「且」） */
  sep: string;
  post: string;
}

function summaryParts(n: FlowNode): SummaryParts {
  const S = (pre: string, chips: string[] = [], post = "", sep = " "): SummaryParts => ({ pre, chips, post, sep });
  switch (n.kind) {
    case "group": return S(tx("子组", "Subgroup"), [n.name]);
    case "send": {
      const p = n.payload;
      if (p.type === "hex") return S(tx("发送 HEX", "Send HEX"), [p.text || tx("(空)", "(empty)")], "", " ");
      if (p.type === "ascii") return S(tx("发送 ASCII", "Send ASCII"), [p.text || tx("(空)", "(empty)")]);
      if (p.type === "cmd") return S(tx("发送命令", "Send command"), [p.cmdId ? commandName(p.cmdId) : tx("(未选)", "(none)")]);
      return S(tx("发送 工厂组帧", "Send factory"));
    }
    case "wait": return S(tx("等待", "Wait"), [`${n.ms}ms`]);
    case "waitFrame":
      return S(tx("等帧", "Wait frame"), [matchDesc(n.match), `≤${n.timeoutMs}ms`], n.ignoreFail ? tx("失败忽略", "fail ignored") : "");
    case "runSuite": {
      const s = sequencerStore.getSuite(n.suiteId);
      return S(tx("运行序列", "Run suite"), [(s?.name ?? n.suiteId) || tx("(未选)", "(none)")], n.wait ? tx("等完成", "await") : "");
    }
    case "runGroup":
      return S(
        n.wait ? tx("调用组", "Call group") : tx("触发组", "Trigger group"),
        [groupName(n.groupId) || tx("(未选)", "(none)")],
      );
    case "setVar": return S("", [n.name || "?", varFromDesc(n.from)], "", " = ");
    case "toast": return S(`通知[${n.level}]`, [n.text || tx("(空)", "(empty)")]);
    case "sound": return S(tx("提示音", "Sound"), [n.level]);
    case "if":
      return S(tx("如果", "If"), n.conds.length ? n.conds.map(condDesc) : [tx("(无条件=恒真)", "(no cond = true)")], "", tx(" 且 ", " AND "));
    case "loop": {
      if (n.mode === "count")
        return S(tx("循环", "Loop"), [tx(`${n.count} 次`, `${n.count}×`)], n.intervalMs ? tx(`间隔 ${n.intervalMs}ms`, `gap ${n.intervalMs}ms`) : "");
      return S(
        tx("当满足时循环", "While"),
        n.cond && n.cond.length ? n.cond.map(condDesc) : [tx("(无条件)", "(always)")],
        n.intervalMs ? tx(`间隔 ${n.intervalMs}ms`, `gap ${n.intervalMs}ms`) : "",
        tx(" 且 ", " AND "),
      );
    }
    case "break": return S(tx("跳出循环", "Break loop"));
    case "abort": return S(tx("中止本组", "Abort group"));
    /* ---------- B4c 新增 ---------- */
    case "setControl":
      return S(tx("画布变量", "Ctl var"), [n.varName || tx("(未选)", "(none)"), varFromDesc(n.from)]);
    case "setSwitch": return S(tx("拨开关", "Switch"), [n.swName || tx("(未选)", "(none)"), n.state]);
    case "modbusWrite":
      return S(tx("Modbus写", "Mb write"), [`FC0${n.fn}`, `#${n.slave}`, `@${n.addr}`, String(n.value)]);
    case "log": return S(tx("日志", "Log"), [`[${n.level}]`, n.text || tx("(空)", "(empty)")]);
    case "snapshot": return S(tx("截图", "Snap"), [n.panel, n.note || ""]);
    case "exportCsv": return S(tx("导CSV", "CSV"), [n.chanId ? chanName(n.chanId) : tx("(未选)", "(none)"), tx(`最近 ${n.lastN} 点`, `last ${n.lastN}`)]);
    case "stopSuite": return S(tx("停序列", "Stop suite"));
    case "emitFlow": return S(tx("发事件", "Emit"), [n.name || tx("(未命名)", "(unnamed)"), ...n.data.map((d) => d.k)]);
    case "clip": return S(tx("剪贴板", "Clip"), [n.text || tx("(空)", "(empty)")]);
    case "resetVars": return S(tx("复位变量", "Reset"), [n.scope === "one" ? n.name || tx("(未选)", "(none)") : tx("全部", "all")]);
  }
}

function commandName(cmdId: string): string {
  const item = commandStore.getCommand(cmdId);
  return item?.name ?? cmdId;
}

/** 纯文本摘要（title tooltip 用） */
function summaryText(n: FlowNode): string {
  const s = summaryParts(n);
  return [s.pre, s.chips.join(s.sep), s.post].filter(Boolean).join(" ").trim();
}

/** 摘要 JSX：说明文字弱、参数 chips 强（胶囊底 + 等宽） */
function Summary({ n }: { n: FlowNode }) {
  const s = summaryParts(n);
  return (
    <>
      {s.pre && <span className="orch-sum-t">{s.pre}</span>}
      {s.chips.map((c, i) => (
        <span key={i} className="orch-chip-wrap">
          {i > 0 && <span className="orch-sum-t">{s.sep}</span>}
          <span className="orch-chip">{c}</span>
        </span>
      ))}
      {s.post && <span className="orch-sum-t">{s.post}</span>}
    </>
  );
}

function eventSummary(ev: EventBlock): string {
  switch (ev.kind) {
    case "manual": return tx("手动", "Manual");
    case "session": return `会话${ev.phase === "start" ? tx("开始", "start") : tx("停止", "stop")}`;
    case "frame": return `帧 ${matchDesc(ev.match)}${ev.stride > 1 ? ` ×1/${ev.stride}` : ""}`;
    case "threshold": return `通道 ${ev.chId ? chanName(ev.chId) : "?"} ${ev.op === "above" ? ">" : "<"} ${ev.value} ${ev.edge === "enter" ? tx("进入", "enter") : tx("回落", "exit")}`;
    case "timer": return `每 ${ev.intervalMs}ms`;
    case "sentinel": return `哨兵 ${ev.level}`;
    case "varChanged": return `${ev.varName || "?"} 变更`;
    /* ---------- B4d 新增 ---------- */
    case "frameError": return `坏帧${ev.stride > 1 ? ` ×1/${ev.stride}` : ""}`;
    case "chanChanged": return `通道 ${ev.chId ? chanName(ev.chId) : "?"} 变化>${ev.tol}${ev.minIntervalMs > 50 ? ` 节流${ev.minIntervalMs}ms` : ""}`;
    case "newTpl": return ev.tplId ? `新帧型 ${tplName(ev.tplId)}` : tx("任意新帧型", "any new type");
    case "flowEvt": return `事件 ${ev.name || "?"}`;
    case "idle": return tx(`空闲 ≥${ev.idleMs}ms`, `idle ≥${ev.idleMs}ms`);
  }
}

function groupName(id: string): string {
  const find = (nodes: FlowNode[]): string | null => {
    for (const n of nodes) {
      if (n.kind === "group") {
        if (n.id === id) return n.name;
        const deep = find(n.children);
        if (deep) return deep;
      } else if (n.kind === "if") {
        const deep = find([...n.then, ...n.els]);
        if (deep) return deep;
      } else if (n.kind === "loop") {
        const deep = find(n.body);
        if (deep) return deep;
      }
    }
    return null;
  };
  return find((bind.orchEngine.getDoc() ?? { groups: [] as GroupNode[] }).groups as unknown as FlowNode[]) ?? "";
}

/** 事件可用性体检（C1「为什么没触发」）：bad=配置不完整永不触发；warn=配置在但数据源暂时喂不进 */
function eventHealth(ev: EventBlock, doc: FlowDoc): { lvl: "warn" | "bad"; tip: string } | null {
  switch (ev.kind) {
    case "frame":
      if (ev.match.by === "raw" && !ev.match.hex.trim())
        return { lvl: "bad", tip: tx("匹配内容为空：填入要侦测的 HEX 字节，否则永远不会命中", "Empty match bytes: this can never fire") };
      return null;
    case "threshold":
    case "chanChanged": {
      if (!ev.chId) return { lvl: "bad", tip: tx("未选通道：请在检查器里选择 2D 曲线通道", "No channel picked") };
      if (!plotStore.getSnapshot().channels.some((c) => c.id === ev.chId))
        return { lvl: "warn", tip: tx("通道已被删除：请重新选择", "Channel was deleted — pick another") };
      if (plotStore.getChanData(ev.chId).v.length === 0)
        return { lvl: "warn", tip: tx("通道暂无数据：等数据流入后才会触发", "Channel has no data yet") };
      return null;
    }
    case "varChanged": {
      if (!ev.varName) return { lvl: "bad", tip: tx("未选变量", "No var picked") };
      if (!doc.vars.some((v) => v.name === ev.varName))
        return { lvl: "warn", tip: tx("变量已不存在：请重新选择", "Var no longer exists — pick another") };
      return null;
    }
    case "flowEvt":
      if (!ev.name.trim()) return { lvl: "bad", tip: tx("未写事件名：与发送方「发事件」块同名才会命中", "Empty name: nothing can match it") };
      return null;
    default:
      return null;
  }
}

/* B4a：行徽标色类/名称改由 registry 供（未知 kind 兜底旧值，防历史脏文档崩渲染） */
const kindMeta = (k: string) => (BLOCK_REGISTRY as Record<string, (typeof BLOCK_REGISTRY)[keyof typeof BLOCK_REGISTRY] | undefined>)[k];
const kindCls = (k: string): string => kindMeta(k)?.cls ?? "note";
const kindLabel = (k: string): { zh: string; en: string } => kindMeta(k)?.label ?? { zh: k, en: k };

/** 拖拽期节点索引：行 id → 是否容器（group/if/loop）。一次构建 O(n)，替代旧每帧递归 findNode */
function buildNodeIndex(g: GroupNode | undefined): Map<string, { container: boolean }> {
  const idx = new Map<string, { container: boolean }>();
  if (!g) return idx;
  const walk = (list: FlowNode[]) => {
    for (const n of list) {
      idx.set(n.id, { container: BLOCK_REGISTRY[n.kind].container });
      if (n.kind === "group") walk(n.children);
      else if (n.kind === "if") {
        walk(n.then);
        walk(n.els);
      } else if (n.kind === "loop") walk(n.body);
    }
  };
  walk(g.children);
  return idx;
}

/* ================= 面板 ================= */

export function OrchestratorPanel() {
  useLocale();
  const store = useSyncExternalStore(orchestratorStore.subscribe, orchestratorStore.getSnapshot);
  const suites = useSyncExternalStore(sequencerStore.subscribe, sequencerStore.getSnapshot);
  const [, tick] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const [addAt, setAddAt] = useState<AddAt | null>(null);
  /** B4e：空态引导「从模板新建」下拉展开 */
  const [presetOpen, setPresetOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const doc = store.doc;

  // ---------- 运行日志抽屉（P74c P0-UI）：引擎 800 条环形缓冲终于有消费端 ----------
  const [logOpen, setLogOpen] = useState(false);
  /** null = 全部组；否则只看该组（从组徽标点进来） */
  const [logGroup, setLogGroup] = useState<string | null>(null);
  const [logOnlyFail, setLogOnlyFail] = useState(false);
  const [flashGroup, setFlashGroup] = useState<string | null>(null);

  /* ---------- C1：Operator 只读边界 ----------
     边界（用户拍板「禁编辑、允许运行」）：结构/配置类入口置灰，
     总开关、▶ 运行、日志、导出、折叠、选中查看一律可用。
     store 层另有同等守卫（AI/MCP/扩展面板调用也受约束），这里只做「点不动」的可见性。 */
  const readOnly = useOperator().pkg !== null;
  /** 只读时统一的一句说明，挂在所有被禁用的编辑入口 title 上 */
  const roTip = readOnly
    ? tx("（Operator 只读模式已锁定编排配置，退出后编辑）", " (operator read-only: orchestration config locked)")
    : "";

  // 运行实例数：引擎无变更事件，500ms 轻轮询（仅面板挂载期间）
  useEffect(() => {
    const h = window.setInterval(() => tick((v) => v + 1), 500);
    return () => window.clearInterval(h);
  }, []);

  const runN = bind.orchEngine.runningCount();

  // 选中项失效（删除 / 导入整文档替换）→ 回退变量视图：右侧不再挂一块空白检查器
  useEffect(() => {
    if (!sel) return;
    const g = doc.groups.find((x) => x.id === sel.groupId);
    if (
      !g ||
      (sel.eventId && !g.events.some((e) => e.id === sel.eventId)) ||
      (sel.blockId && !findNode(g.children, sel.blockId))
    ) {
      setSel(null);
    }
  }, [doc, sel]);

  // 导入成功后的统一反馈：闪新组 + 滚动定位（从序列导入 / JSON 导入共用）
  const flashNewGroup = (id: string) => {
    setFlashGroup(id);
    requestAnimationFrame(() => {
      document.querySelector(`[data-orch-card="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    window.setTimeout(() => setFlashGroup((v) => (v === id ? null : v)), 1600);
  };

  /* ---------- 组操作（A4：容量红线写入侧拦截 + 反馈） ---------- */

  const createGroup = (name?: string) => {
    const id = orchestratorStore.addGroup(name);
    if (!id && !readOnly)
      toast(tx(`编排组已达上限 ${ORCH_LIMITS.groupCap}，请先删除或合并后再新建`, `Group limit reached (${ORCH_LIMITS.groupCap}) — delete or merge first`));
    return id;
  };

  const openLogsFor = (gid: string | null) => {
    setLogGroup(gid);
    setLogOpen(true);
  };

  /* ---------- 拖拽（P75 B3：共享内核 useListDrag） ----------
     捕获指针 + rAF 合帧 + 矩形缓存 + 直写 DOM 指示/ghost；拖拽期间主树零 setState。
     落点语义：块 → 行上/下/内 + 跨组卡（moveBlockAcross 补全旧"拖不动"黑洞）；
     事件块 → 本组事件槽/徽标（徽标拖拽入口本次一并接上）。 */

  /** 拖拽期节点索引：行 id → 是否容器（每次拖拽构建一次，替代旧每帧递归 findNode） */
  const nodeIdxRef = useRef<Map<string, { container: boolean }> | null>(null);

  const moveX = (p: DragState, toGid: string, parentId: string | null, index: number) => {
    if (toGid === p.groupId) orchestratorStore.moveBlock(p.groupId, p.id, parentId, index);
    else orchestratorStore.moveBlockAcross(p.groupId, p.id, toGid, parentId, index);
  };

  /** 拖进自己子树 = store 必然静默拒绝 → 落点指示也不给（显示"可以放"是撒谎） */
  const subtreeHas = (groupId: string, rootId: string, targetId: string): boolean => {
    const g = doc.groups.find((x) => x.id === groupId);
    const root = g ? findNode(g.children, rootId) : undefined;
    if (!root) return false;
    const walk = (n: FlowNode): boolean => {
      if (n.id === targetId) return true;
      if (n.kind === "group") return n.children.some(walk);
      if (n.kind === "if") return [...n.then, ...n.els].some(walk);
      if (n.kind === "loop") return n.body.some(walk);
      return false;
    };
    return walk(root);
  };

  const drag = useListDrag<DragState, DropData>({
    rowSelector: "[data-orch-row]",
    rowIdAttr: "orchRow",
    scrollSelector: ".orch-canvas",
    onFrame: (p, f) => {
      if (p.kind === "ev") {
        const hit = document.elementFromPoint(f.x, f.y);
        const slot = hit?.closest<HTMLElement>("[data-orch-slot]");
        if (!slot || slot.dataset.orchSlot !== p.groupId) return null; // 事件块只进本组事件槽
        const badge = hit?.closest<HTMLElement>("[data-orch-ev]");
        const el = badge ?? slot;
        return {
          mark: { el, cls: badge ? "drop-before" : "drop-in" },
          data: { key: badge ? `ev:${badge.dataset.orchEv}` : `__slot__:${p.groupId}`, pos: "in" },
        };
      }
      if (f.hover && f.hover.rowId !== p.id) {
        if (subtreeHas(p.groupId, p.id, f.hover.rowId)) return null;
        const container = nodeIdxRef.current?.get(f.hover.rowId)?.container ?? false;
        const pos: DragPos = f.hover.ratio < 0.28 ? "before" : f.hover.ratio > 0.72 ? "after" : container ? "in" : "after";
        const toGid = f.hover.el.closest<HTMLElement>("[data-orch-card]")?.dataset.orchCard;
        return { mark: { el: f.hover.el, cls: `orch-drop-${pos}` }, data: { key: f.hover.rowId, pos, toGid } };
      }
      if (f.hover) return null; // 悬在源行上：无落点（旧版会误判成追加到列表尾）
      const hit = document.elementFromPoint(f.x, f.y);
      if (!hit?.closest(".orch-canvas")) return null;
      if (hit.closest("[data-orch-slot]")) return null; // 块不能进事件槽：不显示落点也不落
      const card = hit.closest<HTMLElement>("[data-orch-card]");
      return { mark: null, data: { key: "__list__", pos: "after", toGid: card?.dataset.orchCard } };
    },
    onDrop: (p, data) => {
      if (p.kind === "ev") {
        if (data.key.startsWith("__slot__:")) orchestratorStore.moveEventTo(p.groupId, p.id, -1);
        else if (data.key.startsWith("ev:")) orchestratorStore.moveEventTo(p.groupId, p.id, data.key.slice(3));
        return;
      }
      const to = data.toGid ?? p.groupId;
      if (data.key === "__list__") {
        const len = doc.groups.find((x) => x.id === to)?.children.length ?? 0;
        moveX(p, to, null, len);
        return;
      }
      const loc = orchestratorStore.locate(to, data.key);
      if (!loc) return;
      if (data.pos === "in") {
        const sub = listNodes(to, data.key);
        moveX(p, to, data.key, sub ? sub.length : 0);
        return;
      }
      moveX(p, to, loc.parentId, data.pos === "before" ? loc.index : loc.index + 1);
    },
    renderGhost: (p) => {
      if (p.kind === "ev") {
        const ev = doc.groups.find((x) => x.id === p.groupId)?.events.find((v) => v.id === p.id);
        return (
          <>
            <span className="dg-k">{tx("事件", "Event")}</span>
            <span className="dg-s">{ev ? eventSummary(ev) : p.id}</span>
          </>
        );
      }
      const g = doc.groups.find((x) => x.id === p.groupId);
      const n = g ? findNode(g.children, p.id) : undefined;
      if (!n) return null;
      return (
        <>
          <span className="dg-k">{(l => tx(l.zh, l.en))(kindLabel(n.kind))}</span>
          <span className="dg-s">{summaryText(n)}</span>
        </>
      );
    },
  });

  const startDrag = (e: React.PointerEvent, kind: "blk" | "ev", id: string, groupId: string) => {
    if (kind === "blk") nodeIdxRef.current = buildNodeIndex(doc.groups.find((x) => x.id === groupId));
    drag.begin(e, { kind, id, groupId });
  };

  const listNodes = (gid: string, parentId: string | null): FlowNode[] | null => {
    const g = doc.groups.find((x) => x.id === gid);
    if (!g) return null;
    if (parentId === null) return g.children;
    const p = findNode(g.children, parentId);
    if (!p) return null;
    return p.kind === "group" ? p.children : p.kind === "if" ? p.then : p.kind === "loop" ? p.body : null;
  };

  /* ---------- 从序列导入（B7：二次确认 + 定位新组） ---------- */

  const importFromSuite = async (s: Suite) => {
    const blocks = countBlocks(s.steps);
    if (!(await confirmDialog(
      tx(
        `将追加一个「未启用」的编排组：\n\n名称：${s.name || "导入的序列"}\n块数：${blocks}\n\n导入后不会自动运行；请在画布上核对块流，再勾选启用、挂事件或手动运行。`,
        `Append a DISABLED group:\n\nName: ${s.name || "imported suite"}\nBlocks: ${blocks}\n\nNothing runs until you review it and enable it.`,
      ),
    ))) return;
    const id = orchestratorStore.importSuite(s);
    if (!id) {
      toast(tx(`导入失败：编排组已达上限 ${ORCH_LIMITS.groupCap} 或套件为空`, `Import failed: group limit (${ORCH_LIMITS.groupCap}) reached or the suite is empty`));
      return;
    }
    setSel(null);
    flashNewGroup(id);
  };

  /* ---------- 导出（B8：与 DataTable / 3D CSV 同一条 save 管线） ---------- */

  const doExport = async () => {
    const content = orchestratorStore.exportJSON();
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({
        defaultPath: "orchestrator-flow.json",
        filters: [{ name: "Uartix+ " + tx("编排文档", "flow doc"), extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await invoke("save_text_file", { path, content });
      toast(tx("已导出编排文档", "Flow doc exported"));
    } catch {
      // 浏览器（非 Tauri）降级：锚点下载
      const blob = new Blob([content], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "orchestrator-flow.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  /* ---------- 渲染 ---------- */

  return (
    <div className={`orch${readOnly ? " ro" : ""}`}>
      {/* 拖拽 ghost（portal 到 body；useListDrag 直写 transform 跟手） */}
      {drag.ghost}
      {readOnly && (
        <div className="orch-ro-bar" title={tx("Operator 只读模式：编排配置与结构只读，测试运行（总开关 / 运行按钮 / 日志 / 导出）可用", "Operator read-only: orchestration config is locked; test running (master switch / Run / log / export) still works")}>
          <IconLock />
          {tx("Operator 只读：编排结构锁定，可运行与查看", "Operator read-only: structure locked, running and viewing allowed")}
        </div>
      )}
      <div className="orch-top">
        <button
          className={`btn sm${doc.settings.masterOn ? " primary" : ""}`}
          title={tx("编排总开关：关闭后所有自动事件与手动运行都停止", "Master switch: stops all auto events and manual runs")}
          onClick={() => orchestratorStore.setMasterOn(!doc.settings.masterOn)}
        >
          {doc.settings.masterOn ? tx("编排中", "Armed") : tx("已停", "Stopped")}
        </button>
        <span className="orch-runinfo" title={tx("运行中 + 排队中的组实例数", "Running + queued group instances")}>
          <IconQueue />
          {runN > 0 ? tx(`运行中 ${runN}`, `${runN} running`) : tx("空闲", "Idle")}
        </span>
        <span
          className={`orch-cap${orchestratorStore.atGroupCap() ? " bad" : ""}`}
          title={tx(`顶层组数量 / 上限（每组实例队列上限 ${ORCH_LIMITS.queueCap}）`, `Top-level groups / limit (per-group queue cap ${ORCH_LIMITS.queueCap})`)}
        >
          {doc.groups.length}/{ORCH_LIMITS.groupCap}
        </span>
        <span className="orch-sp" />
        <button
          className={`btn sm${logOpen ? " primary" : ""}`}
          title={tx("运行日志：触发/跳过/失败/熔断全过程（编辑文档导致实例中止也记在这里）", "Run log: triggers, skips, failures, fuses — including instances stopped by doc edits")}
          onClick={() => setLogOpen((v) => !v)}
        >
          <IconLogs />
          {tx("日志", "Log")}
        </button>
        <button
          className={`btn sm${!sel || (!sel.blockId && !sel.eventId) ? " primary" : ""}`}
          title={tx("查看/编辑编排变量库（选中块时点此回到变量视图）", "Flow vars (click to leave the selected block)")}
          onClick={() => setSel(null)}
        >
          {tx("变量库", "Vars")}
        </button>
        <span className="orch-sp" />
        <button
          className="btn sm"
          disabled={orchestratorStore.atGroupCap() || readOnly}
          title={
            readOnly
              ? tx("Operator 只读模式：不能新建组", "Operator read-only: cannot create groups") + roTip
              : orchestratorStore.atGroupCap()
                ? tx(`已达上限 ${ORCH_LIMITS.groupCap}，请先删除或合并组`, `Limit ${ORCH_LIMITS.groupCap} reached — delete or merge first`)
                : tx("新建一个顶层编排组", "Create a top-level group")
          }
          onClick={() => {
            setSel(null); // 新建组后回到变量视图，避免选中态跨组悬挂
            createGroup();
          }}
        >
          <IconPlus />
          {tx("新建组", "New group")}
        </button>
        <select
          className="input orch-sel"
          value=""
          disabled={readOnly}
          title={
            readOnly
              ? tx("Operator 只读模式：不能从序列导入", "Operator read-only: cannot import suites") + roTip
              : tx("把测试序列器的套件转换为一个编排组（先确认，导入后默认停用）", "Convert a sequencer suite into a group (confirm first; imported disabled)")
          }
          onChange={(e) => {
            const s = suites.suites.find((x) => x.id === e.target.value);
            if (s) void importFromSuite(s);
          }}
        >
          <option value="">{tx("从序列导入", "Import from sequencer")}</option>
          {suites.suites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button
          className="btn sm"
          disabled={readOnly}
          title={
            readOnly
              ? tx("Operator 只读模式：不能导入编排文档", "Operator read-only: cannot import a flow doc") + roTip
              : tx("导入编排文档 JSON", "Import flow doc JSON")
          }
          onClick={() => fileRef.current?.click()}
        >
          {tx("导入", "Import")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const err = orchestratorStore.importJSON(await f.text());
            if (err) {
              await alertDialog(err);
              return;
            }
            setSel(null);
            toast(tx("已导入编排文档", "Flow doc imported"));
            const first = orchestratorStore.getSnapshot().doc.groups[0];
            if (first) flashNewGroup(first.id);
          }}
        />
        <button
          className="btn sm"
          title={tx("导出编排文档 JSON（含变量与组；走系统保存对话框）", "Export flow doc JSON (vars and groups) via the system save dialog")}
          onClick={() => void doExport()}
        >
          {tx("导出", "Export")}
        </button>
      </div>
      <div className="orch-body">
        <div className="orch-canvas" data-orch-list>
          {doc.groups.length === 0 && (
            <div className="orch-empty">
              <div className="orch-empty-t">{tx("自动编排器", "Orchestrator")}</div>
              <div className="orch-empty-d">
                {tx(
                  "组 = 编排单元：头部事件槽挂事件块（帧命中/阈值/定时器/哨兵…）自动触发，组内块线性执行；支持如果/循环逻辑块、变量库与调用测试序列。不挂事件的组由运行按钮手动跑或被别的组调用。",
                  "A group is an orchestration unit: event blocks at the head auto-trigger it; blocks inside run linearly. Supports if/loop logic, flow vars and sequencer calls.",
                )}
              </div>
              <ol className="orch-steps">
                <li>{tx("新建组，往里添加动作块（发送 / 等待 / 如果 / 循环…）", "Create a group, add action blocks (send / wait / if / loop…)")}</li>
                <li>{tx("给组挂事件（阈值 / 帧命中 / 定时器…），或直接用运行按钮手动跑", "Attach events (threshold / frame / timer…), or run it with the Run button")}</li>
                <li>{tx("打开左上「编排中」总开关——条件一满足就自动执行", "Flip the master switch — actions run the moment conditions hit")}</li>
              </ol>
              <div className="orch-empty-ops">
                <button className="btn primary" disabled={readOnly} title={readOnly ? tx("Operator 只读模式：不能新建组", "Operator read-only: cannot create groups") : undefined} onClick={() => createGroup()}>
                  <IconPlus />
                  {tx("新建组", "New group")}
                </button>
                <button className="btn" disabled={readOnly} onClick={() => setPresetOpen((v) => !v)}>
                  {tx("从模板新建", "From template")}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const r = requestAsk(
                      tx(
                        "我想在自动编排器里搭一条自动化。请先问我 2~3 个关键问题（触发条件、要执行的动作、需要的变量），然后用 orchestrator 动作直接帮我搭好。",
                        "I want to build an automation in the orchestrator. Ask me 2-3 key questions (trigger, actions, vars), then build it with orchestrator actions.",
                      ),
                    );
                    toast(r.ok ? tx("已把需求转给 AI 助手", "Sent to the AI assistant") : (r.err ?? tx("AI 助手忙，稍后再试", "AI busy, try later")));
                  }}
                >
                  {tx("让 AI 帮我搭", "Ask AI to build")}
                </button>
              </div>
              {presetOpen && (
                <div className="orch-preset-list">
                  {ORCH_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className="orch-preset"
                      disabled={readOnly}
                      title={tx(p.desc.zh, p.desc.en)}
                      onClick={() => {
                        // P78b：模板 = 组数组 + 可选变量声明；逐组导入、变量重名跳过
                        const bundle = p.build();
                        const free = ORCH_LIMITS.groupCap - orchestratorStore.getSnapshot().doc.groups.length;
                        if (bundle.groups.length > free) {
                          toast(tx(`编排组已达上限 ${ORCH_LIMITS.groupCap}，无法导入该模板`, `Group limit ${ORCH_LIMITS.groupCap} reached`));
                          return;
                        }
                        const ids = bundle.groups
                          .map((g) => orchestratorStore.importPresetGroup(g))
                          .filter((x): x is string => !!x);
                        if (!ids.length) return;
                        for (const v of bundle.vars ?? []) {
                          if (!orchestratorStore.getSnapshot().doc.vars.some((x) => x.name === v.name)) {
                            orchestratorStore.addVar(v);
                          }
                        }
                        setPresetOpen(false);
                        setSel(null);
                        toast(
                          tx(
                            `已导入「${p.name.zh}」（${ids.length} 个组${bundle.vars?.length ? ` + ${bundle.vars.length} 个变量` : ""}，未启用，检查参数后手动打开）`,
                            `Imported "${p.name.en}" (${ids.length} group(s)${bundle.vars?.length ? ` + ${bundle.vars.length} vars` : ""}, disabled — review then enable)`,
                          ),
                        );
                        flashNewGroup(ids[0]);
                      }}
                    >
                      <span className="orch-preset-n">{tx(p.name.zh, p.name.en)}</span>
                      <span className="orch-preset-d">{tx(p.desc.zh, p.desc.en)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {doc.groups.map((g) => (
            <GroupCard
              key={g.id}
              g={g}
              doc={doc}
              masterOn={doc.settings.masterOn}
              sel={sel}
              onSelect={setSel}
              addAt={addAt}
              setAddAt={setAddAt}
              startDrag={startDrag}
              flash={flashGroup === g.id}
              onOpenLogs={openLogsFor}
              readOnly={readOnly}
              roTip={roTip}
            />
          ))}
        </div>
        {sel && (sel.blockId || sel.eventId) ? (
          <Inspector sel={sel} doc={doc} onSel={setSel} />
        ) : (
          <VarsEditor />
        )}
      </div>
      {logOpen && (
        <LogDrawer
          doc={doc}
          groupId={logGroup}
          onlyFail={logOnlyFail}
          onGroup={setLogGroup}
          onOnlyFail={setLogOnlyFail}
          onClose={() => setLogOpen(false)}
        />
      )}
    </div>
  );
}

/* ================= 运行日志抽屉（P74c P0-UI） ================= */

const PHASE_META: Record<LogPhase, { zh: string; en: string; cls: string }> = {
  trigger: { zh: "触发", en: "TRIG", cls: "trig" },
  skip: { zh: "跳过", en: "SKIP", cls: "skip" },
  block: { zh: "块", en: "BLK", cls: "blk" },
  fail: { zh: "失败", en: "FAIL", cls: "fail" },
  abort: { zh: "中止", en: "ABRT", cls: "abort" },
  fuse: { zh: "熔断", en: "FUSE", cls: "fuse" },
  done: { zh: "完成", en: "DONE", cls: "done" },
};

/** 抽屉一次最多渲染的行数（引擎缓冲 800 条，DOM 只画最近的，避免长面板卡顿） */
const LOG_ROWS = 300;

function LogDrawer(props: {
  doc: FlowDoc;
  groupId: string | null;
  onlyFail: boolean;
  onGroup: (g: string | null) => void;
  onOnlyFail: (v: boolean) => void;
  onClose: () => void;
}) {
  const { doc, groupId, onlyFail, onGroup, onOnlyFail, onClose } = props;
  // 面板本身 500ms 轮询重渲染，这里直接读引擎快照即可（无需额外订阅）。
  // 过滤 800 条是微秒级开销；DOM 只画最近 LOG_ROWS 行，所以不做缓存。
  const all = bind.orchEngine.getLogs();
  const nameOf = (id: string) => (id ? doc.groups.find((g) => g.id === id)?.name ?? id : tx("全局", "Global"));
  const filtered = all.filter(
    (l) => (!groupId || l.groupId === groupId) && (!onlyFail || l.phase === "fail" || l.phase === "fuse"),
  );
  const rows = filtered.slice(Math.max(0, filtered.length - LOG_ROWS)).reverse();

  const groupsWithLogs: string[] = [];
  for (const l of all) if (l.groupId && !groupsWithLogs.includes(l.groupId)) groupsWithLogs.push(l.groupId);

  const failN = all.filter((l) => l.phase === "fail" || l.phase === "fuse").length;

  return (
    <div className="orch-log">
      <div className="orch-log-head">
        <span className="orch-log-title">
          <IconLogs />
          {tx("运行日志", "Run log")}
        </span>
        <span className="orch-log-count">
          {tx(`共 ${all.length} 条`, `${all.length} entries`)}
          {failN > 0 && <i className="orch-log-bad">{tx(` · 异常 ${failN}`, ` · ${failN} issues`)}</i>}
        </span>
        <span className="orch-sp" />
        <button
          className={`btn sm${onlyFail ? " primary" : ""}`}
          title={tx("只看失败/熔断", "Failures & fuses only")}
          onClick={() => onOnlyFail(!onlyFail)}
        >
          {tx("只看异常", "Issues")}
        </button>
        <button className="btn sm" title={tx("清空日志缓冲", "Clear the log buffer")} onClick={() => bind.orchEngine.clearLogs()}>
          {tx("清空", "Clear")}
        </button>
        <button className="orch-log-x" title={tx("收起日志", "Collapse log")} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="orch-log-filters">
        <button className={`orch-chip-btn${groupId === null ? " on" : ""}`} onClick={() => onGroup(null)}>
          {tx("全部组", "All groups")}
        </button>
        {groupsWithLogs.map((gid) => (
          <button key={gid} className={`orch-chip-btn${groupId === gid ? " on" : ""}`} onClick={() => onGroup(groupId === gid ? null : gid)}>
            {nameOf(gid)}
          </button>
        ))}
      </div>
      <div className="orch-log-rows">
        {rows.length === 0 && (
          <div className="orch-log-empty">
            {all.length === 0
              ? tx("还没有运行记录：挂好事件后打开总开关，或点组上的运行按钮手动跑一次", "No runs yet — arm the master switch, or hit Run on a group")
              : tx("当前筛选下没有记录", "No entries match the current filter")}
          </div>
        )}
        {rows.map((l, i) => (
          <LogRow key={`${l.ts}-${l.instId}-${l.blockId ?? ""}-${i}`} l={l} groupName={nameOf(l.groupId)} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ l, groupName }: { l: LogEntry; groupName: string }) {
  const m = PHASE_META[l.phase];
  const time = new Date(l.ts).toLocaleTimeString();
  return (
    <div className={`orch-log-row p-${m.cls}`} title={`${time} · ${groupName} · ${l.detail}`}>
      <span className="orch-log-time">{time}</span>
      <span className={`orch-log-tag t-${m.cls}`}>{tx(m.zh, m.en)}</span>
      <span className="orch-log-g">{groupName}</span>
      <span className="orch-log-d">
        {l.instId > 0 && <i className="orch-log-inst">#{l.instId}</i>}
        {l.detail}
      </span>
      {l.durMs !== undefined && <span className="orch-log-dur">{l.durMs}ms</span>}
    </div>
  );
}

/** 统计套件里的块数（导入确认对话框用；组容器按 1 块算，避免夸大节奏） */
function countBlocks(steps: Suite["steps"]): number {
  let n = 0;
  const walk = (list: Suite["steps"]) => {
    for (const s of list) {
      n++;
      if (s.kind === "group") walk(s.children);
    }
  };
  walk(steps);
  return n;
}

function findNode(nodes: FlowNode[], id: string): FlowNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === "group") {
      const r = findNode(n.children, id);
      if (r) return r;
    } else if (n.kind === "if") {
      const r = findNode([...n.then, ...n.els], id);
      if (r) return r;
    } else if (n.kind === "loop") {
      const r = findNode(n.body, id);
      if (r) return r;
    }
  }
  return undefined;
}

/* ================= 组卡片 ================= */

function GroupCard(props: {
  g: GroupNode;
  doc: FlowDoc;
  masterOn: boolean;
  sel: Sel | null;
  onSelect: (s: Sel | null) => void;
  addAt: AddAt | null;
  setAddAt: (v: AddAt | null) => void;
  startDrag: (e: React.PointerEvent, kind: "blk" | "ev", id: string, groupId: string) => void;
  /** 刚从序列导入 → 高亮 1.6s（B7 定位） */
  flash: boolean;
  onOpenLogs: (groupId: string) => void;
  /** C1：Operator 只读 → 结构编辑入口置灰（▶ 运行与折叠查看保留） */
  readOnly: boolean;
  roTip: string;
}) {
  const { g, doc, masterOn, sel, onSelect, addAt, setAddAt, startDrag, flash, onOpenLogs, readOnly, roTip } = props;
  const [editing, setEditing] = useState(false);
  const [settingsAt, setSettingsAt] = useState<HTMLElement | null>(null);
  const runBlock = manualBlockReason(g, masterOn);
  const cd = g.cooldownMs ?? 0;
  const roTitle = (t: string) => (readOnly ? t + roTip : t);

  return (
    <div className={`orch-card${g.enabled ? "" : " off"}${flash ? " flash" : ""}`} data-orch-card={g.id}>
      <div className="orch-card-head">
        <button
          className="orch-fold"
          title={tx("折叠/展开", "Collapse/expand")}
          onClick={() => orchestratorStore.updateGroup(g.id, { collapsed: !g.collapsed })}
        >
          <IconChevron dir={g.collapsed ? "right" : "down"} />
        </button>
        {editing ? (
          <input
            className="input orch-name"
            autoFocus
            defaultValue={g.name}
            onBlur={(e) => {
              orchestratorStore.updateGroup(g.id, { name: e.target.value });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span
            className="orch-title"
            onDoubleClick={() => {
              if (readOnly) return;
              setEditing(true);
            }}
            title={readOnly ? tx("双击重命名", "Double-click to rename") + roTip : tx("双击重命名", "Double-click to rename")}
          >
            {g.name}
          </span>
        )}
        {/* 一眼可判「这个组会不会自己跑」：事件数 + 手动可用性 */}
        <span
          className={`orch-evcount${g.events.length === 0 ? " manual" : ""}`}
          title={
            g.events.length === 0
              ? tx("事件槽为空：本组不会自动触发，只能手动运行或被其他组调用", "Empty event slot: never auto-triggers — run it manually or call it from another group")
              : tx(`挂了 ${g.events.length} 个事件块`, `${g.events.length} event block(s)`)
          }
        >
          {g.events.length === 0 ? tx("手动", "manual") : tx(`事件 ${g.events.length}`, `evt ${g.events.length}`)}
        </span>
        {cd > 0 && (
          <span
            className="orch-cd"
            title={tx(`静默期 ${cd}ms：上次触发后的这段时间内新事件直接丢弃`, `Silence window ${cd}ms: events inside it are dropped`)}
          >
            <IconClock />
            {cd >= 1000 ? `${(cd / 1000).toFixed(cd % 1000 === 0 ? 0 : 1)}s` : `${cd}ms`}
          </span>
        )}
        <GroupStatsChip gid={g.id} onOpenLogs={onOpenLogs} />
        <span className="orch-sp" />
        <input
          type="checkbox"
          className="sq-en"
          checked={g.enabled}
          disabled={readOnly}
          title={roTitle(tx("启用/禁用该组（禁用后事件不触发、运行按钮也不跑）", "Enable/disable the group"))}
          onChange={(e) => orchestratorStore.updateGroup(g.id, { enabled: e.target.checked })}
        />
        <button
          className={`sq-a${runBlock ? " dis" : ""}`}
          disabled={!!runBlock}
          title={runBlock ?? tx("手动运行一次（不受熔断与静默期限制）", "Run once manually (ignores fuse and silence window)")}
          onClick={() => {
            if (!bind.orchEngine.runManual(g.id)) toast(runBlock ?? tx("触发未生效（队列已满？）", "Trigger did not fire (queue full?)"));
          }}
        >
          <IconPlay />
        </button>
        <button
          className="sq-a"
          disabled={readOnly}
          title={roTitle(tx("复制该组（含子树）", "Duplicate (with subtree)"))}
          onClick={() => {
            if (!orchestratorStore.duplicateGroup(g.id) && !readOnly)
              toast(tx(`编排组已达上限 ${ORCH_LIMITS.groupCap}，无法再复制`, `Group limit ${ORCH_LIMITS.groupCap} reached`));
          }}
        >
          <IconCopy />
        </button>
        <button
          className="sq-a"
          disabled={readOnly}
          title={roTitle(tx("组设置：静默期 / 满队列策略 / 备注", "Group settings: silence window / queue policy / note"))}
          onClick={(e) => setSettingsAt(settingsAt ? null : e.currentTarget)}
        >
          <IconTune />
        </button>
        <button
          className="sq-a bad"
          disabled={readOnly}
          title={roTitle(tx("删除该组", "Delete the group"))}
          onClick={() => {
            void (async () => {
              if (
                !(await confirmDialog({
                  message: tx(`确定删除组「${g.name}」？整棵块流与事件槽一并删除，不可撤销。`, `Delete group "${g.name}"? Its whole block flow and events will be removed. This cannot be undone.`),
                  danger: true,
                  okLabel: tx("删除", "Delete"),
                }))
              )
                return;
              orchestratorStore.removeGroup(g.id);
            })();
          }}
        >
          <IconClose />
        </button>
      </div>

      {g.note && !g.collapsed && <div className="orch-note">{g.note}</div>}

      {settingsAt && <GroupSettings g={g} anchor={settingsAt} onClose={() => setSettingsAt(null)} />}

      {/* 事件槽（顶层组才有触发语义；画布只渲染顶层组）。落点指示由 useListDrag 直写 DOM */}
      <div
        className="orch-slot"
        data-orch-slot={g.id}
        title={tx("事件槽：自动触发器挂这里（可拖动排序）", "Event slot: auto triggers live here (draggable)")}
      >
        <span className="orch-slot-lab">{tx("事件", "Events")}</span>
        {g.events.length === 0 && (
          <span className="orch-slot-empty" title={tx("挂上事件块后本组会自动触发；也可以只手动运行或被其他组调用", "Attach an event block to auto-trigger; otherwise it stays manual/callable")}>
            {tx("未挂事件 · 仅可手动运行或被其他组调用", "No events · run manually or via other groups only")}
          </span>
        )}
        {g.events.map((ev) => {
          const h = eventHealth(ev, doc);
          return (
            <span
              key={ev.id}
              className={`orch-ev${sel?.eventId === ev.id && sel?.groupId === g.id ? " sel" : ""}`}
              data-orch-ev={ev.id}
              onClick={() => onSelect({ groupId: g.id, eventId: ev.id })}
              onPointerDown={(e) => {
                // 徽标拖拽排序（P75 B3 接上）：× 按钮与只读态不拖；未过激活阈值的按下仍走 onClick 选中
                if (readOnly || (e.target as HTMLElement).closest("button")) return;
                startDrag(e, "ev", ev.id, g.id);
              }}
            >
              {eventSummary(ev)}
              {h && <i className={`orch-ev-h ${h.lvl}`} title={h.tip} />}
              <button
                className="orch-ev-x"
                disabled={readOnly}
                title={roTitle(tx("移除事件", "Remove event"))}
                onClick={(e) => {
                  e.stopPropagation();
                  orchestratorStore.removeEvent(g.id, ev.id);
                }}
              >
                <IconClose />
              </button>
            </span>
          );
        })}
        <EventAdd groupId={g.id} readOnly={readOnly} roTip={roTip} onSelect={onSelect} />
      </div>

      {!g.collapsed && (
        <div className="orch-children">
          {g.children.map((n) => (
            <RenderNode
              key={n.id}
              node={n}
              groupId={g.id}
              depth={1}
              sel={sel}
              onSelect={onSelect}
              addAt={addAt}
              setAddAt={setAddAt}
              startDrag={startDrag}
              readOnly={readOnly}
              roTip={roTip}
            />
          ))}
          <AddHere
            groupId={g.id}
            parentId={null}
            addAt={addAt}
            setAddAt={setAddAt}
            label={tx("在此添加块", "Add block here")}
            readOnly={readOnly}
            roTip={roTip}
          />
        </div>
      )}
    </div>
  );
}

/* ================= 组设置（A3：组级节流终于有了入口） ================= */

const CD_PRESETS = [0, 500, 1000, 5000, 30000, 60000];

function GroupSettings({ g, anchor, onClose }: { g: GroupNode; anchor: HTMLElement; onClose: () => void }) {
  const cd = g.cooldownMs ?? 0;
  const policy = g.queuePolicy ?? "dropNew";
  const [draft, setDraft] = useState({ cd: String(cd), note: g.note ?? "" });
  return (
    <OrchDropdown anchor={anchor} onClose={onClose} interactive>
      <span className="orch-pop-h">{tx("静默期（冷却）", "Silence window (cooldown)")}</span>
      <div className="orch-set-hint">
        {tx("上次触发后的这段时间内，本组的新事件直接丢弃。阈值/哨兵这类高频源建议 1~5s。", "Events arriving inside this window after a trigger are dropped. Use 1–5s for high-rate sources like thresholds or sentinels.")}
      </div>
      <div className="orch-set-row">
        <input
          className="input orch-set-num"
          type="number"
          min={0}
          max={600000}
          value={draft.cd}
          onChange={(e) => setDraft((d) => ({ ...d, cd: e.target.value }))}
          onBlur={() => orchestratorStore.updateGroup(g.id, { cooldownMs: Number(draft.cd) || 0 })}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="orch-set-unit">{tx("ms（0 = 不冷却）", "ms (0 = off)")}</span>
      </div>
      <div className="orch-set-row">
        {CD_PRESETS.map((p) => (
          <button
            key={p}
            className={`orch-chip-btn${cd === p ? " on" : ""}`}
            onClick={() => {
              setDraft((d) => ({ ...d, cd: String(p) }));
              orchestratorStore.updateGroup(g.id, { cooldownMs: p });
            }}
          >
            {p === 0 ? tx("关", "off") : p % 1000 === 0 ? `${p / 1000}s` : `${p}ms`}
          </button>
        ))}
      </div>

      <span className="orch-pop-h">{tx("满队列策略（队列深度 8）", "On full queue (depth 8)")}</span>
      {QUEUE_POLICY.map((p) => (
        <button
          key={p.k}
          className="orch-pop-i orch-pop-radio"
          title={tx(p.tipZh, p.tipEn)}
          onClick={() => orchestratorStore.updateGroup(g.id, { queuePolicy: p.k })}
        >
          {policy === p.k ? <IconDot /> : <IconCircle />}
          {tx(p.zh, p.en)}
        </button>
      ))}
      <div className="orch-set-hint">
        {tx("组内实例严格 FIFO 串行：在跑 1 个 + 最多排队 7 个。", "Instances run strictly FIFO: 1 running + up to 7 queued.")}
      </div>

      <span className="orch-pop-h">{tx("备注", "Note")}</span>
      <textarea
        className="input orch-set-note"
        rows={2}
        placeholder={tx("给这个组留一句说明（显示在组标题下）", "A short note shown under the group title")}
        value={draft.note}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
        onBlur={() => orchestratorStore.updateGroup(g.id, { note: draft.note })}
      />
    </OrchDropdown>
  );
}

/** 组运行统计徽标：跑过 N 次 · 失败 M（引擎 stats 常驻，面板 500ms 轮询驱动刷新）；点击→只看该组日志 */
function GroupStatsChip({ gid, onOpenLogs }: { gid: string; onOpenLogs: (gid: string) => void }) {
  const st = bind.orchEngine.statsOf(gid);
  if (st.total === 0) return null;
  const last = st.lastTs ? new Date(st.lastTs).toLocaleTimeString() : "";
  return (
    <button
      className={`orch-stats${st.fail > 0 ? " bad" : ""}`}
      title={tx(
        `共跑 ${st.total} 次，失败 ${st.fail} 次；上次 ${last}：${st.lastDetail}\n点击查看本组运行日志`,
        `${st.total} runs, ${st.fail} failed; last ${last}: ${st.lastDetail}\nClick to view this group's log`,
      )}
      onClick={() => onOpenLogs(gid)}
    >
      {tx(`跑 ${st.total}`, `${st.total}×`)}
      {st.fail > 0 && <i className="orch-stats-fail">{tx(`败 ${st.fail}`, `✗${st.fail}`)}</i>}
    </button>
  );
}

function EventAdd(props: { groupId: string; readOnly: boolean; roTip: string; onSelect: (s: { groupId: string; eventId: string }) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <span className="orch-evadd-wrap">
      <button
        className="orch-evadd"
        disabled={props.readOnly}
        title={
          props.readOnly
            ? tx("添加事件块", "Add event block") + props.roTip
            : tx("添加事件块", "Add event block")
        }
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <IconPlus />
      </button>
      {anchor && (
        <OrchDropdown anchor={anchor} onClose={() => setAnchor(null)}>
          <span className="orch-pop-h">{tx("事件块（挂到事件槽，自动触发本组）", "Event block (auto-triggers the group)")}</span>
          {EVENT_MENU.map((m) => (
            <button
              key={m.k}
              className="orch-pop-i"
              title={tx(m.tip.zh, m.tip.en)}
              onClick={() => {
                const ev = orchestratorStore.makeEvent(m.k);
                orchestratorStore.addEvent(props.groupId, ev);
                // 新事件立即进检查器：多数事件需要选通道/填匹配才算配置完，
                // 不选中就会留下「既不自动触发又不能手动 ▶」的两头堵状态
                props.onSelect({ groupId: props.groupId, eventId: ev.id });
                setAnchor(null);
              }}
            >
              {tx(m.label.zh, m.label.en)}
            </button>
          ))}
        </OrchDropdown>
      )}
    </span>
  );
}

/* ================= 块行递归渲染 ================= */

function RenderNode(props: {
  node: FlowNode;
  groupId: string;
  depth: number;
  sel: Sel | null;
  onSelect: (s: Sel | null) => void;
  addAt: AddAt | null;
  setAddAt: (v: AddAt | null) => void;
  startDrag: (e: React.PointerEvent, kind: "blk" | "ev", id: string, groupId: string) => void;
  readOnly: boolean;
  roTip: string;
}) {
  const { node, groupId, depth, sel, onSelect, addAt, setAddAt, startDrag, readOnly, roTip } = props;
  const selected = sel?.blockId === node.id && sel.groupId === groupId;
  const container = BLOCK_REGISTRY[node.kind].container;
  const roTitle = (t: string) => (readOnly ? t + roTip : t);

  const body = (list: FlowNode[]) =>
    list.map((c) => (
      <RenderNode
        key={c.id}
        node={c}
        groupId={groupId}
        depth={depth + 1}
        sel={sel}
        onSelect={onSelect}
        addAt={addAt}
        setAddAt={setAddAt}
        startDrag={startDrag}
        readOnly={readOnly}
        roTip={roTip}
      />
    ));

  return (
    <div key={node.id}>
      <div
        className={`sq-row orch-row k-${kindCls(node.kind)} d${Math.min(depth, 4)}${selected ? " sel" : ""}`}
        data-orch-row={node.id}
        onClick={() => onSelect({ groupId, blockId: node.id })}
      >
        <span
          className="sq-grip"
          title={tx("按住拖动排序（松手落到目标行上/下/内）", "Hold and drag to reorder (drop above/below/into)")}
          onPointerDown={(e) => {
            if (readOnly) return;
            startDrag(e, "blk", node.id, groupId);
          }}
        >
          <IconGrip />
        </span>
        <input
          type="checkbox"
          className="sq-en"
          checked={node.enabled}
          disabled={readOnly}
          title={roTitle(tx("启用/禁用该块（禁用后跳过执行）", "Enable/disable this block"))}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => orchestratorStore.updateBlock(groupId, node.id, { enabled: e.target.checked })}
        />
        <span className={`sq-kind orch-k-${kindCls(node.kind)}`}>
          {(l => tx(l.zh, l.en))(kindLabel(node.kind))}
        </span>
        <span className="orch-summary" title={summaryText(node)}>
          <Summary n={node} />
        </span>
        <span className="orch-edit-hint">{tx("编辑", "Edit")}</span>
        {("onFail" in node) && (
          <span
            className={`orch-failtag${(node as ExecBlock).onFail === "continue" ? " c" : ""}${readOnly ? " dis" : ""}`}
            title={roTitle(tx("失败时：中止=终止本组，继续=记日志接着跑", "On fail: abort=stop the group, continue=log and go on"))}
            onClick={(e) => {
              e.stopPropagation();
              if (readOnly) return;
              orchestratorStore.updateBlock(groupId, node.id, {
                onFail: (node as ExecBlock).onFail === "continue" ? "abort" : "continue",
              });
            }}
          >
            {(node as ExecBlock).onFail === "continue" ? tx("继续", "cont") : tx("中止", "abort")}
          </span>
        )}
        <span className="sq-acts" onClick={(e) => e.stopPropagation()}>
          <button className="sq-a" disabled={readOnly} title={roTitle(tx("上移", "Move up"))} onClick={() => nudge(groupId, node.id, -1)}>
            <IconArrowUp />
          </button>
          <button className="sq-a" disabled={readOnly} title={roTitle(tx("下移", "Move down"))} onClick={() => nudge(groupId, node.id, 1)}>
            <IconArrowDown />
          </button>
          <button className="sq-a" disabled={readOnly} title={roTitle(tx("复制该块（含子树）", "Duplicate (with subtree)"))} onClick={() => orchestratorStore.duplicateBlock(groupId, node.id)}>
            <IconCopy />
          </button>
          <button className="sq-a bad" disabled={readOnly} title={roTitle(tx("删除", "Delete"))} onClick={() => orchestratorStore.removeBlock(groupId, node.id)}>
            <IconClose />
          </button>
        </span>
      </div>

      {container && (
        <div className="sq-children">
          {node.kind === "if" && (
            <>
              <div className="orch-branch">{tx("那么", "THEN")}</div>
              {body(node.then)}
              <AddHere groupId={groupId} parentId={node.id} which="then" addAt={addAt} setAddAt={setAddAt} readOnly={readOnly} roTip={roTip} />
              <div className="orch-branch">{tx("否则", "ELSE")}</div>
              {body(node.els)}
              <AddHere groupId={groupId} parentId={node.id} which="els" addAt={addAt} setAddAt={setAddAt} readOnly={readOnly} roTip={roTip} />
            </>
          )}
          {node.kind === "loop" && (
            <>
              {body(node.body)}
              <AddHere groupId={groupId} parentId={node.id} which="body" addAt={addAt} setAddAt={setAddAt} readOnly={readOnly} roTip={roTip} />
            </>
          )}
          {node.kind === "group" && (
            <>
              {body(node.children)}
              <AddHere groupId={groupId} parentId={node.id} addAt={addAt} setAddAt={setAddAt} readOnly={readOnly} roTip={roTip} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** if 的 then/els 是两个子列表：AddHere 用 which 区分落点；拖拽「进内」默认进 THEN */
function AddHere(props: {
  groupId: string;
  parentId: string | null;
  which?: "then" | "els" | "body";
  addAt: AddAt | null;
  setAddAt: (v: AddAt | null) => void;
  label?: string;
  readOnly: boolean;
  roTip: string;
}) {
  const { groupId, parentId, which, addAt, setAddAt, label, readOnly, roTip } = props;
  const active =
    addAt && addAt.groupId === groupId && addAt.parentId === parentId && (addAt.which ?? null) === (which ?? null);
  return (
    <span className="orch-addhere-wrap">
      <button
        className={`orch-addbar${active ? " open" : ""}`}
        disabled={readOnly}
        title={readOnly ? tx("添加块", "Add block") + roTip : undefined}
        onClick={(e) => setAddAt(active ? null : { groupId, parentId, which, anchor: e.currentTarget })}
      >
        {active ? (
          <>
            <IconChevron dir="down" />
            {tx("收起", "Close")}
          </>
        ) : (
          <>
            <IconPlus />
            {label ?? tx("在此添加块", "Add block here")}
          </>
        )}
      </button>
      {active && addAt && (
        <OrchDropdown anchor={addAt.anchor ?? null} onClose={() => setAddAt(null)} cols>
          {(["exec", "logic", "org"] as BlockGrp[]).map((grp) => (
            <span key={grp} className="orch-pop-g">
              <span className="orch-pop-h">{tx(BLOCK_GRP_TITLE[grp].zh, BLOCK_GRP_TITLE[grp].en)}</span>
              {BLOCK_MENU.filter((m) => m.cat === grp).map((m) => (
                <button
                  key={m.k}
                  className="orch-pop-i"
                  title={tx(m.tip.zh, m.tip.en)}
                  onClick={() => {
                    const node = orchestratorStore.makeBlock(m.k);
                    if (parentId === null) {
                      const list = findTopList(groupId);
                      orchestratorStore.addBlock(groupId, null, list ? list.length : 0, node);
                    } else {
                      addToContainer(groupId, parentId, node, which === "els" ? "els" : "then");
                    }
                    setAddAt(null);
                  }}
                >
                  <span className={`orch-dot orch-dot-${m.cls}`} />
                  {tx(m.label.zh, m.label.en)}
                </button>
              ))}
            </span>
          ))}
        </OrchDropdown>
      )}
    </span>
  );
}

function findTopList(groupId: string): FlowNode[] | null {
  const doc = currentDoc();
  const g = doc?.groups.find((x) => x.id === groupId);
  return g ? g.children : null;
}

function addToContainer(groupId: string, parentId: string, node: FlowNode, which?: "then" | "els"): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const p = findNode(doc.groups.find((g) => g.id === groupId)?.children ?? [], parentId);
  if (!p) return false;
  if (p.kind === "group") return orchestratorStore.addBlock(groupId, p.id, null, node) !== null;
  if (p.kind === "loop") return orchestratorStore.addBlock(groupId, p.id, null, node) !== null;
  if (p.kind === "if") return orchestratorStore.addBlock(groupId, p.id, null, node, which) !== null;
  return false;
}

function currentDoc(): FlowDoc | null {
  return bind.orchEngine.getDoc();
}

/** 上移/下移：按当前父列表索引 ±1 */
function nudge(groupId: string, blockId: string, delta: number) {
  const loc = orchestratorStore.locate(groupId, blockId);
  if (!loc) return;
  orchestratorStore.moveBlock(groupId, blockId, loc.parentId, loc.index + delta);
}
