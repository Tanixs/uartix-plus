/**
 * P74 编排器引擎测试。
 *
 * 覆盖红线与核心语义：
 * - 总开关/组启用门控；手动运行；块顺序执行
 * - 帧事件 stride 取样 + evt 字段注入 + ${} 插值
 * - 阈值/定时器按块投递（组归属）；varChanged 同值不触发
 * - if/else、loop（count/while/break/上限）、嵌套组内联
 * - runGroup：等待、自调拒绝、递归深度帽、A→B→A 等待环检测
 * - 队列策略 dropNew/dropOld/stopOld（FIFO 深度 queueCap=8）；组级冷却；
 *   send 令牌桶 50/s；触发风暴熔断
 * - 手动触发：空事件槽恒可手动；非空槽须挂「手动」块
 * - 变量类型收敛；sessionStop 复位非持久变量；setDoc 保留同型变量值；
 *   持久变量落盘快照与 seed 回填（P74c A1）
 * - waitFrame 超时/命中；日志环形 800
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchEngine, type OrchDeps } from "./engine";
import { ORCH_LIMITS, type ExecBlock, type FlowDoc, type FlowVar, type FrameRowLite, type GroupNode, type LogEntry } from "./types";

/* ================= 桩与工具 ================= */

let idSeq = 0;
const nid = () => `b${++idSeq}`;

function mkDeps() {
  const sent: { mode: string; text: string }[] = [];
  const toasts: { text: string; level: string }[] = [];
  const sounds: string[] = [];
  const suites: { id: string; wait: boolean }[] = [];
  const chans = new Map<string, number>([["temp", 25]]);
  let waitFrameReply: FrameRowLite | null = null;
  const deps: OrchDeps = {
    now: () => Date.now(),
    resolveSend: (p) =>
      p.type === "hex" ? { mode: "hex", text: p.text } : p.type === "ascii" ? { mode: "ascii", text: p.text } : null,
    send: (mode, text) => {
      sent.push({ mode, text });
    },
    runSuite: (id, wait) => {
      suites.push({ id, wait });
      return true;
    },
    waitFrame: async () => waitFrameReply,
    chanLatest: (chId) => chans.get(chId) ?? null,
    sessionState: () => "idle",
    toast: (text, level) => {
      toasts.push({ text, level });
    },
    sound: (level) => {
      sounds.push(level);
    },
  };
  return { deps, sent, toasts, sounds, suites, chans, setWaitFrame: (r: FrameRowLite | null) => (waitFrameReply = r) };
}

const send = (text: string, onFail: "abort" | "continue" = "abort"): ExecBlock => ({
  id: nid(),
  kind: "send",
  enabled: true,
  onFail,
  payload: { type: "hex", text },
});
const wait = (ms: number): ExecBlock => ({ id: nid(), kind: "wait", enabled: true, onFail: "abort", ms });

function mkGroup(p: Partial<GroupNode> & { id?: string }): GroupNode {
  return { kind: "group", id: "g1", name: "G1", enabled: true, events: [], children: [], ...p };
}
function mkDoc(groups: GroupNode[], vars: FlowVar[] = []): FlowDoc {
  return { version: 1, title: "t", vars, groups, settings: { masterOn: true } };
}

describe("OrchEngine", () => {
  let h: ReturnType<typeof mkDeps>;
  let eng: OrchEngine;
  const settle = (ms = 5) => vi.advanceTimersByTimeAsync(ms);
  const logs = (): LogEntry[] => eng.getLogs();

  beforeEach(() => {
    vi.useFakeTimers();
    h = mkDeps();
    eng = new OrchEngine(h.deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("总开关关闭 / 组禁用 → 不触发", () => {
    eng.setDoc(mkDoc([mkGroup({ children: [send("AA")] })]));
    eng.getDoc()!.settings.masterOn = false;
    expect(eng.runManual("g1")).toBe(false);
    eng.setDoc(mkDoc([mkGroup({ enabled: false, children: [send("BB")] })]));
    expect(eng.runManual("g1")).toBe(false);
  });

  it("手动顺序执行：send→wait→send，等待期间可停止", async () => {
    eng.setDoc(mkDoc([mkGroup({ children: [send("AA"), wait(100), send("BB")] })]));
    expect(eng.runManual("g1")).toBe(true);
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["AA"]);
    eng.stopAll();
    await settle(200);
    expect(h.sent.map((s) => s.text)).toEqual(["AA"]);
    expect(logs().some((l) => l.phase === "abort")).toBe(true);
  });

  it("等待自然到期后继续", async () => {
    eng.setDoc(mkDoc([mkGroup({ children: [wait(50), send("CC")] })]));
    eng.runManual("g1");
    await settle(100);
    expect(h.sent.map((s) => s.text)).toEqual(["CC"]);
  });

  it("帧事件 stride 取样 + evt 字段注入 + 插值", async () => {
    const row = (v: number) => ({
      tplId: "t",
      tplName: "姿态帧",
      valid: true,
      len: 8,
      fields: [{ id: "f1", name: "温度", value: v }],
    });
    eng.setDoc(
      mkDoc(
        [
          mkGroup({
            events: [{ id: "e1", kind: "frame", match: { by: "field", tplId: "t", fieldName: "温度", op: "gt", expected: 50 }, stride: 2 }],
            children: [
              { id: nid(), kind: "setVar", enabled: true, onFail: "abort", name: "temp", from: { k: "evtField", field: "温度" } },
              { id: nid(), kind: "toast", enabled: true, onFail: "abort", level: "info", text: "T=${temp}" },
            ],
          }),
        ],
        [{ name: "temp", type: "number", def: 0, persist: false }],
      ),
    );
    eng.emit({ kind: "frame", row: row(60) }); // stride 第1帧：取样跳过
    eng.emit({ kind: "frame", row: row(70) }); // 第2帧：命中
    await settle(0);
    expect(eng.getVar("temp")).toBe(70);
    expect(h.toasts.some((t) => t.text === "T=70")).toBe(true);
  });

  it("阈值/定时器事件按 groupId+blockId 归属", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({ id: "ga", events: [{ id: "th", kind: "threshold", chId: "temp", op: "above", value: 60, edge: "enter", debounceMs: 0 }], children: [send("T1")] }),
        mkGroup({ id: "gb", events: [{ id: "tm", kind: "timer", intervalMs: 1000 }], children: [send("T2")] }),
      ]),
    );
    eng.emit({ kind: "threshold", groupId: "ga", blockId: "th", chId: "temp", value: 61, phase: "enter" });
    eng.emit({ kind: "timer", groupId: "gb", blockId: "tm" });
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["T1", "T2"]);
  });

  it("varChanged 触发；同值写入不触发", async () => {
    eng.setDoc(
      mkDoc([mkGroup({ events: [{ id: "w", kind: "varChanged", varName: "n" }], children: [send("W")] })], [
        { name: "n", type: "number", def: 0, persist: false },
      ]),
    );
    expect(eng.setVar("n", 5)).toBe(true);
    await settle(0);
    expect(h.sent).toHaveLength(1);
    expect(eng.setVar("n", 5)).toBe(true); // 同值
    await settle(0);
    expect(h.sent).toHaveLength(1);
    expect(eng.statsOf("g1").total).toBe(1);
  });

  it("if/else 分支：chan 条件", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({
          children: [
            {
              id: nid(),
              kind: "if",
              enabled: true,
              conds: [{ k: "chan", chId: "temp", op: "gt", value: 50 }],
              then: [send("HI")],
              els: [send("LO")],
            },
          ],
        }),
      ]),
    );
    eng.runManual("g1");
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["LO"]);
    h.chans.set("temp", 60);
    eng.runManual("g1");
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["LO", "HI"]);
  });

  it("loop count：计数+break 提前退出", async () => {
    eng.setDoc(
      mkDoc(
        [
          mkGroup({
            children: [
              {
                id: nid(),
                kind: "loop",
                enabled: true,
                mode: "count",
                count: 100,
                intervalMs: 0,
                body: [
                  { id: nid(), kind: "setVar", enabled: true, onFail: "abort", name: "n", from: { k: "expr", src: "n+1" } },
                  { id: nid(), kind: "if", enabled: true, conds: [{ k: "var", name: "n", op: "ge", value: 3 }], then: [{ id: nid(), kind: "break", enabled: true }], els: [] },
                ],
              },
              send("AFTER"),
            ],
          }),
        ],
        [{ name: "n", type: "number", def: 0, persist: false }],
      ),
    );
    eng.runManual("g1");
    await settle(0);
    expect(eng.getVar("n")).toBe(3);
    expect(h.sent.map((s) => s.text)).toEqual(["AFTER"]);
  });

  it("loop while：条件退出；迭代超上限 → 组失败", async () => {
    // while：n<3 时自增
    eng.setDoc(
      mkDoc(
        [
          mkGroup({
            children: [
              {
                id: nid(),
                kind: "loop",
                enabled: true,
                mode: "while",
                cond: [{ k: "var", name: "n", op: "lt", value: 3 }],
                intervalMs: 0,
                body: [{ id: nid(), kind: "setVar", enabled: true, onFail: "abort", name: "n", from: { k: "expr", src: "n+1" } }],
              },
            ],
          }),
        ],
        [{ name: "n", type: "number", def: 0, persist: false }],
      ),
    );
    eng.runManual("g1");
    await settle(0);
    expect(eng.getVar("n")).toBe(3);

    // 恒真 while → 1000 上限熔断
    const g = mkGroup({
      id: "g2",
      children: [
        {
          id: nid(),
          kind: "loop",
          enabled: true,
          mode: "while",
          cond: [{ k: "expr", src: "1==1" }],
          intervalMs: 0,
          body: [],
        },
      ],
    });
    eng.setDoc(mkDoc([g]));
    eng.runManual("g2");
    await settle(50);
    expect(eng.statsOf("g2").fail).toBe(1);
    expect(logs().some((l) => l.detail.includes("循环迭代超限"))).toBe(true);
  });

  it("runGroup：等待被调组完成；自调拒绝；递归深度帽；等待环检测", async () => {
    // 等待：g1 → runGroup(g2, wait) → g2 发 B，随后 g1 发 A2
    eng.setDoc(
      mkDoc([
        mkGroup({ id: "g1", children: [{ id: nid(), kind: "runGroup", enabled: true, onFail: "abort", groupId: "g2", wait: true }, send("A2")] }),
        mkGroup({ id: "g2", children: [send("B")] }),
      ]),
    );
    eng.runManual("g1");
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["B", "A2"]);

    // 自调
    eng.setDoc(mkDoc([mkGroup({ id: "g3", children: [{ id: nid(), kind: "runGroup", enabled: true, onFail: "abort", groupId: "g3", wait: false }] })]));
    eng.runManual("g3");
    await settle(0);
    expect(logs().some((l) => l.detail.includes("禁止调用自身"))).toBe(true);

    // 递归深度：链式 g4→g5→...→g13（>8 层）；sent 基线 = 本 it 内此前已发的 B/A2
    const sentBase = h.sent.length;
    const chainGroups: GroupNode[] = [];
    for (let i = 4; i <= 13; i++) {
      chainGroups.push(
        mkGroup({
          id: `g${i}`,
          children:
            i < 13
              ? [{ id: nid(), kind: "runGroup", enabled: true, onFail: "abort", groupId: `g${i + 1}`, wait: false }]
              : [send("DEEP")],
        }),
      );
    }
    eng.setDoc(mkDoc(chainGroups));
    eng.runManual("g4");
    await settle(0);
    expect(h.sent).toHaveLength(sentBase);
    expect(logs().some((l) => l.detail.includes("递归深度超限"))).toBe(true);

    // 等待环 A→B→A
    eng.setDoc(
      mkDoc([
        mkGroup({ id: "ga", children: [{ id: nid(), kind: "runGroup", enabled: true, onFail: "abort", groupId: "gb", wait: true }] }),
        mkGroup({ id: "gb", children: [{ id: nid(), kind: "runGroup", enabled: true, onFail: "abort", groupId: "ga", wait: true }] }),
      ]),
    );
    eng.runManual("ga");
    await settle(0);
    expect(logs().some((l) => l.detail.includes("等待环"))).toBe(true);
  });

  it("队列 FIFO dropNew：未满时排队执行，满 8 后丢弃新触发", async () => {
    eng.setDoc(mkDoc([mkGroup({ children: [wait(100), send("X")] })]));
    // 深度上限 8（含在跑的 1 个）→ 前 8 次全部入队，第 9 次起丢弃
    for (let i = 0; i < 11; i++) eng.runManual("g1");
    await settle(1000);
    expect(h.sent).toHaveLength(8);
    expect(logs().filter((l) => l.detail.includes("队列已满")).length).toBe(3);
  });

  it("队列 FIFO dropOld：满队列时挤掉最旧的排队项", async () => {
    eng.setDoc(mkDoc([mkGroup({ queuePolicy: "dropOld", children: [wait(100), send("X")] })]));
    for (let i = 0; i < 11; i++) eng.runManual("g1");
    await settle(1000);
    // 在跑的 1 个不受影响；排队 7 个，后 3 次各挤掉 1 个 → 净执行 8 个
    expect(h.sent).toHaveLength(8);
    expect(logs().some((l) => l.detail.includes("被新触发挤掉"))).toBe(true);
    expect(logs().some((l) => l.detail.includes("丢弃新触发"))).toBe(false);
  });

  it("队列 FIFO stopOld：新触发中止在跑与排队实例", async () => {
    eng.setDoc(mkDoc([mkGroup({ queuePolicy: "stopOld", children: [wait(100), send("X")] })]));
    eng.runManual("g1");
    eng.runManual("g1");
    await settle(0);
    eng.runManual("g1"); // 中止前两个，自己上位
    await settle(500);
    expect(h.sent).toHaveLength(1);
    expect(logs().some((l) => l.detail.includes("stopOld"))).toBe(true);
  });

  it("手动触发：空事件槽恒可手动；非空槽须挂「手动」块", async () => {
    // 空事件槽 = 手动/子程序组
    eng.setDoc(mkDoc([mkGroup({ id: "g1", children: [send("M1")] })]));
    expect(eng.canManual("g1")).toBe(true);
    expect(eng.runManual("g1")).toBe(true);
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["M1"]);

    // 只有自动事件 → ▶ 不可用（事件块有真实语义：摘掉手动块即不可手动跑）
    eng.setDoc(mkDoc([mkGroup({ id: "g1", events: [{ id: "tm", kind: "timer", intervalMs: 1000 }], children: [send("M2")] })]));
    expect(eng.canManual("g1")).toBe(false);
    expect(eng.runManual("g1")).toBe(false);
    await settle(0);
    expect(h.sent).toHaveLength(1);

    // 自动事件 + 手动块 → 两者都通
    eng.setDoc(
      mkDoc([
        mkGroup({
          id: "g1",
          events: [
            { id: "tm", kind: "timer", intervalMs: 1000 },
            { id: "mn", kind: "manual" },
          ],
          children: [send("M3")],
        }),
      ]),
    );
    expect(eng.canManual("g1")).toBe(true);
    expect(eng.runManual("g1")).toBe(true);
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["M1", "M3"]);
  });

  it("组级冷却：阈值事件连续触发被冷却丢弃", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({
          cooldownMs: 1000,
          events: [{ id: "th", kind: "threshold", chId: "temp", op: "above", value: 60, edge: "enter", debounceMs: 0 }],
          children: [send("T")],
        }),
      ]),
    );
    eng.emit({ kind: "threshold", groupId: "g1", blockId: "th", chId: "temp", value: 61, phase: "enter" });
    eng.emit({ kind: "threshold", groupId: "g1", blockId: "th", chId: "temp", value: 62, phase: "enter" });
    await settle(0);
    expect(h.sent).toHaveLength(1);
    expect(logs().some((l) => l.detail.includes("冷却"))).toBe(true);
  });

  it("send 令牌桶 50/s：超额丢弃（onFail=continue 不中断）", async () => {
    const children = Array.from({ length: 55 }, (_, i) => send(`S${i}`, "continue"));
    eng.setDoc(mkDoc([mkGroup({ children })]));
    eng.runManual("g1");
    await settle(0);
    expect(h.sent).toHaveLength(50);
    expect(logs().filter((l) => l.detail.includes("发送速率超限"))).toHaveLength(5);
    expect(eng.statsOf("g1").fail).toBe(0);
  });

  it("触发风暴熔断：1s 内 >100 次 → 停 1s + 提示", async () => {
    eng.setDoc(
      mkDoc([mkGroup({ events: [{ id: "w", kind: "varChanged", varName: "n" }], children: [send("W")] })], [
        { name: "n", type: "number", def: 0, persist: false },
      ]),
    );
    for (let i = 0; i < 120; i++) eng.setVar("n", i % 2);
    await settle(0);
    expect(h.toasts.some((t) => t.text.includes("暂停"))).toBe(true);
    expect(logs().some((l) => l.phase === "fuse")).toBe(true);
    // FIFO 深度 8：风暴期间队列先被填满，其余丢弃（不再无限堆叠）
    expect(h.sent.length).toBeLessThanOrEqual(8);
    expect(logs().some((l) => l.detail.includes("队列已满"))).toBe(true);
  });

  it("变量类型收敛：数字/字符串/布尔；失败不静默", () => {
    eng.setDoc(
      mkDoc([], [
        { name: "n", type: "number", def: 0, persist: false },
        { name: "s", type: "string", def: "", persist: false },
        { name: "b", type: "bool", def: false, persist: false },
      ]),
    );
    expect(eng.setVar("n", "3.5")).toBe(true);
    expect(eng.getVar("n")).toBe(3.5);
    expect(eng.setVar("n", "abc")).toBe(false);
    expect(eng.getVar("n")).toBe(3.5);
    expect(eng.setVar("s", 42)).toBe(true);
    expect(eng.getVar("s")).toBe("42");
    expect(eng.setVar("b", 1)).toBe(true);
    expect(eng.getVar("b")).toBe(true);
    expect(eng.setVar("b", "xx")).toBe(false);
    expect(eng.getVar("b")).toBe(true);
  });

  it("sessionStop 复位非持久变量、保留持久变量；setDoc 同型变量保值", async () => {
    eng.setDoc(
      mkDoc([], [
        { name: "p", type: "number", def: 7, persist: true },
        { name: "q", type: "number", def: 3, persist: false },
      ]),
    );
    eng.setVar("p", 9);
    eng.setVar("q", 9);
    eng.sessionStop();
    expect(eng.getVar("p")).toBe(9);
    expect(eng.getVar("q")).toBe(3);

    eng.setDoc(
      mkDoc([], [
        { name: "p", type: "number", def: 7, persist: true },
        { name: "q", type: "number", def: 3, persist: false },
      ]),
    );
    expect(eng.getVar("p")).toBe(9); // setDoc 同名同型保留
  });

  it("持久变量：persistVars 快照只含持久项；seed 仅在无同型现值时回填（P74c A1）", () => {
    const vars: FlowVar[] = [
      { name: "p", type: "number", def: 7, persist: true },
      { name: "v", type: "number", def: 1, persist: false },
    ];
    eng.setDoc({ version: 1, title: "t", vars, groups: [], settings: { masterOn: true } });
    eng.setVar("p", 42);
    eng.setVar("v", 5);
    expect(eng.persistVars()).toEqual({ p: 42 });

    // 全新引擎（等价于重启）：seed 回填持久值，非持久项落默认
    const e2 = new OrchEngine(h.deps);
    e2.setDoc({ version: 1, title: "t", vars, groups: [], settings: { masterOn: true } }, { p: 42, v: 5 });
    expect(e2.getVar("p")).toBe(42);
    expect(e2.getVar("v")).toBe(1);

    // 引擎只做类型收敛：number→string 的旧值会被收敛成 "42"（不静默放大）；
    // 「改类型即清旧值」由 store 侧负责——类型变更时从落盘区删掉该变量（见 orchestratorStore）。
    const e3 = new OrchEngine(h.deps);
    e3.setDoc(
      { version: 1, title: "t", vars: [{ name: "p", type: "string", def: "d", persist: true }], groups: [], settings: { masterOn: true } },
      { p: 42 },
    );
    expect(e3.getVar("p")).toBe("42");

    // 收敛失败 → 落默认值（不是乱值）
    const e5 = new OrchEngine(h.deps);
    e5.setDoc(
      { version: 1, title: "t", vars: [{ name: "p", type: "bool", def: true, persist: true }], groups: [], settings: { masterOn: true } },
      { p: "maybe" },
    );
    expect(e5.getVar("p")).toBe(true);

    // 异型 seed 被类型收敛拒绝时同样落默认（"42abc" 不是合法数字）
    const e4 = new OrchEngine(h.deps);
    e4.setDoc({ version: 1, title: "t", vars, groups: [], settings: { masterOn: true } }, { p: "42abc" });
    expect(e4.getVar("p")).toBe(7);

    // 已有同型现值时不覆盖（编辑文档不把运行值拉回磁盘旧值）
    eng.setDoc({ version: 1, title: "t", vars, groups: [], settings: { masterOn: true } }, { p: 999 });
    expect(eng.getVar("p")).toBe(42);
  });

  it("waitFrame：超时按 onFail 处理；命中记录", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({
          children: [
            { id: nid(), kind: "waitFrame", enabled: true, onFail: "continue", match: { by: "tpl", tplId: "t" }, timeoutMs: 50, ignoreFail: true },
            send("NEXT"),
          ],
        }),
      ]),
    );
    eng.runManual("g1");
    await settle(100);
    expect(h.sent.map((s) => s.text)).toEqual(["NEXT"]);
    expect(logs().some((l) => l.detail.includes("未等到匹配帧"))).toBe(true);

    h.setWaitFrame({ tplId: "t", tplName: "应答帧", valid: true, len: 6, fields: [] });
    eng.runManual("g1");
    await settle(0);
    expect(logs().some((l) => l.detail.includes("等到帧 [应答帧]"))).toBe(true);
  });

  it("runSuite 块：等待结果并入组判定", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({ children: [{ id: nid(), kind: "runSuite", enabled: true, onFail: "abort", suiteId: "s1", wait: true }] }),
      ]),
    );
    eng.runManual("g1");
    await settle(0);
    expect(h.suites).toEqual([{ id: "s1", wait: true }]);
    expect(eng.statsOf("g1").fail).toBe(0);
  });

  it("运行日志环形 800：超限覆写最旧", async () => {
    const children = Array.from({ length: 1000 }, (_, i) => send(`S${i}`, "continue"));
    eng.setDoc(mkDoc([mkGroup({ children })]));
    eng.runManual("g1");
    await settle(0);
    expect(eng.getLogs()).toHaveLength(800);
  });

  it("嵌套组：内联执行子流（事件槽无触发语义）", async () => {
    eng.setDoc(
      mkDoc([
        mkGroup({
          children: [
            mkGroup({ id: "inner", events: [{ id: "tm", kind: "timer", intervalMs: 100 }], children: [send("N")] }),
            send("M"),
          ],
        }),
      ]),
    );
    eng.runManual("g1");
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["N", "M"]);
    // 内层 timer 事件不应触发任何组（事件槽仅顶层组有效）
    eng.emit({ kind: "timer", groupId: "inner", blockId: "tm" });
    await settle(0);
    expect(h.sent).toHaveLength(2);
  });
});

/* ================= B4c：新动作块 ================= */

describe("OrchEngine B4c 新动作块", () => {
  let h: ReturnType<typeof mkDeps>;
  let eng: OrchEngine;
  const settle = (ms = 5) => vi.advanceTimersByTimeAsync(ms);
  const logs = (): LogEntry[] => eng.getLogs();
  /** 块工厂（onFail 可指定） */
  const blk = (n: ExecBlock, onFail: "abort" | "continue" = "abort"): ExecBlock => ({ ...n, id: nid(), enabled: true, onFail });

  beforeEach(() => {
    vi.useFakeTimers();
    h = mkDeps();
    eng = new OrchEngine(h.deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("setControl：写画布变量（const/通道）；变量不存在按 onFail", async () => {
    const ctl: [string, number | string][] = [];
    h.deps.writeControlVar = (name, value) => {
      if (name === "ghost") return false;
      ctl.push([name, value]);
      return true;
    };
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "setControl", varName: "sp", from: { k: "const", value: 88 } } as ExecBlock),
          blk({ kind: "setControl", varName: "sp", from: { k: "chan", chId: "temp" } } as ExecBlock),
          blk({ kind: "setControl", varName: "ghost", from: { k: "const", value: 1 } } as ExecBlock, "continue"),
          blk({ kind: "setControl", varName: "sp", from: { k: "const", value: 0 } } as ExecBlock),
        ],
      }),
    ]));
    eng.runManual("g1");
    await settle(0);
    expect(ctl).toEqual([["sp", 88], ["sp", 25], ["sp", 0]]);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("ghost"))).toBe(true);
  });

  it("setControl：钩子未接线 → fail；bool 常量收敛为 0/1", async () => {
    const ctl: [string, number | string][] = [];
    h.deps.writeControlVar = (name, value) => (ctl.push([name, value]), true);
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "setControl", varName: "a", from: { k: "const", value: true } } as ExecBlock),
          blk({ kind: "setControl", varName: "b", from: { k: "const", value: 2 } } as ExecBlock, "continue"),
        ],
      }),
    ]));
    eng.runManual("g1");
    await settle(0);
    expect(ctl).toEqual([["a", 1], ["b", 2]]);
    delete h.deps.writeControlVar;
    eng.setDoc(mkDoc([mkGroup({ children: [blk({ kind: "setControl", varName: "x", from: { k: "const", value: 1 } } as ExecBlock)] })]));
    eng.runManual("g1");
    await settle(0);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("未接线"))).toBe(true);
  });

  it("setSwitch：on/off/toggle 透传；卡不存在/未写名按 onFail", async () => {
    const flips: { name: string; state: string }[] = [];
    h.deps.setSwitchCard = (name, state) => {
      if (name === "ghost") return false;
      flips.push({ name, state });
      return true;
    };
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "setSwitch", swName: "SW1", state: "on" } as ExecBlock),
          blk({ kind: "setSwitch", swName: "SW1", state: "toggle" } as ExecBlock),
          blk({ kind: "setSwitch", swName: "ghost", state: "off" } as ExecBlock, "continue"),
          blk({ kind: "setSwitch", swName: "", state: "on" } as ExecBlock, "continue"),
        ],
      }),
    ]));
    eng.runManual("g1");
    await settle(0);
    expect(flips).toEqual([{ name: "SW1", state: "on" }, { name: "SW1", state: "toggle" }]);
    expect(logs().filter((l) => l.phase === "fail")).toHaveLength(2);
  });

  it("modbusWrite：FC06/FC05 编码为 RTU HEX 帧走 send（同令牌桶）；参数非法 fail", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "modbusWrite", slave: 1, fn: 6, addr: 10, value: 500 } as ExecBlock),
          blk({ kind: "modbusWrite", slave: 2, fn: 5, addr: 3, value: 1 } as ExecBlock),
          blk({ kind: "modbusWrite", slave: 300, fn: 6, addr: 0, value: 0 } as ExecBlock, "continue"),
        ],
      }),
    ]));
    eng.runManual("g1");
    await settle(0);
    // FC06: slave(1) fn(06) addr(00 0A) value(01 F4) + CRC
    expect(h.sent[0].mode).toBe("hex");
    expect(h.sent[0].text.startsWith("01 06 00 0A 01 F4")).toBe(true);
    expect(h.sent[0].text.split(" ")).toHaveLength(8);
    // FC05 置位: 02 05 00 03 FF 00 + CRC
    expect(h.sent[1].text.startsWith("02 05 00 03 FF 00")).toBe(true);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("Modbus"))).toBe(true);
  });

  it("log：写运行日志；crit 同步 toast；emitFlow 派发 flow 事件（B4d 前无监听者）", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "log", level: "info", text: "值=${n}" } as ExecBlock),
          blk({ kind: "log", level: "crit", text: "炸了" } as ExecBlock),
          blk({ kind: "emitFlow", name: "done", data: [{ k: "code", src: "n * 2" }] } as ExecBlock),
        ],
      }),
    ], [{ name: "n", type: "number", def: 7, persist: false }]));
    eng.runManual("g1");
    await settle(0);
    expect(logs().some((l) => l.detail.includes("[info] 值=7"))).toBe(true);
    expect(h.toasts.some((t) => t.level === "crit" && t.text === "炸了")).toBe(true);
    expect(logs().some((l) => l.detail.includes("done"))).toBe(true);
  });

  it("emitFlow：空名 fail；data 表达式失败 fail；≤4 对截断在 normalize 侧", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "emitFlow", name: "", data: [] as { k: string; src: string }[] } as ExecBlock, "continue"),
          blk({ kind: "emitFlow", name: "bad", data: [{ k: "x", src: "missing + 1" }] } as ExecBlock, "continue"),
        ],
      }),
    ]));
    eng.runManual("g1");
    await settle(0);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("未写事件名"))).toBe(true);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("x"))).toBe(true);
  });

  it("snapshot / exportCsv / clip / stopSuite：钩子接线成功；未接线按 onFail", async () => {
    const snapped: string[] = [];
    let csv: { ch: string; n: number } | null = null;
    let clipped: string | null = null;
    let stopped = 0;
    h.deps.snapshotPanel = async (panel) => {
      if (panel === "spectrum") return false; // 模拟面板未开
      snapped.push(panel);
      return true;
    };
    h.deps.exportCsv = async (chId, lastN) => {
      if (!chId) return false;
      csv = { ch: chId, n: lastN };
      return true;
    };
    h.deps.clipWrite = async (text) => {
      clipped = text;
      return true;
    };
    h.deps.stopSuite = () => {
      stopped++;
    };
    eng.setDoc(mkDoc([
      mkGroup({
        children: [
          blk({ kind: "snapshot", panel: "plot2d", note: "检查点" } as ExecBlock),
          blk({ kind: "snapshot", panel: "spectrum", note: "" } as ExecBlock, "continue"),
          blk({ kind: "exportCsv", chanId: "temp", lastN: 500 } as ExecBlock),
          blk({ kind: "clip", text: "v=${n}" } as ExecBlock),
          blk({ kind: "stopSuite" } as ExecBlock),
        ],
      }),
    ], [{ name: "n", type: "number", def: 3, persist: false }]));
    eng.runManual("g1");
    await settle(0);
    expect(snapped).toEqual(["plot2d"]);
    expect(csv).toEqual({ ch: "temp", n: 500 });
    expect(clipped).toBe("v=3");
    expect(stopped).toBe(1);
    // 未接线 → fail
    delete h.deps.snapshotPanel;
    delete h.deps.exportCsv;
    delete h.deps.clipWrite;
    eng.setDoc(mkDoc([mkGroup({ children: [blk({ kind: "snapshot", panel: "plot2d", note: "" } as ExecBlock, "continue")] })]));
    eng.runManual("g1");
    await settle(0);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("未接线"))).toBe(true);
  });

  it("resetVars：all 复位全部变量（含持久）；one 复位单个；不存在 fail；不触发 varChanged 链", async () => {
    const varChangedHits: string[] = [];
    eng.setDoc(mkDoc([
      mkGroup({
        events: [],
        children: [
          blk({ kind: "setVar", name: "a", from: { k: "const", value: 99 } } as ExecBlock),
          blk({ kind: "setVar", name: "b", from: { k: "const", value: "x" } } as ExecBlock),
          blk({ kind: "resetVars", scope: "one", name: "a" } as ExecBlock),
          blk({ kind: "resetVars", scope: "one", name: "zz" } as ExecBlock, "continue"),
          blk({ kind: "resetVars", scope: "all", name: "" } as ExecBlock),
        ],
      }),
    ], [
      { name: "a", type: "number", def: 0, persist: false },
      { name: "b", type: "string", def: "", persist: true },
    ]));
    // 监听 varChanged：挂一个 varChanged 事件组应零触发（silent 复位）
    eng.setDoc(mkDoc([
      mkGroup({
        events: [{ id: "ev1", kind: "varChanged", varName: "a" }],
        children: [send("HIT")],
      }),
      mkGroup({
        id: "g2",
        name: "G2",
        children: [
          blk({ kind: "setVar", name: "a", from: { k: "const", value: 42 } } as ExecBlock),
          blk({ kind: "resetVars", scope: "all", name: "" } as ExecBlock),
        ],
      }),
    ], [
      { name: "a", type: "number", def: 0, persist: false },
    ]));
    eng.runManual("g2");
    await settle(0);
    // setVar 42 会触发一次 varChanged → g1 命中发 HIT；resetVars 复位不再触发
    expect(h.sent.map((s) => s.text)).toEqual(["HIT"]);
    expect(eng.getVar("a")).toBe(0);
    void varChangedHits;
  });
});

/* ================= B4d：新事件块匹配语义 ================= */

describe("OrchEngine B4d 新事件块", () => {
  let h: ReturnType<typeof mkDeps>;
  let eng: OrchEngine;
  const settle = (ms = 5) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    h = mkDeps();
    eng = new OrchEngine(h.deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const badRow = (tplId = "t1"): FrameRowLite => ({
    tplId,
    tplName: `tpl-${tplId}`,
    valid: false,
    len: 8,
    fields: [],
  });

  it("frameError：valid=false 命中、valid=true 不命中；stride 取样", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        events: [{ id: "ev1", kind: "frameError", stride: 1 }],
        children: [send("BAD")],
      }),
    ]));
    eng.emit({ kind: "frame", row: badRow() });
    await settle(0);
    expect(h.sent.map((s) => s.text)).toEqual(["BAD"]); // 坏帧命中
    eng.emit({ kind: "frame", row: { ...badRow(), valid: true } });
    await settle(0);
    expect(h.sent).toHaveLength(1); // 好帧不喂坏帧块
    // evt.len 注入
    const hit = eng.getLogs().find((l) => l.detail.includes("坏帧"));
    expect(hit?.detail).toContain("len=8");
  });

  it("frameError stride=3：三个坏帧取样一次", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        events: [{ id: "ev1", kind: "frameError", stride: 3 }],
        children: [send("HIT")],
      }),
    ]));
    for (let i = 0; i < 5; i++) eng.emit({ kind: "frame", row: badRow() });
    await settle(10);
    expect(h.sent).toHaveLength(1); // 第 3 个坏帧才命中，第 5 个未到步长
  });

  it("newTpl：tplId 过滤；空 tplId = 任意新帧型；ctx 注入 tplId/tplName/len", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        id: "g1",
        name: "G1",
        events: [{ id: "ev1", kind: "newTpl", tplId: "t9" }],
        children: [send("T9")],
      }),
      mkGroup({
        id: "g2",
        name: "G2",
        events: [{ id: "ev2", kind: "newTpl", tplId: "" }],
        children: [send("ANY")],
      }),
    ]));
    eng.emit({ kind: "newTpl", tplId: "t1", tplName: "tpl-t1", len: 12 });
    await settle(0);
    expect(h.sent.map((x) => x.text)).toEqual(["ANY"]); // g1 过滤掉，g2 任意命中
    eng.emit({ kind: "newTpl", tplId: "t9", tplName: "tpl-t9", len: 5 });
    await settle(0);
    expect(h.sent.map((x) => x.text)).toEqual(["ANY", "T9", "ANY"]); // 两组都命中
    const log = eng.getLogs().find((l) => l.detail.includes("tpl-t9"));
    expect(log?.detail).toContain("新帧型");
  });

  it("flowEvt：emitFlow 跨组触发同名监听；data 注入 evt；名字不符不触发", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        id: "gA",
        name: "GA",
        events: [],
        children: [
          { id: nid(), kind: "emitFlow", enabled: true, onFail: "abort", name: "done", data: [{ k: "code", src: "n * 2" }] } as ExecBlock,
          { id: nid(), kind: "emitFlow", enabled: true, onFail: "abort", name: "other", data: [] } as ExecBlock,
        ],
      }),
      mkGroup({
        id: "gB",
        name: "GB",
        events: [{ id: "evB", kind: "flowEvt", name: "done" }],
        children: [
          { id: nid(), kind: "setVar", enabled: true, onFail: "abort", name: "x", from: { k: "evtField", field: "code" } } as ExecBlock,
          send("GOT"),
        ],
      }),
    ], [
      { name: "n", type: "number", def: 21, persist: false },
      { name: "x", type: "number", def: 0, persist: false },
    ]));
    eng.runManual("gA");
    await settle(0);
    // done 命中一次（other 不命中）；data.code=42 注入 evt 上下文
    expect(h.sent.map((x) => x.text)).toEqual(["GOT"]);
    expect(eng.getVar("x")).toBe(42);
    const log = eng.getLogs().find((l) => l.detail.includes("自定义事件"));
    expect(log?.detail).toContain("done");
  });

  it("chanChanged / idle：自归属事件别组不抢；本组命中且 ctx 注入", async () => {
    eng.setDoc(mkDoc([
      mkGroup({
        id: "g1",
        name: "G1",
        events: [
          { id: "c1", kind: "chanChanged", chId: "temp", tol: 0, minIntervalMs: 50 },
          { id: "i1", kind: "idle", idleMs: 1000 },
        ],
        children: [send("SELF")],
      }),
      mkGroup({
        id: "g2",
        name: "G2",
        events: [{ id: "c2", kind: "chanChanged", chId: "temp", tol: 0, minIntervalMs: 50 }],
        children: [send("OTHER")],
      }),
    ]));
    // chanChanged 只归属 blockId=c1 → g2 的 c2 不抢
    eng.emit({ kind: "chanChanged", groupId: "g1", blockId: "c1", chId: "temp", old: 25, new: 30 });
    await settle(0);
    expect(h.sent.map((x) => x.text)).toEqual(["SELF"]);
    const log = eng.getLogs().find((l) => l.detail.includes("25 → 30"));
    expect(log).toBeTruthy();
    // idle 只归属 i1
    h.sent.length = 0;
    eng.emit({ kind: "idle", groupId: "g1", blockId: "i1", idleMs: 1000, lastTs: Date.now() - 1000 });
    await settle(0);
    expect(h.sent.map((x) => x.text)).toEqual(["SELF"]);
  });
});

/* ================= B4e：send 多帧透传 ================= */

describe("OrchEngine send 多帧（B4e）", () => {
  let h: ReturnType<typeof mkDeps>;
  let eng: OrchEngine;
  const settle = (ms = 5) => vi.advanceTimersByTimeAsync(ms);
  const logs = (): LogEntry[] => eng.getLogs();

  beforeEach(() => {
    vi.useFakeTimers();
    h = mkDeps();
    eng = new OrchEngine(h.deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("factory 多帧：按序逐帧发送（每帧过令牌桶），日志 HEX×N 共 N 字节", async () => {
    h.deps.resolveSend = () => ({ mode: "hex", frames: ["AA 55", "BB", "CC DD"] });
    eng.setDoc(mkDoc([mkGroup({ children: [send("XX")] })]));
    eng.runManual("g1");
    await settle(0);
    expect(h.sent.map((s) => s.mode)).toEqual(["hex", "hex", "hex"]);
    expect(h.sent.map((s) => s.text)).toEqual(["AA 55", "BB", "CC DD"]);
    expect(logs().some((l) => l.detail === "HEX×3 共 5 字节")).toBe(true);
  });

  it("多帧中途令牌桶耗尽 → 带 已发/总数 的 fail", async () => {
    h.deps.resolveSend = () => ({ mode: "hex", frames: ["01", "02", "03"] });
    // 预耗令牌桶到只剩 2
    eng.setDoc(mkDoc([mkGroup({ children: [send("WARM"), send("WARM")] })]));
    eng.runManual("g1");
    await settle(0);
    h.sent.length = 0;
    eng.getLogs().length = 0;
    // @ts-expect-error 突破私有：直接压低令牌计数（测试专用）
    eng.sendN = ORCH_LIMITS.sendBucketRate - 2;
    eng.setDoc(mkDoc([mkGroup({ children: [send("M"), send("SKIP")] })]));
    eng.runManual("g1");
    await settle(0);
    // 第一个 send 块（3 帧）只发出 1 帧就超限中止（WARM 已被上方清空，只剩 M 的帧）
    expect(h.sent.map((s) => s.text)).toEqual(["01"]);
    expect(logs().some((l) => l.phase === "fail" && l.detail.includes("1/3"))).toBe(true);
  });

  it("表达式 now = 引擎时钟（P78b：继电整定测周期的基础）", async () => {
    eng.setDoc(
      mkDoc(
        [
          mkGroup({
            events: [{ id: "e1", kind: "manual" }],
            children: [
              { id: nid(), kind: "setVar", enabled: true, onFail: "continue", name: "Tu", from: { k: "expr", src: "now - tUp" } },
              { id: nid(), kind: "setVar", enabled: true, onFail: "continue", name: "tUp", from: { k: "expr", src: "now" } },
            ],
          }),
        ],
        [
          { name: "tUp", type: "number", def: 0, persist: false },
          { name: "Tu", type: "number", def: 0, persist: false },
        ],
      ),
    );
    const before = Date.now();
    eng.setVar("tUp", before - 250);
    eng.runManual("g1");
    await settle(0);
    const tu = eng.getVar("Tu") as number;
    // now 求值发生在 runManual 内：Tu = 求值时刻 - (before-250)，夹在 [250, 经过多久+250]
    expect(tu).toBeGreaterThanOrEqual(250);
    expect(tu).toBeLessThanOrEqual(Date.now() - before + 250);
    expect(eng.getVar("tUp")).toBeGreaterThanOrEqual(before);
  });
});
