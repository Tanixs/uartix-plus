/**
 * P137：子代理（只读子任务）的**过程可见性**与**额度读数**。
 *
 * 这批钉的都是"派发那一刻"的接线，两条各管一头：
 *  - **接得上**：`makeSubagentDispatch` 必须把子的 `onEvent`/`onProgress` 交下去——
 *    旧实现一个回调都不传（详设 F1），子的逐轮事件在 `runAgent` 返回后就地蒸发，
 *    于是"子代理在查"和"子代理挂了"在屏幕上长得一样。
 *  - **放对位置**：子的逐轮**不得**进父台账（详设 C1/F5：一次派发上界约 22 条事件，
 *    五次就是 `EVENTS_CAP=200` 的 55%）。这条是反向钉，摘掉正向功能也不会红，所以单独钉。
 * 另有三处纯派生（`asSubagentData` / `subRunSteps` / `nestedSubagentUsage`）——
 * 渲染层按 §8-48 的口径只画这些派生的结果，逻辑住在这里才钉得住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

vi.mock("./provider", () => ({ invokeAgentProvider: vi.fn() }));
vi.mock("../mcp/jobExecutor", () => ({ setLocalJobInterest: vi.fn() }));
const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: null }) }));
vi.mock("../plot/plotStore", () => ({
  getSnapshot: vi.fn(() => ({ channels: [] })),
  getChanData: vi.fn(() => ({ t: [], v: [] })),
  timeOrigin: vi.fn(() => 0),
  sampleRate: vi.fn(() => 0),
}));

const { invokeAgentProvider } = await import("./provider");
const agentRun = await import("./agentRun");
const settings = await import("../settings/settingsStore");
const { SUBAGENT_CAPS } = await import("./subagent");
const { asSubagentData, nestedSubagentUsage, receiptRows, subRunSteps } = await import("./toolDisplay");
import type { AgentProvider, RunEvent } from "./types";

const REPORT = "报告：帧尾两字节像 CRC16，初值 0xFFFF。" + "证据逐条列在这里。".repeat(60);
const CHILD_TOOL = "settings_read";

let parentTurns = 0;
let childTurns = 0;
/** 打开后子代理每轮都发一次调用、永不收工 ⇒ 用它去撞自己的轮数顶 */
let childNeverStops = false;

/** 父：第一轮派子代理，第二轮收尾。子：读一次设置，然后吐报告。两边都走同一个 fake provider。 */
const scripted: AgentProvider = async (messages) => {
  const goal = messages.find((m) => m.role === "user")?.content ?? "";
  if (goal.startsWith("child:")) {
    childTurns++;
    if (childNeverStops) {
      return { content: "", calls: [{ callId: `n${childTurns}`, name: CHILD_TOOL, arguments: "{}" }] };
    }
    if (childTurns === 1) {
      return { content: "先读一眼设置", calls: [{ callId: "x1", name: CHILD_TOOL, arguments: "{}" }] };
    }
    return { content: REPORT, calls: [] };
  }
  parentTurns++;
  if (parentTurns === 1) {
    return {
      content: "先派只读子代理去查帧尾",
      calls: [{ callId: "s1", name: "subagent", arguments: JSON.stringify({ goal: "child: 查帧尾是不是校验码" }) }],
    };
  }
  return { content: "按子代理的报告收尾", calls: [] };
};

const receipts = (events: readonly RunEvent[]) => events.filter((e) => e.kind === "receipt");
const toolsOf = (events: readonly RunEvent[]) => receipts(events).map((e) => e.tool);

async function oneDispatch(): Promise<string> {
  return agentRun.startRun({ goal: "sub 派一次子代理再收尾", scope: "create" });
}

beforeEach(() => {
  vi.mocked(invokeAgentProvider).mockReset();
  vi.mocked(invokeAgentProvider).mockImplementation(scripted);
  parentTurns = 0;
  childTurns = 0;
  childNeverStops = false;
  agentRun.resetForTests();
  settings.patch({ agentSubagent: true });
});

describe("P137 派发的实时过程：接得上、且放对位置", () => {
  it("子的逐轮事件进了那张内存表（旧实现一个回调都不传，这里必须拿到内容）", async () => {
    await oneDispatch();
    const live = agentRun.getSubRun("s1");
    expect(live).not.toBeNull();
    expect(live!.goal).toContain("child:");
    expect(toolsOf(live!.events)).toContain(CHILD_TOOL);
    expect(live!.done).toBe(true);
    expect(live!.status).toBe("succeeded");
    expect(live!.caps).toEqual({ maxRounds: 6, maxCalls: 16, timeoutMs: 180_000 });
    expect(live!.rounds).toBeGreaterThanOrEqual(1);
  });

  it("反向钉：子的逐轮不进父台账，父侧只留一条派发回执", async () => {
    const runId = await oneDispatch();
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(toolsOf(view.events).filter((t) => t === "subagent")).toHaveLength(1);
    expect(toolsOf(view.events)).not.toContain(CHILD_TOOL);
    // 台账里那条派发回执的 callId 就是内存表的键（渲染层靠它找回过程）
    const rec = receipts(view.events).find((e) => e.tool === "subagent")!;
    expect(rec.receipt!.callId).toBe("s1");
    expect(agentRun.getSubRun(rec.receipt!.callId)).not.toBeNull();
  });

  it("额度读数随回执走：caps 与实耗进了台账，所以重启后仍答得出「跑在哪个顶上」", async () => {
    const runId = await oneDispatch();
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    const data = asSubagentData(receipts(view.events).find((e) => e.tool === "subagent")!.receipt!.data);
    expect(data).not.toBeNull();
    expect(data!.caps).toEqual(SUBAGENT_CAPS);
    expect(typeof data!.elapsedMs).toBe("number");
    expect(data!.rounds).toBeGreaterThanOrEqual(1);
    expect(data!.answer).toBe(REPORT);
    expect(data!.capHit).toBeUndefined();
  });

  it("随父记录消失：removeRun / clearHistory 之后内存表里不留空壳", async () => {
    const runId = await oneDispatch();
    expect(agentRun.getSubRun("s1")).not.toBeNull();
    expect(agentRun.removeRun(runId)).toBe(true);
    expect(agentRun.getSubRun("s1")).toBeNull();

    // 脚本由轮次计数器驱动，第二次派发前要复位，否则父任务第一轮就直接收尾（= 没有派发可清）
    parentTurns = 0;
    childTurns = 0;
    await oneDispatch();
    expect(agentRun.getSubRun("s1")).not.toBeNull();
    agentRun.clearHistory();
    expect(agentRun.getSubRun("s1")).toBeNull();  });

  it("还在跑的那次派发才出现在实时行里（已完成的走卡片，不重复占一行）", async () => {
    await oneDispatch();
    const runId = agentRun.getSnapshot().runs[0].runId;
    expect(agentRun.liveSubRunsOf(runId)).toEqual([]);
  });

  it("子撞自己的轮数顶：回执要说得出是**哪一项**用尽，而不是只回一个终态", async () => {
    // 子代理每轮都发一次调用、永不收工 ⇒ 6 轮那一项先到线（`SUBAGENT_CAPS.maxRounds`）
    childNeverStops = true;
    const runId = await oneDispatch();
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    const rec = receipts(view.events).find((e) => e.tool === "subagent")!;
    expect(rec.receipt!.ok).toBe(false);
    expect(rec.receipt!.code).toBe("subagent_incomplete");
    const data = asSubagentData(rec.receipt!.data)!;
    expect(data.subStatus).toBe("paused");
    expect(data.capHit).toBe("rounds");
    expect(data.rounds).toBe(SUBAGENT_CAPS.maxRounds);
    // 内存表里同一件事也要答得出（界面上的"额度 6/6 轮"用的就是这份）
    const live = agentRun.getSubRun(rec.receipt!.callId)!;
    expect(live.rounds).toBe(SUBAGENT_CAPS.maxRounds);
  });
});

describe("P137 纯派生：渲染层只画这些结果", () => {
  const subData = {
    goal: "查帧尾", answer: "一".repeat(300), rounds: 3, calls: 5,
    toolsUsed: ["fs_read"], subStatus: "succeeded", note: "报告不是证据",
    caps: { maxRounds: 6, maxCalls: 16, timeoutMs: 180_000 }, elapsedMs: 42_000,
  };

  it("asSubagentData 认这个形状，别的形状一律不认（每个必填字段各摘掉一次）", () => {
    expect(asSubagentData(subData)).not.toBeNull();
    // 每条反例只缺/只坏**一个**字段：一次缺两个的反例会让前一道闸替它把关，那条守卫就红不了（§8-55③）
    expect(asSubagentData({ goal: "g", answer: "a", rounds: 1, calls: 1, subStatus: "ok" })).toBeNull();
    expect(asSubagentData({ ...subData, toolsUsed: "fs_read" })).toBeNull();
    expect(asSubagentData({ ...subData, answer: 42 })).toBeNull();
    expect(asSubagentData({ ...subData, subStatus: 1 })).toBeNull();
    expect(asSubagentData({ ...subData, rounds: "3" })).toBeNull();
    expect(asSubagentData(null)).toBeNull();
    expect(asSubagentData([])).toBeNull();
  });

  it("派发回执不走通用 160 字通道：正文与额度另有渲染处，其余键照旧列", () => {
    const rows = receiptRows(subData);
    expect(rows.some((r) => r.k === "answer")).toBe(false);
    expect(rows.some((r) => r.k === "caps")).toBe(false);
    expect(rows.some((r) => r.k === "elapsedMs")).toBe(false);
    expect(rows.some((r) => r.k === "goal" && r.v === "查帧尾")).toBe(true);
    // 对照：普通回执仍然照旧逐值列出并截到 160 字——这条不能因为特判而变松
    const plain = receiptRows({ note: "长".repeat(400), count: 2 });
    expect(plain.find((r) => r.k === "note")!.v).toHaveLength(160);
    expect(plain.map((r) => r.k)).toEqual(["note", "count"]);
  });

  it("subRunSteps 只列带回执的事件：轮次心跳与思维链不算「子代理做过的动作」", () => {
    const events: RunEvent[] = [
      { seq: 1, kind: "turn", text: "〔第 1 轮〕" },
      { seq: 2, kind: "reasoning", text: "先看看有哪些字段" },
      { seq: 3, kind: "receipt", tool: CHILD_TOOL, args: "{}", receipt: { callId: "x1", ok: true, status: "read" } },
      { seq: 4, kind: "status", text: "第 1 轮失败：上游空闲" },
      { seq: 5, kind: "receipt", tool: "fs_read", args: '{"path":"a.txt"}', receipt: { callId: "x2", ok: false, status: "error", code: "path_outside_whitelist" } },
      { seq: 6, kind: "context", text: "用量" },
    ];
    const steps = subRunSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0].v).toContain("已读取");
    expect(steps[1].v).toContain("路径不在白名单");
    expect(steps.every((s) => !s.v.includes("〔第 1 轮〕"))).toBe(true);
  });

  it("nestedSubagentUsage：可读的相加；只有『真跑过但被落盘省略』才计 lost，就地被拒的不算", () => {
    const events: RunEvent[] = [
      { seq: 1, kind: "receipt", tool: "subagent", receipt: { callId: "s1", ok: true, status: "read", data: subData } },
      { seq: 2, kind: "receipt", tool: "subagent", receipt: { callId: "s2", ok: true, status: "read" }, receiptTruncated: true },
      { seq: 3, kind: "receipt", tool: "subagent", receipt: { callId: "s3", ok: true, status: "read", data: { truncated: true, bytes: 9000 } } },
      // 就地被拒的派发：没烧过一分钱，绝不能算进"用量被省略"（那是一句谎话，§8-41）
      { seq: 4, kind: "receipt", tool: "subagent", receipt: { callId: "s4", ok: false, status: "not_executed", code: "subagent_disabled", data: { hint: "总开关未开启" } } },
      { seq: 5, kind: "receipt", tool: "settings_read", receipt: { callId: "s5", ok: true, status: "read", data: { revision: "r" } } },
    ];
    expect(nestedSubagentUsage(events)).toEqual({ rounds: 3, calls: 5, lost: 2 });
    expect(nestedSubagentUsage([])).toEqual({ rounds: 0, calls: 0, lost: 0 });
    expect(nestedSubagentUsage([events[3]])).toEqual({ rounds: 0, calls: 0, lost: 0 });
  });
});
