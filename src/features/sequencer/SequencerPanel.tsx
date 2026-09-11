import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { IconDownload, IconPlay, IconStop, IconTrash, IconUpload } from "../../shared/icons";
import * as sequencerStore from "./sequencerStore";
import { renderReportHtml } from "./report";
import * as bind from "./sequencerBind";
import { LIMITS, type CmpOp, type FrameMatch, type RunProgress, type Step, type StepKind, type StepResult, type Suite } from "./types";
import * as templateStore from "../protocol/templateStore";
import * as commandStore from "../controls/commandStore";
import * as variableStore from "../controls/variableStore";

/**
 * 测试序列器面板（T2 编辑器 + T3 执行视图）。
 *
 * 面板只是视图：套件数据在 sequencerStore（localStorage 持久化），执行在
 * runner/bind（模块级）。运行中允许继续编辑——引擎持有启动时的步骤引用，
 * 编辑不影响本次运行，下次运行生效。
 */

const KIND_LABEL: Record<StepKind, { zh: string; en: string; cls: string }> = {
  send: { zh: "发送", en: "Send", cls: "send" },
  wait: { zh: "等待", en: "Wait", cls: "wait" },
  waitForFrame: { zh: "等帧", en: "WaitFrame", cls: "frame" },
  assertVar: { zh: "断言", en: "Assert", cls: "assert" },
  group: { zh: "分组", en: "Group", cls: "group" },
  note: { zh: "备注", en: "Note", cls: "note" },
};

const OPS: { v: CmpOp; zh: string; en: string }[] = [
  { v: "eq", zh: "=", en: "=" },
  { v: "ne", zh: "≠", en: "≠" },
  { v: "gt", zh: ">", en: ">" },
  { v: "lt", zh: "<", en: "<" },
  { v: "ge", zh: "≥", en: "≥" },
  { v: "le", zh: "≤", en: "≤" },
  { v: "approx", zh: "≈±容差", en: "≈±tol" },
  { v: "changed", zh: "有变化", en: "changed" },
];

export function SequencerPanel() {
  useLocale();
  const store = useSyncExternalStore(sequencerStore.subscribe, sequencerStore.getSnapshot);
  const progress = useSyncExternalStore(bind.subscribeRun, bind.getRunProgress);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const suite = store.suites.find((s) => s.id === selectedId) ?? store.suites[0] ?? null;
  const running = progress !== null && progress.status !== "finished" && progress.suiteId === suite?.id;
  const runningAny = progress !== null && progress.status !== "finished";

  if (!suite) {
    return (
      <div className="seq">
        <div className="seq-empty">
          <div className="seq-empty-title">{tx("测试序列器", "Test Sequencer")}</div>
          <div className="seq-empty-desc">
            {tx(
              "把「发送 → 等帧 → 断言」串成可重复执行的测试序列，支持分组循环、单步调试与帧触发。所有数据保存在本机。",
              "Chain send → wait-frame → assert into repeatable test sequences with groups, step-debug and frame triggers. All data stays local.",
            )}
          </div>
          <button className="btn primary" onClick={() => setSelectedId(sequencerStore.addSuite("").id)}>
            {tx("＋ 新建序列", "＋ New sequence")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="seq">
      <SuiteBar
        key={suite.id}
        suite={suite}
        suites={store.suites}
        onSelect={setSelectedId}
        running={running}
        runningAny={runningAny}
        progress={progress}
      />
      <StepEditor suite={suite} running={running} />
      <ResultView progress={progress} mine={progress?.suiteId === suite.id} />
    </div>
  );
}

/* ================= 套件栏 ================= */

function SuiteBar(props: {
  suite: Suite;
  suites: Suite[];
  onSelect: (id: string) => void;
  running: boolean;
  runningAny: boolean;
  progress: RunProgress | null;
}) {
  const { suite, suites, onSelect, running, runningAny, progress } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [triggerOpen, setTriggerOpen] = useState(suite.trigger.mode === "onFrame");
  // 属性路径收窄不保留进闭包：提为 const，供 JSX 条件块与回调安全引用
  const trig = suite.trigger;
  const onFrame = trig.mode === "onFrame" ? trig : null;
  const awaiting = progress?.status === "awaitingStep" && runningAny;

  const run = () => {
    const err = bind.startSuite(suite, { stepMode: false });
    if (err) window.alert(err);
  };
  const runStep = () => {
    const err = bind.startSuite(suite, { stepMode: true });
    if (err) window.alert(err);
  };

  const doImport = async (f: File) => {
    const n = sequencerStore.importSuites(await f.text());
    window.alert(n > 0 ? tx(`已导入 ${n} 个序列`, `Imported ${n} sequence(s)`) : tx("导入失败：文件里没有有效序列", "Import failed: no valid sequence in file"));
  };

  const doExport = () => {
    const json = sequencerStore.exportSuite(suite.id);
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${suite.name || "sequence"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="seq-top">
      <div className="seq-row">
        <select
          className="input seq-suite"
          value={suite.id}
          onChange={(e) => onSelect(e.target.value)}
          title={tx("选择序列", "Pick sequence")}
        >
          {suites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          className="input seq-name"
          value={suite.name}
          onChange={(e) => sequencerStore.renameSuite(suite.id, e.target.value)}
          title={tx("重命名序列", "Rename sequence")}
          spellCheck={false}
        />
        <button
          className="btn sm"
          onClick={() => onSelect(sequencerStore.addSuite("").id)}
          title={tx("新建序列", "New sequence")}
        >
          ＋
        </button>
        <button
          className="btn sm"
          onClick={() => {
            if (window.confirm(tx(`删除序列「${suite.name}」？`, `Delete "${suite.name}"?`))) {
              sequencerStore.removeSuite(suite.id);
            }
          }}
          title={tx("删除当前序列", "Delete current sequence")}
        >
          <IconTrash />
        </button>
        <button className="btn sm" onClick={() => fileRef.current?.click()} title={tx("导入 JSON", "Import JSON")}>
          <IconUpload />
        </button>
        <button className="btn sm" onClick={doExport} title={tx("导出当前序列 JSON", "Export current sequence JSON")}>
          <IconDownload />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="seq-row">
        {running ? (
          <button className="btn sm warn" onClick={() => bind.stopSuite()} title={tx("停止运行", "Stop run")}>
            <IconStop />
            {tx("停止", "Stop")}
          </button>
        ) : (
          <>
            <button className="btn sm primary" onClick={run} disabled={runningAny} title={tx("从头运行整个序列", "Run the whole sequence")}>
              <IconPlay />
              {tx("运行", "Run")}
            </button>
            <button className="btn sm" onClick={runStep} disabled={runningAny} title={tx("单步调试：每步完成挂起，点「继续」走下一步", "Step mode: pause after each step")}>
              {tx("单步", "Step")}
            </button>
          </>
        )}
        {awaiting && (
          <button className="btn sm primary" onClick={() => bind.resumeSuite()} title={tx("放行下一步", "Resume next step")}>
            {tx("▶ 继续", "▶ Resume")}
          </button>
        )}
        <label className="mb-chk" title={tx("任何一步失败立刻停止（关闭后记录失败继续跑完）", "Stop on first failure (off: record failures and keep going)")}>
          <input
            type="checkbox"
            checked={suite.failFast}
            onChange={(e) => sequencerStore.setFailFast(suite.id, e.target.checked)}
          />
          {tx("失败即停", "Fail fast")}
        </label>
        <label className="mb-chk" title={tx("收到匹配帧自动运行（防重入 + 冷却）", "Auto-run on matching frame (re-entry guarded + cooldown)")}>
          <input
            type="checkbox"
            checked={suite.trigger.mode === "onFrame"}
            onChange={(e) => {
              setTriggerOpen(e.target.checked);
              sequencerStore.setTrigger(
                suite.id,
                e.target.checked
                  ? { mode: "onFrame", match: { by: "raw", hex: "" }, cooldownMs: 500 }
                  : { mode: "manual" },
              );
            }}
          />
          {tx("帧触发", "On frame")}
        </label>
        <span className="seq-status">
          {running
            ? progress?.status === "awaitingStep"
              ? tx("单步挂起", "Paused (step)")
              : tx("运行中…", "Running…")
            : ""}
        </span>
      </div>

      {onFrame && triggerOpen && (
        <div className="seq-row seq-trigger">
          <span className="seq-lab">{tx("触发帧", "Trigger")}</span>
          <MatchEditor
            match={onFrame.match}
            onChange={(m) => sequencerStore.setTrigger(suite.id, { mode: "onFrame", match: m, cooldownMs: onFrame.cooldownMs })}
          />
          <label className="mb-f" title={tx("两次触发之间的最小间隔", "Min interval between triggers")}>
            {tx("冷却", "Cooldown")}
            <input
              className="input sq-n70"
              type="number"
              min={0}
              max={60000}
              value={onFrame.cooldownMs}
              onChange={(e) =>
                sequencerStore.setTrigger(suite.id, {
                  mode: "onFrame",
                  match: onFrame.match,
                  cooldownMs: Math.max(0, Math.round(Number(e.target.value) || 0)),
                })
              }
            />
            ms
          </label>
        </div>
      )}
    </div>
  );
}

/* ================= 步骤编辑器 ================= */

const ADD_KINDS: StepKind[] = ["send", "wait", "waitForFrame", "assertVar", "group", "note"];

function StepEditor(props: { suite: Suite; running: boolean }) {
  const { suite, running } = props;
  const dragRef = useRef<{ id: string } | null>(null);
  const [drop, setDropState] = useState<{ id: string | null; pos: "before" | "after" | "in" } | null>(null);
  const dropRef = useRef<{ id: string | null; pos: "before" | "after" | "in" } | null>(null);
  const setDrop = (d: { id: string | null; pos: "before" | "after" | "in" } | null) => {
    dropRef.current = d;
    setDropState(d);
  };

  const moveBy = (stepId: string, delta: -1 | 1) => {
    const loc = sequencerStore.locateStep(suite.id, stepId);
    if (!loc) return;
    const target = loc.index + (delta === -1 ? -1 : 2);
    sequencerStore.moveStep(suite.id, stepId, loc.parentId, target);
  };
  const indent = (stepId: string) => {
    const loc = sequencerStore.locateStep(suite.id, stepId);
    if (!loc) return;
    // 前一个兄弟是 group → 移进去；否则移到与它同列表的前一个 group 内
    const list = siblingsOf(suite, loc.parentId);
    const prev = list[loc.index - 1];
    if (prev && prev.kind === "group") sequencerStore.moveStep(suite.id, stepId, prev.id, prev.children.length);
  };
  const outdent = (stepId: string) => {
    const loc = sequencerStore.locateStep(suite.id, stepId);
    if (!loc || loc.parentId === null) return;
    const pLoc = sequencerStore.locateStep(suite.id, loc.parentId);
    if (!pLoc) return;
    sequencerStore.moveStep(suite.id, stepId, pLoc.parentId, pLoc.index + 1);
  };
  const siblingsOf = (s: Suite, parentId: string | null): Step[] => {
    if (parentId === null) return s.steps;
    const find = (steps: Step[]): Step | undefined => {
      for (const x of steps) {
        if (x.id === parentId) return x;
        if (x.kind === "group") {
          const r = find(x.children);
          if (r) return r;
        }
      }
      return undefined;
    };
    const p = find(s.steps);
    return p && p.kind === "group" ? p.children : [];
  };

  const dropOn = (targetId: string | null, pos: "before" | "after" | "in") => {
    const drag = dragRef.current;
    if (!drag) return;
    if (targetId === null) {
      sequencerStore.moveStep(suite.id, drag.id, null, suite.steps.length);
      return;
    }
    const loc = sequencerStore.locateStep(suite.id, targetId);
    if (!loc) return;
    if (pos === "in") {
      const t = sequencerStore.findStep(suite.id, targetId);
      if (t && t.kind === "group") sequencerStore.moveStep(suite.id, drag.id, t.id, t.children.length);
      return;
    }
    sequencerStore.moveStep(suite.id, drag.id, loc.parentId, pos === "before" ? loc.index : loc.index + 1);
  };

  // pointer 拖拽（替代 HTML5 DnD：Tauri/WebView2 下 draggable 受 user-select 与拖放拦截影响，体验不稳）
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { id };
    const onMove = (ev: PointerEvent) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = hit?.closest<HTMLElement>("[data-sq-row]");
      const tid = row?.dataset.sqRow;
      if (tid && tid !== id) {
        const r = row.getBoundingClientRect();
        const y = (ev.clientY - r.top) / Math.max(1, r.height);
        const t = sequencerStore.findStep(suite.id, tid);
        const pos: "before" | "after" | "in" = y < 0.28 ? "before" : y > 0.72 ? "after" : t?.kind === "group" ? "in" : "after";
        setDrop({ id: tid, pos });
        return;
      }
      setDrop(hit?.closest("[data-sq-list]") ? { id: null, pos: "after" } : null);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = dropRef.current;
      if (dragRef.current && d) dropOn(d.id, d.pos);
      dragRef.current = null;
      setDrop(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const renderRow = (step: Step, depth: number) => {
    const dropCls = drop && drop.id === step.id ? ` sq-drop-${drop.pos}` : "";
    return (
      <div key={step.id}>
        <div
          className={`sq-row d${Math.min(depth, 4)}${dropCls}`}
          data-sq-row={step.id}
        >
          <span
            className="sq-grip"
            onPointerDown={(e) => startDrag(e, step.id)}
            title={tx("按住拖动排序（松手落到目标行上/下/组内）", "Hold and drag to reorder (drop above / below / into a group)")}
          >
            ⠿
          </span>
          <input
            type="checkbox"
            className="sq-en"
            checked={step.enabled}
            title={tx("启用/禁用该步（禁用后跳过执行，报告中保留）", "Enable/disable step (disabled steps are skipped but kept in the report)")}
            onChange={(e) => sequencerStore.updateStep(suite.id, step.id, (s) => ({ ...s, enabled: e.target.checked }) as Step)}
          />
          <span className={`sq-kind sq-k-${KIND_LABEL[step.kind].cls}`}>{tx(KIND_LABEL[step.kind].zh, KIND_LABEL[step.kind].en)}</span>
          <StepFields suite={suite} step={step} />
          <span className="sq-acts">
            <button className="sq-a" onClick={() => moveBy(step.id, -1)} title={tx("上移", "Move up")}>↑</button>
            <button className="sq-a" onClick={() => moveBy(step.id, 1)} title={tx("下移", "Move down")}>↓</button>
            <button className="sq-a" onClick={() => indent(step.id)} title={tx("缩进：移入上一个分组", "Indent: move into previous group")}>→</button>
            <button className="sq-a" onClick={() => outdent(step.id)} title={tx("外移：移出所在分组", "Outdent: move out of the group")}>←</button>
            <button className="sq-a" onClick={() => sequencerStore.duplicateStep(suite.id, step.id)} title={tx("复制该步（含子树）", "Duplicate (with subtree)")}>⧉</button>
            <button className="sq-a bad" onClick={() => sequencerStore.removeStep(suite.id, step.id)} title={tx("删除", "Delete")}>×</button>
          </span>
        </div>
        {step.kind === "group" && (
          <div className="sq-children">
            {step.children.map((c) => renderRow(c, depth + 1))}
            <GroupAdd suite={suite} group={step} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="seq-steps">
      <div className="seq-row seq-addbar">
        <span className="seq-lab">{tx("添加步骤", "Add step")}</span>
        {ADD_KINDS.map((k) => (
          <button key={k} className="btn sm" onClick={() => sequencerStore.addStep(suite.id, null, k)}>
            ＋{tx(KIND_LABEL[k].zh, KIND_LABEL[k].en)}
          </button>
        ))}
        {suite.steps.length === 0 && (
          <span className="seq-hint">
            {tx("点上方按钮添加步骤；拖 ⠿ 调整顺序；分组内可再套分组（最多 4 层）", "Add steps above; drag ⠿ to reorder; groups nest up to 4 levels")}
          </span>
        )}
        {running && (
          <span className="seq-hint" title={tx("引擎持有启动时的步骤快照，本次运行不受影响", "The engine runs on the snapshot taken at start; edits apply next run")}>
            {tx("运行中：编辑在下次运行生效", "Editing applies to the next run")}
          </span>
        )}
      </div>
      <div className="seq-tree" data-sq-list>
        {suite.steps.map((s) => renderRow(s, 1))}
      </div>
    </div>
  );
}

function GroupAdd(props: { suite: Suite; group: Extract<Step, { kind: "group" }> }) {
  const { suite, group } = props;
  return (
    <select
      className="input sq-childadd"
      value=""
      onChange={(e) => {
        if (e.target.value) sequencerStore.addStep(suite.id, group.id, e.target.value as StepKind);
      }}
      title={tx("添加子步骤", "Add child step")}
    >
      <option value="">＋ {tx("子步骤", "Child step")}</option>
      {ADD_KINDS.map((k) => (
        <option key={k} value={k}>
          ＋{tx(KIND_LABEL[k].zh, KIND_LABEL[k].en)}
        </option>
      ))}
    </select>
  );
}

/** 行内参数区（按 kind 渲染对应编辑控件） */
function StepFields(props: { suite: Suite; step: Step }) {
  const { suite, step } = props;
  const patch = (fn: (s: Step) => Step) => sequencerStore.updateStep(suite.id, step.id, fn);

  switch (step.kind) {
    case "send": {
      const p = step.payload;
      return (
        <span className="sq-fields">
          <select
            className="input sq-w76"
            value={p.type === "factory" ? "hex" : p.type}
            onChange={(e) => {
              const t = e.target.value as "hex" | "ascii" | "cmd";
              patch((s) =>
                s.kind === "send"
                  ? {
                      ...s,
                      payload:
                        t === "hex"
                          ? { type: "hex", text: "" }
                          : t === "ascii"
                            ? { type: "ascii", text: "" }
                            : { type: "cmd", cmdId: "" },
                    }
                  : s,
              );
            }}
          >
            <option value="hex">HEX</option>
            <option value="ascii">ASCII</option>
            <option value="cmd">{tx("命令", "Command")}</option>
          </select>
          {p.type === "hex" || p.type === "ascii" ? (
            <input
              className="input sq-mono sq-flex"
              value={p.text}
              placeholder={p.type === "hex" ? "FF AA 01 …" : tx("hello\\r\\n（支持 \\r \\n \\t \\xNN）", "hello\\r\\n (\\r \\n \\t \\xNN ok)")}
              spellCheck={false}
              onChange={(e) => patch((s) => (s.kind === "send" && (s.payload.type === "hex" || s.payload.type === "ascii") ? { ...s, payload: { type: p.type, text: e.target.value } } : s))}
            />
          ) : p.type === "cmd" ? (
            <CmdSelect cmdId={p.cmdId} onChange={(id) => patch((s) => (s.kind === "send" ? { ...s, payload: { type: "cmd", cmdId: id } } : s))} />
          ) : (
            <span className="sq-hint">{tx("指令工厂载荷（v2 执行）", "Factory payload (v2)")}</span>
          )}
        </span>
      );
    }
    case "wait":
      return (
        <span className="sq-fields">
          <input
            className="input sq-n80"
            type="number"
            min={LIMITS.waitMinMs}
            max={LIMITS.waitMaxMs}
            value={step.ms}
            onChange={(e) => patch((s) => (s.kind === "wait" ? { ...s, ms: clampInt(e.target.value, LIMITS.waitMinMs, LIMITS.waitMaxMs, 100) } : s))}
          />
          <span className="sq-unit">ms</span>
        </span>
      );
    case "waitForFrame":
      return (
        <span className="sq-fields">
          <MatchEditor match={step.match} onChange={(m) => patch((s) => (s.kind === "waitForFrame" ? { ...s, match: m } : s))} />
          <label className="sq-inline" title={tx("超时；0 = 一直等到停止", "Timeout; 0 = wait until stopped")}>
            {tx("超时", "Timeout")}
            <input
              className="input sq-n70"
              type="number"
              min={0}
              max={LIMITS.frameTimeoutMaxMs}
              value={step.timeoutMs}
              onChange={(e) => patch((s) => (s.kind === "waitForFrame" ? { ...s, timeoutMs: clampInt(e.target.value, 0, LIMITS.frameTimeoutMaxMs, 3000) } : s))}
            />
            ms
          </label>
        </span>
      );
    case "assertVar": {
      const vars = variableStore.listVars();
      return (
        <span className="sq-fields">
          <input
            className="input sq-n110"
            value={step.varName}
            placeholder={tx("变量名", "Variable")}
            list="sq-varlist"
            onChange={(e) => patch((s) => (s.kind === "assertVar" ? { ...s, varName: e.target.value } : s))}
          />
          <select
            className="input sq-w64"
            value={step.op}
            onChange={(e) => patch((s) => (s.kind === "assertVar" ? { ...s, op: e.target.value as CmpOp } : s))}
          >
            {OPS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.zh}
              </option>
            ))}
          </select>
          {step.op === "changed" ? (
            <span className="sq-hint">{tx("与上次断言值比较", "vs last asserted value")}</span>
          ) : (
            <>
              <input
                className="input sq-n90"
                type="number"
                value={typeof step.expected === "number" ? step.expected : 0}
                onChange={(e) => patch((s) => (s.kind === "assertVar" ? { ...s, expected: Number(e.target.value) || 0 } : s))}
                title={tx("期望值", "Expected value")}
              />
              <select
                className="input sq-w96"
                value={typeof step.expected === "object" && step.expected ? step.expected.var : ""}
                title={tx("期望值可引用另一个变量", "Expected can reference another variable")}
                onChange={(e) =>
                  patch((s) =>
                    s.kind === "assertVar" ? { ...s, expected: e.target.value ? { var: e.target.value } : 0 } : s,
                  )
                }
              >
                <option value="">{tx("（固定值）", "(fixed value)")}</option>
                {vars.map((v) => (
                  <option key={v.name} value={v.name}>
                    {`{${v.name}}`}
                  </option>
                ))}
              </select>
              {step.op === "approx" && (
                <input
                  className="input sq-n70"
                  type="number"
                  value={step.tolerance ?? 0}
                  title={tx("容差", "Tolerance")}
                  onChange={(e) => patch((s) => (s.kind === "assertVar" ? { ...s, tolerance: Math.abs(Number(e.target.value) || 0) } : s))}
                />
              )}
            </>
          )}
        </span>
      );
    }
    case "group":
      return (
        <span className="sq-fields">
          <input
            className="input sq-n110"
            value={step.name}
            placeholder={tx("分组名", "Group name")}
            onChange={(e) => patch((s) => (s.kind === "group" ? { ...s, name: e.target.value } : s))}
          />
          <span className="sq-inline" title={tx("循环轮数", "Repeat count")}>
            ×
            <input
              className="input sq-n56"
              type="number"
              min={1}
              max={LIMITS.groupRepeatsMax}
              value={step.repeats}
              onChange={(e) => patch((s) => (s.kind === "group" ? { ...s, repeats: clampInt(e.target.value, 1, LIMITS.groupRepeatsMax, 1) } : s))}
            />
          </span>
          <select
            className="input sq-w110"
            value={step.onFailure}
            title={tx("组内失败后的行为", "Behavior on failure inside the group")}
            onChange={(e) => patch((s) => (s.kind === "group" ? { ...s, onFailure: e.target.value as "abort" | "continue" } : s))}
          >
            <option value="abort">{tx("失败短路", "Abort on fail")}</option>
            <option value="continue">{tx("失败续跑", "Continue on fail")}</option>
          </select>
        </span>
      );
    case "note":
      return (
        <span className="sq-fields">
          <input
            className="input sq-flex"
            value={step.text}
            placeholder={tx("备注内容（进报告）", "Note text (goes into the report)")}
            onChange={(e) => patch((s) => (s.kind === "note" ? { ...s, text: e.target.value } : s))}
          />
        </span>
      );
  }
}

function CmdSelect(props: { cmdId: string; onChange: (id: string) => void }) {
  const cmds = useSyncExternalStore(commandStore.subscribe, commandStore.getSnapshot);
  const flat = useMemo(() => commandStore.flatCommands(), [cmds]);
  return (
    <select
      className="input sq-flex"
      value={props.cmdId}
      onChange={(e) => props.onChange(e.target.value)}
      title={tx("从命令库选择（内容支持 {变量} 占位）", "Pick from command library ({var} placeholders supported)")}
    >
      <option value="">{flat.length ? tx("选择命令…", "Pick a command…") : tx("（命令库为空）", "(command library empty)")}</option>
      {flat.map(({ item }) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  );
}

/** 帧匹配编辑器：等帧步骤与帧触发共用 */
export function MatchEditor(props: { match: FrameMatch; onChange: (m: FrameMatch) => void }) {
  const { match, onChange } = props;
  const tpls = useSyncExternalStore(templateStore.subscribe, templateStore.getSnapshot);
  const templates = tpls.rules.templates;
  const tpl = match.by !== "raw" ? templates.find((t) => t.id === match.tplId) : undefined;

  return (
    <span className="sq-fields">
      <select
        className="input sq-w76"
        value={match.by}
        onChange={(e) => {
          const by = e.target.value as FrameMatch["by"];
          if (by === "raw") onChange({ by: "raw", hex: "" });
          else if (by === "tpl") onChange({ by: "tpl", tplId: templates[0]?.id ?? "" });
          else
            onChange({
              by: "field",
              tplId: templates[0]?.id ?? "",
              fieldName: templates[0]?.fields[0]?.name ?? "",
              op: "eq",
              expected: 0,
            });
        }}
      >
        <option value="raw">{tx("原始字节", "Raw bytes")}</option>
        <option value="tpl">{tx("模板", "Template")}</option>
        <option value="field">{tx("模板+字段", "Template+field")}</option>
      </select>
      {match.by === "raw" ? (
        <input
          className="input sq-mono sq-n150"
          value={match.hex}
          placeholder="AA 55 …"
          spellCheck={false}
          title={tx("帧内包含该字节序列即命中", "Matches when the frame contains these bytes")}
          onChange={(e) => onChange({ by: "raw", hex: e.target.value })}
        />
      ) : (
        <>
          <select
            className="input sq-w140"
            value={match.tplId}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              onChange(
                match.by === "field"
                  ? { ...match, tplId: e.target.value, fieldName: t?.fields[0]?.name ?? "" }
                  : { by: "tpl", tplId: e.target.value },
              );
            }}
          >
            {!tpl && <option value="">({tx("无模板", "no template")})</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {match.by === "field" && (
            <>
              <select
                className="input sq-w110"
                value={match.fieldName}
                onChange={(e) => onChange({ ...match, fieldName: e.target.value })}
              >
                {tpl?.fields.map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
              <select
                className="input sq-w56"
                value={match.op}
                onChange={(e) => onChange({ ...match, op: e.target.value as CmpOp })}
              >
                {OPS.filter((o) => o.v !== "changed").map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.zh}
                  </option>
                ))}
              </select>
              <input
                className="input sq-n90"
                type="number"
                value={typeof match.expected === "number" ? match.expected : 0}
                onChange={(e) => onChange({ ...match, expected: Number(e.target.value) || 0 })}
                title={tx("字段期望值", "Expected field value")}
              />
            </>
          )}
        </>
      )}
    </span>
  );
}

function clampInt(raw: string, lo: number, hi: number, def: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/* ================= 结果视图 ================= */

const STATUS_TEXT: Record<string, { zh: string; en: string }> = {
  pass: { zh: "通过", en: "pass" },
  fail: { zh: "失败", en: "fail" },
  timeout: { zh: "超时", en: "timeout" },
  skipped: { zh: "跳过", en: "skip" },
  aborted: { zh: "中止", en: "aborted" },
};

function ResultView(props: { progress: RunProgress | null; mine: boolean }) {
  const { progress, mine } = props;
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const stats = useMemo(() => {
    const c = { pass: 0, bad: 0, skip: 0 };
    const walk = (rs: StepResult[]) => {
      for (const r of rs) {
        if (r.status === "pass") c.pass++;
        else if (r.status === "fail" || r.status === "timeout") c.bad++;
        else c.skip++;
        if (r.children) walk(r.children);
      }
    };
    if (progress?.results) walk(progress.results);
    return c;
  }, [progress]);

  if (!progress || !mine) {
    return (
      <div className="seq-results off">
        <div className="seq-res-head muted">{tx("尚无运行结果", "No run results yet")}</div>
      </div>
    );
  }

  // 属性路径收窄不保留进闭包：报告导出回调里要用，提为 const
  const res = progress.status === "finished" && progress.result ? progress.result : null;
  const headCls = progress.status === "finished" ? (progress.result?.status === "done" ? "ok" : "bad") : "run";

  return (
    <div className="seq-results">
      <div className={`seq-res-head ${headCls}`} onClick={() => setOpen((v) => !v)}>
        <span className="seq-res-title">
          {progress.status === "running"
            ? tx("运行中…", "Running…")
            : progress.status === "awaitingStep"
              ? tx("单步挂起", "Paused (step)")
              : progress.result?.status === "done"
                ? tx("完成", "Done")
                : progress.result?.status === "aborted"
                  ? tx("已中止", "Aborted")
                  : tx("失败", "Failed")}
        </span>
        <span className="seq-res-stats">
          ✓{stats.pass} ✗{stats.bad} ·{(progress.result ? ((progress.result.finishedAt - progress.result.startedAt) / 1000).toFixed(2) : "…")}s
        </span>
        <span className="seq-res-toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="seq-res-tree">
          {progress.results.map((r) => (
            <ResultNode key={r.stepId} r={r} depth={1} collapsed={collapsed} toggle={(id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }) } />
          ))}
          {progress.results.length === 0 && <div className="seq-hint">{tx("等待第一个步骤完成…", "Waiting for the first step…")}</div>}
        </div>
      )}
      {res && (
        <div className="seq-res-foot">
          <span>
            {res.steps.length} {tx("个顶层步骤", "top-level steps")} ·{" "}
            {new Date(res.finishedAt).toLocaleTimeString()}
          </span>
          <button
            className="btn sm"
            onClick={() => {
              const blob = new Blob([renderReportHtml(res)], { type: "text/html;charset=utf-8" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `${res.suiteName || "sequence"}-report.html`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}
            title={tx("导出自包含 HTML 测试报告", "Export a self-contained HTML test report")}
          >
            <IconDownload />
            {tx("导出报告", "Export report")}
          </button>
        </div>
      )}
    </div>
  );
}

function ResultNode(props: {
  r: StepResult;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const { r, depth, collapsed, toggle } = props;
  const isGroup = r.kind === "group" && (r.children?.length ?? 0) > 0;
  // ≤50 子节点默认展开；更大的组默认折叠（点开仍可看），防大循环渲染爆炸
  const autoOpen = (r.children?.length ?? 0) <= 50;
  const open = isGroup && (autoOpen ? !collapsed.has(r.stepId) : collapsed.has(r.stepId));
  const st = STATUS_TEXT[r.status] ?? STATUS_TEXT.skipped;

  return (
    <div>
      <div className={`sq-res d${Math.min(depth, 5)} st-${r.status}`}>
        {isGroup ? (
          <button className="sq-res-tgl" onClick={() => toggle(r.stepId)}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="sq-res-dot" />
        )}
        <span className="sq-res-label" title={r.detail}>
          {r.label}
        </span>
        <span className="sq-res-detail">{r.detail}</span>
        <span className="sq-res-ms">{r.durationMs > 0 ? `${r.durationMs}ms` : ""}</span>
        <span className={`sq-res-st st-${r.status}`}>{st.zh}</span>
      </div>
      {isGroup && open && r.children!.map((c, i) => <ResultNode key={`${c.stepId}.${i}`} r={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />)}
    </div>
  );
}
