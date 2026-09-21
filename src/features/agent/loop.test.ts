import { afterEach, expect, it, vi } from "vitest";
import { runAgent, DEFAULT_BUDGET } from "./loop";
import type { AgentProvider, TaskAdapter, ToolCall, ToolReceipt } from "./types";

/** 投影断言用的最小形状（provider 收到的 messages 结构子集） */
interface AgentMessageLite { role: string; content: string }

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

it("oversized receipt data is truncated before feeding the model; ledger keeps full receipt", async () => {
  stubStorage();
  const big = "x".repeat(9 * 1024);
  let modelSawTruncated = false;
  let modelSawFakeRef = false;
  const provider: AgentProvider = async (messages) => {
    const toolMsg = messages.find((m) => m.role === "tool");
    if (toolMsg) {
      const d = JSON.parse(toolMsg.content).data;
      modelSawTruncated = d?.truncated === true;
      // P94-G3：二级兜底不许再凭空造 artifactRef（数据没入库，照着取必失败）
      modelSawFakeRef = Boolean(d?.artifactRef);
    }
    return { content: toolMsg ? "done" : "read", calls: toolMsg ? [] : [{ callId: "big", name: "echo", arguments: "{}" }] };
  };
  const result = await runAgent({ goal: "g", provider, adapter: echoAdapter(() => ({ callId: "big", ok: true, status: "read", data: big })), context: ctx() });
  expect(modelSawTruncated).toBe(true);
  expect(modelSawFakeRef).toBe(false);
  const ledger = result.events.find((e) => e.kind === "receipt")!.receipt!;
  expect(ledger.data).toBe(big); // 事件台账保留完整回执供 UI/导出
});

it("P94-G3：adapter 已裁过（带 artifactRef）的回执与 read_artifact 的分页结果都不再二次裁剪", async () => {
  stubStorage();
  const page = { ref: "call:x", from: 0, totalBytes: 30000, text: "y".repeat(9 * 1024), hasMore: true, nextFrom: 9216 };
  const seen: unknown[] = [];
  const provider: AgentProvider = async (messages) => {
    const toolMsg = messages.find((m) => m.role === "tool");
    if (toolMsg) seen.push(JSON.parse(toolMsg.content).data);
    return { content: toolMsg ? "done" : "read", calls: toolMsg ? [] : [{ callId: "x", name: "read_artifact", arguments: '{"ref":"call:x"}' }] };
  };
  const result = await runAgent({
    goal: "g",
    provider,
    adapter: echoAdapter((c) => ({
      callId: c.callId,
      ok: true,
      status: "read",
      data: c.name === "read_artifact" ? page : { truncated: true, artifactRef: "call:x", preview: "p", fullBytes: 30000 },
    })),
    context: ctx(),
  });
  expect(result.status).toBe("succeeded");
  const d = seen[0] as { text?: string; hasMore?: boolean };
  expect(d.text).toBe(page.text); // 原样送达，没被换成"指向未入库 key 的占位"
  expect(d.hasMore).toBe(true);
});

it("P95-H1/H2：超软顶先丢历史附图（本轮附图保留）并记一条 context 事件", async () => {
  stubStorage();
  const big = "data:image/png;base64," + "A".repeat(700 * 1024); // 单张 ~700KB
  const seen: { imgs: string[]; msgs: number }[] = [];
  const provider: AgentProvider = async (messages) => {
    seen.push({
      imgs: messages.flatMap((m) => m.images ?? []),
      msgs: messages.length,
    });
    return { content: "完成", calls: [] };
  };
  const history = [
    { role: "user" as const, content: "上一轮带的图", images: [big, big] },
    { role: "assistant" as const, content: "上一轮结论" },
  ];
  const result = await runAgent({
    goal: "看这张新图",
    images: [big],
    history,
    historyShadowed: 3,
    provider,
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
  });
  expect(result.status).toBe("succeeded");
  // 第一次送模型时历史图已被丢弃，本轮目标的图仍在
  expect(seen[0]?.imgs.length).toBe(1);
  const ctxEvt = result.events.find((e) => e.kind === "context" && e.ctx?.droppedImages);
  expect(ctxEvt?.ctx?.droppedImages).toBe(2);
  expect(ctxEvt?.ctx?.step).toBeDefined();
  expect(ctxEvt?.ctx?.shadowed).toBe(3);
  expect(ctxEvt?.text).toContain("历史截图");
  // 用量快照回传给 run 视图（AgentInline meta 行与复制日志都读它）
  expect(result.ctx?.peakBytes).toBeGreaterThan(0);
  expect(result.ctx?.last?.msgs).toBeGreaterThan(0);
});

it("P95-H1：连本轮附图都放不下时，本地判死并给得出可行动文案（不再打必然失败的请求）", async () => {
  stubStorage();
  const huge = "data:image/png;base64," + "B".repeat(3 * 1024 * 1024); // 单张就超软顶
  let called = 0;
  const provider: AgentProvider = async () => {
    called++;
    return { content: "x", calls: [] };
  };
  const result = await runAgent({
    goal: "这张超大图",
    images: [huge],
    provider,
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
  });
  expect(called).toBe(0); // 省掉一次必然失败的往返
  expect(result.status).toBe("failed");
  const line = result.events.find((e) => e.text?.startsWith("执行出错："))?.text ?? "";
  expect(line).toContain("KB");
  expect(line).toContain("拆成几次任务");
  // 机器码与内部结构绝不泄漏进时间线
  expect(line).not.toContain("agentError");
});

it("foldContext keeps head and recent turns when over soft limit; P95 报告折叠条数", async () => {
  const { foldContext, CONTEXT_SOFT_LIMIT, REQUEST_SOFT_LIMIT } = await import("./context");
  const filler = "y".repeat(20 * 1024);
  const messages = [
    { role: "system" as const, content: "SYS" },
    { role: "user" as const, content: "GOAL" },
    ...Array.from({ length: 12 }, (_, i) => ({ role: "assistant" as const, content: `turn${i} ${filler}` })),
  ];
  const r = foldContext(messages);
  const folded = r.messages;
  expect(folded[0].content).toBe("SYS");
  expect(folded[1].content).toBe("GOAL");
  expect(folded.length).toBeLessThan(messages.length);
  expect(folded[folded.length - 1].content).toContain("turn11");
  expect(folded.some((m) => m.role === "system" && m.content.includes("步骤摘要"))).toBe(true);
  // P95-H2：折了几条必须是可记账的数字（旧实现只返回数组，"折了多少"事后无从得知）
  // 总 14 条 = system + 目标 + 12 轮；头 2 条永不折、保留最近 8 条 ⇒ 中间 4 条进摘要
  expect(r.folded).toBe(4);
  expect(r.changed).toBe(true);
  // 未超软阈值时原样返回
  const small = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];
  const rs = foldContext(small);
  expect(rs.messages).toBe(small);
  expect(rs.folded).toBe(0);
  expect(CONTEXT_SOFT_LIMIT).toBeGreaterThan(0);
  // P95-H1：按字节目标继续收紧——越小的预算折得越多，且必然不超目标或已折到极限
  const tight = foldContext(messages, 60 * 1024);
  expect(tight.folded).toBeGreaterThan(r.folded);
  expect(REQUEST_SOFT_LIMIT).toBeGreaterThan(60 * 1024);
});

it("P90 B1/B6：思维链事件先于正文、不回灌模型；图片只挂首条 user 且折叠后仍在", async () => {
  stubStorage();
  const provider: AgentProvider = async () => ({ content: "完成", calls: [], reasoning: "先看现状再决定" });
  const result = await runAgent({
    goal: "把主题改深",
    images: ["data:image/png;base64,AAA"],
    provider,
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
  });
  const ri = result.events.findIndex((e) => e.kind === "reasoning");
  const ci = result.events.findIndex((e) => e.kind === "turn" && e.text === "完成");
  expect(ri).toBeGreaterThanOrEqual(0);
  expect(ci).toBeGreaterThan(ri);
  expect(result.events[ri]?.text).toBe("先看现状再决定");
  // 思维文本绝不进回灌历史（省 token，也防模型自我复述）
  expect(JSON.stringify(result.messages)).not.toContain("先看现状再决定");
  // 图片挂在首条 user 上，且经折叠仍保留
  const { foldContext } = await import("./context");
  expect(result.messages[1]).toMatchObject({ role: "user", images: ["data:image/png;base64,AAA"] });
  expect(foldContext(result.messages).messages[1]?.images).toEqual(["data:image/png;base64,AAA"]);
});

it("P90 B1：模型不产思维链时零 reasoning 事件（不留空卡）", async () => {
  stubStorage();
  const provider: AgentProvider = async () => ({ content: "完成", calls: [] });
  const result = await runAgent({
    goal: "g",
    provider,
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
  });
  expect(result.events.some((e) => e.kind === "reasoning")).toBe(false);
});

/* ================= P91 A2/A3/A4：单轮重试与续跑 ================= */

const hostErr = (code: string, msg: string, retryable: boolean, shrink = false) =>
  new Error(JSON.stringify({ agentError: 1, code, msg, retryable, shrink }));

it("P91 A3：可重试的单轮失败自动退避重试，成功后任务继续（不再一崩到底）", async () => {
  stubStorage();
  let calls = 0;
  const provider: AgentProvider = async () => {
    calls++;
    if (calls === 1) throw hostErr("provider_error", "模型服务在回复中途返回错误", true);
    return { content: "第二次成功", calls: [] };
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), retryBackoffMs: [1],
  });
  expect(calls).toBe(2);
  expect(result.status).toBe("succeeded");
  const note = result.events.find((e) => e.kind === "status" && (e.text ?? "").includes("自动重试"));
  expect(note?.text).toContain("模型服务在回复中途返回错误");
  expect(result.events.some((e) => (e.text ?? "").startsWith("执行出错"))).toBe(false);
});

it("P91 A3：不可重试类立即定因失败，一次都不多打", async () => {
  stubStorage();
  let calls = 0;
  const provider: AgentProvider = async () => { calls++; throw hostErr("config", "API Key 无效或无权限（401）", false); };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), retryBackoffMs: [1],
  });
  expect(calls).toBe(1);
  expect(result.status).toBe("failed");
  // 失败原因进台账（用户能看到"Key 无效"而不是笼统"失败"）
  expect(result.events.some((e) => (e.text ?? "").includes("API Key 无效"))).toBe(true);
});

it("P91 A3：重试上限 2 次；截断类逐级下调输出预算", async () => {
  stubStorage();
  const budgets: (number | undefined)[] = [];
  const provider: AgentProvider = async (_m, _t, _s, options) => {
    budgets.push(options?.maxTokens);
    throw hostErr("truncated", "模型输出达长度上限被截断（length）；未执行工具", true, true);
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), retryBackoffMs: [1],
  });
  expect(budgets).toEqual([16384, 8192, 4096]); // 首发 + 2 次重试，预算逐级降
  expect(result.status).toBe("failed");
  expect(result.events.filter((e) => e.kind === "status" && (e.text ?? "").includes("输出预算降至"))).toHaveLength(2);
});

it("P96-K4：失败轮已收的思考不再蒸发；第二次起关深度思考；计数实时上报", async () => {
  stubStorage();
  const thinks: (boolean | undefined)[] = [];
  const progress: [number, number][] = [];
  let attempts = 0;
  let n = 0;
  const provider: AgentProvider = async (_m, _t, _s, options) => {
    n++;
    thinks.push(options?.thinking);
    options?.onDelta?.("reasoning", `第${n}次尝试的思考`.repeat(8));
    if (n < 3) throw hostErr("provider_error", "模型服务在回复中途返回错误：Upstream idle timeout exceeded；未执行工具", true, true);
    return { content: "完成", calls: [] };
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), retryBackoffMs: [1],
    onAttemptStart: () => { attempts++; },
    onProgress: (r, c) => { progress.push([r, c]); },
  });
  expect(result.status).toBe("succeeded");
  // 首发不传（跟随设置项），重试显式 false —— 长静默正是上游按空闲掐断的诱因
  expect(thinks).toEqual([undefined, false, false]);
  expect(attempts).toBe(3);
  // 旧实现：失败即丢，2m48s 的思考在界面上蒸发 ⇒ 现在每次失败都留一条"未完成轮"事件
  const partials = result.events.filter((e) => e.kind === "reasoning" && (e.text ?? "").includes("未完成轮"));
  expect(partials).toHaveLength(2);
  expect(partials[0]?.text).toContain("第1次尝试的思考");
  expect(partials[1]?.text).toContain("第2次尝试的思考");
  // 计数实时报（旧实现只在 finalize 回填，跑满 6 分钟界面仍是 0/24）
  expect(progress[progress.length - 1]).toEqual([1, 0]);
});

it("P91 A3：重试途中被用户停止 → cancelled，不再发起第三次", async () => {
  stubStorage();
  const c = new AbortController();
  let calls = 0;
  const provider: AgentProvider = async () => {
    calls++;
    if (calls === 1) { setTimeout(() => c.abort(), 0); throw hostErr("timeout", "模型推理超时", true); }
    return { content: "不该走到这", calls: [] };
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: { source: "local_agent", runId: "t", signal: c.signal, scope: "create" }, retryBackoffMs: [20],
  });
  expect(result.status).toBe("cancelled");
  expect(calls).toBe(1);
});

it("P91 A1：思维链事件带真实思考时长；增量回调透传且不进台账", async () => {
  stubStorage();
  const seen: string[] = [];
  const provider: AgentProvider = async (_m, _t, _s, options) => {
    options?.onDelta?.("reasoning", "先想");
    await new Promise((r) => setTimeout(r, 12));
    options?.onDelta?.("reasoning", "一下");
    options?.onDelta?.("text", "正文");
    return { content: "正文", calls: [], reasoning: "先想一下" };
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), onDelta: (kind, text) => seen.push(`${kind}:${text}`),
  });
  expect(seen).toEqual(["reasoning:先想", "reasoning:一下", "text:正文"]);
  const rea = result.events.find((e) => e.kind === "reasoning");
  expect(rea?.ms).toBeGreaterThanOrEqual(10); // 旧实现恒 0s 的假值已被真实时长取代
  expect(result.events.filter((e) => e.text === "先想" || e.text === "一下")).toHaveLength(0);
});

it("P91 A4：resumeFrom 续跑保留历史、补齐 system、seq 从 seqBase 续号", async () => {
  stubStorage();
  const history = [
    { role: "user" as const, content: "原目标" },
    { role: "assistant" as const, content: "读现状", calls: [{ callId: "c1", name: "echo", arguments: "{}" }] },
    { role: "tool" as const, callId: "c1", content: "{\"ok\":true}" },
  ];
  const provider: AgentProvider = async (messages) => {
    expect(messages[0].role).toBe("system"); // 骨架缺 system → loop 补齐且不重复
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages[1]).toMatchObject({ role: "user", content: "原目标" });
    expect(messages[messages.length - 1]).toMatchObject({ role: "tool", callId: "c1" });
    return { content: "接着做完", calls: [] };
  };
  const result = await runAgent({
    goal: "ignored", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), resumeFrom: history, seqBase: 7,
  });
  expect(result.status).toBe("succeeded");
  expect(result.events[0].seq).toBe(8);
  expect(result.messages.length).toBeGreaterThan(history.length);
});

it("P92 A2：history 注入会话先前上下文——一份 system、历史在目标之前、目标仍是最后一条 user", async () => {
  stubStorage();
  let seen: AgentMessageLite[] = [];
  const provider: AgentProvider = async (messages) => {
    seen = messages as unknown as AgentMessageLite[];
    return { content: "接着做", calls: [] };
  };
  const result = await runAgent({
    goal: "切常规创造", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
    history: [
      { role: "system", content: "不该再来一份 system" },
      { role: "user", content: "先看现状再决定" },
      { role: "assistant", content: "已看，建议 A/B 两种落地" },
    ],
  });
  expect(result.status).toBe("succeeded");
  expect(seen.filter((m) => m.role === "system")).toHaveLength(1); // 唯一一份系统提示
  expect(seen[0].content).not.toContain("不该再来一份");
  expect(seen[1].content).toBe("先看现状再决定"); // 上一轮对话在前
  expect(seen[2].content).toBe("已看，建议 A/B 两种落地");
  expect(seen[3]).toMatchObject({ role: "user", content: "切常规创造" }); // 本轮目标在最后
});

it("P91 E：失败文案对用户可读——机器码与 Rust Debug 串绝不进时间线", async () => {
  stubStorage();
  const provider: AgentProvider = async () => {
    throw new Error(JSON.stringify({ agentError: 1, code: "provider_error", msg: "模型服务在回复中途返回错误：upstream timeout（timeout）；未执行工具", retryable: false, shrink: false }));
  };
  const result = await runAgent({
    goal: "g", provider, adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), retryBackoffMs: [1],
  });
  const wire = JSON.stringify(result.events);
  expect(result.status).toBe("failed");
  expect(wire).toContain("模型服务在回复中途返回错误");
  for (const leak of ["agentError", "Some(", "[object Object]", "retryable", "undefined", "null"]) {
    expect(wire).not.toContain(leak);
  }
});

/* ======================= P99a-C1 §6.2：每轮注入宿主事实 ======================= */

it("P99a-C1：事实每轮重算、只注进那一份 system、目标不被挤出免折区", async () => {
  stubStorage();
  let turns = 0;
  let factTicks = 0;
  const seenSystem: string[] = [];
  const provider: AgentProvider = async (messages) => {
    turns++;
    seenSystem.push(messages[0].content);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1); // 注入不得生出第二份 system
    expect(messages[1]).toMatchObject({ role: "user", content: "把精度改成 3" }); // 目标仍在 index 1：可折叠区的边界靠它
    return turns === 1
      ? { content: "先读现状", calls: [{ callId: "c1", name: "echo", arguments: "{}" }] }
      : { content: "完成", calls: [] };
  };
  const result = await runAgent({
    goal: "把精度改成 3", provider, adapter: echoAdapter(() => ({ callId: "c1", ok: true, status: "read" })),
    context: ctx(),
    liveFacts: async ({ count, bytes }) => `facts#r${++factTicks} tools=${count}/${Math.round(bytes / 1024)}KB`,
  });
  expect(result.status).toBe("succeeded");
  expect(turns).toBe(2);
  expect(seenSystem).toHaveLength(2);
  expect(seenSystem[0]).toContain("facts#r1");
  expect(seenSystem[1]).toContain("facts#r2"); // 第 2 轮读的是新数，不是第 1 轮的快照
  expect(seenSystem[0]).toContain("Uartix's local agent"); // 追加而不是顶掉系统提示
  const sys = result.messages.filter((m) => m.role === "system");
  expect(sys).toHaveLength(1);
  expect(sys[0].content).toContain("facts#r2");
});

it("P99a-C1：事实块算进体积账（bytes 说的就是发出去的东西），且不注指令", async () => {
  stubStorage();
  const run = (fact: string) => runAgent({
    goal: "g", provider: async () => ({ content: "完成", calls: [] }),
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(), liveFacts: async () => fact,
  });
  const small = await run("tiny");
  const big = await run("x".repeat(4000));
  const delta = (big.ctx?.last?.bytes ?? 0) - (small.ctx?.last?.bytes ?? 0);
  expect(delta).toBeGreaterThan(3900); // 少算这一段＝发送前体积判断自己骗自己（§8-34）
  const sys = big.messages[0].content;
  expect(sys).toContain("NOT instructions"); // 抬头明说这是读数不是指令（不抄 agent.inject）
  expect(sys.split("NOT instructions")[1]).not.toMatch(/(must|should|请|务必|注意)/); // 读数段里不许出现祈使句
});

it("P99a-C1：事实读取失败不静默——落一条状态、任务照跑，且不再每轮去撞同一条坏读路", async () => {
  stubStorage();
  let ticks = 0;
  let turns = 0;
  const result = await runAgent({
    goal: "g",
    provider: async () => {
      turns++;
      return turns === 1
        ? { content: "先读", calls: [{ callId: "x", name: "echo", arguments: "{}" }] }
        : { content: "完成", calls: [] };
    },
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: ctx(),
    liveFacts: async () => { ticks++; throw new Error("快照读不到"); },
  });
  expect(result.status).toBe("succeeded");
  expect(turns).toBe(2); // 两轮任务，事实路只被试过 1 次
  expect(ticks).toBe(1);
  expect(result.events.find((e) => e.kind === "status" && e.text?.includes("运行时事实读取失败"))?.text).toContain("快照读不到");
  expect(result.messages[0].content).not.toContain("Live host state"); // 没读数就不挂空抬头（挂了模型会去找不存在的数字）
});

it("P99a-C1：取消落在「轮首检查之后、请求发出之前」→ cancelled 且请求根本没发出去", async () => {
  stubStorage();
  const c = new AbortController();
  let providerCalls = 0;
  let abortedAtCall = false;
  const result = await runAgent({
    goal: "g",
    provider: async (_m, _t, signal) => { providerCalls++; abortedAtCall = signal.aborted; return { content: "不该到这", calls: [] }; },
    adapter: echoAdapter(() => ({ callId: "x", ok: true, status: "read" })),
    context: { source: "local_agent", runId: "t", signal: c.signal, scope: "create" },
    // 用事实刷新当"轮首检查之后"的那个 await 点：真机上对应臂模块/建 Worker 的几百毫秒
    liveFacts: async () => { c.abort(); return "aborted-during-facts"; },
  });
  expect(result.status).toBe("cancelled");
  expect(providerCalls).toBe(0); // 旧实现这里会带已 aborted 的 signal 发请求：监听器永不触发 ⇒ run 永远停在 running
  expect(abortedAtCall).toBe(false);
  expect(JSON.stringify(result.events)).toContain("任务已取消：本轮请求未发送");
});
