/**
 * P135-B · 只读子代理的三件事，各有牙：
 *  ① 只读 —— 面是一张**点名白名单**（按 effect 反射会把 `run_app_action` 那类"声明只读、
 *     实为升档"的工具请进来），且写类工具根本不在面上；
 *  ② 同一总预算 —— 上限从父任务的实际剩余折算，用量记回父账；
 *     ⚠ 关键在于 `caps` 的 0 是"不限"，而这里的 0 必须是"没了"：混用就等于给嵌套开了一条
 *     绕过预算的路（`subagentCaps` 与那条测试钉的就是这一点）；
 *  ③ 不能再扩权 —— 授权域照抄父任务那份再裁一次，父读不到的子也读不到。
 * 另外两条合同：递归在结构上不存在（名单里没有 `subagent`），成本面有独立开关。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
// 与 agentAdapter.test 同一套：把重模块挡住，测试不触渲染链
const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
const operator = vi.hoisted(() => ({ pkg: null as unknown }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: operator.pkg }) }));
const plot = vi.hoisted(() => ({
  getSnapshot: vi.fn(() => ({ channels: [] })),
  getChanData: vi.fn(() => ({ t: [], v: [] })),
  timeOrigin: vi.fn(() => 1000),
  sampleRate: vi.fn(() => 50),
}));
vi.mock("../plot/plotStore", () => plot);
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

const { SUBAGENT_FACE, SUBAGENT_CAPS, subagentCaps, subagentCapHit, subagentToolEntries } = await import("./subagent");
const { createReadOnlyAgentAdapter } = await import("./agentAdapter");
const { hostEntryByName } = await import("./hostEntries");
const { toolHarness, recordingGate } = await import("./toolTestKit");
const { runAgent } = await import("./loop");
const { patch } = await import("../settings/settingsStore");
import type { AgentProvider, SubagentReport, TaskAdapter, TaskContext } from "./types";

const ENTRY = subagentToolEntries[0];
const FACE = new Set<string>(SUBAGENT_FACE);
const names = (adapter: { definitions: { name: string }[] }) => adapter.definitions.map((d) => d.name);

const report = (over: Partial<SubagentReport> = {}): SubagentReport => ({
  status: "succeeded", rounds: 2, calls: 3, tools: ["fs_read", "fs_grep"], text: "帧尾两字节像 CRC16，初值 0xFFFF",
  caps: { ...SUBAGENT_CAPS }, elapsedMs: 12_000, ...over,
});

function harness(dispatch?: unknown, gate = recordingGate()) {
  const h = toolHarness([ENTRY], { gate });
  if (dispatch) h.scratch.subagent = dispatch as never;
  return h;
}

beforeEach(() => {
  patch({ agentSubagent: true });
});

describe("只读面（判据①）", () => {
  it("名单里每一支都存在且真是只读；漏配与升档都红", () => {
    for (const name of SUBAGENT_FACE) {
      const e = hostEntryByName(name);
      expect(e, `子代理名单里的 ${name} 在注册表里不存在（漂了）`).toBeTruthy();
      const effect = e!.effect;
      expect(["read", "analysis"], `${name} 不是只读（effect=${effect}）：它不该出现在子代理面上`).toContain(effect);
    }
    expect(SUBAGENT_FACE.length, "名单长度变了要连同详设 §2 那段理由一起回看").toBe(21);
  });

  it("那四支「声明只读、其实会做事」的不在名单上", () => {
    // run_app_action：assess 按内层 kind 升档到 destructive_write / device_send
    // plot_channels / plot_window：只读但申请数据租约，子任务不是 run 视图、没人回收
    // task_plan：写计划台账，而闭环判据绑的是父 runId
    for (const name of ["run_app_action", "plot_channels", "plot_window", "task_plan"]) {
      expect(FACE.has(name), `${name} 不该进只读面`).toBe(false);
    }
  });

  it("名单里没有 subagent 自己：递归在结构上不存在", () => {
    expect(FACE.has("subagent")).toBe(false);
    const sub = createReadOnlyAgentAdapter({ runId: "s1", scope: "custom", allowed: ["config", "plugins", "files"] });
    expect(names(sub), "子代理的工具面上能再派子代理 ⇒ 无限套娃").not.toContain("subagent");
    // 真调也走不到派发：子的 scratch 没接装配，宿主面里那支 entry 根本不在这张面上
    expect(names(sub)).not.toContain("fs_write");
  });

  it("子适配器的工具面**恰好等于**这张名单：按 effect 反射组面会在这里红", () => {
    const ALL = ["config", "plugins", "device", "files", "network", "shell", "ui", "write"];
    const got = new Set(names(createReadOnlyAgentAdapter({ runId: "s6", scope: "custom", allowed: ALL })));
    for (const n of SUBAGENT_FACE) expect(got.has(n), `名单里的 ${n} 没进子面（装配与名单漂了）`).toBe(true);
    for (const n of got) expect(FACE.has(n), `子面里多出名单外的一支：${n}（反射组面的典型后果）`).toBe(true);
    expect(got.size, "八域全开时子面应当恰好是整张名单").toBe(SUBAGENT_FACE.length);
  });

  it("写类工具在子面上根本不存在：调 fs_write 得 unknown_tool 而不是被执行", async () => {
    const sub = createReadOnlyAgentAdapter({ runId: "s2", scope: "custom", allowed: ["config", "plugins", "files", "write"] });
    const r = await sub.execute({ callId: "w1", name: "fs_write", arguments: "{}" }, {
      source: "local_agent", runId: "s2", signal: new AbortController().signal, scope: "custom", allowed: ["write"],
    });
    expect(r.ok).toBe(false);
    expect(r.code, "写类工具竟然被派发出去了（面不是白名单）").toBe("unknown_tool");
  });
});

describe("授权域继承（判据③：不能再扩权）", () => {
  it("仅预览档的子代理只剩无域那几支，文件与网络都进不去", () => {
    const preview = names(createReadOnlyAgentAdapter({ runId: "s3", scope: "preview" }));
    for (const gated of ["fs_read", "fs_grep", "session_read", "web_fetch", "image_swatch"]) {
      expect(preview, `${gated} 需要授权域，仅预览档不该拿到它`).not.toContain(gated);
    }
    expect(preview).toContain("theme_read"); // 无域那支恒发，与主面同一条规则
  });

  it("勾了 files 才有 fs_read；没勾 network 就没有 web_search —— 父读不到的子也读不到", () => {
    const withFiles = names(createReadOnlyAgentAdapter({ runId: "s4", scope: "custom", allowed: ["files"] }));
    expect(withFiles).toContain("fs_read");
    expect(withFiles, "父任务没勾网络域，子代理却拿到了 web_search ⇒ 扩权").not.toContain("web_search");
  });

  it("子面是父面的子集：同一份 (scope, allowed) 下不会多出父面没有的工具", () => {
    const allowed = ["config", "plugins", "files"] as const;
    const parent = names(createReadOnlyAgentAdapter({ runId: "s5", scope: "custom", allowed }));
    const list = ["fs_read", "fs_list", "fs_grep", "fs_glob", "session_read", "theme_read", "app_state", "ui_inventory"];
    for (const n of list) expect(parent.includes(n), `对照名单漂了：${n}`).toBe(FACE.has(n));
  });
});

describe("预算继承（判据②）", () => {
  it("父剩多少就交多少；父不限则跟着不限；父剩 0 一律不许开跑", () => {
    // P138-A 撤掉自带上限 ⇒ SUBAGENT_CAPS 三项都是 0（=不限）。
    // 契约变更（§8-44 口径）：旧断言钉的是"子有一档自己的顶（16 次）"，那档现在没了；
    // 换成钉"父剩 40 次就交 40 次"——它同时是撤除后最容易写反的那处：
    // 若照 `Math.min(own=0, 40)` 取，0 会被 loop 读成"不限" ⇒ 绕开父预算（P135-B §3 那颗雷复活）。
    expect(subagentCaps(undefined)).toEqual(SUBAGENT_CAPS);
    expect(subagentCaps({ rounds: null, calls: null, ms: null })).toEqual(SUBAGENT_CAPS);
    expect(subagentCaps({ rounds: 2, calls: 40, ms: 30_000 }))
      .toEqual({ maxRounds: 2, maxCalls: 40, timeoutMs: 30_000 });
    // ⚠ 这三条是本批最容易写错的地方：caps 的 0 = 不限，父额度用完也是 0
    expect(subagentCaps({ rounds: 0, calls: 5, ms: 5_000 }), "父轮数用尽还放行 ⇒ 派子任务成了绕过预算的路").toBeNull();
    expect(subagentCaps({ rounds: 3, calls: 0, ms: 5_000 })).toBeNull();
    expect(subagentCaps({ rounds: 3, calls: 3, ms: 0 }), "已到时限还放行").toBeNull();
  });

  it("撞顶判定不再把'不限'读成'用尽'（0 档必须跳过，否则每次派发都报撞顶）", () => {
    expect(subagentCapHit({ maxRounds: 0, maxCalls: 0, timeoutMs: 0 }, { rounds: 99, calls: 99, elapsedMs: 10 ** 9 })).toBeNull();
    expect(subagentCapHit({ maxRounds: 3, maxCalls: 0, timeoutMs: 0 }, { rounds: 3, calls: 99, elapsedMs: 10 ** 9 })).toBe("rounds");
    expect(subagentCapHit({ maxRounds: 9, maxCalls: 4, timeoutMs: 0 }, { rounds: 1, calls: 4, elapsedMs: 1 })).toBe("calls");
    expect(subagentCapHit({ maxRounds: 9, maxCalls: 9, timeoutMs: 1000 }, { rounds: 1, calls: 1, elapsedMs: 1000 })).toBe("ms");
    expect(subagentCapHit({ maxRounds: 9, maxCalls: 9, timeoutMs: 1000 }, { rounds: 1, calls: 1, elapsedMs: 999 })).toBeNull();
  });

  it("开关关着 → subagent_disabled，而且不弹批准卡（白要一次确认＝橡皮图章）", async () => {
    patch({ agentSubagent: false });
    const gate = recordingGate();
    const h = harness(async () => report(), gate);
    const r = await h.run("subagent", { goal: "看看这份日志里温度跳变几次" });
    expect(r.code).toBe("subagent_disabled");
    expect(gate.requests, "总开关关着还要人点头是多余的摩擦").toHaveLength(0);
  });

  it("没接装配的通路 → 如实的 subagent_unavailable，不给一条假成功", async () => {
    const h = harness(); // 没有 dispatch
    const r = await h.run("subagent", { goal: "查一下" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("subagent_unavailable");
  });

  it("父额度用尽 → subagent_budget_exhausted，dispatch 一次都没被调用", async () => {
    let called = 0;
    const h = harness(async () => { called++; return report(); });
    const r = await h.run("subagent", { goal: "查一下" }, { remaining: { rounds: 0, calls: 2, ms: 9_000 } });
    expect(r.code).toBe("subagent_budget_exhausted");
    expect(called, "assess 拒了却还是把子任务跑了出去").toBe(0);
  });

  it("goal 为空 → subagent_no_goal（不许把空问题派出去烧一轮）", async () => {
    const h = harness(async () => report());
    const r = await h.run("subagent", { goal: "   " });
    expect(r.code).toBe("subagent_no_goal");
  });
});

describe("回报与记账", () => {
  it("成功那条带回 answer/rounds/calls/toolsUsed，并明说这是报告不是证据", async () => {
    const charged: { rounds: number; calls: number }[] = [];
    const h = harness(async () => report());
    const r = await h.run("subagent", { goal: "哪几字节像校验位" }, {
      remaining: { rounds: 6, calls: 6, ms: 60_000 },
      chargeNested: (u) => charged.push({ rounds: u.rounds, calls: u.calls }),
    });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, unknown>;
    expect(String(d.answer)).toContain("CRC16");
    expect(d.toolsUsed).toEqual(["fs_read", "fs_grep"]);
    expect(String(d.note)).toContain("报告");
    expect(String(d.note)).not.toContain("已经改好");
    expect(charged).toEqual([{ rounds: 2, calls: 3 }]);
  });

  it("子任务没跑完：ok:false + subagent_incomplete，但仍然带回它拿到的东西与终态", async () => {
    const h = harness(async () => report({ status: "paused", text: "读到一半", rounds: 6, calls: 16 }));
    const r = await h.run("subagent", { goal: "查" }, { remaining: { rounds: 6, calls: 16, ms: 60_000 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("subagent_incomplete");
    const d = r.data as Record<string, unknown>;
    expect(d.answer).toBe("读到一半"); // "没做完"要说得出做到哪儿了
    expect(d.subStatus).toBe("paused");
    expect(String(d.note)).toContain("没跑完");
  });

  it("派发拿到的是父任务那一个 signal：点停止必须能停在子的下一轮之前", async () => {
    const ctrl = new AbortController();
    let got: AbortSignal | undefined;
    const h = harness(async (_goal: string, c: TaskContext) => { got = c.signal; return report(); });
    await h.run("subagent", { goal: "查一下" }, { signal: ctrl.signal });
    expect(got, "另起一个 AbortController ⇒ 父任务停了、子任务还在烧请求").toBe(ctrl.signal);
  });

  it("父任务的实际计数包含子任务烧掉的量（loop 侧），并且用完就 paused", async () => {
    const seen: (TaskContext["remaining"] | undefined)[] = [];
    const adapter: TaskAdapter = {
      definitions: [{ name: "subagent", description: "d", parameters: { type: "object", properties: {} } }],
      async execute(call, ctx) {
        seen.push(ctx.remaining);
        // 模拟一次派发：子任务烧了 2 轮 3 次
        ctx.chargeNested?.({ rounds: 2, calls: 3, tools: ["fs_read"] });
        return { callId: call.callId, ok: true, status: "read", data: { answer: "查完了" } };
      },
    };
    let turn = 0;
    const provider: AgentProvider = async () => {
      turn++;
      // 第 3 轮起模型还想再派，但预算已经没了
      return turn <= 3
        ? { content: `t${turn}`, calls: [{ callId: `c${turn}`, name: "subagent", arguments: '{"goal":"g"}' }] }
        : { content: "done", calls: [] };
    };
    const r = await runAgent({
      goal: "派活给自己查", provider, adapter,
      context: { source: "local_agent", runId: "t", signal: new AbortController().signal, scope: "create" },
      maxRounds: 4, maxCalls: 100, timeoutMs: 0,
    });
    // 口径：`remaining` 是**本轮已经用过之后**还剩多少（父自己这一轮已在账上），
    // 而这一次调用本身还没计数（它在 execute 之后才 +1）——所以首轮是 rounds 3 / calls 100。
    expect(seen[0], "工具没收到本轮剩余额度 ⇒ 子代理无法夹自己的上限").toEqual({ rounds: 3, calls: 100, ms: null });
    expect(seen[1]!.rounds, "第二轮的剩余没扣掉子任务烧掉的量").toBe(0);
    expect(seen[1]!.calls, "第二轮的剩余额度没扣掉子任务烧掉的调用").toBe(96);
    // 0 在这里就是"没了"，不是 caps 那句"不限"——这一句把 §3 那颗雷钉在真数据上
    expect(subagentCaps(seen[1]!), "本轮恰好用完父额度时该拒派，而不是把 0 读成不限").toBeNull();
    expect(r.rounds, "父计数不含子的量（界面上那个 N/24 会少报）").toBeGreaterThanOrEqual(4);
    expect(r.status).toBe("paused");
    expect(r.pauseReason).toBe("rounds");
  });
});
