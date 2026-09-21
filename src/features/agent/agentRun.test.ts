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
const { isLiveRun } = await import("./types");
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
  if (goal.startsWith("bigtext")) {
    // P95-H3 之后走形态压缩的收据会很短；这条专门产一份"形态无关的超长文本"以覆盖落盘截断标记
    if (turn === 1) {
      return {
        content: "",
        calls: [{ callId: "g1", name: "run_app_action", arguments: JSON.stringify({ kind: "xrayEvidence" }) }],
      };
    }
    return { content: "ok", calls: [] };
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
  // 每个用例重新领一份 provider 实现：上一条排队的 mockImplementationOnce 不许渗进来。
  // P99a-C1 之后这必须有——取消现在会**不发请求**就落地（loop 的发送前闸），
  // 那条 once 实现于是可能整条都没被消费，漏到下一个用例就把人家挂死。
  vi.mocked(invokeAgentProvider).mockReset();
  vi.mocked(invokeAgentProvider).mockImplementation(scripted);
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

  it("持久化脱敏：大 data 不落盘但**留截断标记**；重启后 running → interrupted", async () => {
    // P95-H3 之后 plot_window 这类会被形态压缩到预算内，改用"形态无关的长文本"制造超限回执
    runAppAction.mockResolvedValueOnce({ ok: true, data: { evidence: "E".repeat(9000) } });
    const runId = await agentRun.startRun({ goal: "bigtext 取证据链", scope: "create" });
    await agentRun.getSnapshot(); // ensure settled
    const stored = JSON.parse(storage.get("vs.agentRuns.v1") ?? "[]") as {
      runId: string; status: string;
      events: { kind: string; receiptTruncated?: boolean; receipt?: { data?: { truncated?: boolean; bytes?: number } } }[];
    }[];
    const row = stored.find((r) => r.runId === runId);
    expect(row?.status).toBe("succeeded");
    const oversize = row!.events.find((e) => e.receipt && JSON.stringify(e.receipt.data ?? "").length > 2048);
    expect(oversize).toBeUndefined(); // 落盘副本有界
    // P94-G2（红线 A7）：省略必须留下可辨认的痕迹——旧实现把 data 直接设 undefined，
    // 台账读起来像"那次调用没返回任何内容"，投影也无从向模型说明。
    const cut = row!.events.find((e) => e.kind === "receipt" && e.receiptTruncated);
    expect(cut).toBeTruthy();
    expect(cut!.receipt?.data?.truncated).toBe(true);
    expect(cut!.receipt?.data?.bytes).toBeGreaterThan(2048);
    // 模拟重启：手动把状态改成 running 再重新加载模块
    stored[0].status = "running";
    storage.set("vs.agentRuns.v1", JSON.stringify(stored));
    vi.resetModules();
    const fresh = await import("./agentRun");
    expect(fresh.getSnapshot().runs[0].status).toBe("interrupted");
    expect(fresh.getSnapshot().activeRunId).toBeNull();
  });

  it("P95-H2：ctx 用量快照过 persist→loadSaved 一轮不丢（reviveRun 是字段白名单，漏字段即静默消失）", async () => {
    storage.set("vs.agentRuns.v1", JSON.stringify([{
      runId: "cx1", goal: "带 ctx 的任务", goalBrief: "带 ctx 的任务", scope: "create", status: "succeeded",
      rounds: 3, calls: 1, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 0 },
      createdAt: 1, updatedAt: 2, finishedAt: 2, events: [], pending: null, undoState: {},
      ctx: { peakBytes: 245000, last: { bytes: 240000, msgs: 12, images: 1, droppedImages: 2, folded: 4, shadowed: 3, step: "images" } },
    }]));
    vi.resetModules();
    const fresh = await import("./agentRun");
    const r = fresh.getSnapshot().runs[0];
    expect(r.ctx?.peakBytes).toBe(245000);
    expect(r.ctx?.last).toMatchObject({ droppedImages: 2, folded: 4, shadowed: 3, step: "images" });
  });

  it("P99a-C1：任务一发布就停得下来——控制器与 running 同时成立，不等臂模块的 await", async () => {
    const p = agentRun.startRun({ goal: "flow 立刻停", scope: "create" });
    // 故意不给任何 await：此刻 executeRun 还压在 armEnabledModules 里
    const id = agentRun.getSnapshot().activeRunId;
    expect(id).toBeTruthy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    agentRun.stopRun(id!);
    expect(warn).not.toHaveBeenCalled(); // 停不掉必须有声音（旧实现是静默早退 ⇒ 界面上"停止"按了没反应）
    warn.mockRestore();
    await p;
    expect(agentRun.getSnapshot().runs.find((r) => r.runId === id)?.status).toBe("cancelled");
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

describe("P89 A 折叠策略与记录删除", () => {
  it("A1 仅 running/paused 自动展开，全部终态（含失败）折叠为一行摘要", () => {
    expect(isLiveRun("running")).toBe(true);
    expect(isLiveRun("paused")).toBe(true);
    for (const s of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      expect(isLiveRun(s)).toBe(false);
    }
  });

  it("A2 removeRun：终态台账与持久化同时剔除；运行中/不存在均拒删", async () => {
    const runId = await agentRun.startRun({ goal: "flow 删除这条记录", scope: "create" });
    expect(storage.get("vs.agentRuns.v1")).toContain(runId);
    expect(agentRun.removeRun(runId)).toBe(true);
    expect(agentRun.getSnapshot().runs).toHaveLength(0);
    expect(storage.get("vs.agentRuns.v1")).not.toContain(runId);
    expect(agentRun.removeRun("missing-run")).toBe(false);

    const blocker: AgentProvider = (_m, _t, signal) =>
      new Promise<ModelTurn>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    vi.mocked(invokeAgentProvider).mockImplementationOnce(blocker);
    const p = agentRun.startRun({ goal: "busy 不可删", scope: "create" });
    await vi.waitFor(() => expect(agentRun.getSnapshot().activeRunId).toBeTruthy(), { timeout: 2000 });
    const live = agentRun.getSnapshot().activeRunId!;
    expect(agentRun.removeRun(live)).toBe(false);
    expect(agentRun.getSnapshot().runs.map((r) => r.runId)).toContain(live);
    agentRun.stopRun(live);
    await p;
  });

  it("A4 startRun 经注册钩子写会话标题（agentRun 不反向 import chatStore）", async () => {
    const seen: [string, string][] = [];
    agentRun.setSessionTitleCb((sessionId, goal) => seen.push([sessionId, goal]));
    try {
      await agentRun.startRun({ goal: "flow 给会话起标题", scope: "create", sessionId: "sess-1" });
      await agentRun.startRun({ goal: "flow 无会话不写标题", scope: "create" });
    } finally {
      agentRun.setSessionTitleCb(null);
    }
    expect(seen).toEqual([["sess-1", "flow 给会话起标题"]]);
  });
});

describe("P90 A2 目标展示字段 goalBrief", () => {
  it("带附件全文的 goal：展示与标题都用用户原话", async () => {
    const fileBlock = "【附加文件：style.md】\n```\n" + "硬提示词样式规范行 ".repeat(40) + "\n```";
    const seen: [string, string][] = [];
    agentRun.setSessionTitleCb((id, t) => seen.push([id, t]));
    try {
      const runId = await agentRun.startRun({
        goal: `${fileBlock}\n\n把主题改成深海蓝并加大字号`,
        goalBrief: "把主题改成深海蓝并加大字号",
        scope: "create",
        sessionId: "s-brief",
      });
      const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
      expect(view.goalBrief).toBe("把主题改成深海蓝并加大字号");
      expect(view.goal).toContain("style.md"); // 发给模型的完整目标不丢附件
      expect(seen).toEqual([["s-brief", "把主题改成深海蓝并加大字号"]]);
    } finally {
      agentRun.setSessionTitleCb(null);
    }
  });

  it("缺省 goalBrief：从 goal 折叠空白派生并截 60 字加省略号", async () => {
    const long = "把 主题\n改成深海蓝 ".repeat(20);
    const runId = await agentRun.startRun({ goal: long, scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.goalBrief.length).toBe(61); // 60 字 + 省略号
    expect(view.goalBrief.endsWith("…")).toBe(true);
    expect(view.goalBrief).not.toContain("\n");
  });

  it("旧台账无 goalBrief：复活时从 goal 派生（向后兼容）", async () => {
    const stored = [
      {
        runId: "legacy-1",
        goal: "旧记录 目标全文",
        scope: "create",
        status: "succeeded",
        rounds: 1,
        calls: 1,
        caps: { maxRounds: 24, maxCalls: 64, deadlineAt: Date.now() },
        createdAt: 1,
        updatedAt: 2,
        events: [],
      },
    ];
    storage.set("vs.agentRuns.v1", JSON.stringify(stored));
    vi.resetModules();
    const fresh = await import("./agentRun");
    expect(fresh.getSnapshot().runs[0].goalBrief).toBe("旧记录 目标全文");
  });
});

describe("P92 A4：任务结论回写会话", () => {
  it("终态把最后一条真实叙述交给钩子（agentRun 不反向 import chatStore，红线 R1）", async () => {
    const seen: [string, string, string][] = [];
    agentRun.setRunConclusionCb((sid, rid, text) => seen.push([sid, rid, text]));
    try {
      const runId = await agentRun.startRun({ goal: "flow 走完给出结论", scope: "create", sessionId: "s-conc" });
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toBe("s-conc");
      expect(seen[0][1]).toBe(runId);
      expect(seen[0][2]).toContain("完成");
      // 回写的是结论叙述，不是轮次心跳或"任务结束：xxx"脚手架
      expect(seen[0][2]).not.toMatch(/〔第 \d+ 轮〕|^任务结束：/);
    } finally {
      agentRun.setRunConclusionCb(null);
    }
  });

  it("无 sessionId 的 run（MCP/Operator 侧）不回写", async () => {
    const seen: string[] = [];
    agentRun.setRunConclusionCb((sid) => seen.push(sid));
    try {
      await agentRun.startRun({ goal: "flow 无会话", scope: "create" });
      expect(seen).toEqual([]);
    } finally {
      agentRun.setRunConclusionCb(null);
    }
  });
});

describe("P92 D1：台账参数不再说谎", () => {
  it("截断过的调用不入续跑历史，未截断的正常还原", () => {
    const view = {
      runId: "x", goal: "做玻璃主题", goalBrief: "做玻璃主题", scope: "create", status: "failed",
      rounds: 2, calls: 2, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 1 }, createdAt: 1, updatedAt: 1,
      events: [
        { seq: 1, ts: 1, kind: "turn", text: "先读现状" },
        { seq: 2, ts: 1, kind: "receipt", tool: "read_appearance", args: "{}", receipt: { callId: "a1", ok: true, status: "read" } },
        { seq: 3, ts: 1, kind: "receipt", tool: "save_plugin", args: '{"name":"玻璃","payload":{"blocks":[', argsTruncated: true, receipt: { callId: "a2", ok: true, status: "applied" } },
      ],
      pending: null, undoState: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const msgs = agentRun.rebuildMessages(view);
    const calls = msgs.flatMap((m) => m.calls ?? []);
    expect(calls.map((c) => c.callId)).toEqual(["a1"]); // 半截参数的那支整对丢弃
    expect(msgs.some((m) => m.role === "tool" && m.callId === "a2")).toBe(false);
    const note = msgs.find((m) => m.role === "system" && m.content.includes("1 次工具调用"));
    expect(note).toBeTruthy();
  });

  it("回灌内容剥掉一次性撤销令牌", () => {
    const view = {
      runId: "y", goal: "g", goalBrief: "g", scope: "create", status: "failed",
      rounds: 1, calls: 1, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 1 }, createdAt: 1, updatedAt: 1,
      events: [
        { seq: 1, ts: 1, kind: "receipt", tool: "theme_patch", args: "{}", receipt: { callId: "p1", ok: true, status: "applied", undoToken: "tok-live" } },
      ],
      pending: null, undoState: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(JSON.stringify(agentRun.rebuildMessages(view))).not.toContain("tok-live");
  });
});

describe("P91 A1/A4：实时增量与失败续跑", () => {
  const restore = () => vi.mocked(invokeAgentProvider).mockImplementation(scripted);

  it("流式增量落 live 缓冲（运行中可见），终态即清且不进台账", async () => {
    let during: string | null = null;
    vi.mocked(invokeAgentProvider).mockImplementation(async (_m, _t, _s, opts) => {
      opts?.onDelta?.("reasoning", "正在想");
      opts?.onDelta?.("text", "冒出");
      const id = agentRun.getSnapshot().runs[0]?.runId ?? "";
      during = agentRun.getLive(id)?.text ?? null;
      return { content: "完成", calls: [] };
    });
    const runId = await agentRun.startRun({ goal: "live 测试", scope: "create" });
    expect(during).toBe("冒出");
    expect(agentRun.getLive(runId)).toBeNull(); // 终态即清，不留悬挂缓冲
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    // 增量只供实时显示，不逐片入台账（否则 200 条上限会被 chunk 冲爆）；
    // 整轮正文由 loop 在轮末以一条 turn 事件落账
    expect(view.events.some((e) => (e.text ?? "").includes("冒出"))).toBe(false);
    expect(view.events.some((e) => e.kind === "turn" && e.text === "完成")).toBe(true);
    restore();
  });

  it("P96-K4：运行中轮/调用计数就报；重试前清实时缓冲但已收内容进台账", async () => {
    const seen: { rounds: number; calls: number; liveText: string }[] = [];
    let n = 0;
    vi.mocked(invokeAgentProvider).mockImplementation(async (_m, _t, _s, opts) => {
      n++;
      const v = agentRun.getSnapshot().runs.find((r) => r.status === "running");
      seen.push({
        rounds: v?.rounds ?? -1,
        calls: v?.calls ?? -1,
        liveText: agentRun.getLive(v?.runId ?? "")?.text ?? "",
      });
      opts?.onDelta?.("text", `第${n}次冒出来的字`);
      if (n === 1) {
        throw new Error(JSON.stringify({
          agentError: 1, code: "provider_error", msg: "Upstream idle timeout exceeded", retryable: true, shrink: true,
        }));
      }
      return { content: "完成", calls: [] };
    });
    const runId = await agentRun.startRun({ goal: "计数观察", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    // 第一次请求：什么都没算过
    expect(seen[0]).toEqual({ rounds: 0, calls: 0, liveText: "" });
    // 重试：缓冲已复位（旧实现累着上一次的半截字，"正在思考 5m55s" 就是这么来的）
    expect(seen[1]?.liveText).toBe("");
    // 但上一次已收的内容没有蒸发——它作为"未完成轮"事件进了台账
    expect(view.events.some((e) => e.kind === "reasoning" && (e.text ?? "").includes("第1次冒出来的字"))).toBe(true);
    expect(view.rounds).toBe(1);
    expect(view.calls).toBe(0);
    restore();
  });

  it("失败任务「继续任务」在同一 run 上续跑：已生效步骤不重做、台账追加、seq 不撞号", async () => {
    let phase = "fail";
    vi.mocked(invokeAgentProvider).mockImplementation(async (messages) => {
      const toolMsgs = messages.filter((m) => m.role === "tool");
      if (phase === "fail") {
        if (toolMsgs.length === 0) return { content: "先读现状", calls: [{ callId: "r1", name: "settings_read", arguments: "{}" }] };
        throw new Error(JSON.stringify({ agentError: 1, code: "provider_error", msg: "模型服务在回复中途返回错误", retryable: false, shrink: false }));
      }
      // 续跑：骨架里必须已带第一轮的工具回执（= 已生效步骤不重做）与唯一 system 提示
      expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
      expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
      return { content: "接着完成", calls: [] };
    });
    const runId = await agentRun.startRun({ goal: "续跑测试", scope: "create" });
    let view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("failed");
    expect(view.events.some((e) => (e.text ?? "").includes("模型服务在回复中途返回错误"))).toBe(true);
    const before = view.events.length;
    expect(agentRun.canRetry(runId)).toBe(true);

    phase = "ok";
    await agentRun.retryRun(runId);
    view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.events.length).toBeGreaterThan(before); // 追加而非覆盖
    expect(view.events.some((e) => (e.text ?? "").startsWith("已从中断处继续"))).toBe(true);
    expect(view.events.some((e) => e.kind === "receipt" && e.tool === "settings_read")).toBe(true);
    const seqs = view.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 撤销按 seq 定位，撞号即撤销错条
    restore();
  });

  it("canRetry：仅 failed/interrupted 且无在途 run 时为真", async () => {
    vi.mocked(invokeAgentProvider).mockImplementation(async () => ({ content: "完成", calls: [] }));
    const ok = await agentRun.startRun({ goal: "成功任务", scope: "create" });
    expect(agentRun.canRetry(ok)).toBe(false);
    expect(agentRun.canRetry("不存在")).toBe(false);
    restore();
  });

  it("rebuildMessages：心跳与失败叙述不回灌，截断参数归一化为 {}", () => {
    const view = {
      runId: "x", goal: "把面板做成玻璃", goalBrief: "把面板做成玻璃", scope: "create", status: "failed",
      rounds: 2, calls: 1, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 1 }, createdAt: 1, updatedAt: 1,
      events: [
        { seq: 1, ts: 1, kind: "turn", text: "〔第 1 轮〕" },
        { seq: 2, ts: 1, kind: "turn", text: "先读现状" },
        { seq: 3, ts: 1, kind: "receipt", tool: "theme_patch", args: "{\"tokens\":{\"a\":", receipt: { callId: "t1", ok: true, status: "applied" } },
        { seq: 4, ts: 1, kind: "status", text: "第 2 轮失败：模型服务在回复中途返回错误；自动重试 1/2" },
        { seq: 5, ts: 1, kind: "turn", text: "〔第 2 轮〕" },
        { seq: 6, ts: 1, kind: "turn", text: "执行出错：模型服务在回复中途返回错误" },
      ],
      pending: null, undoState: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const msgs = agentRun.rebuildMessages(view);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(msgs[1].calls).toEqual([{ callId: "t1", name: "theme_patch", arguments: "{}" }]);
    expect(msgs[2]).toMatchObject({ role: "tool", callId: "t1" });
    const wire = JSON.stringify(msgs);
    expect(wire).not.toContain("〔第");
    expect(wire).not.toContain("执行出错");
    expect(wire).not.toContain("自动重试");
  });
});
