/**
 * P88b-2 三跨工具场景验收（详设 §12，fake provider 零网络零密钥）：
 * ① 主题/布局：读设置 → 新建卡片 → 应用主题 → 修正 → 撤销设置改动；
 * ② 协议：列模板 → 另存新模板（不覆盖既有）→ 校验回执；
 * ③ 数据分析：plot_channels（租约）→ plot_window 采样 → 指标计算 → 报告卡片回填。
 * 每个场景断言：工具调用序列、真实回执链（tool 消息回填）、run 终态 succeeded、计数真实。
 * 脚本以「已执行工具数」驱动（tool 消息数=已派发回执数），确定性推进，不猜回执形状。
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
  getSnapshot: vi.fn(() => ({ channels: [{ id: "c1", name: "加速度X", tplId: "t", fieldId: "f", visible: true, color: "#000" }] })),
  getChanData: vi.fn(() => ({ t: [0, 1], v: [1, 2] })),
  timeOrigin: vi.fn(() => 0),
  sampleRate: vi.fn(() => 100),
}));
vi.mock("../plot/plotStore", () => plot);
const { releaseDataLease } = await import("../plot/dataLease");

const { invokeAgentProvider } = await import("./provider");
const agentRun = await import("./agentRun");
import type { AgentMessage, AgentProvider, ModelTurn } from "./types";

/** 已执行工具调用数 = 消息序列中的 tool 回执数（确定性步数）。 */
function doneCount(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "tool").length;
}

beforeEach(() => {
  runAppAction.mockReset();
  runAppAction.mockResolvedValue({ ok: true, data: "完成" });
  plot.getChanData.mockReturnValue({ t: [0, 1], v: [1, 2] });
  releaseDataLease("s1");
  releaseDataLease("s2");
  releaseDataLease("s3");
  agentRun.resetForTests();
});

describe("P88b-2 三跨工具场景", () => {
  it("场景① 主题/布局：读→建卡→应用主题→修正→撤销设置", async () => {
    let readRevision = "";
    const script: AgentProvider = async (messages) => {
      const step = doneCount(messages);
      const turn = (name: string, args: unknown): ModelTurn =>
        ({ content: "", calls: [{ callId: `a${step + 1}`, name, arguments: JSON.stringify(args) }] });
      if (step === 0) return { content: "先读当前外观状态", calls: [{ callId: "a1", name: "settings_read", arguments: "{}" }] };
      if (step === 1) {
        // 步1 回执是 settings_read：拿 revision 供 apply 做 compare-and-swap
        const last = JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content) as { revision?: string };
        expect(last.revision).toBeTruthy();
        readRevision = last.revision!;
        return turn("run_app_action", { kind: "writeCard", args: { id: "diag-1", title: "诊断", kind: "metric" } });
      }
      if (step === 2) return turn("run_app_action", { kind: "setTheme", args: { name: "glass" } });
      if (step === 3) return turn("settings_apply", { patch: { decimals: 3 }, revision: readRevision });
      return { content: "外观已更新，可在任务卡撤销字号改动", calls: [] };
    };
    vi.mocked(invokeAgentProvider).mockImplementation(script);
    const runId = await agentRun.startRun({ goal: "场景1：新建诊断卡并套用玻璃主题", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.calls).toBe(4);
    // 动作序列真实：writeCard → setTheme
    expect(runAppAction.mock.calls.map((c) => c[0])).toEqual(["writeCard", "setTheme"]);
    // 设置 apply 回执带 undoToken（撤销入口）
    const applyEvt = view.events.find((e) => e.kind === "receipt" && e.tool === "settings_apply");
    expect(applyEvt?.receipt?.ok).toBe(true);
    expect(typeof applyEvt?.receipt?.undoToken).toBe("string");
    // 会话内撤销生效
    const undo = agentRun.undoReceipt(runId, applyEvt!.seq);
    expect(undo).toBe("undone");
  });

  it("场景② 协议：列模板 → 另存新模板不覆盖", async () => {
    runAppAction.mockImplementation(async (kind: string) => {
      if (kind === "listProtocols") return { ok: true, data: { templates: [{ id: "wit", name: "WIT私有" }] } };
      if (kind === "writeTemplate") return { ok: true, data: { id: "as-nmea", created: true, overwritten: false } };
      return { ok: true, data: "完成" };
    });
    const script: AgentProvider = async (messages) => {
      const step = doneCount(messages);
      const turn = (name: string, args: unknown): ModelTurn =>
        ({ content: "", calls: [{ callId: `b${step + 1}`, name, arguments: JSON.stringify(args) }] });
      if (step === 0) return { content: "查看现有模板", calls: [{ callId: "b1", name: "run_app_action", arguments: JSON.stringify({ kind: "listProtocols", args: {} }) }] };
      if (step === 1) {
        // 另存新模板：不覆盖既有 wit
        return turn("run_app_action", { kind: "writeTemplate", args: { id: "as-nmea", name: "NMEA0183-新", fields: [] } });
      }
      const last = JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content) as { data?: { overwritten?: boolean } };
      expect(last.data?.overwritten).toBe(false);
      return { content: "模板已另存并通过 schema 校验", calls: [] };
    };
    vi.mocked(invokeAgentProvider).mockImplementation(script);
    const runId = await agentRun.startRun({ goal: "场景2：生成协议模板草稿并另存", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(runAppAction.mock.calls.map((c) => c[0])).toEqual(["listProtocols", "writeTemplate"]);
    expect(view.calls).toBe(2);
  });

  it("场景③ 数据分析：租约采样 → 读窗口 → 指标 → 报告回填", async () => {
    // 600 点正弦窗口（>8KiB 才走压缩这条道）：模型侧计算 min/max 并写报告卡
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 600 }, (_, i) => i * 10),
      v: Array.from({ length: 600 }, (_, i) => Math.sin(i / 10)),
    });
    const script: AgentProvider = async (messages) => {
      const step = doneCount(messages);
      const turn = (name: string, args: unknown): ModelTurn =>
        ({ content: "", calls: [{ callId: `c${step + 1}`, name, arguments: JSON.stringify(args) }] });
      const toolData = () => messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content).data as Record<string, unknown> | undefined);
      if (step === 0) return { content: "订阅并枚举通道", calls: [{ callId: "c1", name: "plot_channels", arguments: "{}" }] };
      if (step === 1) return turn("plot_window", { channelIds: ["c1"], maxPoints: 600 });
      if (step === 2) {
        // P95-H3：模型看到的是形态压缩后的摘要（分位数 + 首尾），全量仍可分页取回
        const pw = toolData()[1] as { series?: { points: number }[]; artifactRef?: string };
        expect(pw.series?.[0].points).toBe(600);
        expect(pw.artifactRef, "压缩过的收据必须带可取回的 artifactRef").toBeTruthy();
        return turn("read_artifact", { ref: pw.artifactRef });
      }
      if (step === 3) {
        // 一页只有 8KiB：hasMore 就得用 nextFrom 续要（这就是模型侧的真实循环）
        const page = toolData()[2] as { hasMore?: boolean; nextFrom?: number; from?: number };
        expect(page.from).toBe(0);
        expect(page.hasMore).toBe(true);
        const pw = toolData()[1] as { artifactRef?: string };
        return turn("read_artifact", { ref: pw.artifactRef, from: page.nextFrom });
      }
      if (step === 4) {
        // 拼回全量后算指标（正弦峰值 ≈ 0.999）
        const pages = toolData()
          .filter((d): d is { text: string; from: number } =>
            typeof d?.text === "string" && typeof d?.from === "number")
          .sort((a, b) => a.from - b.from)
          .map((d) => d.text)
          .join("");
        const full = JSON.parse(pages) as { series: { v: number[] }[] };
        expect(full.series[0].v).toHaveLength(600);
        const max = Math.max(...full.series[0].v);
        return turn("run_app_action", { kind: "writeCard", args: { id: "rpt-1", title: "振动分析", kind: "report", summary: { max } } });
      }
      return { content: "诊断报告已回填", calls: [] };
    };
    vi.mocked(invokeAgentProvider).mockImplementation(script);
    const runId = await agentRun.startRun({ goal: "场景3：读取曲线做诊断报告", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.calls).toBe(5);
    // 报告卡拿到的是真实窗口算出的指标
    const reportCall = runAppAction.mock.calls.find((c) => c[0] === "writeCard");
    expect((reportCall?.[1] as { summary?: { max?: number } }).summary?.max).toBeGreaterThan(0.99);
    // 租约随 run 终止释放（§6.1）
    const { leaseCount } = await import("../plot/dataLease");
    expect(leaseCount()).toBe(0);
  });
});
