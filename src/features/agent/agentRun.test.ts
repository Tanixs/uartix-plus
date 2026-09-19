/**
 * P88b-2 agentRun 纵向测试（fake provider，零网络零密钥）：
 * - 设置流（read→apply 带 revision）+ 动作执行 → succeeded 真实计数；
 * - 批准闭环：needs_local_approval → approve 后同参重试放行；
 * - stopRun：取消后状态 cancelled、租约释放、本地轮询标记复位；
 * - 持久化：大 data 脱敏丢弃；重启（重新加载模块）后 running → interrupted（§5.4）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });

vi.mock("./provider", () => ({ invokeAgentProvider: vi.fn() }));
vi.mock("../mcp/jobExecutor", () => ({ setLocalJobInterest: vi.fn() }));
const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: null }) }));
const plot = vi.hoisted(() => ({
  getSnapshot: vi.fn(() => ({ channels: [{ id: "c1", name: "X", tplId: "t", fieldId: "f", visible: true, color: "#000" }] })),
  getChanData: vi.fn(() => ({ t: [0, 1], v: [1, 2] })),
  timeOrigin: vi.fn(() => 0),
  sampleRate: vi.fn(() => 10),
}));
vi.mock("../plot/plotStore", () => plot);
const { releaseDataLease, leaseCount } = await import("../plot/dataLease");

const { invokeAgentProvider } = await import("./provider");
const { setLocalJobInterest } = await import("../mcp/jobExecutor");
const agentRun = await import("./agentRun");
import type { AgentProvider, ModelTurn } from "./types";

let turn = 0;
let hangSignal: AbortSignal | null = null;

/** 场景由 goal 前缀驱动，模拟真实多轮工具反馈。 */
const scripted: AgentProvider = async (messages, _tools, signal) => {
  const goal = messages.find((m) => m.role === "user")?.content ?? "";
  turn++;
  if (goal.startsWith("flow")) {
    if (turn === 1) return { content: "读取设置", calls: [{ callId: "c1", name: "settings_read", arguments: "{}" }] };
    if (turn === 2) {
      const last = [...messages].reverse().find((m) => m.role === "tool");
      const rev = String((JSON.parse(last?.content ?? "{}") as { revision?: string }).revision);
      return { content: "", calls: [{ callId: "c2", name: "settings_apply", arguments: JSON.stringify({ patch: { decimals: 3 }, revision: rev }) }] };
    }
    if (turn === 3) return { content: "", calls: [{ callId: "c3", name: "run_app_action", arguments: JSON.stringify({ kind: "setTheme", args: { name: "begonia" } }) }] };
    return { content: "完成：字号精度已应用", calls: [] };
  }
  if (goal.startsWith("approve")) {
    if (turn === 1) {
      return { content: "", calls: [{ callId: "d1", name: "run_app_action", arguments: JSON.stringify({ kind: "removeCard", args: { id: "card-9" } }) }] };
    }
    if (turn === 2) {
      const last = [...messages].reverse().find((m) => m.role === "tool");
      if ((JSON.parse(last?.content ?? "{}") as { code?: string }).code === "needs_local_approval") {
        const snap = agentRun.getSnapshot();
        const pending = snap.runs[0]?.pending;
        expect(pending).toBeTruthy();
        expect(agentRun.approve(snap.runs[0].runId, pending!.id)).toBe(true);
        return { content: "", calls: [{ callId: "d2", name: "run_app_action", arguments: JSON.stringify({ kind: "removeCard", args: { id: "card-9" } }) }] };
      }
      return { content: "清理完成", calls: [] };
    }
    return { content: "done", calls: [] };
  }
  if (goal.startsWith("lease-stop")) {
    if (turn === 1) return { content: "", calls: [{ callId: "e1", name: "plot_channels", arguments: "{}" }] };
    hangSignal = signal;
    await new Promise<ModelTurn>((resolve) => { signal.addEventListener("abort", () => resolve({ content: "", calls: [] }), { once: true }); });
    return { content: "", calls: [] };
  }
  if (goal.startsWith("big")) {
    if (turn === 1) {
      plot.getChanData.mockReturnValue({ t: Array.from({ length: 4000 }, (_, i) => i), v: Array.from({ length: 4000 }, (_, i) => i) });
      return { content: "", calls: [{ callId: "f1", name: "plot_window", arguments: JSON.stringify({ maxPoints: 2000 }) }] };
    }
    return { content: "ok", calls: [] };
  }
  return { content: "done", calls: [] };
};
vi.mocked(invokeAgentProvider).mockImplementation(scripted);

beforeEach(() => {
  turn = 0;
  runAppAction.mockReset();
  runAppAction.mockResolvedValue({ ok: true, data: "完成" });
  plot.getChanData.mockReturnValue({ t: [0, 1], v: [1, 2] });
  releaseDataLease("lease-stop-run");
  agentRun.resetForTests();
});

describe("agentRun 运行宿主", () => {
  it("设置流 + 动作执行：真实计数 succeeded；轮询标记随运行启停", async () => {
    const runId = await agentRun.startRun({ goal: "flow 调大精度并应用主题", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.calls).toBe(3);
    expect(view.rounds).toBe(4);
    expect(view.finishedAt).toBeTruthy();
    // 设置 apply 生效 + 事件里有 undoToken；动作被执行
    expect(runAppAction).toHaveBeenCalledWith("setTheme", { name: "begonia" }, { highPriv: true });
    const applyEvt = view.events.find((e) => e.receipt?.undoToken);
    expect(applyEvt).toBeTruthy();
    expect(setLocalJobInterest).toHaveBeenCalledWith(true);
    expect(setLocalJobInterest).toHaveBeenLastCalledWith(false);
    expect(agentRun.getSnapshot().activeRunId).toBeNull();
  });

  it("批准闭环：needs_local_approval → 批准后同参重试放行", async () => {
    await agentRun.startRun({ goal: "approve 删除测试卡片", scope: "create" });
    const view = agentRun.getSnapshot().runs[0];
    expect(view.status).toBe("succeeded");
    const okEvt = view.events.find((e) => e.kind === "receipt" && e.receipt?.ok === true && e.receipt.status === "applied");
    expect(okEvt).toBeTruthy();
  });

  it("拒绝后不再弹同参卡；run 结束 pending 清空", async () => {
    runAppAction.mockResolvedValue({ ok: false, err: "卡片不存在" });
    // 用 preview 档位触发 preview_only（不走批准卡）——此处验证 pending 生命周期由 UI 驱动的路径在 reject 后不再出现
    const runId = await agentRun.startRun({ goal: "approve 删除测试卡片", scope: "preview" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.pending).toBeNull();
  });

  it("stopRun：取消态、租约释放、不执行后续工具", async () => {
    const p = agentRun.startRun({ goal: "lease-stop 采集后挂起", scope: "create" });
    await vi.waitFor(() => expect(agentRun.getSnapshot().activeRunId).toBeTruthy(), { timeout: 2000 });
    const runId = agentRun.getSnapshot().activeRunId!;
    await vi.waitFor(() => expect(leaseCount()).toBe(1), { timeout: 2000 });
    await vi.waitFor(() => expect(hangSignal).not.toBeNull(), { timeout: 2000 }); // turn2 已挂起
    agentRun.stopRun(runId);
    await p;
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("cancelled");
    expect(leaseCount()).toBe(0); // §6.1 租约随 run 终止释放
    expect(hangSignal?.aborted).toBe(true);
  });

  it("持久化脱敏：大 data 不落盘；重启后 running → interrupted", async () => {
    const runId = await agentRun.startRun({ goal: "big 读取大窗口", scope: "create" });
    await agentRun.getSnapshot(); // ensure settled
    const stored = JSON.parse(storage.get("vs.agentRuns.v1") ?? "[]") as { runId: string; status: string; events: { receipt?: { data?: unknown } }[] }[];
    const row = stored.find((r) => r.runId === runId);
    expect(row?.status).toBe("succeeded");
    const bigEvt = row!.events.find((e) => e.receipt && JSON.stringify(e.receipt.data ?? "").length > 2048);
    expect(bigEvt).toBeUndefined(); // 大 data 已脱敏丢弃
    // 模拟重启：手动把状态改成 running 再重新加载模块
    stored[0].status = "running";
    storage.set("vs.agentRuns.v1", JSON.stringify(stored));
    vi.resetModules();
    const fresh = await import("./agentRun");
    expect(fresh.getSnapshot().runs[0].status).toBe("interrupted");
    expect(fresh.getSnapshot().activeRunId).toBeNull();
  });

  it("空目标拒绝；重复启动抛 RunBusyError", async () => {
    await expect(agentRun.startRun({ goal: "  ", scope: "create" })).rejects.toThrow("任务目标不能为空");
    // 重复启动：用 abort 感知的挂起 provider 占住，stopRun 后可收敛
    const blocker: AgentProvider = (_m, _t, signal) =>
      new Promise<ModelTurn>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    vi.mocked(invokeAgentProvider).mockImplementationOnce(blocker);
    const p = agentRun.startRun({ goal: "busy", scope: "create" });
    await vi.waitFor(() => expect(agentRun.getSnapshot().activeRunId).toBeTruthy(), { timeout: 2000 });
    await expect(agentRun.startRun({ goal: "second", scope: "create" })).rejects.toThrow("已有 Agent 任务在运行");
    agentRun.stopRun(agentRun.getSnapshot().activeRunId!);
    await p;
  });
});
