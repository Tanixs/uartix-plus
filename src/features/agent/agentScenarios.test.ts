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
// P138-B：页大小是"一次传多少"，与截断线（一次留多少）分家；测试必须读同一枚常数而不是抄数字
const { ARTIFACT_PAGE_BYTES } = await import("./localEntries");
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

describe("P138-B：两条线必须分家（不自我引用的不变式）", () => {
  it("页大小必须明显小于截断线——相等就等于把「一次传多少」钉死在「一次留多少」上", async () => {
    const { RECEIPT_DATA_LIMIT } = await import("./context");
    // 上一条断言拿常数验常数，是同义反复（改常数它一定跟着过）；这条比的是两枚常数之间的关系。
    expect(ARTIFACT_PAGE_BYTES * 4).toBeLessThan(RECEIPT_DATA_LIMIT);
  });
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
    // P138-B 改了这条的前提：`plot_window` 硬顶 2000 点（约 3 万字节），落在新的 48 KiB 阈值之内
    // ⇒ 窗口**原样**进上下文，不再"先抽稀、再让模型分页要回逐点数据"
    // （§8-34①：未超限就原样，压缩的唯一触发条件是超限）。
    // 压缩与分页那条路仍各自有人钉：agentAdapter 的"真超限才压缩 + 按字段分配额度"、loop 的 P94-G3 两条。
    let wroteCard = false;
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 2000 }, (_, i) => i * 10),
      v: Array.from({ length: 2000 }, (_, i) => Math.sin(i / 10)),
    });
    const script: AgentProvider = async (messages) => {
      const step = doneCount(messages);
      const turn = (name: string, args: unknown): ModelTurn =>
        ({ content: "", calls: [{ callId: `c${step + 1}`, name, arguments: JSON.stringify(args) }] });
      const toolData = () => messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content).data as Record<string, unknown> | undefined);
      if (step === 0) return { content: "订阅并枚举通道", calls: [{ callId: "c1", name: "plot_channels", arguments: "{}" }] };
      if (step === 1) return turn("plot_window", { channelIds: ["c1"], maxPoints: 2000 });
      if (step === 2) {
        // 这条场景**仍然**走压缩：2000 个点的 `v` 是 17 位浮点，整份窗口实测越过 48 KiB 那条线
        // （同一条场景在 `agentAdapter.test` 里的整数版本则落在线内、原样进台账——两条一起把阈值两侧都盖住）。
        const pw = toolData()[1] as { series?: { points: number }[]; artifactRef?: string };
        expect(pw.series?.[0].points).toBe(2000);
        expect(pw.artifactRef, "压缩过的收据必须带一个真能取回原文的 ref").toBeTruthy();
        return turn("read_artifact", { ref: pw.artifactRef });
      }
      // 分页循环：一页只有 ARTIFACT_PAGE_BYTES，`hasMore` 为真就得按 nextFrom 续要——
      // 这就是模型侧的真实循环。旧剧本把页数写死（两页），换窗口大小就会在半截 JSON 上 parse 失败，
      // 那正是"剧本假设了阈值"的形状；现在按 hasMore 续到取完为止。
      const pages = toolData()
        .filter((d): d is { text: string; from: number; hasMore?: boolean; nextFrom?: number } =>
          typeof d?.text === "string" && typeof d?.from === "number")
        .sort((a, b) => a.from - b.from);
      if (pages.length) {
        const last = pages[pages.length - 1];
        expect(pages[0].from, "第一页必须从头开始").toBe(0);
        // 取回来的那一页不许被再截一层：页大小一旦等于截断线，适配器会把这一页当成"超限回执"
        // 再折一次并生成新 ref ⇒ 模型永远取不完（本批把 ARTIFACT_PAGE_BYTES 与阈值拆开就是为了这条）。
        // 分页结果不许被二次裁剪，也不许跟着截断线一起变胖（页大小是传输经济，两条线分家才有这条）
        expect(pages.some((p) => (p as { shrunk?: unknown }).shrunk !== undefined), "分页结果被二次裁剪").toBe(false);
        expect(Math.max(...pages.map((p) => p.text.length)), "每页的正文长度必须由 ARTIFACT_PAGE_BYTES 定")
          .toBeLessThanOrEqual(ARTIFACT_PAGE_BYTES + 8);
        if (last.hasMore) {
          // 剧本必须自己封顶：预算默认不限轮数（2026-09-26 裁决），一个不会停的续要是能把
          // 测试 worker 顶到堆溢出的（本批实测撞过一次）。真取不完就该红，不该 OOM。
          expect(pages.length, "分页续到第 20 页还没完 ⇒ 说明 hasMore/nextFrom 不收敛，是真缺陷").toBeLessThan(20);
          return turn("read_artifact", { ref: (toolData()[1] as { artifactRef?: string }).artifactRef, from: last.nextFrom });
        }
        if (wroteCard) return { content: "诊断报告已回填", calls: [] };
        const full = JSON.parse(pages.map((d) => d.text).join("")) as { series: { v: number[] }[] };
        expect(full.series[0].v).toHaveLength(2000);
        const max = Math.max(...full.series[0].v);
        wroteCard = true;
        return turn("run_app_action", { kind: "writeCard", args: { id: "rpt-1", title: "振动分析", kind: "report", summary: { max } } });
      }
      // 卡片写过就得收工。旧剧本靠 `step === 4` 这种写死的步数停在这一点上；
      // 改成按状态判，是因为上一版我把"续到 hasMore 为假"写成循环后，
      // 取完页之后每一轮都重新算一遍指标再发一次 writeCard —— 3125 轮、6250 条消息，
      // 直接把测试 worker 顶到堆溢出（预算默认不限轮数，所以剧本自己必须会停）。
      return { content: "诊断报告已回填", calls: [] };
    };
    vi.mocked(invokeAgentProvider).mockImplementation(script);
    const runId = await agentRun.startRun({ goal: "场景3：读取曲线做诊断报告", scope: "create" });
    const view = agentRun.getSnapshot().runs.find((r) => r.runId === runId)!;
    expect(view.status).toBe("succeeded");
    expect(view.calls).toBeGreaterThanOrEqual(5);
    // 报告卡拿到的是真实窗口算出的指标
    const reportCall = runAppAction.mock.calls.find((c) => c[0] === "writeCard");
    expect((reportCall?.[1] as { summary?: { max?: number } }).summary?.max).toBeGreaterThan(0.99);
    // 租约随 run 终止释放（§6.1）
    const { leaseCount } = await import("../plot/dataLease");
    expect(leaseCount()).toBe(0);
  });
});
