import { afterEach, expect, it, vi } from "vitest";
import { runAgent, DEFAULT_BUDGET } from "./loop";
import type { AgentProvider, TaskAdapter, ToolCall, ToolReceipt } from "./types";

afterEach(() => vi.unstubAllGlobals());

function stubStorage() {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
  return storage;
}

function echoAdapter(handler: (call: ToolCall) => ToolReceipt): TaskAdapter {
  return {
    definitions: [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} } }],
    async execute(call) { return handler(call); },
  };
}

const ctx = () => ({ source: "local_agent" as const, runId: "t", signal: new AbortController().signal, scope: "create" as const });

it("vertical slice: real settings tool applies, matching structured receipt feeds next model turn, then terminates", async () => {
  stubStorage();
  vi.resetModules();
  const { settingsAdapter, settingsRevision, undoSettings } = await import("./settingsTools");
  const settings = await import("../settings/settingsStore");
  const before = settings.getSnapshot().zoom;
  let turns = 0;
  const provider: AgentProvider = async (messages) => {
    turns++;
    if (turns === 1) return { content: "Increase zoom", calls: [{ callId: "safe-write-1", name: "settings_apply", arguments: JSON.stringify({ patch: { zoom: 125 }, revision: settingsRevision() }) }] };
    const tool = messages[messages.length - 1]!;
    expect(tool.role).toBe("tool");
    expect(tool.callId).toBe("safe-write-1");
    const receipt = JSON.parse(tool.content);
    expect(receipt).toMatchObject({ callId: "safe-write-1", ok: true, status: "applied", data: { zoom: 125 } });
    expect(settings.getSnapshot().zoom).toBe(125);
    return { content: "Verified zoom 125; task complete", calls: [] };
  };
  const result = await runAgent({ goal: "Increase font size", provider, adapter: settingsAdapter, context: ctx() });
  expect(result.status).toBe("succeeded");
  expect(result.calls).toBe(1);
  expect(turns).toBe(2);
  expect(undoSettings(result.events.find((e) => e.kind === "receipt")!.receipt!.undoToken!)).toBe(true);
  expect(settings.getSnapshot().zoom).toBe(before);
});

it("cancel before first turn: zero tool executions, status cancelled", async () => {
  stubStorage();
  const ac = new AbortController();
  ac.abort();
  let executed = 0;
  const provider: AgentProvider = async () => ({ content: "x", calls: [{ callId: "c1", name: "echo", arguments: "{}" }] });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => { executed++; return { callId: "c1", ok: true, status: "read" }; }), context: { ...ctx(), signal: ac.signal } });
  expect(result.status).toBe("cancelled");
  expect(executed).toBe(0);
});

it("cancel during a turn: undispatched calls are dropped", async () => {
  stubStorage();
  const ac = new AbortController();
  let executed = 0;
  const adapter: TaskAdapter = {
    definitions: [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} } }],
    async execute(call) {
      executed++;
      if (call.name === "echo") ac.abort(); // 第一个工具执行后用户取消
      return { callId: call.callId, ok: true, status: "read" };
    },
  };
  const provider: AgentProvider = async () => ({ content: "two calls", calls: [{ callId: "a", name: "echo", arguments: "{}" }, { callId: "b", name: "echo", arguments: "{}" }] });
  const result = await runAgent({ goal: "g", provider, adapter, context: { ...ctx(), signal: ac.signal } });
  expect(result.status).toBe("cancelled");
  expect(executed).toBe(1); // 第二个调用未派发
});

it("budget: maxCalls cap pauses without executing further calls", async () => {
  stubStorage();
  let executed = 0;
  const provider: AgentProvider = async () => ({
    content: "spam",
    calls: Array.from({ length: 10 }, (_, i) => ({ callId: `c${i}`, name: "echo", arguments: "{}" })),
  });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => { executed++; return { callId: "x", ok: true, status: "read" }; }), context: ctx(), maxCalls: 4 });
  expect(result.status).toBe("paused");
  expect(executed).toBe(4);
  expect(result.calls).toBe(4);
});

it("budget: maxRounds cap pauses, caps reported for remaining-quota UI", async () => {
  stubStorage();
  const provider: AgentProvider = async () => ({ content: "loop", calls: [{ callId: `r${Date.now()}${Math.random()}`, name: "echo", arguments: "{}" }] });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })), context: ctx(), maxRounds: 3 });
  expect(result.status).toBe("paused");
  expect(result.rounds).toBe(3);
  expect(result.caps.maxRounds).toBe(3);
});

it("budget options cannot exceed hard caps", async () => {
  stubStorage();
  const provider: AgentProvider = async () => ({ content: "done", calls: [] });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })), context: ctx(), maxRounds: 9999, maxCalls: 9999 });
  expect(result.caps.maxRounds).toBe(DEFAULT_BUDGET.maxRounds);
  expect(result.caps.maxCalls).toBe(DEFAULT_BUDGET.maxCalls);
});

it("same callId executes exactly once; reused id with different args rejected", async () => {
  stubStorage();
  let executed = 0;
  let turns = 0;
  const provider: AgentProvider = async () => {
    turns++;
    if (turns === 1) return { content: "first", calls: [{ callId: "dup", name: "echo", arguments: '{"n":1}' }] };
    if (turns === 2) return { content: "same id same args", calls: [{ callId: "dup", name: "echo", arguments: '{"n":1}' }] };
    if (turns === 3) return { content: "same id other args", calls: [{ callId: "dup", name: "echo", arguments: '{"n":2}' }] };
    return { content: "end", calls: [] };
  };
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => { executed++; return { callId: "dup", ok: true, status: "applied" }; }), context: ctx() });
  expect(executed).toBe(1);
  const receipts = result.events.filter((e) => e.kind === "receipt").map((e) => e.receipt!);
  expect(receipts[1]).toMatchObject({ ok: true }); // 同参数重放：返回缓存回执，不再执行
  expect(receipts[2]).toMatchObject({ ok: false, code: "call_id_reused", status: "not_executed" }); // 换参数：协议违规
});

it("three identical failures pause the loop (no token burn)", async () => {
  stubStorage();
  let executed = 0;
  const provider: AgentProvider = async () => ({ content: "retry", calls: [{ callId: `f${executed}`, name: "echo", arguments: '{"fixed":true}' }] });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => { executed++; return { callId: "x", ok: false, status: "error", code: "boom" }; }), context: ctx() });
  expect(result.status).toBe("paused");
  expect(executed).toBe(3);
});

it("invalid JSON arguments never reach the adapter", async () => {
  stubStorage();
  let executed = 0;
  const provider: AgentProvider = async () => ({ content: "bad", calls: [{ callId: "b1", name: "echo", arguments: "{not json" }] });
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => { executed++; return { callId: "b1", ok: true, status: "read" }; }), context: ctx(), maxRounds: 1 });
  expect(executed).toBe(0);
  expect(result.events.find((e) => e.kind === "receipt")?.receipt).toMatchObject({ ok: false, status: "error", code: "tool_failed_or_invalid_arguments" });
});

it("oversized receipt data is truncated to artifactRef before feeding the model; ledger keeps full receipt", async () => {
  stubStorage();
  const big = "x".repeat(9 * 1024);
  let modelSawTruncated = false;
  const provider: AgentProvider = async (messages) => {
    const toolMsg = messages.find((m) => m.role === "tool");
    if (toolMsg) modelSawTruncated = JSON.parse(toolMsg.content).data?.truncated === true;
    return { content: toolMsg ? "done" : "read", calls: toolMsg ? [] : [{ callId: "big", name: "echo", arguments: "{}" }] };
  };
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => ({ callId: "big", ok: true, status: "read", data: big })), context: ctx() });
  expect(modelSawTruncated).toBe(true);
  const ledger = result.events.find((e) => e.kind === "receipt")!.receipt!;
  expect(ledger.data).toBe(big); // 事件台账保留完整回执供 UI/导出
});

it("foldContext keeps head and recent turns when over soft limit", async () => {
  const { foldContext, CONTEXT_SOFT_LIMIT } = await import("./context");
  const filler = "y".repeat(20 * 1024);
  const messages = [
    { role: "system" as const, content: "SYS" },
    { role: "user" as const, content: "GOAL" },
    ...Array.from({ length: 12 }, (_, i) => ({ role: "assistant" as const, content: `turn${i} ${filler}` })),
  ];
  const folded = foldContext(messages);
  expect(folded[0].content).toBe("SYS");
  expect(folded[1].content).toBe("GOAL");
  expect(folded.length).toBeLessThan(messages.length);
  expect(folded[folded.length - 1].content).toContain("turn11");
  expect(folded.some((m) => m.role === "system" && m.content.includes("步骤摘要"))).toBe(true);
  // 未超软阈值时原样返回
  const small = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];
  expect(foldContext(small)).toBe(small);
  expect(CONTEXT_SOFT_LIMIT).toBeGreaterThan(0);
});
