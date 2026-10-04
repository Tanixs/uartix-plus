/**
 * P133-I：导出会话为 Markdown —— **过程要出得来，密钥要进不去**。
 *
 * 用户原话："AI助手导出对话到md能不能导出内容再全面一点，比如工具调用，思维链等。"
 * 旧实现只写 `m.content`：思维链、每次工具调用的参数、每条回执全丢在界面上，
 * 拿到的那份 md 只剩两段"结果"——正是他贴回来问的那件事。
 *
 * 载入方式同 chatStore.sessions.test：seed 持久化会话 → resetModules → 重新 import，
 * 这样每条用例都拿到一份干净的 store，而不是互相踩状态。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../panels/panelActivity", () => ({ isOpen: () => false, subscribe: vi.fn() }));
vi.mock("./aiChatFeed", () => ({ updateChatFeed: vi.fn() }));
vi.mock("./imageStore", () => ({ saveImage: vi.fn(), restoreImages: vi.fn(async () => []), deleteImages: vi.fn() }));
// Agent 链按隔离意图挡在门外（同会话层测试的理由）；导出只吃调用方递进来的 run 视图。
vi.mock("../agent/agentRun", () => ({
  occupiedSessionIds: () => new Set<string>(),
  setSessionTitleCb: vi.fn(),
  setRunConclusionCb: vi.fn(),
}));
vi.mock("./contextCollector", () => ({
  collectContext: () => [],
  contextToText: () => "",
  summaryTemplates: () => "",
  curveStatsText: () => "",
  DEFAULT_CONTEXT: { conn: false, protocol: false, protoFull: false, samples: false, hex: false },
}));

const T0 = 1_770_000_000_000;

async function loadChat(messages: unknown[], id = "a", locale?: "en") {
  vi.resetModules();
  const store = new Map<string, string>();
  if (locale) store.set("vs.settings", JSON.stringify({ locale }));
  store.set("vs.aiSessions", JSON.stringify({
    sessions: [{ id, title: "改页面", createdAt: T0, updatedAt: T0, usage: { prompt: 0, completion: 0 }, messages }],
    activeId: id,
  }));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return await import("./chatStore");
}

const msg = (over: Record<string, unknown>) => ({ id: `m${Math.random()}`, ts: T0, role: "assistant", content: "", ...over });

function fakeRun(over: Record<string, unknown> = {}) {
  return {
    runId: "r1",
    goal: "删掉那条没人用的旧 CSS 规则并跑校验",
    goalBrief: "删掉那条没人用的旧 CSS 规则",
    scope: "custom",
    status: "succeeded",
    rounds: 2,
    calls: 1,
    caps: { maxRounds: 20, maxCalls: 60, deadlineAt: 0 },
    createdAt: T0,
    updatedAt: T0 + 9_000,
    finishedAt: T0 + 9_000,
    sessionId: "a",
    events: [
      { seq: 1, ts: T0 + 1000, kind: "reasoning", text: "先在 src/styles 里确认没有活引用", ms: 1200 },
      {
        seq: 2, ts: T0 + 2000, kind: "receipt", tool: "fs_edit",
        args: `{"path":"D:/w/theme.css","old_text":"${"x".repeat(3000)}"}`,
        receipt: { callId: "c2", ok: true, status: "applied", data: { apiKey: "sk-abcdef123456", bytes: 12 } },
      },
      { seq: 3, ts: T0 + 3000, kind: "turn", text: "删掉了三条规则" },
      { seq: 4, ts: T0 + 3500, kind: "status", text: "运行现状变化：主题已重载" },
      { seq: 5, ts: T0 + 4000, kind: "context", text: "第 2 轮：请求 30 KB" },
    ],
    ...over,
  } as never;
}

describe("P133-I · 导出会话为 Markdown", () => {
  it("Agent 任务的过程进得来：思维链、工具名、参数、回执码一条不少", async () => {
    const chat = await loadChat([
      msg({ role: "user", content: "删掉那条规则", via: "agent", contextTitles: ["协议字段", "帧统计"], images: ["data:image/png;base64,AA"] }),
      msg({ content: "结果正文", fromRunId: "r1" }),
    ]);
    const md = chat.exportSessionMd([fakeRun()]);
    // 抬头先说清这份东西有多少过程在里面
    expect(md).toContain("Agent 任务 1 个 · 工具调用 1 次");
    // 用户消息的附件与图片计数
    expect(md).toContain("附带上下文：协议字段、帧统计");
    expect(md).toContain("图片 1 张（导出不含图片内容）");
    // 台账里那五行一条都不能少（思维链 / 工具+参数 / 回执 / 状态 / 上下文）
    expect(md).toContain("思维链: 先在 src/styles 里确认没有活引用");
    expect(md).toContain("工具: fs_edit");
    expect(md).toContain("回执: ok=true status=applied");
    expect(md).toContain("状态: 运行现状变化：主题已重载");
    expect(md).toContain("上下文: 第 2 轮：请求 30 KB");
    expect(md).toContain("模型叙述: 删掉了三条规则");
    // 结论气泡本身也在（气泡=结论、卡片=过程的分工不能因为导出而丢）
    expect(md).toContain("结果正文");
    // **过程要落在它发生的位置**：只在结尾堆一段"未回写的任务"也算"内容都在"，
    // 但读的人对不上是哪句话之后发生的——那正是"全面"与"能用"的差别。
    expect(md.indexOf("## 用户")).toBeLessThan(md.indexOf("工具: fs_edit"));
    expect(md.indexOf("工具: fs_edit")).toBeLessThan(md.indexOf("结果正文"));
    expect(md).not.toContain("未回写进对话的任务");
  });

  it("思维链按轮次落，且不与正文重复一遍", async () => {
    const chat = await loadChat([
      msg({
        role: "user", content: "巡检一下",
      }),
      msg({
        content: "第一段第二段",
        rounds: [
          { r: "我先看连接", c: "第一段", ms: 3000 },
          { r: "", c: "第二段", ms: 1000 },
        ],
      }),
    ]);
    const md = chat.exportSessionMd([]);
    expect(md).toContain("第 1 轮思考 · 3.0s");
    expect(md).toContain("> 我先看连接");
    // 第 2 轮没有思考文字：不该冒出一个空的「第 2 轮思考」标题
    expect(md).not.toContain("第 2 轮思考");
    expect(md).toContain("第二段");
    // rounds 的 c 就是 content 的来源，两处各写一遍等于同一句话写两次
    expect(md.split("第一段").length - 1).toBe(1);
  });

  it("剪贴板档：截断必须看得见——被砍短的参数读起来不许像完整的", async () => {
    await loadChat([msg({ content: "x" })]);
    const { serializeLog, LOG_CLIPBOARD } = await import("../agent/runLog");
    const clip = serializeLog(fakeRun(), LOG_CLIPBOARD);
    expect(clip).toContain("此处截断，共");
    expect(clip).not.toContain("x".repeat(3000));
    // 对照：同一个 run 走文件档就必须完整——这条对照才是 P139 的命题，
    // 少了它，"两个出口"只是一个说法（把文件档也设成 4000 就没人红）。
    const { LOG_FILE } = await import("../agent/runLog");
    expect(serializeLog(fakeRun(), LOG_FILE)).toContain("x".repeat(3000));
  });

  it("P139：用户主动导出的那份文件不再被剪贴板的尺度截断", async () => {
    const chat = await loadChat([msg({ content: "结果正文", fromRunId: "r1" })]);
    const md = chat.exportSessionMd([fakeRun()]);
    expect(md).toContain("x".repeat(3000));
    expect(md).not.toContain("此处截断，共");
  });

  it("P139：从磁盘恢复的台账，未落盘的正文条数要在文件里说一次", async () => {
    const { droppedPlaceholder } = await import("../agent/context");
    const run = fakeRun({
      events: [
        { seq: 1, ts: T0 + 1000, kind: "receipt", tool: "session_read", receipt: { callId: "c1", ok: true, status: "read", data: droppedPlaceholder(41_000) } },
        { seq: 2, ts: T0 + 2000, kind: "receipt", tool: "fs_read", receipt: { callId: "c2", ok: true, status: "read", data: { content: "短正文，本来就在预算内" } } },
      ],
    });
    const chat = await loadChat([msg({ content: "结果正文", fromRunId: "r1" })]);
    const md = chat.exportSessionMd([run]);
    expect(md).toContain("未落盘: 1 条");
    // 这份文件不是"缺了三条"——占位形状只认真被落盘省略的那几条（fs_read 的 truncated 不算）
    expect(md).not.toContain("未落盘: 2 条");
  });

  it("P139 对照：一条都没被省略时那句「未落盘」不许凭空出现", async () => {
    const chat = await loadChat([msg({ content: "结果正文", fromRunId: "r1" })]);
    const md = chat.exportSessionMd([fakeRun()]);
    expect(md).not.toContain("未落盘");
  });

  it("密钥进不去：回执里带着 apiKey 也得被盖掉", async () => {
    const chat = await loadChat([msg({ content: "x" })]);
    const md = chat.exportSessionMd([fakeRun()]);
    expect(md).not.toContain("sk-abcdef123456");
    expect(md).toContain("已打码");
    // 直接驱动擦除函数：三种形状都要盖住，且不能把正常内容吃掉
    const s = chat.scrubSecrets('{"apiKey":"sk-abcdefghijkl","note":"留着"} Authorization: Bearer abcdef123456 ok');
    expect(s).not.toContain("abcdefghijkl");
    expect(s).not.toContain("Bearer abcdef123456");
    expect(s).toContain("留着");
    expect(s).toContain("ok");
  });

  it("没回写进对话的任务也照录；别的热会话的 run 不混进来", async () => {
    const chat = await loadChat([msg({ content: "结果正文", fromRunId: "r1" })]);
    const md = chat.exportSessionMd([
      fakeRun(),
      fakeRun({ runId: "r2", goalBrief: "顺手加的第二个任务", sessionId: "a", events: [] }),
      fakeRun({ runId: "r9", goalBrief: "别的会话的任务", sessionId: "b", events: [] }),
    ]);
    expect(md).toContain("未回写进对话的任务");
    expect(md).toContain("顺手加的第二个任务");
    expect(md).not.toContain("别的会话的任务");
    expect(md).toContain("Agent 任务 2 个");
  });

  it("出错与中止的那一轮要标出来，不给一条看起来成功的记录", async () => {
    const chat = await loadChat([
      msg({ content: "", error: "上游 401" }),
      msg({ content: "写到一半", aborted: true }),
    ]);
    const md = chat.exportSessionMd([]);
    expect(md).toContain("> 出错：上游 401");
    expect(md).toContain("这一轮被中止");
    expect(md).toContain("写到一半");
  });

  it("英文界面下导出的是整份英文——外壳与内嵌台账不能一种语言壳另一种语言芯", async () => {
    const chat = await loadChat([msg({ content: "结果正文", fromRunId: "r1" })], "a", "en");
    const md = chat.exportSessionMd([fakeRun()]);
    expect(md).toContain("# Uartix+ conversation log");
    expect(md).toContain("- Messages: 1 · agent tasks 1 · tool calls 1");
    expect(md).toContain("### Agent task");
    // 台账那半边的语言由同一个 locale 决定（runLog 走 tx()）
    expect(md).toContain("Status: Done");
    expect(md).toContain("Reasoning: ");
    // P139：文件档不截，所以英文文档里既不该有截断标记，也不该漏进中文侧的字样
    expect(md).not.toContain("truncated;");
    expect(md).not.toContain("导出时间");
    expect(md).not.toContain("回执:");
    expect(md).not.toContain("此处截断");
  });
});
