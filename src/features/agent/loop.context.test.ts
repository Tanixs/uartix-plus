/**
 * P134-A · "每轮到底送给模型多少"的可复核断言。
 *
 * 起因是一句观察："上下文好像每次重新发送对话就会变少、自动压缩"。这句话可证伪，所以不写成注释，
 * 写成测试：把 provider 收到的每一轮 payload 全量记下来，然后问五件事——
 * ① 没到线时是不是真的全量重发（是，且必须一直是）；
 * ② 到线之后折叠会不会**毁掉台账**（不会：折叠只作用于这一轮发出去的那份）；
 * ③ 折叠阶梯放不下时是不是真的放不下（实测修掉一处"第一级就收工"的假溢出）；
 * ④ 折叠边界会不会把"一次调用"和"它的回执"劈开（对标 DSH：不会）；
 * ⑤ 宿主对模型许的诺（"有 N 条被省略"、"可用 read_artifact 取回"）是不是真送到、真兑得上。
 * §8-41：对模型的承诺要有守卫，没有守卫的承诺等于没有承诺。
 */
import { expect, it } from "vitest";
import { runAgent } from "./loop";
import { agentPayloadBytes, foldContext, markStaleArtifacts, REQUEST_SOFT_LIMIT } from "./context";
import { historyCharBudget } from "./contextBudget";
import type { AgentMessage, AgentProvider, TaskAdapter, ToolReceipt } from "./types";

const ctx = () => ({
  source: "local_agent" as const,
  runId: "t",
  signal: new AbortController().signal,
  scope: "create" as const,
});

/** 记每一轮 provider 实际收到的消息（折叠会换新数组，所以必须逐轮快照） */
function recorder(): { rounds: AgentMessage[][]; snap: (m: AgentMessage[]) => void } {
  const rounds: AgentMessage[][] = [];
  return { rounds, snap: (m) => rounds.push(m.map((x) => ({ ...x }))) };
}

/**
 * capped=true 模仿**生产管线**裁过的形状：带 artifactRef。
 * 不带 ref 的大回执会先被 loop 自己的第二级 shrinkReceipt 换成 2KB 预览（那是绕过管线的适配器才走的路径），
 * 那样根本到不了折叠——所以测折叠必须用生产的形状。
 */
function echoAdapter(payload: string, capped = false): TaskAdapter {
  return {
    definitions: [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} } }],
    async execute(call): Promise<ToolReceipt> {
      return {
        callId: call.callId, ok: true, status: "read",
        data: capped ? { artifactRef: `call:${call.callId}`, text: payload } : { text: payload },
      };
    },
  };
}

async function runTurns(rounds: number, receiptBytes: number, rec: ReturnType<typeof recorder>, capped = false) {
  let turn = 0;
  const provider: AgentProvider = async (messages) => {
    rec.snap(messages);
    turn++;
    if (turn > rounds) return { content: "done", calls: [] };
    return { content: `step ${turn}`, calls: [{ callId: `c${turn}`, name: "echo", arguments: "{}" }] };
  };
  return runAgent({
    goal: "measure the per-round payload", provider,
    adapter: echoAdapter("x".repeat(receiptBytes), capped),
    context: ctx(), maxRounds: rounds + 4, maxCalls: rounds + 4, timeoutMs: 0,
  });
}

const SENTINEL = "x".repeat(64);

it("没到软顶时确实是全量重发：第 1 轮的回执原文在第 8 轮里逐字还在", async () => {
  const rec = recorder();
  const r = await runTurns(8, 6_000, rec); // 8 × 6KB ≈ 48KB，远低于 1.6MB 软顶
  expect(r.status).toBe("succeeded");
  const bytes = rec.rounds.map((m) => agentPayloadBytes(m));
  // 单调不减：这一条钉的就是"每轮变少"这个说法本身——没到线之前它不该变少
  for (let i = 1; i < bytes.length; i++) {
    expect(bytes[i], `第 ${i + 1} 轮比上一轮小（${bytes[i]} < ${bytes[i - 1]}）⇒ 有东西被静默丢掉了`)
      .toBeGreaterThanOrEqual(bytes[i - 1]!);
  }
  const last = rec.rounds[rec.rounds.length - 1]!;
  const first = last.find((m) => m.role === "tool" && m.callId === "c1");
  expect(first, "第 1 轮的工具回执在最后一轮不见了").toBeTruthy();
  expect(first!.content).toContain(SENTINEL); // 回执原文逐字还在（消息数与字节都另有断言在管）
  // 第 1 轮那条"送模型 N 条 · 约 X KB"是基线读数，不等于发生了压缩
  const shrunk = r.events.filter((e) => e.kind === "context").filter((e) => (e.ctx?.folded ?? 0) > 0 || (e.ctx?.droppedImages ?? 0) > 0);
  expect(shrunk, "远未软顶却发生了丢图/折叠").toEqual([]);
});

it("超软顶才折叠，且折叠只作用于发出去的那一份：台账本体不许被改写", async () => {
  const rec = recorder();
  // 10 × 400KB：越过软顶，但"只留最近 2 条"放得下 ⇒ 走的是折叠成功这条路，不是 context_overflow
  const r = await runTurns(10, 400_000, rec, true);
  const fold = r.events.find((e) => e.kind === "context" && e.text?.includes("超软顶"));
  expect(fold, "10 条巨型回执还没触发折叠，这条测试就没测到折叠路径").toBeTruthy();
  expect(fold!.ctx!.folded ?? 0, "折叠事件里没有 folded 计数（折了多少必须可复盘）").toBeGreaterThan(0);
  expect(r.status, "折叠没收进预算，任务被溢出判死").toBe("succeeded");
  const kept = r.messages.filter((m) => m.role === "tool");
  expect(kept).toHaveLength(10);
  for (const m of kept) expect(m.content).toContain(SENTINEL);
  expect(r.ctx?.peakBytes ?? 0, "峰值字节没记账（输入区那条用量条读的就是它）").toBeGreaterThan(0);
});

/* ============ 折叠边界：不许劈开"一次调用"和"它的回执"（对标 DSH toolPairingBalancedBefore） ============ */

/** 造一份"最近一条恰好是 tool"的历史：朴素的按条数切会把 assistant 调用与它的回执劈开 */
function pairHeavy(n: number, chars: number): AgentMessage[] {
  const out: AgentMessage[] = [{ role: "system", content: "prompt" }, { role: "user", content: "goal" }];
  for (let i = 0; i < n; i++) {
    out.push({ role: "assistant", content: `第 ${i} 步`, calls: [{ callId: `k${i}`, name: "echo", arguments: "{}" }] });
    out.push({ role: "tool", callId: `k${i}`, content: JSON.stringify({ callId: `k${i}`, ok: true, status: "read", text: "z".repeat(chars) }) });
  }
  return out;
}

function orphanTools(msgs: AgentMessage[]): string[] {
  const declared = new Set<string>();
  for (const m of msgs) for (const c of m.calls ?? []) declared.add(c.callId);
  return msgs.filter((m) => m.role === "tool" && m.callId && !declared.has(m.callId)).map((m) => m.callId!);
}

it("折叠边界不会留下孤儿回执", () => {
  /* 形状要故意"不整齐"：DSH 的循环里一轮可以产出"正文 + 若干调用"，尾部那条常常是一句
     没有调用的 assistant 文本。这种奇数长度下，按条数切的边界恰好落在**回执**上——
     上一版夹具用的是整齐的双数长度，边界永远切在 assistant 上，删掉配对保护也不红（实测）。 */
  const heavy = pairHeavy(12, 200_000);
  const msgs: AgentMessage[] = [...heavy, { role: "assistant", content: "上面这些先记着，我再想想" }];
  const folded = foldContext(msgs, REQUEST_SOFT_LIMIT);
  expect(folded.folded, "这份历史没触发折叠，测不到边界").toBeGreaterThan(0);
  expect(orphanTools(folded.messages), "发出去的载荷里有孤儿 tool（Anthropic 会 400，模型也会以为存在一次没发生的调用）").toEqual([]);
  // 反向自证：同一份数据按"朴素按条数切"必须真的产生孤儿，否则上面那条只是运气好
  const naive = [...msgs.slice(0, 2), { role: "system" as const, content: "（摘要）" }, ...msgs.slice(msgs.length - 2)];
  expect(orphanTools(naive).length, "探针失效：朴素切法也没产生孤儿，那这条自证证明不了任何事").toBeGreaterThan(0);
});

it("折叠摘要里「能不能取回原文」跟着事实走，不许无条件承诺 read_artifact", () => {
  const said = foldContext(pairHeavy(8, 200_000), REQUEST_SOFT_LIMIT).messages.find((m) => m.content.includes("较早"))!.content;
  expect(said).not.toContain("可用 read_artifact 取回");
  expect(said).toContain("重新调用");
  const withRef = pairHeavy(8, 20_000).map((m) => (m.role === "tool"
    ? { ...m, content: m.content.replace('"status":"read"', '"status":"read","artifactRef":"call:k1"') }
    : m));
  const got = foldContext(withRef, 120_000).messages.find((m) => m.content.includes("较早"))!.content;
  expect(got).toContain("read_artifact");
});

/* ================= 对模型许的诺必须真的送到（P134-A 的主案） ================= */

it("续跑时宿主写的「续跑说明」必须真的送到模型，不能在半路被 system 过滤掉", async () => {
  const rounds: AgentMessage[][] = [];
  const skeleton: AgentMessage[] = [
    { role: "user", content: "把面板 A 改成深色" },
    { role: "assistant", content: "先看现状", calls: [{ callId: "c1", name: "echo", arguments: "{}" }] },
    { role: "tool", callId: "c1", content: JSON.stringify({ callId: "c1", ok: true, status: "read" }) },
    // rebuildMessages 在参数超出台账上限时追加的正是这一条
    { role: "system", content: "（续跑说明：先前有 2 次工具调用的参数超出台账上限，未纳入本历史；它们确实已执行过，请勿据此重复写入。）" },
  ];
  let turn = 0;
  const provider: AgentProvider = async (messages) => {
    rounds.push(messages.map((m) => ({ ...m })));
    turn++;
    return { content: turn === 1 ? "继续" : "done", calls: turn === 1 ? [{ callId: "c9", name: "echo", arguments: "{}" }] : [] };
  };
  const r = await runAgent({
    goal: "把面板 A 改成深色", provider, adapter: echoAdapter("y"), context: ctx(),
    resumeFrom: skeleton, maxRounds: 3, timeoutMs: 0,
  });
  expect(r.status).toBe("succeeded");
  const sent = rounds[0]!;
  expect(sent.map((m) => m.content).join("\n"), "续跑说明没送到模型：它会在不知道「有步骤被省略」的前提下决定重做写入").toContain("续跑说明");
  expect(sent.filter((m) => m.role === "system")).toHaveLength(1); // 并进那一份 system，不是新插一条
});

it("会话投影写的「省略说明」必须送到模型，且提示词仍然只有一份", async () => {
  const rounds: AgentMessage[][] = [];
  const history: AgentMessage[] = [
    { role: "user", content: "上一轮：帮我把曲线面板调暗" },
    { role: "assistant", content: "已调暗" },
    { role: "system", content: "（更早 12 条会话记录已省略以适配上下文预算。）" },
    { role: "system", content: "（先前 3 次工具调用的参数超出台账上限，未纳入本历史；它们确实已执行过，请勿据此重复写入。）" },
  ];
  let turn = 0;
  const provider: AgentProvider = async (messages) => {
    rounds.push(messages.map((m) => ({ ...m })));
    turn++;
    return { content: turn === 1 ? "先看现状" : "done", calls: [] };
  };
  await runAgent({ goal: "再把网格线去掉", provider, adapter: echoAdapter("z"), context: ctx(), history, maxRounds: 3, timeoutMs: 0 });
  const sent = rounds[0]!;
  const text = sent.map((m) => m.content).join("\n");
  expect(text).toContain("更早 12 条会话记录已省略");
  expect(text).toContain("请勿据此重复写入");
  expect(sent.filter((m) => m.role === "system" && m.content.includes("Uartix"))).toHaveLength(1);
  expect(text).toContain("帮我把曲线面板调暗"); // 历史正文没被这次合并弄丢
});

it("大批历史压进来时，压缩发生且「省略说明」仍在最终送出的那份里", async () => {
  const rec = recorder();
  let turn = 0;
  const provider: AgentProvider = async (messages) => {
    rec.snap(messages);
    turn++;
    return { content: turn === 1 ? "先看现状" : "done", calls: [] };
  };
  const heavy: AgentMessage[] = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user", content: `h${i} ${"y".repeat(200_000)}`,
  }));
  await runAgent({
    goal: "接着上次", provider, adapter: echoAdapter("z"), context: ctx(),
    history: [...heavy, { role: "system", content: "（更早 40 条会话记录已省略以适配上下文预算。）" }],
    maxRounds: 3, timeoutMs: 0,
  });
  const sent = rec.rounds[0]!;
  expect(sent.map((m) => m.content).join("\n"), "预算收紧时先把说明丢了：模型会以为上一轮什么都没发生").toContain("更早 40 条会话记录已省略");
  expect(sent.filter((m) => m.role === "system" && m.content.includes("Uartix"))).toHaveLength(1);
});

/* ================= 预算口径与缓存实话 ================= */

it("历史预算扣掉这一轮的输出预留（DSH 的 messageBudget = W − O），且预留最多吃半个窗口", () => {
  const plain = historyCharBudget(128_000, 0.6, undefined, 0);
  // 预留小于"没用的那 40%"时不该咬到历史：0.6 的比例本身已经留了 51.2k 的余量
  expect(historyCharBudget(128_000, 0.6, undefined, 40_000), "40k 预留不该改变结果（比例已经留了更多）").toBe(plain);
  const withOut = historyCharBudget(128_000, 0.6, undefined, 60_000);
  expect(withOut, "预留吃到 60k 时历史预算却没变 ⇒ 历史塞满、回答没地方落").toBeLessThan(plain);
  const absurd = historyCharBudget(128_000, 0.6, undefined, 200_000);
  expect(absurd, "档案把 maxOutputTokens 填得比窗口还大时，不该把历史压到下限").toBe(historyCharBudget(128_000, 0.6, undefined, 64_000));
  expect(historyCharBudget(0, 0.6, undefined, 8_000), "窗口不合法时该退回兜底值而不是 0").toBeGreaterThan(0);
});

it("重放旧回执时「已缓存可取回」改口成实话，引用不再留给模型去撞", () => {
  const rec = {
    callId: "c1", ok: true, status: "read" as const,
    data: { artifactRef: "call:c1", text: "…", note: "完整内容已缓存，用 read_artifact 取回" },
  };
  const out = markStaleArtifacts(rec) as typeof rec;
  expect((out.data as { artifactRef?: string }).artifactRef, "引用还在：模型会照着它撞一次 artifact_expired").toBeUndefined();
  expect(String((out.data as { note: string }).note)).toContain("上一次运行");
  const plain = { callId: "c2", ok: true, status: "read" as const, data: { text: "hi" } };
  expect(markStaleArtifacts(plain), "没有引用的回执不该被复制一遍").toBe(plain);
});
