/**
 * P88b-2 adapter 单测：策略门四值、审批绑定（同参放行/换参失效/过期作废）、
 * preview 档位零写入、租约一次性申请、plot_window 抽稀、read_artifact 取回。
 * 重模块（appActions/serial/operator/plotStore/provider）全部 mock，不触渲染链。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
const operator = vi.hoisted(() => ({ pkg: null as unknown }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: operator.pkg }) }));
const plot = vi.hoisted(() => ({
  getSnapshot: vi.fn(() => ({ channels: [{ id: "c1", name: "加速度X", tplId: "t1", fieldId: "f1", visible: true, color: "#000" }] })),
  getChanData: vi.fn(() => ({ t: [0, 1000, 2000], v: [1, 2, 3] })),
  timeOrigin: vi.fn(() => 1000),
  sampleRate: vi.fn(() => 50),
}));
vi.mock("../plot/plotStore", () => plot);

const { createLocalAgentAdapter, argsHash, APPROVAL_TTL_MS, ARTIFACT_READ_LIMIT } = await import("./agentAdapter");
const { releaseDataLease, leaseCount } = await import("../plot/dataLease");
import type { ApprovalGate, ApprovalRequest } from "./agentAdapter";
import type { TaskContext, ToolCall } from "./types";

function ctx(scope: "preview" | "create"): TaskContext {
  return { source: "local_agent", runId: "r1", signal: new AbortController().signal, scope };
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
  operator.pkg = null;
  releaseDataLease("r1");
});

describe("agentAdapter 策略门", () => {
  it("preview 档位：写动作 preview_only 零执行", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("run_app_action", { kind: "setTheme", args: { name: "glass" } }), ctx("preview"));
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "preview_only" });
    expect(runAppAction).not.toHaveBeenCalled();
  });

  it("create 档位：config_write 自动执行；read 回执 status=read", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("run_app_action", { kind: "setTheme", args: { name: "glass" } }), ctx("create"));
    expect(runAppAction).toHaveBeenCalledWith("setTheme", { name: "glass" }, { highPriv: true });
    expect(r).toMatchObject({ ok: true, status: "applied" });
    const r2 = await a.execute(call("run_app_action", { kind: "listProtocols" }), ctx("create"));
    expect(r2.status).toBe("read");
  });

  it("破坏性动作需本地批准：回执 needs_local_approval 且计划入卡", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const args = { kind: "removeCard", args: { id: "card-9" } };
    const r = await a.execute(call("run_app_action", args), ctx("create"));
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "needs_local_approval" });
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0].plan).toContain("删除或覆盖");
    expect(gate.requests[0].tool).toBe("removeCard");
    expect(runAppAction).not.toHaveBeenCalled();
  });

  it("批准令牌绑定参数：同参放行，换参重新请求批准", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const args = { kind: "removeCard", args: { id: "card-9" } };
    await a.execute(call("run_app_action", args), ctx("create"));
    // 用户批准：绑定同参 hash
    vi.mocked(gate.takeToken).mockImplementation((_rid, tool, hash) => (tool === "removeCard" && hash === argsHash(args) ? "tok-1" : null));
    const ok = await a.execute(call("run_app_action", args), ctx("create"));
    expect(ok.ok).toBe(true);
    // 换参：令牌不匹配 → 再次 needs_local_approval
    const changed = await a.execute(call("run_app_action", { kind: "removeCard", args: { id: "card-OTHER" } }), ctx("create"));
    expect(changed.code).toBe("needs_local_approval");
  });

  it("Operator 锁：写动作 deny；未知动作 unknown_action", async () => {
    operator.pkg = { id: "pkg" };
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const r = await a.execute(call("run_app_action", { kind: "setTheme" }), ctx("create"));
    expect(r.code).toBe("denied_by_policy");
    const r2 = await a.execute(call("run_app_action", { kind: "nope" }), ctx("create"));
    expect(r2.code).toBe("unknown_action");
  });

  it("设备上下文 unknown（未连接）：device_send 需批准，不猜成仿真", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const r = await a.execute(call("run_app_action", { kind: "openPort", args: { port: "COM3" } }), ctx("create"));
    expect(r.code).toBe("needs_local_approval");
    expect(gate.requests[0].plan).toContain("实车");
  });
});

describe("agentAdapter 数据分析工具（§6.1 租约）", () => {
  it("plot_channels：首次申请租约，回执含统计与 coverage；二次调用不重复申请", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("plot_channels"), ctx("create"));
    expect(r.ok).toBe(true);
    const data = r.data as { channels: { id: string; points: number; min: number; max: number; sampleRate: number }[]; coverage: { live: boolean } };
    expect(data.channels[0]).toMatchObject({ id: "c1", points: 3, min: 1, max: 3, sampleRate: 50 });
    expect(data.coverage.live).toBe(true);
    expect(leaseCount()).toBe(1);
    await a.execute(call("plot_channels"), ctx("create"));
    expect(leaseCount()).toBe(1);
  });

  it("plot_window：超限抽稀保首尾；2000 硬顶经 artifact 可验", async () => {
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 5000 }, (_, i) => i * 10),
      v: Array.from({ length: 5000 }, (_, i) => i),
    });
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    // 500 点 ≈ 5KB，低于 8KiB 截断线：回执内可直接验证抽稀
    const r = await a.execute(call("plot_window", { channelIds: ["c1"], maxPoints: 500 }), ctx("create"));
    const data = r.data as { series: { t: number[]; v: number[] }[]; truncated?: boolean };
    expect(data.truncated).toBeUndefined();
    expect(data.series[0].t).toHaveLength(500);
    expect(data.series[0].t[0]).toBe(0);
    expect(data.series[0].t[499]).toBe(49990);
    // 请求 99999 → 硬顶 2000：回执被截断，但 artifact 内可验证长度
    const c2 = call("plot_window", { maxPoints: 99999 });
    const r2 = await a.execute(c2, ctx("create"));
    expect((r2.data as { truncated?: boolean }).truncated).toBe(true);
    const stored = a.artifacts.get(`call:${c2.callId}`) as { series: { t: number[] }[] };
    expect(stored.series[0].t.length).toBe(2000);
  });

  it("大回执转 artifactRef，read_artifact 全量取回；超读限返回截断说明", async () => {
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 4000 }, (_, i) => i),
      v: Array.from({ length: 4000 }, (_, i) => i),
    });
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const c = call("plot_window", { maxPoints: 2000 });
    const r = await a.execute(c, ctx("create"));
    const d = r.data as { truncated?: boolean; artifactRef?: string };
    expect(d.truncated).toBe(true);
    expect(d.artifactRef).toBe(`call:${c.callId}`);
    const full = await a.execute(call("read_artifact", { ref: d.artifactRef }), ctx("create"));
    const fd = full.data as { series?: unknown[] };
    expect(Array.isArray(fd.series)).toBe(true);
    // 人造超读限 artifact：返回头部截断说明，不整包下发
    a.artifacts.set("call:big", { blob: "x".repeat(ARTIFACT_READ_LIMIT + 10) });
    const big = await a.execute(call("read_artifact", { ref: "call:big" }), ctx("create"));
    expect((big.data as { truncated: boolean }).truncated).toBe(true);
  });

  it("取消后零执行；未知工具 unknown_tool", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("plot_channels"), { source: "local_agent", runId: "r1", signal: ac.signal, scope: "create" });
    expect(r.code).toBe("cancelled");
    const r2 = await a.execute(call("time_travel"), ctx("create"));
    expect(r2.code).toBe("unknown_tool");
    expect(APPROVAL_TTL_MS).toBeGreaterThan(0);
  });
});
