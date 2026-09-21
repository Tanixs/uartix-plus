/**
 * P91 B1：时间线合成器单测——钉死"任务卡不再沉底"这件事本身。
 */
import { describe, expect, it } from "vitest";
import { buildTimeline } from "./timeline";
import type { ChatMsg } from "../ai/chatStore";
import type { AgentRunView } from "./agentRun";

const msg = (id: string, ts: number, role: "user" | "assistant" = "user"): ChatMsg => ({ id, role, content: id, ts });
const run = (runId: string, createdAt: number): AgentRunView => ({
  runId, goal: runId, goalBrief: runId, scope: "create", status: "running",
  rounds: 0, calls: 0, caps: { maxRounds: 24, maxCalls: 64, deadlineAt: 0 },
  createdAt, updatedAt: createdAt, events: [], pending: null, undoState: {},
});

const shape = (items: ReturnType<typeof buildTimeline>) => items.map((i) => `${i.kind}:${i.key.slice(2)}`);

describe("buildTimeline", () => {
  it("任务卡紧跟发起它的用户消息，之后的新消息排在它下面（不再沉底）", () => {
    const t = buildTimeline(
      [msg("u1", 100), msg("a1", 120), msg("u2", 200), msg("a2", 260)],
      [run("r1", 101)],
    );
    expect(shape(t)).toEqual(["msg:u1", "run:r1", "msg:a1", "msg:u2", "msg:a2"]);
  });

  it("同刻并列时消息在前（appendUserMessage 先落、startRun 后起）", () => {
    const t = buildTimeline([msg("u1", 100)], [run("r1", 100)]);
    expect(shape(t)).toEqual(["msg:u1", "run:r1"]);
  });

  it("多个任务各自锚在自己的发起消息后，顺序按时间", () => {
    const t = buildTimeline(
      [msg("u1", 100), msg("u2", 300), msg("u3", 500)],
      [run("rB", 301), run("rA", 101)],
    );
    expect(shape(t)).toEqual(["msg:u1", "run:rA", "msg:u2", "run:rB", "msg:u3"]);
  });

  it("续跑不搬家：retryRun 保留原 createdAt，任务卡留在原位", () => {
    const r = run("r1", 101);
    r.status = "failed";
    const t = buildTimeline([msg("u1", 100), msg("u2", 400)], [r]);
    expect(shape(t)).toEqual(["msg:u1", "run:r1", "msg:u2"]);
  });

  it("空态与只有任务（消息被删光）都不抛", () => {
    expect(buildTimeline([], [])).toEqual([]);
    expect(shape(buildTimeline([], [run("r1", 5)]))).toEqual(["run:r1"]);
  });
});
