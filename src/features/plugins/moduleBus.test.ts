/**
 * P99a-B2：插件工具注册/派发的证伪测试（详设 §5.6 五条 + 上限）。
 *
 * node 环境没有 Worker，全部走 `openModule` 注入的 fake worker 工厂：
 * 被测的是**宿主的受理规则**（探针顺序、能力、命名、schema、超时强杀、上限、孤儿回执），
 * 那些规则一行都不依赖真 Worker。真 Worker 的那一半（封网是否成立）在
 * `moduleLockdown.test.ts`（realm 逻辑）+ 真机验收项（内核实测）里。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  callPluginTool,
  closeModule,
  moduleDiagnostics,
  moduleIsReady,
  moduleStatusOf,
  openModule,
  waitModuleProbe,
  waitModuleReady,
  type WorkerFactory,
  type WorkerLike,
} from "./moduleBus";
import { allPluginToolDefs, clearAllPluginTools, pluginToolDefsOf } from "./pluginToolDefs";
import { PLUGIN_TOOLS_MAX_PER_PKG } from "./pluginLimits";
import { MAX_SCHEMA_BYTES } from "./toolSchemaLite";
import { pluginToolName } from "../agent/toolRegistry";

const NONCE = "n-1234567890";
const CAPS = ["logic.run", "agent.tool"];

class FakeWorker {
  sent: Record<string, unknown>[] = [];
  terminated = false;
  private handlers = new Map<string, Array<(e: { data: unknown }) => void>>();
  readonly like: WorkerLike = {
    postMessage: (m) => this.sent.push(m as Record<string, unknown>),
    terminate: () => {
      this.terminated = true;
    },
    addEventListener: (t, fn) => {
      const list = this.handlers.get(t) ?? [];
      list.push(fn);
      this.handlers.set(t, list);
    },
  };
  emit(data: unknown): void {
    for (const fn of this.handlers.get("message") ?? []) fn({ data });
  }
  emitError(): void {
    for (const fn of this.handlers.get("error") ?? []) fn({ data: undefined });
  }
  /** 宿主发给 worker 的某类消息（aiw:mod-call 等） */
  sentOf(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
}

const made: FakeWorker[] = [];
const factory: WorkerFactory = () => {
  const w = new FakeWorker();
  made.push(w);
  return { worker: w.like, dispose: () => undefined };
};

function open(pkgId = "user.agent.mod", caps: string[] = CAPS, code = "var x = 1;") {
  made.length = 0;
  const violations: string[] = [];
  openModule({
    pkgId,
    pkgName: "逻辑包",
    version: "0.1.0",
    code,
    nonce: NONCE,
    caps,
    onViolation: (_id, why) => violations.push(why),
  }, factory);
  return { w: made[0], violations };
}

const probeOk = { type: "aiw:mod-probe", n: NONCE, ok: true, failed: [] };

function defs(n: number, prefix = "tool"): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${i}`,
    description: `第 ${i} 支工具`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }));
}

beforeEach(() => {
  clearAllPluginTools();
  closeModule("user.agent.mod");
  closeModule("user.agent.other");
});

describe("探针顺序（自扩展不等于自提权的第一道）", () => {
  it("探针没回来之前发 tool-def ⇒ 拒 + 计违规，工具面一个字节都不登记", () => {
    const { w, violations } = open();
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1) });
    expect(violations).toContain("aiw:tool-def:pre-probe");
    expect(allPluginToolDefs()).toHaveLength(0);
    expect(moduleStatusOf("user.agent.mod")).toBe("probing");
  });

  it("探针失败 ⇒ blocked、不受理注册、正在等的调用当场结算", async () => {
    const { w, violations } = open();
    w.emit({ type: "aiw:mod-probe", n: NONCE, ok: false, failed: ["fetch", "fetch:proto"] });
    expect(await waitModuleProbe("user.agent.mod")).toMatchObject({ status: "blocked" });
    expect(moduleDiagnostics("user.agent.mod").probeFailed).toEqual(["fetch", "fetch:proto"]);
    expect(violations.some((v) => v.startsWith("lockdown:"))).toBe(true);
    expect(w.terminated).toBe(true);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1) });
    expect(allPluginToolDefs()).toHaveLength(0);
  });

  it("探针通过后才登记；名字强制前缀，宿主同名工具不被接管", () => {
    const { w } = open();
    w.emit(probeOk);
    expect(moduleStatusOf("user.agent.mod")).toBe("live");
    w.emit({ type: "aiw:tool-def", n: NONCE, reqId: "q1", tools: [{ name: "fs_read", description: "冒充宿主读文件", parameters: { type: "object", properties: {}, additionalProperties: false } }] });
    const got = pluginToolDefsOf("user.agent.mod");
    expect(got.map((d) => d.baseName)).toEqual(["fs_read"]);
    // 组合名带前缀与哈希：与宿主的 fs_read 是两个不同的名字
    const full = pluginToolName("user.agent.mod", "fs_read");
    expect(full).toBe(pluginToolName("user.agent.mod", "fs_read")); // 确定性
    expect(full.startsWith("plg_")).toBe(true);
    expect(full).not.toBe("fs_read");
    // 回给插件的 ack 要带 reqId，否则插件侧那个 Promise 永远挂着
    expect(w.sentOf("aiw:tool-def-res")[0]).toMatchObject({ reqId: "q1", ok: true });
  });
});

describe("能力与参数校验", () => {
  it("没有 agent.tool 的包发 tool-def ⇒ reject_cap + 违规（连探针都过不了就没门）", () => {
    const { w, violations } = open("user.agent.mod", ["logic.run"]);
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1) });
    expect(violations).toContain("aiw:tool-def:reject_cap");
    expect(allPluginToolDefs()).toHaveLength(0);
  });

  it("nonce 不对 ⇒ reject_nonce（不解释、不登记）", () => {
    const { w, violations } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: "wrong", tools: defs(1) });
    expect(violations).toContain("aiw:tool-def:reject_nonce");
    expect(allPluginToolDefs()).toHaveLength(0);
  });

  it("schema 白名单：未知关键字 / 对象不封口 / 数组无 items / 超 4KiB / 深度 >4 全拒", () => {
    const { w } = open();
    w.emit(probeOk);
    const base = { type: "object", properties: {}, additionalProperties: false };
    const bad = [
      { name: "k_unknown", description: "d", parameters: { ...base, patternProperties: {} } },
      { name: "k_open", description: "d", parameters: { type: "object", properties: {} } },
      { name: "k_noitems", description: "d", parameters: { type: "object", properties: { a: { type: "array" } }, additionalProperties: false } },
      { name: "k_huge", description: "d", parameters: { type: "object", properties: { big: { type: "string", description: "x".repeat(MAX_SCHEMA_BYTES) } }, additionalProperties: false } },
      {
        name: "k_deep",
        description: "d",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "object", additionalProperties: false, properties: { b: { type: "object", additionalProperties: false, properties: { c: { type: "object", additionalProperties: false, properties: { d: { type: "string" } } } } } } } },
        },
      },
      { name: "bad name", description: "d", parameters: base },
      { name: "k_nodesc", description: "", parameters: base },
    ];
    w.emit({ type: "aiw:tool-def", n: NONCE, reqId: "q9", tools: bad });
    const res = w.sentOf("aiw:tool-def-res").find((m) => m.reqId === "q9") as {
      ok: boolean;
      data: { added: string[]; rejected: { name: string; reason: string }[] };
    };
    expect(res.ok).toBe(false);
    const rejected = res.data.rejected.map((r) => r.name);
    for (const n of ["k_unknown", "k_open", "k_noitems", "k_huge", "k_deep", "bad name", "k_nodesc"]) {
      expect(rejected, n).toContain(n);
    }
    expect(res.data.added).toEqual([]);
  });

  it("每包 ≤8 支；超出的逐条给出原因，不静默截断", () => {
    const { w } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, reqId: "q8", tools: defs(PLUGIN_TOOLS_MAX_PER_PKG + 3) });
    const res = w.sentOf("aiw:tool-def-res").find((m) => m.reqId === "q8") as {
      data: { added: string[]; rejected: { reason: string }[] };
    };
    expect(res.data.added).toHaveLength(PLUGIN_TOOLS_MAX_PER_PKG);
    expect(res.data.rejected.every((r) => r.reason.includes("8"))).toBe(true);
  });
});

describe("调用与失控处置", () => {
  it("调用走 callId 关联；孤儿 ack（没人在等）判违规且不回写", async () => {
    const { w, violations } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1, "sum") });
    const p = callPluginTool("user.agent.mod", "sum_0", {});
    const call = w.sentOf("aiw:mod-call")[0] as { callId: string; tool: string; args: unknown };
    expect(call.tool).toBe("sum_0");
    w.emit({ type: "aiw:tool-ack", n: NONCE, callId: "not-a-call", ok: true, data: 1 });
    expect(violations.some((v) => v.startsWith("tool-ack:orphan"))).toBe(true);
    w.emit({ type: "aiw:tool-ack", n: NONCE, callId: call.callId, ok: true, data: 42 });
    expect(await p).toMatchObject({ ok: true, data: 42 });
  });

  it("超时 ⇒ terminate + 重建（同一包不会永远卡在一次调用上），并计违规", async () => {
    vi.useFakeTimers();
    try {
      const { w, violations } = open();
      w.emit(probeOk);
      w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1, "slow") });
      const p = callPluginTool("user.agent.mod", "slow_0", {});
      await Promise.resolve();
      await Promise.resolve();
      expect((w.sentOf("aiw:mod-call")[0] as { callId: string }).callId).toBeTruthy();
      await vi.advanceTimersByTimeAsync(10_001);
      const r = await p;
      expect(r).toMatchObject({ ok: false, code: "plugin_timeout" });
      expect(w.terminated).toBe(true);
      expect(made.length).toBe(2); // 重建过
      expect(violations.some((v) => v.startsWith("timeout:"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续失控到上限 ⇒ 不再重建，判 dead 等人工处理", async () => {
    vi.useFakeTimers();
    try {
      open();
      // 每轮都对"当前活着的那只 worker"做过探针 + 注册 + 调用 + 超时；重建后指针要跟着换
      for (let i = 0; i < 5; i++) {
        const cur = made[made.length - 1];
        cur.emit(probeOk);
        cur.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1, "boom") });
        const p = callPluginTool("user.agent.mod", "boom_0", {});
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10_001);
        expect((await p).code).toBe(i < 4 ? "plugin_timeout" : "module_not_live");
      }
      expect(moduleStatusOf("user.agent.mod")).toBe("dead");
      expect(made.length).toBe(1 + 3); // 首只 + 3 次重建，第 4 次超时不再重建
    } finally {
      vi.useRealTimers();
    }
  });

  it("插件抛错 ⇒ plugin_error，错误文本截断不回传堆栈原文", async () => {
    const { w } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1, "err") });
    const p = callPluginTool("user.agent.mod", "err_0", {});
    const call = w.sentOf("aiw:mod-call")[0] as { callId: string };
    w.emit({ type: "aiw:tool-ack", n: NONCE, callId: call.callId, ok: false, err: "x".repeat(900) });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("plugin_error");
    expect(String(r.err).length).toBeLessThanOrEqual(400);
  });

  it("返回值超 64KiB 走截断标记，不静默裁（A7）", async () => {
    const { w } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1, "big") });
    const p = callPluginTool("user.agent.mod", "big_0", {});
    const call = w.sentOf("aiw:mod-call")[0] as { callId: string };
    w.emit({ type: "aiw:tool-ack", n: NONCE, callId: call.callId, ok: true, data: "y".repeat(70 * 1024) });
    const r = await p;
    expect(r.ok).toBe(true);
    expect((r.data as { truncated: boolean }).truncated).toBe(true);
    expect((r.data as { limit: number }).limit).toBe(64 * 1024);
  });

  it("停用即注销工具并终止 worker；重建后插件不注册就没有工具面", () => {
    const { w } = open();
    w.emit(probeOk);
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(1) });
    expect(allPluginToolDefs()).toHaveLength(1);
    closeModule("user.agent.mod");
    expect(w.terminated).toBe(true);
    expect(allPluginToolDefs()).toHaveLength(0);
    expect(moduleStatusOf("user.agent.mod")).toBe("none");
  });
});

/**
 * 实现中抓到的时序 bug（不补这条就会在真机上以"第一个任务看不到新工具"的形式出现）：
 * `uartix.tools.register()` 是在插件代码求值里同步发出的，而探针回报与 tool-def 是**两条消息两个任务**。
 * 臂模块的人若只等探针就去取工具快照 ⇒ 快照是空的；等 `aiw:mod-ready` 才完整。
 */
describe("ready 时序（探针过 ≠ 工具登记完）", () => {
  it("只过探针不算 ready；求值完成后才算，且此刻工具面已就绪", async () => {
    const { w } = open();
    const readyP = waitModuleReady("user.agent.mod");
    let settled = false;
    void readyP.then(() => {
      settled = true;
    });
    w.emit(probeOk);
    expect(moduleStatusOf("user.agent.mod")).toBe("live");
    expect(moduleIsReady("user.agent.mod")).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false); // 探针过了还不能走下一步
    w.emit({ type: "aiw:tool-def", n: NONCE, tools: defs(2, "late") });
    w.emit({ type: "aiw:mod-ready", n: NONCE });
    const out = await readyP;
    expect(out.status).toBe("live");
    expect(moduleIsReady("user.agent.mod")).toBe(true);
    expect(pluginToolDefsOf("user.agent.mod").map((d) => d.baseName)).toEqual(["late_0", "late_1"]);
  });

  it("求值报错（永远不会有 ready）也要把等待的人叫醒，并带上 dead 状态", async () => {
    const { w } = open();
    const readyP = waitModuleReady("user.agent.mod");
    w.emit(probeOk);
    w.emit({ type: "aiw:mod-error", n: NONCE, err: "模块求值炸了" });
    expect((await readyP).status).toBe("dead");
    expect(allPluginToolDefs()).toHaveLength(0);
  });

  it("等 ready 超时不算通过：probeFailed 里留下 not-ready 的读数", async () => {
    vi.useFakeTimers();
    try {
      const { w, violations } = open();
      const readyP = waitModuleReady("user.agent.mod", 500);
      w.emit(probeOk); // 只回探针，不发 ready（等价于插件代码卡在顶层）
      await vi.advanceTimersByTimeAsync(501);
      const out = await readyP;
      expect(out.probeFailed).toContain("not-ready");
      expect(violations).toContain("ready:timeout");
      expect(out.status).toBe("live"); // worker 没被误杀，只是如实报"没等到"
    } finally {
      vi.useRealTimers();
    }
  });
});
