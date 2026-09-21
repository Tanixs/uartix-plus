/**
 * P92 A1/A2：会话事件日志与投影出口的单测（移植 dsh 的 session 合同）。
 * 这组测试钉的是"模型看到什么由日志决定，而日志永远说真话"这件事：
 * 遮蔽不改写、截断不回灌、孤儿回执不下发、一次性令牌不外流、同输入投影可重放。
 */
import { describe, expect, it } from "vitest";
import { buildAgentHistory, buildSessionLog, projectMessages, type SessionEvent } from "./sessionLog";
import type { ChatMsg } from "../ai/chatStore";
import type { AgentRunView } from "./agentRun";
import type { ToolReceipt } from "./types";

const msg = (id: string, ts: number, role: "user" | "assistant", content: string): ChatMsg => ({ id, role, content, ts });

const run = (over: Partial<AgentRunView> & { events: AgentRunView["events"] }): AgentRunView => ({
  runId: "r1", goal: "把面板做成玻璃", goalBrief: "把面板做成玻璃", scope: "create", status: "succeeded",
  rounds: 2, calls: 1, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 0 },
  createdAt: 100, updatedAt: 500, finishedAt: 500, sessionId: "s1", pending: null, undoState: {},
  ...over,
});

const rec = (callId: string, extra: Partial<ToolReceipt> = {}): ToolReceipt => ({ callId, ok: true, status: "applied", ...extra });

describe("buildSessionLog", () => {
  it("消息与任务按时间归并成一条共享 seq 的事件流", () => {
    const ev = buildSessionLog(
      [msg("u1", 50, "user", "先看现状"), msg("a1", 80, "assistant", "已看")],
      [run({
        events: [
          { seq: 1, ts: 100, kind: "turn", text: "〔第 1 轮〕" },
          { seq: 2, ts: 120, kind: "turn", text: "读外观 token" },
          { seq: 3, ts: 130, kind: "receipt", tool: "read_appearance", args: "{}", receipt: rec("t1") },
          { seq: 4, ts: 200, kind: "turn", text: "玻璃配方已套用" },
        ],
      })],
    );
    expect(ev.map((e) => e.kind)).toEqual([
      "user/message", "assistant/message", "turn/start",
      "assistant/message/attempt", "tool/call", "tool/result", "assistant/message/attempt", "turn/end",
    ]);
    expect(ev.every((e, i) => e.seq === i + 1)).toBe(true);
    expect(ev.every((e, i) => i === 0 || e.ts >= ev[i - 1].ts)).toBe(true);
  });

  it("脚手架不进日志（心跳、失败叙述、结束行、纯错误占位）", () => {
    const ev = buildSessionLog(
      [{ id: "e1", role: "assistant", content: "", ts: 1, error: "网络失败" } as ChatMsg],
      [run({
        events: [
          { seq: 1, ts: 100, kind: "turn", text: "〔第 1 轮〕" },
          { seq: 2, ts: 110, kind: "status", text: "第 1 轮失败：模型服务返回错误；自动重试 1/2" },
          { seq: 3, ts: 120, kind: "turn", text: "执行出错：模型服务返回错误" },
          { seq: 4, ts: 130, kind: "status", text: "succeeded" },
        ],
      })],
    );
    expect(ev.map((e) => e.kind)).toEqual(["turn/start", "turn/end"]);
  });
});

describe("projectMessages", () => {
  const base = (events: SessionEvent[]) => projectMessages(events);

  it("连续 assistant 文本合并成一条，工具调用挂在同一条 assistant 上", () => {
    const m = base([
      { seq: 1, ts: 1, kind: "user/message", text: "目标" },
      { seq: 2, ts: 2, kind: "assistant/message/attempt", text: "先读" },
      { seq: 3, ts: 3, kind: "tool/call", callId: "c1", tool: "settings_read", args: "{}" },
      { seq: 4, ts: 4, kind: "tool/result", callId: "c1", receipt: rec("c1") },
      { seq: 5, ts: 5, kind: "assistant/message/attempt", text: "再改" },
    ]).messages;
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(m[1].calls).toEqual([{ callId: "c1", name: "settings_read", arguments: "{}" }]);
  });

  it("孤儿回执不下发（没有对应 call 的 result 会让模型以为发生过一次写入）", () => {
    const m = base([
      { seq: 1, ts: 1, kind: "tool/result", callId: "ghost", receipt: rec("ghost") },
      { seq: 2, ts: 2, kind: "user/message", text: "x" },
    ]).messages;
    expect(m.map((x) => x.role)).toEqual(["user"]);
  });

  it("参数被截断过的调用整对丢弃，并留一条说明（P92 D1 的投影侧）", () => {
    const r = base([
      { seq: 1, ts: 1, kind: "assistant/message/attempt", text: "我来保存" },
      { seq: 2, ts: 2, kind: "tool/call", callId: "c9", tool: "save_plugin", args: '{"name":"玻璃"', argsTruncated: true },
      { seq: 3, ts: 3, kind: "tool/result", callId: "c9", receipt: rec("c9") },
    ]);
    // 叙述保留（它是真话），但那支调用的"我要用什么参数"不回灌（半截参数是假话）
    expect(r.messages.map((x) => x.role)).toEqual(["assistant", "system"]);
    expect(r.messages[0].calls ?? []).toHaveLength(0);
    expect(r.messages[1].content).toContain("1 次工具调用");
    expect(JSON.stringify(r.messages)).not.toContain("save_plugin");
  });

  it("撤销令牌不回灌（跨轮复用即误撤销）", () => {
    const m = base([
      { seq: 1, ts: 1, kind: "tool/call", callId: "c1", tool: "theme_patch", args: "{}" },
      { seq: 2, ts: 2, kind: "tool/result", callId: "c1", receipt: rec("c1", { undoToken: "tok-123" }) },
    ]).messages;
    expect(JSON.stringify(m)).not.toContain("tok-123");
  });

  it("超预算从最旧端遮蔽，日志本身不被改写（遮蔽不删）", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push({ seq: i + 1, ts: i, kind: i % 2 ? "assistant/message" : "user/message", text: `第 ${i} 条`.padEnd(200, "x") });
    }
    const r = projectMessages(events, { budgetChars: 1000 });
    expect(r.shadowed).toBeGreaterThan(0);
    expect(r.messages[0].role).toBe("system");
    expect(r.messages[0].content).toContain(`更早 ${r.shadowed} 条`);
    expect(r.chars).toBeLessThanOrEqual(1000);
    // 重放稳定：同输入两次投影结果一致，且事件数组没被改
    const again = projectMessages(events, { budgetChars: 1000 });
    expect(again.messages).toEqual(r.messages);
    expect(events.length).toBe(30);
    expect(events[0].seq).toBe(1);
  });

  it("excludeRunId 排除当前 run（续跑不把自己的过程当历史读两遍）", () => {
    const r = projectMessages(
      [
        { seq: 1, ts: 1, kind: "user/message", text: "别的" },
        { seq: 2, ts: 2, kind: "assistant/message/attempt", text: "本 run 的过程", runId: "r1" },
      ],
      { excludeRunId: "r1" },
    ).messages;
    expect(r.map((m) => m.content)).toEqual(["别的"]);
  });

  it("空日志投影为空数组（新会话第一次任务不多塞东西）", () => {
    const r = projectMessages([]);
    expect(r.messages).toEqual([]);
    expect(r.shadowed).toBe(0);
  });
});

/** P94-G2/G5：日志说真话的另一半——被省略的回执、半截话、历史图片都得有明确口径 */
describe("P94 投影口径", () => {
  it("落盘被省略的回执：仍下发状态，并追加一条说明（不让模型以为「当时什么都没发生」）", () => {
    const msgs = projectMessages([
      { seq: 1, ts: 1, kind: "user/message", text: "改主题" },
      { seq: 2, ts: 2, kind: "tool/call", callId: "c1", tool: "theme_patch", args: "{}" },
      { seq: 3, ts: 3, kind: "tool/result", callId: "c1", receipt: rec("c1"), receiptTruncated: true },
    ]).messages;
    const tool = msgs.find((m) => m.role === "tool");
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool!.content).status).toBe("applied");
    const note = msgs.find((m) => m.role === "system" && m.content.includes("持久化上限"));
    expect(note?.content).toContain("1 次");
  });

  it("被中止/出错的轮次保留正文但加统一前缀标记", () => {
    const ev = buildSessionLog(
      [
        { id: "a1", role: "assistant", content: "这是我读到一半", ts: 10, aborted: true },
        { id: "a2", role: "assistant", content: "报错前写了半句", ts: 20, error: "网关超时" },
        { id: "a3", role: "assistant", content: "", ts: 30, error: "网关超时" },
      ] as ChatMsg[],
      [],
    );
    expect(ev.map((e) => e.kind)).toEqual(["assistant/message", "assistant/message"]); // 纯错误占位仍不进日志
    expect(ev[0].incomplete).toBe("aborted");
    expect(ev[1].incomplete).toBe("error");
    const msgs = projectMessages(ev).messages;
    expect(msgs[0].content).toContain("被用户中止");
    expect(msgs[0].content).toContain("这是我读到一半");
  });

  it("历史图片只对最近 3 条带图 user 透传，其余仍保留文字", () => {
    const withImg = (id: string, ts: number): ChatMsg =>
      ({ id, role: "user", content: id, ts, images: [`data:image/png;base64,${id}`] });
    const ev = buildSessionLog(
      [withImg("u1", 1), withImg("u2", 2), withImg("u3", 3), withImg("u4", 4)],
      [],
    );
    const msgs = projectMessages(ev).messages;
    expect(msgs.map((m) => m.images?.length ?? 0)).toEqual([0, 1, 1, 1]);
  });

  it("buildAgentHistory：从某条重发时，该条及其后被截断的内容不得进历史", () => {
    const messages = [
      msg("u1", 10, "user", "第一个任务"),
      msg("a1", 20, "assistant", "结论一"),
      msg("u2", 30, "user", "第二个任务"), // ← 从这条重发：它和之后的都要先剔掉
      msg("a2", 40, "assistant", "旧结论二"),
    ];
    const history = buildAgentHistory(messages, [], { excludeFromMsgId: "u2" });
    expect(history.messages.map((m) => m.content)).toEqual(["第一个任务", "结论一"]);
    // 不传 exclude 时保持原行为（含全部先前消息）；P95-H2：连同 stats 一起返回
    const all = buildAgentHistory(messages, []);
    expect(all.messages.length).toBe(4);
    expect(all.stats).toMatchObject({ shadowed: 0, chars: expect.any(Number) });
  });
});
