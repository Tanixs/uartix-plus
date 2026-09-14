/**
 * 自动编排器检查器（P74-4b）：选中块/事件的参数编辑 + 变量库/监视。
 *
 * 纯视图：全部编辑走 orchestratorStore 的 update*，引擎值只读
 * （bind.orchEngine.listVars）。表达式输入带即时校验（语法/变量名，
 * evt.* 属运行期上下文不标错）。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { tx } from "../../i18n/strings";
import * as orchestratorStore from "./orchestratorStore";
import * as bind from "./orchestratorBind";
import { MatchEditor } from "../sequencer/SequencerPanel";
import * as sequencerStore from "../sequencer/sequencerStore";
import * as plotStore from "../plot/plotStore";
import * as commandStore from "../controls/commandStore";
import { toast } from "../ai/extRuntime";
import { isOperatorLocked } from "../operator/lock";
import { IconClose, IconPlus } from "../../shared/icons";
import { evalExpr } from "./expr";
import { BLOCK_REGISTRY } from "./blockRegistry";
import { ORCH_LIMITS, VAR_NAME_RE } from "./types";
import * as variableStore from "../controls/variableStore";
import * as controlsStore from "../controls/controlsStore";
import * as templateStore from "../protocol/templateStore";
import type {
  Cond,
  EventBlock,
  FlowDoc,
  FlowNode,
  FlowVar,
  FlowVarType,
  GroupNode,
  OrchOp,
  VarFrom,
} from "./types";

export interface Sel {
  groupId: string;
  blockId?: string;
  eventId?: string;
}

const clampN = (raw: string, lo: number, hi: number, def: number): number => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const fmtVal = (v: number | string | boolean | undefined): string =>
  v === undefined ? "—" : typeof v === "string" ? `"${v}"` : String(v);

function Field(props: { label: string; tip?: string; children: ReactNode }) {
  return (
    <label className="orch-fld">
      <span className="orch-fld-l" title={props.tip}>{props.label}</span>
      {props.children}
    </label>
  );
}

function ChanSelect(props: { value: string; onChange: (v: string) => void }) {
  useSyncExternalStore(plotStore.subscribe, plotStore.getSnapshot);
  const chans = plotStore.getSnapshot().channels;
  return (
    <select
      className="input orch-flex"
      value={props.value}
      title={tx("2D 曲线中的通道（取最新采样值）", "A 2D-plot channel (latest sample)")}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">{chans.length ? tx("选择通道…", "Pick a channel…") : tx("（无通道）", "(no channels)")}</option>
      {chans.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

function VarSelect(props: { doc: FlowDoc; value: string; onChange: (v: string) => void }) {
  return (
    <select
      className="input orch-flex"
      value={props.value}
      title={tx("编排变量（在「变量库」里添加）", "Flow var (add in the Vars view)")}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">{props.doc.vars.length ? tx("选择变量…", "Pick a var…") : tx("（无变量）", "(no vars)")}</option>
      {props.doc.vars.map((v) => (
        <option key={v.name} value={v.name}>{v.name}</option>
      ))}
    </select>
  );
}

function SuiteSelect(props: { value: string; onChange: (v: string) => void }) {
  const suites = useSyncExternalStore(sequencerStore.subscribe, sequencerStore.getSnapshot);
  return (
    <select
      className="input orch-flex"
      value={props.value}
      title={tx("测试序列器里的套件", "A suite from the sequencer")}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">{suites.suites.length ? tx("选择序列…", "Pick a suite…") : tx("（无序列）", "(no suites)")}</option>
      {suites.suites.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  );
}

/** 表达式输入：即时语法/变量校验（evt.* 引用属运行期上下文，不标错） */
function ExprInput(props: { src: string; onChange: (v: string) => void; doc: FlowDoc; placeholder?: string }) {
  const { src, doc } = props;
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const s = src.trim();
    if (!s) {
      setErr(null);
      return;
    }
    try {
      evalExpr(s, { get: (n) => (n === "now" ? 0 : doc.vars.find((v) => v.name === n)?.def), evt: { kind: "manual" } });
      setErr(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m.startsWith("evt.") ? null : m);
    }
  }, [src, doc]);
  return (
    <span className="orch-flex-wrap">
      <input
        className={`input orch-mono orch-flex${err ? " bad" : ""}`}
        value={src}
        placeholder={props.placeholder ?? "speed > 10 && ok"}
        spellCheck={false}
        list="orch-varlist"
        title={tx("表达式：四则/比较/逻辑/变量/evt.字段/白名单函数(abs·min·max·round·floor·ceil·clamp·if·len·fmt)", "Expr: arithmetic/compare/logic/vars/evt.fields/whitelist funcs (abs·min·max·round·floor·ceil·clamp·if·len·fmt)")}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {err && <span className="orch-err">{err}</span>}
    </span>
  );
}

function CmdSelectOrch(props: { cmdId: string; onChange: (id: string) => void }) {
  useSyncExternalStore(commandStore.subscribe, commandStore.getSnapshot); // 命令库变更时重渲染
  const flat = commandStore.flatCommands();
  return (
    <select
      className="input orch-flex"
      value={props.cmdId}
      title={tx("从命令库选择（模板内容支持 {var} 占位）", "Pick from the command library ({var} placeholders supported)")}
      onChange={(e) => props.onChange(e.target.value)}
    >
      <option value="">{flat.length ? tx("选择命令…", "Pick a command…") : tx("（命令库为空）", "(command library empty)")}</option>
      {flat.map(({ item }) => (
        <option key={item.id} value={item.id}>{item.name}</option>
      ))}
    </select>
  );
}

/** 标量输入：number→数字框 / bool→真假选择 / string→文本框（不做隐式转换） */
function ScalarInput(props: {
  kind: FlowVarType;
  value: number | string | boolean;
  onChange: (v: number | string | boolean) => void;
  cls?: string;
}) {
  if (props.kind === "bool") {
    return (
      <select
        className={`input${props.cls ?? " orch-w90"}`}
        value={props.value ? "1" : "0"}
        onChange={(e) => props.onChange(e.target.value === "1")}
      >
        <option value="1">{tx("真", "true")}</option>
        <option value="0">{tx("假", "false")}</option>
      </select>
    );
  }
  if (props.kind === "number") {
    return (
      <input
        className={`input${props.cls ?? " orch-w110"}`}
        type="number"
        value={typeof props.value === "number" ? props.value : Number(props.value) || 0}
        onChange={(e) => props.onChange(e.target.value === "" ? 0 : Number(e.target.value) || 0)}
      />
    );
  }
  return (
    <input
      className={`input${props.cls ?? " orch-w110"}`}
      value={typeof props.value === "string" ? props.value : String(props.value)}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

const mkCond = (k: Cond["k"]): Cond => {
  switch (k) {
    case "chan": return { k: "chan", chId: "", op: "gt", value: 0, tol: 0 };
    case "var": return { k: "var", name: "", op: "eq", value: 0, tol: 0 };
    case "expr": return { k: "expr", src: "" };
    case "evtField": return { k: "evtField", field: "", op: "eq", value: 0 };
    case "session": return { k: "session", state: "open" };
  }
};

const COND_OPS: { v: OrchOp; zh: string; en: string }[] = [
  { v: "eq", zh: "=", en: "=" },
  { v: "ne", zh: "≠", en: "≠" },
  { v: "gt", zh: ">", en: ">" },
  { v: "lt", zh: "<", en: "<" },
  { v: "ge", zh: "≥", en: "≥" },
  { v: "le", zh: "≤", en: "≤" },
  { v: "approx", zh: "≈±容差", en: "≈±tol" },
];

function OpSelect(props: { value: OrchOp; onChange: (v: OrchOp) => void }) {
  return (
    <select className="input orch-w64" value={props.value} onChange={(e) => props.onChange(e.target.value as OrchOp)}>
      {COND_OPS.map((o) => (
        <option key={o.v} value={o.v}>{tx(o.zh, o.en)}</option>
      ))}
    </select>
  );
}

/** 条件列表编辑器（if.conds / loop.cond 共用；AND 关系） */
function CondListEditor(props: { doc: FlowDoc; conds: Cond[]; onCommit: (conds: Cond[]) => void }) {
  const { doc, conds, onCommit } = props;
  const upd = (i: number, next: Cond) => onCommit(conds.map((c, j) => (j === i ? next : c)));

  return (
    <div className="orch-conds">
      {conds.map((c, i) => (
        <div key={i} className="orch-cond">
          <select
            className="input orch-w80"
            value={c.k}
            title={tx("条件来源", "Condition source")}
            onChange={(e) => upd(i, mkCond(e.target.value as Cond["k"]))}
          >
            <option value="chan">{tx("通道", "Channel")}</option>
            <option value="var">{tx("变量", "Var")}</option>
            <option value="expr">{tx("表达式", "Expr")}</option>
            <option value="evtField">{tx("事件字段", "evt field")}</option>
            <option value="session">{tx("会话", "Session")}</option>
          </select>
          {c.k === "chan" && (
            <>
              <ChanSelect value={c.chId} onChange={(v) => upd(i, { ...c, chId: v })} />
              <OpSelect value={c.op} onChange={(op) => upd(i, { ...c, op })} />
              <input
                className="input orch-w90"
                type="number"
                value={c.value}
                title={tx("比较值", "Compare value")}
                onChange={(e) => upd(i, { ...c, value: Number(e.target.value) || 0 })}
              />
              {c.op === "approx" && (
                <input
                  className="input orch-w72"
                  type="number"
                  value={c.tol ?? 0}
                  title={tx("容差", "Tolerance")}
                  onChange={(e) => upd(i, { ...c, tol: Math.max(0, Number(e.target.value) || 0) })}
                />
              )}
            </>
          )}
          {c.k === "var" && (
            <>
              <VarSelect doc={doc} value={c.name} onChange={(v) => upd(i, { ...c, name: v })} />
              <OpSelect value={c.op} onChange={(op) => upd(i, { ...c, op })} />
              <ScalarInput
                kind={doc.vars.find((v) => v.name === c.name)?.type ?? "number"}
                value={c.value}
                onChange={(v) => upd(i, { ...c, value: v })}
              />
              {c.op === "approx" && (
                <input
                  className="input orch-w72"
                  type="number"
                  value={c.tol ?? 0}
                  title={tx("容差", "Tolerance")}
                  onChange={(e) => upd(i, { ...c, tol: Math.max(0, Number(e.target.value) || 0) })}
                />
              )}
            </>
          )}
          {c.k === "expr" && <ExprInput src={c.src} doc={doc} onChange={(src) => upd(i, { ...c, src })} />}
          {c.k === "evtField" && (
            <>
              <input
                className="input orch-w110"
                value={c.field}
                placeholder={tx("字段名（如 value）", "field (e.g. value)")}
                spellCheck={false}
                title={tx("事件上下文字段：帧事件=字段名，阈值=value，变量=old/new", "Event ctx field: frame=field name, threshold=value, var=old/new")}
                onChange={(e) => upd(i, { ...c, field: e.target.value })}
              />
              <OpSelect value={c.op} onChange={(op) => upd(i, { ...c, op })} />
              <input
                className="input orch-w90"
                value={String(c.value)}
                spellCheck={false}
                title={tx("比较值（数字或文本）", "Compare value (number or text)")}
                onChange={(e) => {
                  const t = e.target.value.trim();
                  upd(i, { ...c, value: t !== "" && Number.isFinite(Number(t)) ? Number(t) : e.target.value });
                }}
              />
            </>
          )}
          {c.k === "session" && (
            <select
              className="input orch-flex"
              value={c.state}
              title={tx("会话状态", "Session state")}
              onChange={(e) => upd(i, { ...c, state: e.target.value as typeof c.state })}
            >
              <option value="open">{tx("已连接", "open")}</option>
              <option value="streaming">{tx("在流（2s 内有帧）", "streaming (frames within 2s)")}</option>
              <option value="idle">{tx("空闲（未连接）", "idle (disconnected)")}</option>
            </select>
          )}
          <button
            className="sq-a bad"
            title={tx("删除该条件", "Remove condition")}
            onClick={() => onCommit(conds.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button className="sq-childadd" onClick={() => onCommit([...conds, mkCond("chan")])}>
        {tx("＋ 条件", "＋ Condition")}
      </button>
      <span className="orch-hint">{tx("多个条件同时成立才通过（AND）", "All conditions must hold (AND)")}</span>
    </div>
  );
}

/* B4a：块名称单一真源在 blockRegistry（未知 kind 兜底显示 kind 本身） */
const kindLabel = (k: string): { zh: string; en: string } =>
  (BLOCK_REGISTRY as Record<string, { label: { zh: string; en: string } } | undefined>)[k]?.label ?? {
    zh: k,
    en: k,
  };

/** 全部可调用组（含嵌套组块，缩进表层级）——runGroup 下拉用；引擎 findGroup 本就全树查找 */
function allGroupsFlat(doc: FlowDoc): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walkNodes = (nodes: FlowNode[], depth: number): void => {
    for (const n of nodes) {
      if (n.kind === "group") {
        out.push({ id: n.id, name: n.name, depth });
        walkNodes(n.children, depth + 1);
      } else if (n.kind === "if") {
        walkNodes(n.then, depth);
        walkNodes(n.els, depth);
      } else if (n.kind === "loop") walkNodes(n.body, depth);
    }
  };
  for (const g of doc.groups) {
    out.push({ id: g.id, name: g.name, depth: 0 });
    walkNodes(g.children, 1);
  }
  return out;
}

/** 引用类参数的候选清单（datalist + 编辑期存在性校验的单一边缘） */
function RefDatalists() {
  const ctlVars = variableStore.listVars().map((v) => v.name);
  const swNames: string[] = [];
  for (const p of controlsStore.getSnapshot().pages) {
    for (const c of p.cards) {
      if (c.type === "switch" && !swNames.includes(c.name)) swNames.push(c.name);
    }
  }
  const tpls = templateStore.getSnapshot().rules.templates;
  return (
    <>
      <datalist id="orch-ctlvarlist">
        {ctlVars.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="orch-swlist">
        {swNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="orch-tpllist">
        {tpls.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </datalist>
    </>
  );
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

export function Inspector(props: { sel: Sel; doc: FlowDoc; onSel: (s: Sel | null) => void }) {
  const { sel, doc, onSel } = props;
  const g = doc.groups.find((x) => x.id === sel.groupId);
  if (!g) return null;
  const node = sel.blockId ? findNode(g.children, sel.blockId) : undefined;
  const ev = sel.eventId ? g.events.find((e) => e.id === sel.eventId) : undefined;
  if (!node && !ev) return null;

  const title = ev
    ? tx("事件块", "Event block")
    : ((l => tx(l.zh, l.en))(kindLabel(node!.kind)));

  return (
    <div className="orch-ins">
      <RefDatalists />
      <div className="orch-ins-head">
        <span className="orch-ins-t">{title}</span>
        <span className="orch-ins-path">{g.name}</span>
        <button className="sq-a" title={tx("关闭检查器", "Close inspector")} onClick={() => onSel(null)}>
          <IconClose />
        </button>
      </div>
      {/* C1：Operator 只读 → 整个参数区用一个 disabled fieldset 原生禁用（含 select/input/button），
          关闭检查器等查看动作留在 fieldset 之外仍然可用 */}
      <fieldset className="orch-fs" disabled={isOperatorLocked()}>
        <div className="orch-ins-body">
          {ev ? <EventFields g={g} ev={ev} doc={doc} /> : node && <BlockFields groupId={g.id} node={node} doc={doc} />}
        </div>
      </fieldset>
    </div>
  );
}

/* ---------- 事件参数 ---------- */

function EventFields(props: { g: GroupNode; ev: EventBlock; doc: FlowDoc }) {
  const { g, ev, doc } = props;
  const upd = (patch: Partial<EventBlock>) => orchestratorStore.updateEvent(g.id, ev.id, patch);

  switch (ev.kind) {
    case "manual":
      return (
        <div className="orch-hint">
          {tx("手动事件：仅由组头部的 ▶ 触发，也可被别的组「运行组」调用。", "Manual: fired only by ▶, or invoked by other groups' RunGroup.")}
        </div>
      );
    case "session":
      return (
        <Field label={tx("触发时机", "Phase")} tip={tx("连接打开或断开时触发本组", "Fire this group on connect or disconnect")}>
          <select className="input orch-flex" value={ev.phase} onChange={(e) => upd({ phase: e.target.value as "start" | "stop" })}>
            <option value="start">{tx("连接打开", "connect")}</option>
            <option value="stop">{tx("连接断开", "disconnect")}</option>
          </select>
        </Field>
      );
    case "frame":
      return (
        <>
          <Field label={tx("匹配", "Match")} tip={tx("解码帧命中条件（原始字节/模板/模板+字段）", "Decoded-frame match (raw / template / template+field)")}>
            <MatchEditor match={ev.match} onChange={(m) => upd({ match: m } as Partial<EventBlock>)} />
          </Field>
          <Field label={tx("取样步长", "Stride")} tip={tx("每 N 帧取样一次（1=全量），高频帧流防洪泛", "Sample every N frames (1=all); tames floods")}>
            <input
              className="input orch-w90"
              type="number"
              min={1}
              max={10000}
              value={ev.stride}
              onChange={(e) => upd({ stride: clampN(e.target.value, 1, 10000, 1) })}
            />
          </Field>
        </>
      );
    case "threshold":
      return (
        <>
          <Field label={tx("通道", "Channel")} tip={tx("2D 曲线通道的最新值", "Latest value of a 2D-plot channel")}>
            <ChanSelect value={ev.chId} onChange={(v) => upd({ chId: v } as Partial<EventBlock>)} />
          </Field>
          <Field label={tx("条件", "Rule")} tip={tx("最新值与阈值比较", "Latest value vs threshold")}>
            <select className="input orch-w72" value={ev.op} onChange={(e) => upd({ op: e.target.value as "above" | "below" } as Partial<EventBlock>)}>
              <option value="above">{tx("高于", "above")}</option>
              <option value="below">{tx("低于", "below")}</option>
            </select>
            <input
              className="input orch-w110"
              type="number"
              value={ev.value}
              onChange={(e) => upd({ value: Number(e.target.value) || 0 } as Partial<EventBlock>)}
            />
          </Field>
          <Field label={tx("边沿", "Edge")} tip={tx("进入=穿越瞬间；回落=回到区间内", "enter=on crossing; exit=back inside")}>
            <select className="input orch-w90" value={ev.edge} onChange={(e) => upd({ edge: e.target.value as "enter" | "exit" } as Partial<EventBlock>)}>
              <option value="enter">{tx("进入", "enter")}</option>
              <option value="exit">{tx("回落", "exit")}</option>
            </select>
          </Field>
          <Field label={tx("去抖", "Debounce")} tip={tx("穿越状态需持续 N ms 才确认", "Crossing must hold N ms to confirm")}>
            <input
              className="input orch-w90"
              type="number"
              min={0}
              max={60000}
              value={ev.debounceMs}
              onChange={(e) => upd({ debounceMs: clampN(e.target.value, 0, 60000, 300) } as Partial<EventBlock>)}
            />
            <span className="orch-unit">ms</span>
          </Field>
        </>
      );
    case "timer":
      return (
        <Field label={tx("间隔", "Interval")} tip={tx("每 N ms 触发一次（下限 50ms）", "Fire every N ms (min 50)")}>
          <input
            className="input orch-w110"
            type="number"
            min={50}
            max={3600000}
            value={ev.intervalMs}
            onChange={(e) => upd({ intervalMs: clampN(e.target.value, 50, 3600000, 5000) })}
          />
          <span className="orch-unit">ms</span>
        </Field>
      );
    case "sentinel":
      return (
        <Field label={tx("告警级别", "Level")} tip={tx("warn=警告及以上；crit=仅严重（哨兵需在运行）", "warn=warn and above; crit only (sentinel must run)")}>
          <select className="input orch-flex" value={ev.level} onChange={(e) => upd({ level: e.target.value as "warn" | "crit" } as Partial<EventBlock>)}>
            <option value="warn">{tx("warn 及以上", "warn and above")}</option>
            <option value="crit">{tx("仅 crit", "crit only")}</option>
          </select>
        </Field>
      );
    case "varChanged":
      return (
        <Field label={tx("变量", "Var")} tip={tx("该变量实际变化时触发；条件可用 evt.old / evt.new", "Fires on actual change; use evt.old / evt.new in conds")}>
          <VarSelect doc={doc} value={ev.varName} onChange={(v) => upd({ varName: v } as Partial<EventBlock>)} />
        </Field>
      );
    /* ---------- B4d 新增事件块 ---------- */
    case "frameError":
      return (
        <Field label={tx("取样步长", "Stride")} tip={tx("每 N 个坏帧取样一次（1=全量），高频坏帧防洪泛", "Sample every N bad frames (1=all); tames floods")}>
          <input
            className="input orch-w90"
            type="number"
            min={1}
            max={10000}
            value={ev.stride}
            onChange={(e) => upd({ stride: clampN(e.target.value, 1, 10000, 1) } as Partial<EventBlock>)}
          />
        </Field>
      );
    case "chanChanged":
      return (
        <>
          <Field label={tx("通道", "Channel")} tip={tx("该通道最新值相对上次**报出值**的变化量", "Change of latest value vs last reported")}>
            <ChanSelect value={ev.chId} onChange={(v) => upd({ chId: v } as Partial<EventBlock>)} />
          </Field>
          <Field label={tx("容差", "Tolerance")} tip={tx("变化量 > 容差才算变化（0=任何变化）", "Change must exceed tol (0 = any)")}>
            <input
              className="input orch-w110"
              type="number"
              min={0}
              value={ev.tol}
              onChange={(e) => upd({ tol: Math.max(0, Number(e.target.value) || 0) } as Partial<EventBlock>)}
            />
          </Field>
          <Field label={tx("节流", "Throttle")} tip={tx("两次报出最小间隔；节流期内的变化合并到下一次", "Min gap between reports; changes merge")}>
            <input
              className="input orch-w110"
              type="number"
              min={50}
              max={3600000}
              value={ev.minIntervalMs}
              onChange={(e) => upd({ minIntervalMs: clampN(e.target.value, 50, 3600000, 1000) } as Partial<EventBlock>)}
            />
            <span className="orch-unit">ms</span>
          </Field>
        </>
      );
    case "newTpl": {
      const tplKnown = templateStore.getSnapshot().rules.templates.some((t) => t.id === ev.tplId);
      return (
        <Field label={tx("帧型", "Template")} tip={tx("留空 = 任意新帧型；会话断开重连后重新首见；红色 = 该模板 ID 不存在", "Empty = any new type; re-arms after reconnect; red = unknown template id")}>
          <input
            className={`input orch-flex${ev.tplId.trim() && !tplKnown ? " bad" : ""}`}
            value={ev.tplId}
            placeholder={tx("留空 = 任意", "empty = any")}
            spellCheck={false}
            list="orch-tpllist"
            onChange={(e) => upd({ tplId: e.target.value } as Partial<EventBlock>)}
          />
        </Field>
      );
    }
    case "flowEvt":
      return (
        <Field label={tx("事件名", "Event name")} tip={tx("与发送方「发事件」块的名称一致；字段随 evt 上下文注入", "Matches the emitter's name; fields join evt")}>
          <input className="input orch-flex" value={ev.name} placeholder="alarm" spellCheck={false} onChange={(e) => upd({ name: e.target.value } as Partial<EventBlock>)} />
        </Field>
      );
    case "idle":
      return (
        <Field label={tx("空闲阈值", "Idle after")} tip={tx("连接中超过该时长无帧触发一次；再来帧重新武装", "Fires once after N ms without frames; re-arms on next frame")}>
          <input
            className="input orch-w110"
            type="number"
            min={1000}
            max={3600000}
            value={ev.idleMs}
            onChange={(e) => upd({ idleMs: clampN(e.target.value, 1000, 3600000, 10000) } as Partial<EventBlock>)}
          />
          <span className="orch-unit">ms</span>
        </Field>
      );
  }
}

/* ---------- 块参数 ---------- */

function BlockFields(props: { groupId: string; node: FlowNode; doc: FlowDoc }) {
  const { groupId, node, doc } = props;
  const upd = (patch: Record<string, unknown>) => orchestratorStore.updateBlock(groupId, node.id, patch);

  switch (node.kind) {
    case "send": {
      const p = node.payload;
      return (
        <>
          <Field label={tx("载荷类型", "Payload")} tip={tx("HEX=十六进制；ASCII=文本；命令=命令库条目", "HEX=bytes; ASCII=text; Command=library entry")}>
            <select
              className="input orch-flex"
              value={p.type === "factory" ? "hex" : p.type}
              onChange={(e) => {
                const t = e.target.value as "hex" | "ascii" | "cmd";
                upd({
                  payload:
                    t === "hex" ? { type: "hex", text: "" } : t === "ascii" ? { type: "ascii", text: "" } : { type: "cmd", cmdId: "" },
                });
              }}
            >
              <option value="hex">HEX</option>
              <option value="ascii">ASCII</option>
              <option value="cmd">{tx("命令", "Command")}</option>
            </select>
          </Field>
          {(p.type === "hex" || p.type === "ascii") && (
            <Field
              label={tx("内容", "Content")}
              tip={tx("支持 {var} 取编排变量；ASCII 支持 \\r \\n \\t \\xNN", "{var} pulls flow vars; ASCII supports \\r \\n \\t \\xNN")}
            >
              <input
                className="input orch-mono orch-flex"
                value={p.text}
                placeholder={p.type === "hex" ? "FF 55 {speed} 01" : "AT+SET={name}\\r\\n"}
                spellCheck={false}
                onChange={(e) => upd({ payload: { type: p.type, text: e.target.value } })}
              />
            </Field>
          )}
          {p.type === "cmd" && (
            <Field label={tx("命令", "Command")} tip={tx("模板支持 {var} 占位（编排变量优先）", "Template supports {var} (flow vars first)")}>
              <CmdSelectOrch cmdId={p.cmdId} onChange={(id) => upd({ payload: { type: "cmd", cmdId: id } })} />
            </Field>
          )}
          {p.type === "factory" && <div className="orch-hint">{tx("指令工厂载荷（保留字段）", "Factory payload (reserved)")}</div>}
        </>
      );
    }
    case "wait":
      return (
        <Field label={tx("时长", "Duration")} tip={tx("暂停 10ms ~ 60s", "Pause 10ms ~ 60s")}>
          <input
            className="input orch-w110"
            type="number"
            min={ORCH_LIMITS.waitMinMs}
            max={ORCH_LIMITS.waitMaxMs}
            value={node.ms}
            onChange={(e) => upd({ ms: clampN(e.target.value, ORCH_LIMITS.waitMinMs, ORCH_LIMITS.waitMaxMs, 1000) })}
          />
          <span className="orch-unit">ms</span>
        </Field>
      );
    case "waitFrame":
      return (
        <>
          <Field label={tx("匹配", "Match")} tip={tx("等到命中帧才继续", "Wait until a frame matches")}>
            <MatchEditor match={node.match} onChange={(m) => upd({ match: m })} />
          </Field>
          <Field label={tx("超时", "Timeout")} tip={tx("0 = 一直等到停止", "0 = wait until stopped")}>
            <input
              className="input orch-w110"
              type="number"
              min={0}
              max={ORCH_LIMITS.frameTimeoutMaxMs}
              value={node.timeoutMs}
              onChange={(e) => upd({ timeoutMs: clampN(e.target.value, 0, ORCH_LIMITS.frameTimeoutMaxMs, 3000) })}
            />
            <span className="orch-unit">ms</span>
          </Field>
          <Field label={tx("超时后", "On timeout")} tip={tx("忽略=记日志继续；否则中止本组", "ignore=log and continue; else abort")}>
            <select className="input orch-flex" value={node.ignoreFail ? "1" : "0"} onChange={(e) => upd({ ignoreFail: e.target.value === "1" })}>
              <option value="0">{tx("中止本组", "Abort group")}</option>
              <option value="1">{tx("忽略继续", "Ignore & continue")}</option>
            </select>
          </Field>
        </>
      );
    case "runSuite":
      return (
        <>
          <Field label={tx("序列", "Suite")} tip={tx("调用测试序列器套件；序列器正在跑则本块失败", "Run a sequencer suite; fails if the sequencer is busy")}>
            <SuiteSelect value={node.suiteId} onChange={(v) => upd({ suiteId: v })} />
          </Field>
          <Field label={tx("等待完成", "Await")} tip={tx("等套件跑完再继续", "Wait until it finishes")}>
            <select className="input orch-flex" value={node.wait ? "1" : "0"} onChange={(e) => upd({ wait: e.target.value === "1" })}>
              <option value="1">{tx("等待", "wait")}</option>
              <option value="0">{tx("触发即走", "fire & forget")}</option>
            </select>
          </Field>
        </>
      );
    case "runGroup":
      return (
        <>
          <Field label={tx("目标组", "Target group")} tip={tx("顶层组与嵌套子组都可调用（缩进表层级）；按目标组自己的队列策略排队；递归深度上限 8", "Top-level and nested groups callable (indented); queues by the target's policy; recursion cap 8")}>
            <select className="input orch-flex" value={node.groupId} onChange={(e) => upd({ groupId: e.target.value })}>
              <option value="">{doc.groups.length ? tx("选择组…", "Pick a group…") : tx("（无组）", "(no groups)")}</option>
              {allGroupsFlat(doc).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.depth ? `${"\u00A0".repeat(x.depth * 2)}↳ ${x.name}` : x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={tx("等待完成", "Await")} tip={tx("等子组跑完再继续", "Wait until the subgroup finishes")}>
            <select className="input orch-flex" value={node.wait ? "1" : "0"} onChange={(e) => upd({ wait: e.target.value === "1" })}>
              <option value="1">{tx("等待", "wait")}</option>
              <option value="0">{tx("触发即走", "fire & forget")}</option>
            </select>
          </Field>
        </>
      );
    case "setVar": {
      const t = doc.vars.find((v) => v.name === node.name)?.type;
      const fromK = node.from.k;
      return (
        <>
          <Field label={tx("变量", "Var")} tip={tx("要写的编排变量（在「变量库」添加）", "Target var (add in the Vars view)")}>
            <VarSelect doc={doc} value={node.name} onChange={(v) => upd({ name: v })} />
          </Field>
          <Field label={tx("取值来源", "From")} tip={tx("常量/通道最新值/表达式/事件字段", "const / channel latest / expr / event field")}>
            <select
              className="input orch-flex"
              value={fromK}
              onChange={(e) => {
                const k = e.target.value as VarFrom["k"];
                upd({
                  from:
                    k === "chan"
                      ? { k: "chan", chId: "" }
                      : k === "expr"
                        ? { k: "expr", src: "" }
                        : k === "evtField"
                          ? { k: "evtField", field: "" }
                          : { k: "const", value: 0 },
                });
              }}
            >
              <option value="const">{tx("常量", "Const")}</option>
              <option value="chan">{tx("通道值", "Channel")}</option>
              <option value="expr">{tx("表达式", "Expr")}</option>
              <option value="evtField">{tx("事件字段", "evt field")}</option>
            </select>
          </Field>
          {fromK === "const" && (
            <Field label={tx("值", "Value")} tip={tx("类型跟随变量；未选变量按数字处理", "Type follows the var; numeric when unset")}>
              <ScalarInput kind={t ?? "number"} value={node.from.value} onChange={(v) => upd({ from: { k: "const", value: v } })} />
            </Field>
          )}
          {fromK === "chan" && (
            <Field label={tx("通道", "Channel")} tip={tx("取该通道最新采样值", "Latest sample of this channel")}>
              <ChanSelect value={node.from.chId} onChange={(v) => upd({ from: { k: "chan", chId: v } })} />
            </Field>
          )}
          {fromK === "expr" && (
            <Field label={tx("表达式", "Expr")} tip={tx("结果按变量类型收敛", "Result converges to the var type")}>
              <ExprInput src={node.from.src} doc={doc} onChange={(src) => upd({ from: { k: "expr", src } })} />
            </Field>
          )}
          {fromK === "evtField" && (
            <Field label={tx("事件字段", "Event field")} tip={tx("帧事件=字段名；变量事件=old/new；阈值=value", "frame=field name; var=old/new; threshold=value")}>
              <input
                className="input orch-flex"
                value={node.from.field}
                placeholder="value"
                spellCheck={false}
                onChange={(e) => upd({ from: { k: "evtField", field: e.target.value } })}
              />
            </Field>
          )}
        </>
      );
    }
    case "toast":
      return (
        <>
          <Field label={tx("级别", "Level")} tip={tx("info=普通；warn/crit=警示样式", "info=normal; warn/crit=alert styles")}>
            <select className="input orch-w90" value={node.level} onChange={(e) => upd({ level: e.target.value })}>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="crit">crit</option>
            </select>
          </Field>
          <Field label={tx("文本", "Text")} tip={tx("支持 ${表达式} 插值，如 速度=${speed}", "Supports ${expr} interpolation, e.g. v=${speed}")}>
            <input
              className="input orch-flex"
              value={node.text}
              placeholder={tx("校准完成 ${count} 点", "Done ${count} pts")}
              spellCheck={false}
              onChange={(e) => upd({ text: e.target.value })}
            />
          </Field>
        </>
      );
    case "sound":
      return (
        <Field label={tx("音型", "Tone")} tip={tx("warn=单音；crit=三连急促音", "warn=single; crit=triple urgent")}>
          <select className="input orch-flex" value={node.level} onChange={(e) => upd({ level: e.target.value })}>
            <option value="warn">warn</option>
            <option value="crit">crit</option>
          </select>
        </Field>
      );
    /* ---------- B4c 新增动作块 ---------- */
    case "setControl": {
      const fromK = node.from.k;
      const ctlKnown = variableStore.listVars().some((v) => v.name === node.varName);
      return (
        <>
          <Field label={tx("画布变量", "Ctl var")} tip={tx("控制画布里声明的变量名（监视器/滑条读它）；红色 = 该变量当前不存在", "A control-canvas variable name; red = not found")}>
            <input
              className={`input orch-flex${node.varName.trim() && !ctlKnown ? " bad" : ""}`}
              value={node.varName}
              placeholder="sp"
              spellCheck={false}
              list="orch-ctlvarlist"
              onChange={(e) => upd({ varName: e.target.value })}
            />
          </Field>
          <Field label={tx("取值来源", "From")} tip={tx("常量/通道最新值/表达式/事件字段", "const / channel latest / expr / event field")}>
            <select
              className="input orch-flex"
              value={fromK}
              onChange={(e) => {
                const k = e.target.value as VarFrom["k"];
                upd({
                  from:
                    k === "chan"
                      ? { k: "chan", chId: "" }
                      : k === "expr"
                        ? { k: "expr", src: "" }
                        : k === "evtField"
                          ? { k: "evtField", field: "" }
                          : { k: "const", value: 0 },
                });
              }}
            >
              <option value="const">{tx("常量", "Const")}</option>
              <option value="chan">{tx("通道值", "Channel")}</option>
              <option value="expr">{tx("表达式", "Expr")}</option>
              <option value="evtField">{tx("事件字段", "evt field")}</option>
            </select>
          </Field>
          {fromK === "const" && (
            <Field label={tx("值", "Value")}>
              <ScalarInput kind={typeof node.from.value === "string" ? "string" : typeof node.from.value === "boolean" ? "bool" : "number"} value={node.from.value} onChange={(v) => upd({ from: { k: "const", value: v } })} />
            </Field>
          )}
          {fromK === "chan" && (
            <Field label={tx("通道", "Channel")}>
              <ChanSelect value={node.from.chId} onChange={(v) => upd({ from: { k: "chan", chId: v } })} />
            </Field>
          )}
          {fromK === "expr" && (
            <Field label={tx("表达式", "Expr")}>
              <ExprInput src={node.from.src} doc={doc} onChange={(src) => upd({ from: { k: "expr", src } })} />
            </Field>
          )}
          {fromK === "evtField" && (
            <Field label={tx("事件字段", "Event field")}>
              <input className="input orch-flex" value={node.from.field} placeholder="value" spellCheck={false} onChange={(e) => upd({ from: { k: "evtField", field: e.target.value } })} />
            </Field>
          )}
        </>
      );
    }
    case "setSwitch": {
      const swKnown = controlsStore
        .getSnapshot()
        .pages.some((p) => p.cards.some((c) => c.type === "switch" && c.name === node.swName));
      return (
        <>
          <Field label={tx("开关卡名", "Switch name")} tip={tx("控制页开关卡片的名称（当前页优先，全页兜底）；红色 = 找不到该卡片", "Name of a switch card (active page first); red = no such card")}>
            <input
              className={`input orch-flex${node.swName.trim() && !swKnown ? " bad" : ""}`}
              value={node.swName}
              placeholder="SW1"
              spellCheck={false}
              list="orch-swlist"
              onChange={(e) => upd({ swName: e.target.value })}
            />
          </Field>
          <Field label={tx("动作", "State")} tip={tx("on=拨到最大档；off=第 1 档；toggle=下一档循环", "on=last position; off=first; toggle=next")}>
            <select className="input orch-flex" value={node.state} onChange={(e) => upd({ state: e.target.value })}>
              <option value="on">on</option>
              <option value="off">off</option>
              <option value="toggle">toggle</option>
            </select>
          </Field>
        </>
      );
    }
    case "modbusWrite":
      return (
        <>
          <Field label={tx("功能码", "Function")} tip={tx("FC05=写单线圈（0/1）；FC06=写单寄存器", "FC05=coil (0/1); FC06=register")}>
            <select className="input orch-flex" value={node.fn} onChange={(e) => upd({ fn: Number(e.target.value) === 5 ? 5 : 6 })}>
              <option value={5}>FC05 线圈</option>
              <option value={6}>FC06 寄存器</option>
            </select>
          </Field>
          <Field label={tx("从站 / 地址", "Slave / Addr")} tip="1~247 / 0~65535（0 基址）">
            <div className="orch-row2">
              <input className="input orch-flex" type="number" min={0} max={247} value={node.slave} onChange={(e) => upd({ slave: clampN(e.target.value, 0, 247, 1) })} />
              <input className="input orch-flex" type="number" min={0} max={65535} value={node.addr} onChange={(e) => upd({ addr: clampN(e.target.value, 0, 65535, 0) })} />
            </div>
          </Field>
          <Field label={node.fn === 5 ? tx("线圈值（0/1）", "Coil (0/1)") : tx("寄存器值", "Register value")}>
            <input className="input orch-flex" type="number" value={node.value} onChange={(e) => upd({ value: node.fn === 5 ? (Number(e.target.value) ? 1 : 0) : clampN(e.target.value, -32768, 65535, 0) })} />
          </Field>
          <div className="orch-hint">{tx("以 RTU 帧经当前连接发送（响应不等待）。主站轮询读请用 Modbus 面板。", "Sent as an RTU frame over the current connection (no reply wait). Use the Modbus panel for polled reads.")}</div>
        </>
      );
    case "log":
      return (
        <>
          <Field label={tx("级别", "Level")} tip={tx("crit 级同步弹通知", "crit also toasts")}>
            <select className="input orch-w90" value={node.level} onChange={(e) => upd({ level: e.target.value })}>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="crit">crit</option>
            </select>
          </Field>
          <Field label={tx("文本", "Text")} tip={tx("支持 ${表达式} 插值", "Supports ${expr} interpolation")}>
            <input className="input orch-flex" value={node.text} placeholder={tx("步骤 ${i} 完成", "step ${i} done")} spellCheck={false} onChange={(e) => upd({ text: e.target.value })} />
          </Field>
        </>
      );
    case "snapshot":
      return (
        <>
          <Field label={tx("面板", "Panel")} tip={tx("抓取哪个面板的画面", "Which panel to capture")}>
            <select className="input orch-flex" value={node.panel} onChange={(e) => upd({ panel: e.target.value })}>
              <option value="plot2d">2D 曲线</option>
              <option value="plot3d">3D 轨迹</option>
              <option value="spectrum">频谱</option>
            </select>
          </Field>
          <Field label={tx("备注", "Note")}>
            <input className="input orch-flex" value={node.note} placeholder={tx("检查点", "checkpoint")} spellCheck={false} onChange={(e) => upd({ note: e.target.value })} />
          </Field>
          <div className="orch-hint">{tx("面板需已打开；图片存入图片库（有容量管理）。", "Panel must be open; image goes to the image library.")}</div>
        </>
      );
    case "exportCsv":
      return (
        <>
          <Field label={tx("通道", "Channel")}>
            <ChanSelect value={node.chanId} onChange={(v) => upd({ chanId: v })} />
          </Field>
          <Field label={tx("最近点数", "Last points")} tip={`1 ~ ${ORCH_LIMITS.csvLastNCap}`}>
            <input className="input orch-w110" type="number" min={1} max={ORCH_LIMITS.csvLastNCap} value={node.lastN} onChange={(e) => upd({ lastN: clampN(e.target.value, 1, ORCH_LIMITS.csvLastNCap, 1000) })} />
          </Field>
          <div className="orch-hint">{tx("执行时弹保存对话框；取消保存按失败处理。", "A save dialog opens on run; cancelling counts as failure.")}</div>
        </>
      );
    case "stopSuite":
      return <div className="orch-hint">{tx("停止正在运行的测试序列套件（未在跑也按成功）。", "Stops the running test suite (ok if idle).")}</div>;
    case "emitFlow":
      return (
        <>
          <Field label={tx("事件名", "Event name")} tip={tx(`≤${ORCH_LIMITS.flowEvtNameMax} 字符；接收方挂「自定义事件」块写同名`, `≤${ORCH_LIMITS.flowEvtNameMax} chars; receivers use a flow-evt block with the same name`)}>
            <input className="input orch-flex" value={node.name} placeholder="alarm" spellCheck={false} onChange={(e) => upd({ name: e.target.value })} />
          </Field>
          {node.data.map((d, i) => (
            <div key={i} className="orch-pair">
              <input
                className="input orch-w110"
                value={d.k}
                placeholder={tx("字段名", "field")}
                spellCheck={false}
                onChange={(e) => upd({ data: node.data.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })}
              />
              <input
                className="input orch-flex"
                value={d.src}
                placeholder={tx("表达式", "expr")}
                spellCheck={false}
                onChange={(e) => upd({ data: node.data.map((x, j) => (j === i ? { ...x, src: e.target.value } : x)) })}
              />
              <button className="sq-a" title={tx("删除", "Remove")} onClick={() => upd({ data: node.data.filter((_, j) => j !== i) })}>
                <IconClose />
              </button>
            </div>
          ))}
          <button
            className="sq-childadd"
            disabled={node.data.length >= ORCH_LIMITS.emitFlowDataMax}
            onClick={() => upd({ data: [...node.data, { k: "", src: "0" }] })}
          >
            {tx("＋ 附带字段", "＋ Field")}
          </button>
          <div className="orch-hint">{tx("字段值按表达式求值，随事件注入接收方的 evt 上下文。", "Fields are evaluated and injected into the receiver's evt context.")}</div>
        </>
      );
    case "clip":
      return (
        <Field label={tx("文本", "Text")} tip={tx("支持 ${表达式} 插值", "Supports ${expr} interpolation")}>
          <input className="input orch-flex" value={node.text} placeholder={tx("速度=${speed}", "v=${speed}")} spellCheck={false} onChange={(e) => upd({ text: e.target.value })} />
        </Field>
      );
    case "resetVars":
      return (
        <>
          <Field label={tx("范围", "Scope")} tip={tx("all=全部变量；one=指定变量", "all=every var; one=named var")}>
            <select className="input orch-flex" value={node.scope} onChange={(e) => upd({ scope: e.target.value })}>
              <option value="all">{tx("全部", "all")}</option>
              <option value="one">{tx("单个", "one")}</option>
            </select>
          </Field>
          {node.scope === "one" && (
            <Field label={tx("变量", "Var")}>
              <VarSelect doc={doc} value={node.name} onChange={(v) => upd({ name: v })} />
            </Field>
          )}
          <div className="orch-hint">{tx("复位到默认值，不触发「变量变更」事件（防风暴）。", "Resets to defaults without firing varChanged (no storm).")}</div>
        </>
      );
    case "if":
      return (
        <>
          <div className="orch-hint">{tx("条件全成立 → 执行「那么」，否则执行「否则」。", "All conditions true → THEN, else ELSE.")}</div>
          <CondListEditor doc={doc} conds={node.conds} onCommit={(conds) => upd({ conds })} />
        </>
      );
    case "loop":
      return (
        <>
          <Field label={tx("模式", "Mode")} tip={tx("次数=固定轮数；条件=每轮先验（不成立即停）", "count=fixed rounds; while=pre-check each round")}>
            <select className="input orch-w90" value={node.mode} onChange={(e) => upd({ mode: e.target.value })}>
              <option value="count">{tx("次数", "count")}</option>
              <option value="while">{tx("当…循环", "while")}</option>
            </select>
          </Field>
          {node.mode === "count" ? (
            <Field label={tx("次数", "Count")} tip={`1 ~ ${ORCH_LIMITS.loopIterCap} 轮`}>
              <input
                className="input orch-w110"
                type="number"
                min={1}
                max={ORCH_LIMITS.loopIterCap}
                value={node.count ?? 3}
                onChange={(e) => upd({ count: clampN(e.target.value, 1, ORCH_LIMITS.loopIterCap, 3) })}
              />
            </Field>
          ) : (
            <CondListEditor doc={doc} conds={node.cond ?? []} onCommit={(cond) => upd({ cond })} />
          )}
          <Field label={tx("轮间隔", "Round gap")} tip={tx("每轮之间的停顿，防忙等", "Pause between rounds; avoids busy-wait")}>
            <input
              className="input orch-w110"
              type="number"
              min={0}
              max={600000}
              value={node.intervalMs}
              onChange={(e) => upd({ intervalMs: clampN(e.target.value, 0, 600000, 100) })}
            />
            <span className="orch-unit">ms</span>
          </Field>
        </>
      );
    case "break":
      return <div className="orch-hint">{tx("跳出最近一层循环（只能放在循环体内）。", "Breaks the nearest loop (inside a loop body).")}</div>;
    case "abort":
      return <div className="orch-hint">{tx("立即中止本组实例（后续块不再执行）。", "Aborts this group instance immediately.")}</div>;
    case "group":
      return (
        <Field label={tx("子组名", "Subgroup name")} tip={tx("仅用于收纳（嵌套组不挂事件）", "Organizational only (no events)")}>
          <input
            className="input orch-flex"
            defaultValue={node.name}
            spellCheck={false}
            onBlur={(e) => upd({ name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Field>
      );
  }
}

/* ================= 变量库 / 监视 ================= */

/** 单行变量（改名走草稿态：非法/重名中间态不弹回输入框，只标红，失焦/回车提交、Esc 取消） */
function VarRow(props: { v: FlowVar; liveVal: string; siblings: FlowVar[] }) {
  const { v, liveVal, siblings } = props;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const cur = nameDraft ?? v.name;
  const trimmed = nameDraft !== null ? nameDraft.trim() : v.name;
  const nameErr =
    nameDraft !== null &&
    trimmed !== v.name &&
    (!VAR_NAME_RE.test(trimmed) || siblings.some((x) => x !== v && x.name === trimmed));
  const commitName = () => {
    if (nameDraft === null) return;
    const t = nameDraft.trim();
    if (t !== v.name && VAR_NAME_RE.test(t) && !siblings.some((x) => x !== v && x.name === t)) {
      orchestratorStore.updateVar(v.name, { name: t });
    }
    setNameDraft(null);
  };
  return (
    <div className="orch-var-row">
      <input
        className={`input orch-w110${nameErr ? " bad" : ""}`}
        value={cur}
        spellCheck={false}
        title={nameErr ? tx("变量名非法（字母开头，字母/数字/下划线）或与现有变量重名", "Bad var name (letter first, then letters/digits/_) or duplicate") : tx("变量名（回车提交，Esc 取消）", "Name (Enter to apply, Esc to cancel)")}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => {
          if (cancelRef.current) {
            cancelRef.current = false;
            setNameDraft(null);
            return;
          }
          commitName();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            cancelRef.current = true;
            setNameDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <select
        className="input orch-w80"
        value={v.type}
        title={tx("类型（默认值随之收敛）", "Type (default converges)")}
        onChange={(e) => orchestratorStore.updateVar(v.name, { type: e.target.value as FlowVarType })}
      >
        <option value="number">number</option>
        <option value="string">string</option>
        <option value="bool">bool</option>
      </select>
      {v.type === "bool" ? (
        <select
          className="input orch-w80"
          value={v.def ? "1" : "0"}
          title={tx("默认值", "Default")}
          onChange={(e) => orchestratorStore.updateVar(v.name, { def: e.target.value === "1" })}
        >
          <option value="1">{tx("真", "true")}</option>
          <option value="0">{tx("假", "false")}</option>
        </select>
      ) : (
        <input
          className="input orch-w90"
          value={String(v.def)}
          title={tx("默认值", "Default")}
          spellCheck={false}
          onChange={(e) =>
            orchestratorStore.updateVar(v.name, { def: v.type === "number" ? Number(e.target.value) || 0 : e.target.value })
          }
        />
      )}
      <label className="orch-inline" title={tx("持久化：重启后保留当前值（否则复位默认）", "Persist: keeps the live value across restarts")}>
        <input type="checkbox" checked={v.persist} onChange={(e) => orchestratorStore.updateVar(v.name, { persist: e.target.checked })} />
        {tx("持久", "keep")}
      </label>
      <span className="orch-var-live" title={tx("当前运行值", "Live value")}>
        {liveVal}
      </span>
      <button className="sq-a bad" title={tx("删除变量", "Delete variable")} onClick={() => orchestratorStore.removeVar(v.name)}>
        <IconClose />
      </button>
    </div>
  );
}

export function VarsEditor() {
  const store = useSyncExternalStore(orchestratorStore.subscribe, orchestratorStore.getSnapshot);
  const vars = store.doc.vars;
  // 引擎持有运行值；父组件 500ms 轮询驱动刷新
  const live = bind.orchEngine.listVars();
  const [nn, setNn] = useState("");
  const [nt, setNt] = useState<FlowVarType>("number");

  const tryAdd = () => {
    if (!orchestratorStore.addVar({ name: nn.trim(), type: nt, def: nt === "number" ? 0 : nt === "bool" ? false : "", persist: false })) {
      toast(tx("变量名非法或已存在（字母开头，字母/数字/下划线）", "Bad or duplicate name (letter first, then letters/digits/_)"));
    }
    setNn("");
  };

  return (
    <div className="orch-ins">
      <div className="orch-ins-head">
        <span className="orch-ins-t">{tx("变量库", "Flow vars")}</span>
        <span className="orch-ins-path">{tx("全局 · 类型化 · 可持久化", "global · typed · persistable")}</span>
      </div>
      {/* C1：与 Inspector 同口径——只读时整块参数区原生禁用（运行值监视只读，仍可见） */}
      <fieldset className="orch-fs" disabled={isOperatorLocked()}>
      <div className="orch-ins-body">
        <div className="orch-var-add">
          <input
            className="input orch-flex"
            placeholder={tx("变量名（如 speed）", "name (e.g. speed)")}
            value={nn}
            spellCheck={false}
            onChange={(e) => setNn(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && tryAdd()}
          />
          <select className="input orch-w80" value={nt} onChange={(e) => setNt(e.target.value as FlowVarType)}>
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="bool">bool</option>
          </select>
          <button className="btn sm" onClick={tryAdd}>
            <IconPlus />
            {tx("添加", "Add")}
          </button>
        </div>
        {vars.length === 0 && (
          <div className="orch-hint">
            {tx("还没有变量。setVar、条件、表达式都能引用它们。", "No vars yet. setVar, conditions and expressions can reference them.")}
          </div>
        )}
        {vars.map((v) => (
          <VarRow key={v.name} v={v} siblings={vars} liveVal={fmtVal(live.find((x) => x.name === v.name)?.value ?? v.def)} />
        ))}
        <div className="orch-hint">
          {tx("引用方式：表达式直接用变量名；发送文本用 {var}；通知文本用 ${表达式}。", "Reference: bare name in expressions, {var} in send payloads, ${expr} in toasts.")}
        </div>
      </div>
      </fieldset>
    </div>
  );
}
