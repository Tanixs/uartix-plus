import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  collect: vi.fn(() => [{ title: "SYNTHETIC_SAMPLE_CONTEXT", text: "SYNTHETIC_RAW_BYTES" }]),
  templates: vi.fn(() => "SYNTHETIC_PRIVATE_TEMPLATE"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../panels/panelActivity", () => ({ isOpen: () => false, subscribe: vi.fn() }));
vi.mock("./aiChatFeed", () => ({ updateChatFeed: vi.fn() }));
vi.mock("./imageStore", () => ({ saveImage: vi.fn(), restoreImages: vi.fn(), deleteImages: vi.fn() }));
/* P88e A2：chatStore 引入 occupiedSessionIds 后拖入 Agent 全链（含 Rust 桥副作用 store）——
 * 本测试验证的是出站请求隔离，按隔离意图把 Agent 链整体挡在门外。 */
vi.mock("../agent/agentRun", () => ({ occupiedSessionIds: () => new Set<string>(), setSessionTitleCb: vi.fn() }));
vi.mock("../settings/settingsStore", () => ({
  // 这张桩件可以继续保持"整模块替换"：本文件已经把 `./aiProfileStore` 整体 mock 掉了
  // （见下），而当初需要 importOriginal 透传，只是因为真档案表在求值期要读 AI_PRESETS 建 seed。
  getSnapshot: () => ({ aiBaseUrl: "https://example.invalid", aiApiKey: "test-key-not-real", aiModel: "test" }),
  subscribe: vi.fn(),
}));
/* P110-B1：出站隔离测的是"发出去的那一条里有什么"，不该依赖真档案表 ——
 * 真表的 seed 密钥是空的，chatStore 会当场判"未配置"（那是 provider 新增的前置门），
 * 于是一次请求都发不出去：那不是隔离，是没跑。给一张固定的可用档案，
 * 下面所有出站断言原样成立、一条未改。 */
vi.mock("./aiProfileStore", () => {
  const provider = {
    id: "p", label: "P", baseUrl: "https://example.invalid", apiKey: "test-key-not-real",
    format: "chat" as const, proxy: "", noProxy: "", enabled: true, createdAt: 0,
  };
  const model = {
    id: "m", providerId: "p", label: "test", model: "test", contextTokens: 128_000,
    maxOutputTokens: 8_192, thinkingLevels: [], defaultThinking: "", enabled: true, createdAt: 0,
  };
  const st = { providers: [provider], models: [model], activeProviderId: "p", activeModelId: "m" };
  return {
    activeRef: () => ({ provider, model }),
    getAiProfiles: () => st,
    useAiProfiles: () => st,
    subscribeAiProfiles: () => () => {},
    thinkingParamsFor: () => null,
    thinkingLabels: () => [],
  };
});
vi.mock("./contextCollector", () => ({
  collectContext: mocks.collect,
  contextToText: (blocks: unknown[]) => blocks.length ? "SYNTHETIC_SAMPLE_CONTEXT SYNTHETIC_RAW_BYTES" : "",
  summaryTemplates: mocks.templates,
  curveStatsText: () => "SYNTHETIC_CURVE_STATS",
  DEFAULT_CONTEXT: { conn: true, protocol: true, protoFull: true, samples: true, hex: true },
}));

afterEach(() => vi.unstubAllGlobals());

describe("inertial outbound request isolation", () => {
  it("sends only the requested evidence despite enabled context and existing private history", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const saved = JSON.stringify({ activeId: "session-test", sessions: [{
      id: "session-test", title: "test", createdAt: 0, updatedAt: 0, usage: { prompt: 0, completion: 0 },
      messages: [{ id: "old", role: "user", content: "SYNTHETIC_PRIVATE_HISTORY", images: ["SYNTHETIC_PRIVATE_IMAGE"], ts: 0 }],
    }] });
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "vs.aiSessions" ? saved : null, setItem: vi.fn(), removeItem: vi.fn() });
    const chat = await import("./chatStore");
    const selection = { ...chat.getSnapshot().contextSel };
    await chat.runScene("inertial", { text: "EVIDENCE_ONLY: n=2; source_ms=[0,1000]" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = mocks.invoke.mock.calls[0] as unknown as [string, { messages: { role: string; content: string }[] }];
    expect(command).toBe("ai_chat");
    console.info("Mock ai_chat messages:", JSON.stringify(payload.messages, null, 2));
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0].role).toBe("system");
    expect(payload.messages[1]).toEqual({ role: "user", content: "EVIDENCE_ONLY: n=2; source_ms=[0,1000]" });
    expect(JSON.stringify(payload.messages)).not.toContain("SYNTHETIC_");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.templates).not.toHaveBeenCalled();
    expect(chat.getSnapshot().contextSel).toEqual(selection);
  });
});
