import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const { toWireMessages, fromRustTurn, invokeAgentProvider } = await import("./provider");

// 注意：必须用块体。箭头函数隐式返回 mockReset() 的 mock 本身，
// vitest 会把 beforeEach 返回的函数当 teardown 在测试后调用，触发 unhandled rejection。
beforeEach(() => { invoke.mockReset(); });

it("wire format: camelCase, optional fields omitted when empty", () => {
  const wire = toWireMessages([
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a", calls: [{ callId: "c1", name: "n", arguments: "{}" }] },
    { role: "tool", content: "r", callId: "c1" },
  ]);
  expect(wire[0]).toEqual({ role: "system", content: "s" });
  expect(wire[0]).not.toHaveProperty("calls");
  expect(wire[2].calls).toHaveLength(1);
  expect(wire[3].callId).toBe("c1");
  expect(wire[3]).not.toHaveProperty("calls");
});

it("rust turn: missing fields normalize to empty strings", () => {
  const turn = fromRustTurn({ content: "hi", calls: [{ name: "t" }, { callId: "c", id: "i", name: "n", arguments: "{\"a\":1}" }] });
  expect(turn.content).toBe("hi");
  expect(turn.calls[0]).toEqual({ callId: "", name: "t", arguments: "" });
  expect(turn.calls[1].callId).toBe("c"); // callId 优先于 id
});

it("provider sends settings and structured tools to ai_agent_turn", async () => {
  invoke.mockResolvedValue({ content: "ok", calls: [] });
  const turn = await invokeAgentProvider([{ role: "user", content: "go" }], [{ name: "x", description: "d", parameters: { type: "object" } }], new AbortController().signal);
  expect(turn.content).toBe("ok");
  expect(invoke).toHaveBeenCalledTimes(1);
  const [cmd, args] = invoke.mock.calls[0];
  expect(cmd).toBe("ai_agent_turn");
  expect(args.messages).toEqual([{ role: "user", content: "go" }]);
  expect(args.tools[0].name).toBe("x");
  expect(typeof args.reqId).toBe("string");
});

it("abort before invoke: no request sent", async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(invokeAgentProvider([], [], ac.signal)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});

it("abort while in flight: host ai_abort fires immediately with same reqId", async () => {
  const ac = new AbortController();
  let sentReqId = "";
  invoke.mockImplementation((cmd: string, args: { reqId: string }) => {
    if (cmd === "ai_agent_turn") { sentReqId = args.reqId; return new Promise(() => {}); } // 永不 resolve，模拟挂起
    return Promise.resolve(undefined);
  });
  const p = invokeAgentProvider([], [], ac.signal);
  p.catch(() => undefined); // 在途请求被放弃，调用方 loop 依 signal 收敛
  await Promise.resolve();
  ac.abort();
  await vi.waitFor(() => {
    const abortCall = invoke.mock.calls.find((c) => c[0] === "ai_abort");
    expect(abortCall?.[1]).toEqual({ reqId: sentReqId });
  });
});

it("host error propagates without fabricating tool calls", async () => {
  invoke.mockRejectedValue("模型服务 HTTP 401；未执行工具");
  let err: unknown = null;
  await invokeAgentProvider([], [], new AbortController().signal).catch((e) => { err = e; });
  expect(err).toBe("模型服务 HTTP 401；未执行工具");
});
