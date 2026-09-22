/**
 * P99a-E1-1：**MCP 派发面的特征测试**（characterization）。
 *
 * 为什么先写这个再动代码：`mcpServer.ts` 的 14 支工具派发是一段 switch，**改之前零测试**
 * （`mcpTools.test.ts` 只钉描述与 schema，`jobExecutor.test.ts` 只钉 job 引擎）。
 * A4b 要把它并进注册表——在没有护栏的路上改道，等于赌"我记对了今天的语义"。
 * 所以这一批测试钉的是**改之前的事实**：每一条都是今天真实发生的行为，
 * 并表后哪条变了必须是**当场有意改断言并写清理由**，不许静默改绿。
 *
 * 另一个刻意选择：`dispatch` 是模块私有函数，测试**不导出它**，
 * 而是从真实入口进（`listen("mcp://call")` 的 handler → `bridge_respond` 的 invoke 参数），
 * 顺带把"回执形状"这个对外合同一起钉住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => {
  const handlers: Record<string, (e: { payload: unknown }) => void> = {};
  const responds: { reqId: number; ok: boolean; data: unknown; err: string | null }[] = [];
  const started: Record<string, unknown>[] = [];
  const settings = {
    mcpEnabled: true, mcpPort: 5599, mcpToken: "0123456789abcdef0123",
    mcpAllowSend: false, mcpHighPriv: false,
  };
  const serial = {
    status: "connected", iface: "serial", portName: "COM7", config: { baud: 115200 },
    rxTotal: 10, txTotal: 2, bps: 1.5,
  };
  const telemetry = {
    stats: { total: 100, errors: 3 },
    tplStats: { t1: { ok: 97, err: 3 } },
    latest: {} as Record<string, { value: number; text: string; valid?: boolean; ts: number }>,
  };
  const sentinel = {
    running: true, health: 80, unack: 1, activeCrit: 0, activeWarn: 1,
    totals: { frames: 100, errors: 2 },
    alerts: [] as { ts: number; level: string; key: string; msg: string; count: number; acked: boolean }[],
  };
  return {
    handlers, responds, started, settings, serial, telemetry, sentinel,
    /** 动态 import 的 appActions 被调记录 + 可编排返回值 */
    calls: [] as { kind: string; args: unknown; highPriv: boolean }[],
    appResult: { ok: true, data: "SNAP" } as { ok: boolean; err?: string; data?: unknown },
    sent: [] as { mode: string; text: string }[],
    /** 与真身同名的高权限集合（今天两侧共用同一份，见 appActionKinds） */
    HIGH_ONLY: new Set(["clearPage", "orchestrator", "plot3d", "vdev", "modbus", "sentinel"]),
    frameHandler: null as ((p: { rows: unknown[] }) => void) | null,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "bridge_start") {
      st.started.push(args);
      return { running: true, port: st.settings.mcpPort };
    }
    if (cmd === "bridge_respond") st.responds.push(args as never);
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    st.handlers[name] = cb;
    return () => {};
  }),
}));
vi.mock("../../ipc/framesBus", () => ({
  onFrames: vi.fn((cb: (p: { rows: unknown[] }) => void) => {
    st.frameHandler = cb;
    return () => {};
  }),
}));
vi.mock("../settings/settingsStore", () => ({
  getSnapshot: () => st.settings,
  subscribe: () => () => {},
}));
vi.mock("../serial/serialStore", () => ({
  getSnapshot: () => st.serial,
  sendData: vi.fn(async (mode: string, text: string) => {
    st.sent.push({ mode, text });
  }),
}));
vi.mock("../protocol/telemetryStore", () => ({ getSnapshot: () => st.telemetry }));
vi.mock("../sentinel/sentinelStore", () => ({ getSnapshot: () => st.sentinel }));
vi.mock("../ai/contextCollector", () => ({ curveStatsText: () => "曲线统计文本" }));
vi.mock("../ai/extRuntime", () => ({ toast: vi.fn() }));
vi.mock("../ai/appActions", () => ({
  HIGH_ONLY: st.HIGH_ONLY,
  runAppAction: vi.fn(async (kind: string, args: Record<string, unknown>, opts: { highPriv: boolean }) => {
    st.calls.push({ kind, args, highPriv: opts.highPriv });
    return st.appResult;
  }),
}));
vi.mock("./jobExecutor", () => ({ initJobExecutor: vi.fn() }));

const { init, getStatus } = await import("./mcpServer");

/** `Array.prototype.at` 不在本项目 tsc 的 lib 目标里（es2020），取尾元素统一走这一条 */
function lastOf<T>(a: readonly T[]): T {
  return a[a.length - 1];
}

/** 走真实入口打一次远程调用，取回 `bridge_respond` 的那一份回执 */
async function call(kind: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: unknown; err: string | null }> {
  st.responds.length = 0;
  st.handlers["mcp://call"]({ payload: { reqId: 7000 + kind.length, kind, args } });
  /**
   * 等回执而不是数微任务：`run_action`/`send` 那两支走**动态 import**（appActions 拖全 store 家族，
   * 刻意不在启动期加载），微任务队列排不干净——写死 `await Promise.resolve()` ×N 会让这几条测试
   * 永远"没有回执"，看着像功能坏了，其实是测试自己在等错东西。
   */
  for (let i = 0; i < 80 && st.responds.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const r = st.responds[st.responds.length - 1];
  expect(r, `${kind} 没有回执`).toBeTruthy();
  return { ok: r.ok, data: r.data, err: r.err };
}

beforeEach(async () => {
  vi.useFakeTimers();
  st.calls.length = 0;
  st.sent.length = 0;
  st.started.length = 0;
  st.responds.length = 0;
  st.settings.mcpAllowSend = false;
  st.settings.mcpHighPriv = false;
  st.appResult = { ok: true, data: "SNAP" };
  st.telemetry.latest = Object.fromEntries(
    Array.from({ length: 3 }, (_, i) => [`f${i}`, { value: i, text: `${i}.0`, ts: i }]),
  );
  init(); // 幂等：`initialized` 守卫，重复调用只装一次订阅
  await vi.advanceTimersByTimeAsync(500); // 400ms 去抖 → bridge_start
  vi.useRealTimers();
});

describe("MCP 现状：入口与生命周期", () => {
  it("启用时按设置起桥，且 reqId 原样回到 bridge_respond", async () => {
    expect(st.started.length).toBeGreaterThan(0);
    expect(st.started[0]).toEqual({ port: 5599, token: st.settings.mcpToken });
    expect(getStatus().running).toBe(true);
  });

  it("未知工具拒；四个 job 工具名走 TS 这条路同样拒（今天由 Rust 先拦）", async () => {
    expect((await call("nope")).err).toContain("未知工具");
    for (const j of ["create_job", "get_job", "wait_event", "cancel_job"]) {
      const r = await call(j);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("未知工具"); // 并表后若改成别的语义，必须写清理由
    }
  });
});

describe("MCP 现状：七支只读", () => {
  it("get_status 是 serial+telemetry 的摘要并带 clients 数", async () => {
    const r = await call("get_status");
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: "connected", iface: "serial", port: "COM7", baud: 115200, rxTotal: 10, frames: st.telemetry.stats });
  });

  it("get_fields 有 400 条上限，超限必须标 truncated（A7：不许「只给一部分还说成全部」）", async () => {
    const r0 = await call("get_fields");
    expect((r0.data as { total: number; truncated: boolean }).total).toBe(3);
    expect((r0.data as { truncated: boolean }).truncated).toBe(false);
    st.telemetry.latest = Object.fromEntries(
      Array.from({ length: 420 }, (_, i) => [`x${i}`, { value: i, text: "v", ts: i }]),
    );
    const r1 = await call("get_fields");
    const d = r1.data as { total: number; truncated: boolean; fields: unknown[] };
    expect(d.total).toBe(420);
    expect(d.fields).toHaveLength(400);
    expect(d.truncated).toBe(true);
  });

  it("get_frames：默认 32 条、游标向前翻、环形缓冲有界", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1, tsMs: i * 10, tplId: "t1", tplName: "T", len: 4, valid: true, error: null,
      bytes: new Uint8Array([1, 2, 3, 4]), fields: [],
    }));
    st.frameHandler!({ rows });
    const first = await call("get_frames");
    const d = first.data as { count: number; hasMore: boolean; nextBeforeSeq: number | null };
    expect(d.count).toBe(32); // 默认页大小
    expect(d.hasMore).toBe(true);
    const second = await call("get_frames", { beforeSeq: d.nextBeforeSeq });
    expect((second.data as { count: number }).count).toBeLessThan(32);
  });

  it("get_plot_stats / get_alerts 是文本与摘要，不抛", async () => {
    expect((await call("get_plot_stats")).data).toEqual({ text: "曲线统计文本" });
    st.sentinel.alerts = [{ ts: 1, level: "crit", key: "silence", msg: "静默", count: 1, acked: false }];
    const a = await call("get_alerts");
    expect(a.data).toMatchObject({ running: true, health: 80, unack: 1, totals: { frames: 100, errors: 2 } });
    expect((a.data as { alerts: unknown[] }).alerts).toHaveLength(1);
  });

  it("get_orchestrator / get_plot3d 走 Read 动作，且不受高权限闸拦（Read 不在 HIGH_ONLY 里）", async () => {
    st.settings.mcpHighPriv = false;
    expect((await call("get_orchestrator")).ok).toBe(true);
    expect(lastOf(st.calls)).toMatchObject({ kind: "orchestratorRead", highPriv: false });
    expect((await call("get_plot3d")).ok).toBe(true);
    expect(lastOf(st.calls).kind).toBe("plot3dRead");
  });

  it("只读动作失败时错误原文回传（不吞成 ok:true）", async () => {
    st.appResult = { ok: false, err: "面板未打开" };
    const r = await call("get_orchestrator");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("面板未打开");
  });
});

describe("MCP 现状：写侧的两道一次性闸", () => {
  it("send 未开「允许远程发送」就拒，且指明去哪儿开", async () => {
    const r = await call("send", { text: "AT" });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("允许远程发送");
    expect(st.sent).toHaveLength(0);
  });

  it("send 开了闸即发：mode 默认 ascii、hex 透传、空/纯空白 text 拒", async () => {
    st.settings.mcpAllowSend = true;
    expect((await call("send", { text: "AT" })).data).toEqual({ sent: "AT", mode: "ascii" });
    expect((await call("send", { text: "AA 55", mode: "hex" })).data).toEqual({ sent: "AA 55", mode: "hex" });
    expect((await call("send", { text: "   " })).ok).toBe(false); // 纯空白也算没内容（本批补的校验，见报告 §3）
    expect(st.sent).toHaveLength(2);
  });

  it("run_action 的高权限动作受「允许高权限」闸；开了才带 highPriv:true 下去", async () => {
    const off = await call("run_action", { kind: "clearPage", args: {} });
    expect(off.ok).toBe(false);
    expect(off.err).toContain("允许高权限");
    st.settings.mcpHighPriv = true;
    expect((await call("run_action", { kind: "clearPage", args: {} })).ok).toBe(true);
    expect(lastOf(st.calls)).toEqual({ kind: "clearPage", args: {}, highPriv: true });
  });

  it("run_action：未知/空 kind 在 MCP 边缘就被拒（不下沉到动作层），args 非对象时归一成 {}", async () => {
    st.settings.mcpHighPriv = true;
    /**
     * **P99a-F1 的改判**（原来这条钉的是"MCP 侧不校验、空 kind 原样转发给 `runAppAction("")`"）：
     * 动作名单改由 `appActionSurface.isKnownActionKind` 一处判，两个前端共用。
     * 调用方看到的文本没变（仍是 `未知动作：…`，与 `appActions.ts:78` 那句同写法），
     * 差别是**那条动作根本不会进 `exec()`**——少一次"带着空 kind 走一遍执行路径"的机会。
     */
    const empty = await call("run_action", { args: {} });
    expect(empty.ok).toBe(false);
    expect(empty.err).toBe("未知动作：");
    const bogus = await call("run_action", { kind: "no_such_action", args: {} });
    expect(bogus.ok).toBe(false);
    expect(bogus.err).toBe("未知动作：no_such_action");
    expect(st.calls).toHaveLength(0); // 两次都没下沉
    expect((await call("run_action", { kind: "toast", args: "字符串" })).ok).toBe(true);
    expect(lastOf(st.calls).args).toEqual({});
    expect((await call("run_action", { kind: "toast", args: [1, 2] })).ok).toBe(true);
    expect(lastOf(st.calls).args).toEqual({});
  });

  it("后台起势类（编排 run/enable、虚设 start）一律 needs_manual_confirmation 且不落到动作层", async () => {
    st.settings.mcpHighPriv = true;
    st.calls.length = 0;
    for (const args of [
      { kind: "orchestrator", args: { op: "run", groupId: "g1" } },
      { kind: "orchestrator", args: { op: "enable", on: true } },
      { kind: "vdev", args: { op: "start", name: "炉子" } },
    ]) {
      const r = await call("run_action", args);
      expect(r.err).toContain("needs_manual_confirmation");
    }
    expect(st.calls).toHaveLength(0);
    // enable:false 是停，不是起势 → 放行
    expect((await call("run_action", { kind: "orchestrator", args: { op: "enable", on: false } })).ok).toBe(true);
  });

  it("run_sequence 执行前一律 async_required（旧同步入口已停用）", async () => {
    const r = await call("run_sequence", { json: "{}" });
    expect(r.err).toContain("async_required");
    expect(st.calls).toHaveLength(0);
  });
});

describe("MCP 现状：审计与回执形状", () => {
  it("每次调用落一条审计（含失败），reqId 原样回传", async () => {
    const before = getStatus().audit.length;
    await call("get_status");
    await call("nope");
    const audit = getStatus().audit.slice(before);
    expect(audit.map((a) => [a.kind, a.ok])).toEqual([["get_status", true], ["nope", false]]);
    expect(audit[1].ms).toBeGreaterThanOrEqual(0);
    expect(lastOf(st.responds).reqId).toBe(7000 + "nope".length);
    expect(lastOf(st.responds).err).toBe("未知工具：nope"); // `Error: ` 前缀已被剥掉
  });

  it("超长错误串截到 300 字（外部进程读到的东西不能无限长）", async () => {
    st.appResult = { ok: false, err: "x".repeat(500) };
    const r = await call("get_orchestrator");
    expect(r.err!.length).toBeLessThanOrEqual(300);
  });
});

/* ================= P99c-C1b：命令行专用通道（cli.） ================= */

vi.mock("../market/marketCli", () => ({
  isCliKind: (kind: string) => kind.startsWith("cli."),
  handleCli: async (kind: string, args: Record<string, unknown>) => ({ via: kind, args }),
}));

describe("P99c-C1b · cli. 通道与 MCP 工具面互不打扰", () => {
  it("cli.* 在工具名检查之前分流，不会撞「未知工具」那句话术", async () => {
    const r = await call("cli.market_status", { limit: 3 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ via: "cli.market_status", args: { limit: 3 } });
    expect(r.err).toBeNull();
  });

  it("工具清单里永不含 cli.*：模型那条路够不到命令行动作面（Q7「AI 只读不装」的前提）", async () => {
    const { ALL_TOOL_DEFS } = await import("./mcpTools");
    expect(ALL_TOOL_DEFS.length).toBeGreaterThan(0); // 反空断言：清单读空了这条就是假绿
    expect(ALL_TOOL_DEFS.some((t) => t.name.startsWith("cli."))).toBe(false);
  });
});
