/**
 * P89 A 批会话层测试：A3 新建永远换新 + 启动清空会话、A4 Agent 会话标题、
 * A5 activeId 失效自愈（localStorage 写满截断是唯一确定性失效路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ occupied: new Set<string>() }));
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../panels/panelActivity", () => ({ isOpen: () => false, subscribe: vi.fn() }));
vi.mock("./aiChatFeed", () => ({ updateChatFeed: vi.fn() }));
vi.mock("./imageStore", () => ({ saveImage: vi.fn(), restoreImages: vi.fn(async () => []), deleteImages: vi.fn() }));
/* Agent 链按隔离意图挡在门外（同 chatStore.inertial.test.ts 的理由）；
   occupiedSessionIds 用可变替身驱动「被 run 占用」分支。 */
vi.mock("../agent/agentRun", () => ({
  occupiedSessionIds: () => h.occupied,
  setSessionTitleCb: vi.fn(),
  setRunConclusionCb: vi.fn(), // P92 A4：init 里注册结论回写钩子
}));
vi.mock("../settings/settingsStore", () => ({
  getSnapshot: () => ({ aiBaseUrl: "https://example.invalid", aiApiKey: "test-key-not-real", aiModel: "test"}),
  subscribe: vi.fn(),
}));
vi.mock("./contextCollector", () => ({
  collectContext: () => [],
  contextToText: () => "",
  summaryTemplates: () => "",
  curveStatsText: () => "",
  DEFAULT_CONTEXT: { conn: false, protocol: false, protoFull: false, samples: false, hex: false },
}));

afterEach(() => vi.unstubAllGlobals());

function sess(id: string, msgs = 0, title = "") {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    usage: { prompt: 0, completion: 0 },
    messages: Array.from({ length: msgs }, (_, i) => ({ id: `${id}-m${i}`, role: "user", content: `c${i}`, ts: 1 })),
  };
}

/** 全新加载 chatStore：seed 持久化会话，可选「首次写入即配额满」模拟 */
async function loadChat(sessions: unknown[], activeId: string, opts?: { failFirstWrite?: boolean }) {
  vi.resetModules();
  const store = new Map<string, string>();
  store.set("vs.aiSessions", JSON.stringify({ sessions, activeId }));
  let writes = 0;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts?.failFirstWrite && writes++ === 0) throw new Error("quota exceeded");
      store.set(k, v);
    },
    removeItem: (k: string) => store.delete(k),
  });
  return await import("./chatStore");
}

describe("chatStore 会话管理（P89 A）", () => {
  it("P99a-D1b 任务模板草稿：只填输入框的一次性投递，不代发也不留第二份", async () => {
    const chat = await loadChat([sess("a", 2)], "a");
    expect(chat.getSnapshot().pendingDraft).toBeNull();
    chat.pushDraft("按这个任务模板来做：巡检");
    expect(chat.getSnapshot().pendingDraft).toBe("按这个任务模板来做：巡检");
    // 消费即清：第二次必须拿到 null，否则输入框会被同一段模板反复回填
    expect(chat.consumeDraft()).toBe("按这个任务模板来做：巡检");
    expect(chat.consumeDraft()).toBeNull();
    expect(chat.getSnapshot().pendingDraft).toBeNull();
    // 空串也是一次性投递（用户可能就想填一段空白重来），不能因为 falsy 被吞掉
    chat.pushDraft("");
    expect(chat.consumeDraft()).toBe("");
    expect(chat.consumeDraft()).toBeNull();
  });

  it("A3 启动清理：只删「无消息且无 run 关联且无标题」的会话", async () => {
    h.occupied = new Set(["c"]);
    const chat = await loadChat([sess("a", 2), sess("b", 0), sess("c", 0), sess("d", 0, "手动命名")], "a");
    await chat.init();
    expect(chat.getSnapshot().sessions.map((s) => s.id)).toEqual(["a", "c", "d"]);
    expect(chat.getSnapshot().activeId).toBe("a");
  });

  it("A3 新建永远换新：连续两次新建得到两个不同会话，不复用已有空会话", async () => {
    h.occupied = new Set(["agent-empty"]);
    const chat = await loadChat([sess("agent-empty", 0), sess("with-msg", 3)], "with-msg");
    await chat.init();
    chat.newSession();
    const first = chat.getSnapshot().activeId;
    chat.newSession();
    const second = chat.getSnapshot().activeId;
    expect(first).not.toBe("agent-empty");
    expect(second).not.toBe(first);
    expect(chat.getSnapshot().sessions).toHaveLength(4);
    expect(chat.getSnapshot().sessions[0].messages).toHaveLength(0);
  });

  it("A4 标题：仅空标题时写入，折叠空白并截 22 字；已有标题与未知会话均不写", async () => {
    h.occupied = new Set();
    const chat = await loadChat([sess("t1", 1, ""), sess("t2", 1, "已有标题")], "t1");
    await chat.init();
    const titleOf = (id: string) => chat.getSnapshot().sessions.find((s) => s.id === id)?.title;
    chat.setTitleIfEmpty("t1", "  把   主题改成\n深海蓝，并且   加大字号让整体更清晰一点  ");
    expect(titleOf("t1")).toBe("把 主题改成 深海蓝，并且 加大字号让整体更");
    chat.setTitleIfEmpty("t2", "不该覆盖");
    expect(titleOf("t2")).toBe("已有标题");
    chat.setTitleIfEmpty("nope", "写了也没用");
    chat.setTitleIfEmpty("t1", "   ");
    expect(titleOf("t1")).toBe("把 主题改成 深海蓝，并且 加大字号让整体更");
  });

  it("A5 配额满截断丢掉活动会话 → 写入路径就地自愈，activeId 恒有效", async () => {
    h.occupied = new Set();
    const chat = await loadChat([sess("a", 2), sess("b", 2), sess("c", 2), sess("d", 2)], "d", { failFirstWrite: true });
    await chat.init();
    expect(chat.getSnapshot().activeId).toBe("d");
    chat.renameSession("d", "触发一次持久化");
    const snap = chat.getSnapshot();
    expect(snap.sessions.some((s) => s.id === "d")).toBe(false);
    expect(snap.sessions.some((s) => s.id === snap.activeId)).toBe(true);
    expect(snap.activeId).not.toBe("d");
  });

  it("A5 稳定态：getSnapshot 引用缓存（P88c 白屏红线同类，自愈只在真失效时换引用）", async () => {
    h.occupied = new Set();
    const chat = await loadChat([sess("a", 2)], "a");
    await chat.init();
    expect(chat.getSnapshot()).toBe(chat.getSnapshot());
    expect(chat.getSnapshot().activeId).toBe("a");
  });

  it("A1 appendUserMessage：Agent 目标落用户气泡 + via 标记 + 空标题按原话命名", async () => {
    h.occupied = new Set();
    const chat = await loadChat([sess("a", 0)], "a");
    await chat.init();
    const before = chat.getSnapshot().sessions.length;
    chat.appendUserMessage("  把主题改成深海蓝  ", { via: "agent" });
    const s = chat.getSnapshot().sessions.find((x) => x.id === chat.getSnapshot().activeId)!;
    expect(chat.getSnapshot().sessions).toHaveLength(before); // 当前会话未被清理掉
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "把主题改成深海蓝", via: "agent" });
    expect(s.title).toBe("把主题改成深海蓝");
    chat.appendUserMessage("   "); // 空文本不写
    expect(s.messages).toHaveLength(1);
  });

  it("A1 resendKindOf：按消息当初的来源决定重发链路", async () => {
    h.occupied = new Set();
    const chat = await loadChat([sess("a", 1)], "a");
    expect(chat.resendKindOf({})).toBe("chat");
    expect(chat.resendKindOf({ via: "agent" })).toBe("agent");
  });

  it("A1 rewriteForResend：截断该条之后、就地改写并保留 via", async () => {
    h.occupied = new Set();
    const seed = {
      id: "a",
      title: "旧标题",
      createdAt: 1,
      updatedAt: 1,
      usage: { prompt: 0, completion: 0 },
      messages: [
        { id: "m0", role: "user", content: "原目标", ts: 1, via: "agent" },
        { id: "m1", role: "assistant", content: "过程", ts: 2 },
        { id: "m2", role: "user", content: "后一条", ts: 3 },
      ],
    };
    const chat = await loadChat([seed], "a");
    await chat.init();
    const next = chat.rewriteForResend("m0", "改后的目标");
    const s = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
    expect(next?.id).toBeTruthy();
    expect(next?.id).not.toBe("m0");
    expect(s.messages.map((m) => m.content)).toEqual(["改后的目标"]);
    expect(s.messages[0].via).toBe("agent");
    expect(chat.rewriteForResend("nope", "x")).toBeNull();
    expect(chat.rewriteForResend("m0", "   ")).toBeNull();
  });
});

describe("P92 A4：Agent 任务结论回写会话（气泡=结论、卡片=过程）", () => {
  it("按 runId 幂等：首次追加、再次覆盖同一条，不堆重复气泡", async () => {
    const chat = await loadChat([sess("a", 1, "玻璃主题")], "a");
    await chat.init();
    chat.upsertRunConclusion("a", "r1", "已保存为插件「我的玻璃主题」并启用");
    let s = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ role: "assistant", fromRunId: "r1" });
    // 续跑再次终态 → 覆盖，不新增
    chat.upsertRunConclusion("a", "r1", "续跑后：已保存并启用（结论更新）");
    s = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].content).toContain("结论更新");
  });

  it("目标会话不是当前会话也写对地方（任务跑着用户切走了）", async () => {
    const chat = await loadChat([sess("a", 1, "甲"), sess("b", 1, "乙")], "a");
    await chat.init();
    chat.switchSession("b");
    chat.upsertRunConclusion("a", "r9", "写给甲会话的结论");
    const sa = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
    const sb = chat.getSnapshot().sessions.find((x) => x.id === "b")!;
    expect(sa.messages[sa.messages.length - 1].content).toBe("写给甲会话的结论");
    expect(sb.messages.some((m) => m.fromRunId)).toBe(false);
  });

  it("未知会话与空文本都静默不抛；空标题会话由结论命名", async () => {
    h.occupied = new Set(["a"]); // 被 run 占用的空会话不被启动清理删掉（P89 A3 口径）
    try {
      const chat = await loadChat([sess("a", 0)], "a");
      await chat.init();
      chat.upsertRunConclusion("nope", "r1", "不该写进任何地方");
      chat.upsertRunConclusion("a", "r2", "   ");
      const s = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
      expect(s.messages).toHaveLength(0);
      chat.upsertRunConclusion("a", "r3", "任务完成：字号已调大并保存为插件");
      const s2 = chat.getSnapshot().sessions.find((x) => x.id === "a")!;
      expect(s2.messages).toHaveLength(1);
      expect(s2.title).toBe("任务完成：字号已调大并保存为插件");
    } finally {
      h.occupied = new Set();
    }
  });
});
