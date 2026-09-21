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
  getSnapshot: () => ({ aiBaseUrl: "https://example.invalid", aiApiKey: "test-key-not-real", aiModel: "test"}),
  subscribe: vi.fn(),
}));
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
