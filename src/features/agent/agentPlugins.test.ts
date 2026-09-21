/**
 * P88b-3 Agent 接线测试：save_plugin（档位门/能力派生/自动启用/ID 冲突后缀）、
 * enable_plugin（serial.send 走审批门）、list_plugins（只读）。
 * 重模块 mock 策略同 agentAdapter.test.ts；extRuntime（触 DOM）mock 掉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
const operator = vi.hoisted(() => ({ pkg: null as unknown }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: operator.pkg }) }));
vi.mock("../plot/plotStore", () => ({
  getSnapshot: vi.fn(() => ({ channels: [] })),
  getChanData: vi.fn(() => ({ t: [], v: [] })),
  timeOrigin: vi.fn(() => 1000),
  sampleRate: vi.fn(() => 50),
}));
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

const { createLocalAgentAdapter } = await import("./agentAdapter");
const { argsHash } = await import("./toolRegistry");
const store = await import("../plugins/pluginStore");
const extStore = await import("../ai/extensionStore");
import type { ApprovalGate, ApprovalRequest } from "./toolRegistry";
import type { TaskContext, ToolCall } from "./types";

function ctx(scope: TaskContext["scope"], allowed?: string[]): TaskContext {
  return { source: "local_agent", runId: "r1", signal: new AbortController().signal, scope, ...(allowed ? { allowed } : {}) };
}
const call = (name: string, args?: unknown): ToolCall => ({
  callId: crypto.randomUUID(), name, arguments: JSON.stringify(args ?? {}),
});
function fakeGate(): ApprovalGate & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    request: vi.fn((r: ApprovalRequest) => requests.push(r)),
    takeToken: vi.fn((_rid: string, _tool: string, _hash: string, _now: number) => null as string | null),
    reject: vi.fn(),
  };
}

beforeEach(() => {
  runAppAction.mockReset();
  runAppAction.mockResolvedValue({ ok: true, data: "完成" });
});

const WIDGET_PAYLOAD = { format: "html", html: "<b>仪表</b>" };

describe("save_plugin 档位与落库", () => {
  it("preview 档位：preview_only 零写入", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("save_plugin", { kind: "widget", name: "电压表", payload: WIDGET_PAYLOAD }), ctx("preview"));
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "preview_only" });
    expect(store.getSnapshot().plugins).toHaveLength(0);
  });

  it("custom 档位：未勾选 plugins 域拒绝；勾选后入库（默认停用）", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const args = { kind: "widget", name: "电压表", payload: WIDGET_PAYLOAD };
    const denied = await a.execute(call("save_plugin", args), ctx("custom", ["config"]));
    expect(denied.code).toBe("unauthorized_scope");
    const ok = await a.execute(call("save_plugin", args), ctx("custom", ["config", "plugins"]));
    expect(ok.ok).toBe(true);
    const data = ok.data as { pluginId: string; state: string; caps: string[] };
    expect(data.state).toBe("installed_disabled");
    expect(data.caps).toEqual(["ui.widget", "telemetry.read"]);
    expect(store.getPlugin(data.pluginId)).toBeTruthy();
  });

  it("create 档位：enable=true 且纯 UI 自动启用并建投影；非法 kind/payload 可读报错", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("save_plugin", { kind: "widget", name: "转速表", payload: WIDGET_PAYLOAD, enable: true }), ctx("create"));
    const data = r.data as { pluginId: string; state: string; enabled: boolean };
    expect(data.enabled).toBe(true);
    expect(data.state).toBe("enabled");
    expect(extStore.getSnapshot().exts.some((e) => e.pluginRef === data.pluginId)).toBe(true);
    expect((await a.execute(call("save_plugin", { kind: "rootkit", name: "x", payload: {} }), ctx("create"))).code).toBe("invalid_kind");
    expect((await a.execute(call("save_plugin", { kind: "panel", name: "x", payload: "html" }), ctx("create"))).code).toBe("invalid_payload");
    expect((await a.execute(call("save_plugin", { kind: "panel", name: "x", payload: { format: "html", html: "y" }, id: "Bad ID" }), ctx("create"))).code).toBe("invalid_id");
  });

  /**
   * P99a-B1：`module` 让插件第一次能带 JS。这两张卡钉的是同一句话——
   * **能带逻辑 ≠ 能自动生效**（详设 §11"不给 module 自动启用"）。
   */
  it("module 包：enable:true 也不自动启用（logic.run 不在纯 UI 能力集）", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(
      call("save_plugin", { kind: "module", name: "计算器", payload: { format: "js", code: "uartix.host.post({type:'ping'})" }, enable: true }),
      ctx("create"),
    );
    const data = r.data as { pluginId: string; enabled: boolean; state: string; caps: string[] };
    expect(r.ok).toBe(true);
    expect(data.caps).toEqual(["logic.run"]);
    expect(data.enabled).toBe(false);
    expect(data.state).toBe("installed_disabled");
  });

  it("module 包：封网自证不通过就保持停用，原因照实回传", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const saved = await a.execute(
      call("save_plugin", { kind: "module", name: "探针包", payload: { format: "js", code: "var ok = 1;" } }),
      ctx("create"),
    );
    const id = (saved.data as { pluginId: string }).pluginId;
    const gate = fakeGate();
    gate.takeToken = vi.fn(() => "tok");
    const b = createLocalAgentAdapter({ runId: "r2", gate });
    const r = await b.execute(call("enable_plugin", { id }), ctx("create"));
    expect(r.ok).toBe(false);
    // node 环境没有 Worker：证明不了封网 ⇒ fail-closed，不是"测不了算通过"
    expect(r.code).toBe("module_probe_failed");
    expect(String((r.data as { msg?: string }).msg)).toContain("no-worker");
    expect(store.getPlugin(id)?.state).not.toBe("enabled");
  });

  it("包校验失败回传 errors；显式同 ID＝升版本，撞名但没指 ID＝另起一份绝不覆盖", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const bad = await a.execute(call("save_plugin", { kind: "theme", name: "坏主题", payload: {} }), ctx("create"));
    expect(bad.code).toBe("invalid_package");
    expect((bad.data as { errors: string[] }).errors.length).toBeGreaterThan(0);
    const first = await a.execute(call("save_plugin", { kind: "panel", name: "面板", id: "user.agent.panel", payload: { format: "html", html: "p" } }), ctx("create"));
    const second = await a.execute(call("save_plugin", { kind: "panel", name: "面板", id: "user.agent.panel", payload: { format: "html", html: "p" } }), ctx("create"));
    const id1 = (first.data as { pluginId: string }).pluginId;
    expect(id1).toBe("user.agent.panel");
    // P97-I6 改了这一半的语义：模型**指名**往同一个 id 再存一次，读作"改这个插件"，
    // 升版本 + 旧版进栈（库内仍只有一条），而不是悄悄多出 user.agent.panel-2 那种近似副本。
    const d2 = second.data as { pluginId: string; updated?: boolean; version?: string; history?: number };
    expect(d2).toMatchObject({ pluginId: "user.agent.panel", updated: true, version: "0.1.1", history: 1 });
    expect(store.getSnapshot().plugins.filter((p) => p.pkg.id === "user.agent.panel")).toHaveLength(1);
    // 没给 id 时按名字派生 id，撞车仍是"再来一份"：没有指名就不该覆盖别人的东西
    const dupA = await a.execute(call("save_plugin", { kind: "panel", name: "同名面板", payload: { format: "html", html: "a" } }), ctx("create"));
    const dupB = await a.execute(call("save_plugin", { kind: "panel", name: "同名面板", payload: { format: "html", html: "b" } }), ctx("create"));
    const idA = (dupA.data as { pluginId: string }).pluginId;
    const idB = (dupB.data as { pluginId: string }).pluginId;
    expect(idB).not.toBe(idA);
    expect((dupB.data as { updated?: boolean }).updated).toBeUndefined();
  });
});

describe("enable_plugin 与 list_plugins", () => {
  it("纯 UI 插件静默启用；serial.send 插件走审批门，批准后启用", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const pure = await a.execute(call("save_plugin", { kind: "widget", name: "纯UI件", payload: WIDGET_PAYLOAD }), ctx("create"));
    const pureId = (pure.data as { pluginId: string }).pluginId;
    const on = await a.execute(call("enable_plugin", { id: pureId }), ctx("create"));
    expect(on.ok).toBe(true);
    expect(gate.requests).toHaveLength(0);

    // 手工入库带 serial.send 的包
    const staged = store.stagePackage({
      format: "uartix-plugin", schemaVersion: 2, id: "user.t.sender", version: "0.1.0",
      name: "发送件", hostApi: "^1.0", capabilities: ["ui.widget", "telemetry.read", "serial.send"],
      contributions: { widgets: [{ id: "main", entry: "main.json" }] },
      artifacts: { "main.json": { kind: "widget", ...WIDGET_PAYLOAD } }, provenance: { createdBy: "user", reviewed: false },
    });
    const senderId = store.installStaged(staged.stagingId!).id!;
    const gated = await a.execute(call("enable_plugin", { id: senderId }), ctx("create"));
    expect(gated).toMatchObject({ ok: false, status: "not_executed", code: "needs_local_approval" });
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0].tool).toBe("enable_plugin");
    expect(gate.requests[0].plan).toContain("serial.send");
    expect(store.getPlugin(senderId)?.state).toBe("installed_disabled");
    // 用户批准：绑定同参令牌
    vi.mocked(gate.takeToken).mockImplementation((_rid, tool, hash) =>
      tool === "enable_plugin" && hash === argsHash({ tool: "enable_plugin", id: senderId }) ? "tok-1" : null);
    const ok = await a.execute(call("enable_plugin", { id: senderId }), ctx("create"));
    expect(ok.ok).toBe(true);
    expect(store.getPlugin(senderId)?.state).toBe("enabled");
  });

  it("preview 档位不改变状态；未知插件可读报错；list_plugins 只读", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const saved = await a.execute(call("save_plugin", { kind: "widget", name: "列表件", payload: WIDGET_PAYLOAD }), ctx("create"));
    const id = (saved.data as { pluginId: string }).pluginId;
    const pv = await a.execute(call("enable_plugin", { id }), ctx("preview"));
    expect(pv.code).toBe("preview_only");
    expect(store.getPlugin(id)?.state).toBe("installed_disabled");
    expect((await a.execute(call("enable_plugin", { id: "user.nope" }), ctx("create"))).code).toBe("plugin_not_found");
    const list = await a.execute(call("list_plugins"), ctx("preview"));
    expect(list.ok).toBe(true);
    const plugins = (list.data as { plugins: { id: string; state: string }[] }).plugins;
    expect(plugins.some((p) => p.id === id && p.state === "installed_disabled")).toBe(true);
  });
});
