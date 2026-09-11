import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 执行引擎测试（T1）。全部依赖注入打桩：这里验的是引擎语义
 * （顺序/超时/匹配/断言/分组/失败策略/中止/单步/互斥），不是传输本身。
 */
import type { FrameRow } from "../../ipc/types";
import * as runner from "./runner";
import { LIMITS, type CmpOp, type Step, type Suite } from "./types";

const h = vi.hoisted(() => ({
  frames: [] as ((rows: FrameRow[]) => void)[],
  sent: [] as { mode: string; text: string }[],
  vars: new Map<string, number | string>(),
}));

let seq = 0;
const frame = (over: Partial<FrameRow> = {}): FrameRow => ({
  tplId: "tpl_a",
  tplName: "模板A",
  color: "#fff",
  tsMs: 0,
  seq: seq++,
  len: 8,
  valid: true,
  error: null,
  fields: [],
  bytes: new Uint8Array([0x01, 0x02, 0x03]),
  ...over,
});

const deps = (): runner.SequencerDeps => ({
  send: (mode, text) => {
    h.sent.push({ mode, text });
  },
  resolveSend: (p) =>
    p.type === "hex"
      ? { mode: "hex", text: p.text }
      : p.type === "cmd"
        ? p.cmdId === "cmd_ok"
          ? { mode: "ascii", text: "PING" }
          : null
        : null,
  onFrames: (cb) => {
    h.frames.push(cb);
    return () => {
      const i = h.frames.indexOf(cb);
      if (i >= 0) h.frames.splice(i, 1);
    };
  },
  getVar: (name) => h.vars.get(name),
  now: () => Date.now(),
});

const pushFrame = (row: FrameRow) => h.frames.forEach((f) => f([row]));

const suiteOf = (steps: Step[], over: Partial<Suite> = {}): Suite => ({
  id: "sq_t",
  name: "测试序列",
  steps,
  trigger: { mode: "manual" },
  failFast: true,
  ...over,
});

/** 收口 helper：startRun 判别 + 拿 RunResult（StartResult 联合类型不能直接 .then） */
async function runOf(steps: Step[], over?: Partial<Suite>, opts?: runner.RunOptions) {
  const s = runner.startRun(suiteOf(steps, over), deps(), opts);
  if (!s.ok) throw new Error(s.error);
  return s.handle.done;
}

const send = (text: string): Step => ({ id: text, kind: "send", enabled: true, payload: { type: "hex", text } });
const wait = (ms: number): Step => ({ id: `w${ms}`, kind: "wait", enabled: true, ms });
const waitFrame = (match: Extract<Step, { kind: "waitForFrame" }>["match"], timeoutMs = 1000): Step => ({
  id: "wf",
  kind: "waitForFrame",
  enabled: true,
  match,
  timeoutMs,
});

beforeEach(() => {
  vi.useFakeTimers();
  h.frames.length = 0;
  h.sent.length = 0;
  h.vars.clear();
  seq = 0;
});

afterEach(() => {
  runner.stopRun();
  vi.useRealTimers();
});

describe("基础步骤", () => {
  it("send 按载荷发送并记录结果", async () => {
    const r = await runOf([send("aa bb")]);
    expect(h.sent).toEqual([{ mode: "hex", text: "aa bb" }]);
    expect(r.status).toBe("done");
    expect(r.steps[0].status).toBe("pass");
  });

  it("wait 走真实时间推进且不提前完成", async () => {
    const p = runOf([wait(500), send("01")]);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    const r = await p;
    expect(h.sent).toHaveLength(1);
    expect(r.steps[0].detail).toContain("500ms");
  });

  it("resolveSend 失败 → 该步 fail", async () => {
    const step: Step = { id: "s", kind: "send", enabled: true, payload: { type: "cmd", cmdId: "nope" } };
    const r = await runOf([step]);
    expect(r.steps[0].status).toBe("fail");
    expect(r.status).toBe("failed");
  });
});

describe("waitForFrame", () => {
  it("byRaw：步骤开始后到达的帧才算，旧帧不算", async () => {
    pushFrame(frame({ bytes: new Uint8Array([0xde, 0xad]) })); // 旧帧
    const p = runOf([waitFrame({ by: "raw", hex: "de ad" }, 2000)]);
    await vi.advanceTimersByTimeAsync(1);
    pushFrame(frame({ bytes: new Uint8Array([0xaa, 0xde, 0xad, 0xbb]) }));
    const r = await p;
    expect(r.steps[0].status).toBe("pass");
  });

  it("byRaw：超时返回 timeout", async () => {
    const p = runOf([waitFrame({ by: "raw", hex: "ff" }, 300)]);
    await vi.advanceTimersByTimeAsync(400);
    const r = await p;
    expect(r.steps[0].status).toBe("timeout");
    expect(r.status).toBe("failed");
  });

  it("byTpl：要求 valid 且 tplId 相等", async () => {
    const p = runOf([waitFrame({ by: "tpl", tplId: "tpl_a" })]);
    await vi.advanceTimersByTimeAsync(1);
    pushFrame(frame({ valid: false })); // 无效帧不算
    pushFrame(frame({ tplId: "tpl_b" })); // 别的模板不算
    pushFrame(frame());
    const r = await p;
    expect(r.steps[0].status).toBe("pass");
  });

  it("byField：模板+字段条件", async () => {
    const p = runOf([
      waitFrame({ by: "field", tplId: "tpl_a", fieldName: "温度", op: "gt", expected: 30 }),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    pushFrame(frame({ fields: [{ id: "f1", name: "温度", raw: 25, value: 25, text: null }] }));
    pushFrame(frame({ fields: [{ id: "f1", name: "温度", raw: 31, value: 31, text: null }] }));
    const r = await p;
    expect(r.steps[0].status).toBe("pass");
  });

  it("帧缓冲超过上限丢弃最旧，不阻塞匹配", async () => {
    const p = runOf([waitFrame({ by: "raw", hex: "ee" })]);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < LIMITS.frameBufCap + 50; i++) pushFrame(frame({ bytes: new Uint8Array([0x11]) }));
    pushFrame(frame({ bytes: new Uint8Array([0xee]) }));
    const r = await p;
    expect(r.steps[0].status).toBe("pass");
  });
});

describe("assertVar", () => {
  const mk = (op: CmpOp, expected?: number, tolerance?: number): Step => ({
    id: `a${op}`,
    kind: "assertVar",
    enabled: true,
    varName: "v",
    op,
    expected,
    tolerance,
  });

  it("数值比较各 op 与 approx", async () => {
    h.vars.set("v", 42);
    // failFast=false：各 op 独立验证，不等一个 fail 短路后面
    const r = await runOf([mk("gt", 40), mk("lt", 10), mk("approx", 40, 3), mk("eq", 42)], {
      failFast: false,
    });
    expect(r.steps.map((s) => s.status)).toEqual(["pass", "fail", "pass", "pass"]);
  });

  it("变量不存在 fail；expected 引用变量", async () => {
    h.vars.set("base", 10);
    const steps: Step[] = [
      { id: "a1", kind: "assertVar", enabled: true, varName: "ghost", op: "eq", expected: 1 },
      { id: "a2", kind: "assertVar", enabled: true, varName: "base", op: "eq", expected: { var: "ghost" } },
      { id: "a3", kind: "assertVar", enabled: true, varName: "base", op: "ge", expected: { var: "base" } },
    ];
    const r = await runOf(steps, { failFast: false });
    expect(r.steps[0].detail).toContain("不存在");
    expect(r.steps[1].status).toBe("fail");
    expect(r.steps[2].status).toBe("pass");
  });

  it("changed：与上次断言值比较，首次无基准 fail", async () => {
    const changed: Step = { id: "c", kind: "assertVar", enabled: true, varName: "v", op: "changed" };
    h.vars.set("v", 1);
    // c1 与 c2 之间隔一个 wait：c1 同步执行完记录基准，改值后 c2 才读
    const p = runOf([changed, wait(10), changed], { failFast: false });
    await Promise.resolve(); // 让 c1 执行完、wait 挂起
    h.vars.set("v", 2);
    await vi.advanceTimersByTimeAsync(20);
    const r = await p;
    expect(r.steps[0].status).toBe("fail"); // 首次无基准
    expect(r.steps[2].status).toBe("pass"); // 2 ≠ 基准 1
  });
});

describe("group 与失败策略", () => {
  const failing = (): Step => ({ id: "af", kind: "assertVar", enabled: true, varName: "nope", op: "eq", expected: 1 });

  it("group repeats 循环，全部通过 → pass", async () => {
    const g: Step = {
      id: "g",
      kind: "group",
      enabled: true,
      name: "轮询三遍",
      repeats: 3,
      onFailure: "abort",
      children: [send("01"), wait(10)],
    };
    const p = runOf([g]);
    await vi.advanceTimersByTimeAsync(100); // children 有 wait(10)，fake timers 必须推进
    const r = await p;
    expect(h.sent).toHaveLength(3);
    expect(r.steps[0].status).toBe("pass");
    expect(r.steps[0].attempts).toBe(3);
    expect(r.steps[0].children).toHaveLength(6);
  });

  it("onFailure=abort：失败轮短路，剩余轮次不执行", async () => {
    const g: Step = {
      id: "g",
      kind: "group",
      enabled: true,
      name: "g",
      repeats: 5,
      onFailure: "abort",
      children: [failing()],
    };
    const r = await runOf([g]);
    expect(r.steps[0].attempts).toBe(1);
    expect(r.steps[0].status).toBe("fail");
  });

  it("onFailure=continue：失败后继续跑满轮数", async () => {
    h.vars.set("v", 1);
    const g: Step = {
      id: "g",
      kind: "group",
      enabled: true,
      name: "g",
      repeats: 3,
      onFailure: "continue",
      children: [{ id: "af", kind: "assertVar", enabled: true, varName: "v", op: "lt", expected: 0 }],
    };
    const r = await runOf([g]);
    expect(r.steps[0].attempts).toBe(3);
    expect(r.steps[0].status).toBe("fail");
  });

  it("Suite.failFast=false：顶层记录失败继续跑完", async () => {
    const r = await runOf([failing(), send("02")], { failFast: false });
    expect(h.sent).toHaveLength(1);
    expect(r.steps.map((s) => s.status)).toEqual(["fail", "pass"]);
    expect(r.status).toBe("failed");
  });

  it("failFast=true：首个失败短路，剩余标 skipped", async () => {
    const r = await runOf([failing(), send("02")]);
    expect(h.sent).toHaveLength(0);
    expect(r.steps[1].status).toBe("skipped");
  });

  it("enabled=false 的步骤 skipped 且不执行", async () => {
    const r = await runOf([{ ...send("03"), enabled: false }, send("04")]);
    expect(h.sent.map((s) => s.text)).toEqual(["04"]);
    expect(r.steps[0].status).toBe("skipped");
  });
});

describe("运行控制", () => {
  /** 冲掉一串微任务：send/单步闸门的恢复链不止一层微任务 */
  const flushMicro = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("停止打断 waitForFrame 等待 → aborted", async () => {
    const start = runner.startRun(suiteOf([waitFrame({ by: "raw", hex: "ff" }, 0)]), deps());
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const p = start.handle.done;
    await vi.advanceTimersByTimeAsync(1);
    start.handle.stop();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(r.steps[0].status).toBe("aborted");
  });

  it("单步模式：每步挂起等 resume", async () => {
    const start = runner.startRun(suiteOf([send("0a"), send("0b")]), deps(), { stepMode: true });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const p = start.handle.done;
    await flushMicro();
    expect(h.sent).toEqual([{ mode: "hex", text: "0a" }]); // 第一步已发、第二步未发
    start.handle.resume();
    await flushMicro();
    expect(h.sent.map((s) => s.text)).toEqual(["0a", "0b"]);
    start.handle.resume(); // 最后一步后放行收尾
    const r = await p;
    expect(r.status).toBe("done");
  });

  it("互斥：运行中再启动被拒", async () => {
    const start = runner.startRun(suiteOf([wait(100)]), deps());
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const second = runner.startRun(suiteOf([wait(10)]), deps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("已有序列");
    start.handle.stop();
    await start.handle.done;
  });

  it("stopRun 全局停止入口可用", async () => {
    const start = runner.startRun(suiteOf([wait(60_000)]), deps());
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const p = start.handle.done;
    await vi.advanceTimersByTimeAsync(1);
    runner.stopRun();
    const r = await p;
    expect(r.status).toBe("aborted");
  });

  it("运行结束清空互斥，可再次运行", async () => {
    await runOf([send("01")]);
    const second = runner.startRun(suiteOf([send("02")]), deps());
    expect(second.ok).toBe(true);
    if (second.ok) await second.handle.done;
    expect(h.sent.map((s) => s.text)).toEqual(["01", "02"]);
  });
});
