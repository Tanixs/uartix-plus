/**
 * P88b-2 adapter 单测：策略门四值、审批绑定（同参放行/换参失效/过期作废）、
 * preview 档位零写入、租约一次性申请、plot_window 抽稀、read_artifact 取回。
 * 重模块（appActions/serial/operator/plotStore/provider）全部 mock，不触渲染链。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const runAppAction = vi.hoisted(() => vi.fn());
vi.mock("../ai/appActions", () => ({ runAppAction }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }) }));
const operator = vi.hoisted(() => ({ pkg: null as unknown }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: operator.pkg }) }));
const plot = vi.hoisted(() => ({
  getSnapshot: vi.fn(() => ({ channels: [{ id: "c1", name: "加速度X", tplId: "t1", fieldId: "f1", visible: true, color: "#000" }] })),
  getChanData: vi.fn(() => ({ t: [0, 1000, 2000], v: [1, 2, 3] })),
  timeOrigin: vi.fn(() => 1000),
  sampleRate: vi.fn(() => 50),
}));
vi.mock("../plot/plotStore", () => plot);
// P97-I6：插件回滚会 scheduleStyles → extRuntime 直取 document（node 环境没有）；
// 与 pluginsCore.test 同一手法，只挡这一层 DOM 出口
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

const { createLocalAgentAdapter } = await import("./agentAdapter");
// P99a-A2：审批原语搬到 toolRegistry、清单上限搬到 localEntries（不再有"从适配器再导一次"的壳）
const { argsHash, APPROVAL_TTL_MS } = await import("./toolRegistry");
const { LIST_CAP, OVERVIEW_LIMIT } = await import("./localEntries");
// P99a-C1：parity 断言要用目录本体当参照（app_state 必须是它的投影，不是第二份读者）
const { CATALOG_VIEWS, readCatalog } = await import("./hostCatalog");
const { releaseDataLease, leaseCount } = await import("../plot/dataLease");
import type { ApprovalGate, ApprovalRequest } from "./toolRegistry";
import type { TaskContext, ToolCall } from "./types";

function ctx(scope: "preview" | "create" | "custom", allowed?: string[]): TaskContext {
  return { source: "local_agent", runId: "r1", signal: new AbortController().signal, scope, ...(allowed ? { allowed } : {}) };
}
const call = (name: string, args?: unknown): ToolCall => ({
  callId: crypto.randomUUID(), name, arguments: JSON.stringify(args ?? {}),
});
function fakeGate(): ApprovalGate & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    request: vi.fn((r: ApprovalRequest) => requests.push(r)),
    takeToken: vi.fn((_rid: string, _tool: string, _hash: string, _now: number) => null as string | null),
    reject: vi.fn(),
  };
}

beforeEach(() => {
  runAppAction.mockReset();
  runAppAction.mockResolvedValue({ ok: true, data: "完成" });
  operator.pkg = null;
  releaseDataLease("r1");
});

describe("agentAdapter 策略门", () => {
  it("preview 档位：写动作 preview_only 零执行", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("run_app_action", { kind: "setTheme", args: { name: "glass" } }), ctx("preview"));
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "preview_only" });
    expect(runAppAction).not.toHaveBeenCalled();
  });

  it("P97-I4 插件库门只认 hasDomain：新档位不会因手写 scope 判断而静默漏判", async () => {
    // 用「缺 kind」这一**下游**校验当探针：能走到它就说明授权门放行了。
    // 旧写法是 `scope === "custom" && !allowed.includes("plugins")`，与 hasDomain 同义但是第二份真相。
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const probe = () => a.execute(call("save_plugin", { name: "T" }), ctx("create"));
    expect((await probe()).code).toBe("invalid_kind");
    expect((await a.execute(call("save_plugin", { name: "T" }), ctx("preview"))).code).toBe("preview_only");
    expect((await a.execute(call("save_plugin", { name: "T" }), ctx("custom", ["config"]))).code).toBe("unauthorized_scope");
    // 扩展档（host / full）scope 也是 custom：勾选集含 plugins 就必须放行
    expect((await a.execute(call("save_plugin", { name: "T" }), ctx("custom", ["config", "plugins"]))).code).toBe("invalid_kind");
  });

  it("P97-I6 版本链：改自己的作品升版而不是再造一个插件，且能退回上一版", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const pluginStore = await import("../plugins/pluginStore");
    const id = "user.agent.chain-probe";
    const body = (html: string) => ({ kind: "panel", name: "链路探针", id, payload: { format: "html", html } });

    const first = await a.execute(call("save_plugin", body("<i>v1</i>")), ctx("create"));
    expect(first).toMatchObject({ ok: true, status: "applied" });
    expect((first.data as { version?: string }).version).toBe("0.1.0");

    // 同一个 id 再存一次 ⇒ 走版本链：不新增记录、版本号 +1、旧版进栈
    const second = await a.execute(call("save_plugin", { ...body("<i>v2</i>"), update: id }), ctx("create"));
    expect(second).toMatchObject({ ok: true, status: "applied" });
    const d2 = second.data as { version: string; updated: boolean; history: number; pluginId: string };
    expect(d2).toMatchObject({ pluginId: id, updated: true, version: "0.1.1", history: 1 });
    expect(pluginStore.getSnapshot().plugins.filter((p) => p.pkg.id === id)).toHaveLength(1);
    expect(pluginStore.getPlugin(id)?.pkg.artifacts["main.json"]).toMatchObject({ html: "<i>v2</i>" });

    // 用户/导入件一律拒绝直改（provenance 由 duplicate() 翻成 user，这里直接构造）
    const dup = pluginStore.duplicate(id);
    expect(dup.ok).toBe(true);
    const refused = await a.execute(call("save_plugin", { ...body("<i>x</i>"), update: dup.id }), ctx("create"));
    expect(refused.code).toBe("update_needs_user");
    expect(refused.data).toMatchObject({ id: dup.id, createdBy: "user" });

    // 退回上一版：栈是来回切换的，所以再调一次又回到 v2
    // （装进来是 installed_disabled，走过一次 approveUpdate 后落回 disabled——两者都非启用，投影都没建）
    expect(pluginStore.getPlugin(id)?.state).toBe("disabled");
    const back = await a.execute(call("rollback_plugin", { id }), ctx("create"));
    expect(back).toMatchObject({ ok: true, status: "applied" });
    expect(pluginStore.getPlugin(id)?.pkg.version).toBe("0.1.0");
    expect(pluginStore.getPlugin(id)?.pkg.artifacts["main.json"]).toMatchObject({ html: "<i>v1</i>" });
    await a.execute(call("rollback_plugin", { id }), ctx("create"));
    expect(pluginStore.getPlugin(id)?.pkg.version).toBe("0.1.1");

    expect((await a.execute(call("rollback_plugin", { id: "no.such.plugin" }), ctx("create"))).code).toBe("plugin_not_found");
    // 未授权档一律不动版本（rollback_plugin 与 save_plugin 同一道 plugins 门）
    expect((await a.execute(call("rollback_plugin", { id }), ctx("custom", ["config"]))).code).toBe("unauthorized_scope");
    expect(pluginStore.getPlugin(id)?.pkg.version).toBe("0.1.1");
  });

  it("create 档位：config_write 自动执行；read 回执 status=read", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("run_app_action", { kind: "setTheme", args: { name: "glass" } }), ctx("create"));
    expect(runAppAction).toHaveBeenCalledWith("setTheme", { name: "glass" }, { highPriv: true });
    expect(r).toMatchObject({ ok: true, status: "applied" });
    const r2 = await a.execute(call("run_app_action", { kind: "listProtocols" }), ctx("create"));
    expect(r2.status).toBe("read");
  });

  it("破坏性动作需本地批准：回执 needs_local_approval 且计划入卡", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const args = { kind: "removeCard", args: { id: "card-9" } };
    const r = await a.execute(call("run_app_action", args), ctx("create"));
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "needs_local_approval" });
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0].plan).toContain("删除或覆盖");
    expect(gate.requests[0].tool).toBe("removeCard");
    expect(runAppAction).not.toHaveBeenCalled();
  });

  it("批准令牌绑定参数：同参放行，换参重新请求批准", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const args = { kind: "removeCard", args: { id: "card-9" } };
    await a.execute(call("run_app_action", args), ctx("create"));
    // 用户批准：绑定同参 hash
    vi.mocked(gate.takeToken).mockImplementation((_rid, tool, hash) => (tool === "removeCard" && hash === argsHash(args) ? "tok-1" : null));
    const ok = await a.execute(call("run_app_action", args), ctx("create"));
    expect(ok.ok).toBe(true);
    // 换参：令牌不匹配 → 再次 needs_local_approval
    const changed = await a.execute(call("run_app_action", { kind: "removeCard", args: { id: "card-OTHER" } }), ctx("create"));
    expect(changed.code).toBe("needs_local_approval");
  });

  it("Operator 锁：写动作 deny；未知动作 unknown_action", async () => {
    operator.pkg = { id: "pkg" };
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const r = await a.execute(call("run_app_action", { kind: "setTheme" }), ctx("create"));
    expect(r.code).toBe("denied_by_policy");
    const r2 = await a.execute(call("run_app_action", { kind: "nope" }), ctx("create"));
    expect(r2.code).toBe("unknown_action");
  });

  it("设备上下文 unknown（未连接）：device_send 需批准，不猜成仿真", async () => {
    const gate = fakeGate();
    const a = createLocalAgentAdapter({ runId: "r1", gate });
    const r = await a.execute(call("run_app_action", { kind: "openPort", args: { port: "COM3" } }), ctx("create"));
    expect(r.code).toBe("needs_local_approval");
    expect(gate.requests[0].plan).toContain("实车");
  });
});

describe("agentAdapter 数据分析工具（§6.1 租约）", () => {
  it("plot_channels：首次申请租约，回执含统计与 coverage；二次调用不重复申请", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("plot_channels"), ctx("create"));
    expect(r.ok).toBe(true);
    const data = r.data as { channels: { id: string; points: number; min: number; max: number; sampleRate: number }[]; coverage: { live: boolean } };
    expect(data.channels[0]).toMatchObject({ id: "c1", points: 3, min: 1, max: 3, sampleRate: 50 });
    expect(data.coverage.live).toBe(true);
    expect(leaseCount()).toBe(1);
    await a.execute(call("plot_channels"), ctx("create"));
    expect(leaseCount()).toBe(1);
  });

  it("P90 F app_state：聚合只读、preview 档同样放行、段可裁剪、回执 ≤8KB", async () => {
    const a = createLocalAgentAdapter({ runId: "r-state", gate: fakeGate() });
    const r = await a.execute(call("app_state", { sections: ["session", "plugins"] }), ctx("preview"));
    expect(r.ok).toBe(true);
    expect(r.status).toBe("read");
    const d = r.data as Record<string, { operatorLocked?: boolean; items?: unknown[] }>;
    expect(d.session.operatorLocked).toBe(false);
    expect(Array.isArray(d.plugins.items)).toBe(true);
    expect(d.protocols).toBeUndefined(); // 未请求的段不出现
    const all = await a.execute(call("app_state"), ctx("create"));
    expect(JSON.stringify(all.data).length).toBeLessThanOrEqual(8 * 1024);
    expect((all.data as { channels?: { items: unknown[] } }).channels?.items.length).toBeGreaterThan(0);
    // P99a-C1：概览的瘦身规则只有一条（分段上限 OVERVIEW_LIMIT），且必须自报"给了几条 / 共几条"
    const seg = (all.data as { protocols: { items: unknown[]; total: number } }).protocols;
    expect(seg.items.length).toBeLessThanOrEqual(OVERVIEW_LIMIT);
    expect(seg.total).toBeGreaterThanOrEqual(seg.items.length);
    expect(String((all.data as { note: string }).note)).toContain("app_read");
    expect(String((all.data as { note: string }).note)).toContain(String(OVERVIEW_LIMIT));
  });

  it("plot_window：超限抽稀保首尾；2000 硬顶经 artifact 可验", async () => {
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 5000 }, (_, i) => i * 10),
      v: Array.from({ length: 5000 }, (_, i) => i),
    });
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    // 500 点 ≈ 5KB，低于 8KiB 截断线：回执内可直接验证抽稀
    const r = await a.execute(call("plot_window", { channelIds: ["c1"], maxPoints: 500 }), ctx("create"));
    const data = r.data as { series: { t: number[]; v: number[] }[]; truncated?: boolean };
    expect(data.truncated).toBeUndefined();
    expect(data.series[0].t).toHaveLength(500);
    expect(data.series[0].t[0]).toBe(0);
    expect(data.series[0].t[499]).toBe(49990);
    // 请求 99999 → 硬顶 2000：P95-H3 先按形态压缩（回执里是分位数+首尾），
    // 但**原文照存**并挂 artifactRef ⇒ 压缩不等于销毁，模型仍能要回逐点数据。
    const c2 = call("plot_window", { maxPoints: 99999 });
    const r2 = await a.execute(c2, ctx("create"));
    const d2 = r2.data as { shrunk?: { shape: string; dropped: number }; artifactRef?: string };
    expect(d2.shrunk?.shape).toBe("series");
    expect(d2.shrunk?.dropped).toBeGreaterThan(0);
    expect(d2.artifactRef).toBe(`call:${c2.callId}`);
    const stored = a.artifacts.get(`call:${c2.callId}`) as { series: { t: number[] }[] };
    expect(stored.series[0].t.length).toBe(2000);
  });

  it("大回执转 artifactRef（带预览）；read_artifact 分页取回可完整拼回原文", async () => {
    plot.getChanData.mockReturnValue({
      t: Array.from({ length: 4000 }, (_, i) => i),
      v: Array.from({ length: 4000 }, (_, i) => i),
    });
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const c = call("plot_window", { maxPoints: 2000 });
    const r = await a.execute(c, ctx("create"));
    const d = r.data as { artifactRef?: string; shrunk?: { shape: string }; preview?: string };
    // P95-H3：能按形态压进预算就不给"预览占位"，但一定挂可取回的 ref
    expect(d.shrunk?.shape).toBe("series");
    expect(d.artifactRef).toBe(`call:${c.callId}`);

    let acc = "";
    let from = 0;
    for (let i = 0; i < 40; i++) {
      const page = await a.execute(call("read_artifact", { ref: d.artifactRef, from }), ctx("create"));
      const pd = page.data as { text: string; hasMore: boolean; nextFrom: number; from: number };
      expect(pd.from).toBe(from);
      expect(pd.text.length).toBeGreaterThan(0); // 保证有前进量，否则模型会在同一页死循环
      acc += pd.text;
      from = pd.nextFrom;
      if (!pd.hasMore) break;
    }
    const restored = JSON.parse(acc) as { series: { t: number[] }[] };
    expect(restored.series[0].t.length).toBe(2000); // 分页拼回 = 原样
    // 读完了再要一页 → 空文本、hasMore=false（不报错，模型能自然停止）
    const tail = await a.execute(call("read_artifact", { ref: d.artifactRef, from }), ctx("create"));
    expect((tail.data as { hasMore: boolean; text: string }).hasMore).toBe(false);
    expect((tail.data as { text: string }).text).toBe("");
  });

  it("P94-G3：ref 不在缓存里如实报过期（旧实现报 not_found，模型以为是自己写错了参数）", async () => {
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const miss = await a.execute(call("read_artifact", { ref: "call:gone" }), ctx("create"));
    expect(miss.code).toBe("artifact_expired");
    expect(String((miss.data as { hint?: string }).hint)).toContain("重新调用");
    const noRef = await a.execute(call("read_artifact", {}), ctx("create"));
    expect(noRef.code).toBe("invalid_args");
  });

  it("P94 G4：清单类回执封顶并回 count/returned/truncated（不再无上限整份进上下文）", async () => {
    const original = plot.getSnapshot();
    plot.getSnapshot.mockReturnValue({
      channels: Array.from({ length: LIST_CAP.channels + 12 }, (_, i) => ({
        id: `c${i}`, name: `通道${i}`, tplId: "t", fieldId: "f", color: "#fff", visible: true,
      })),
    });
    try {
      const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
      const r = await a.execute(call("plot_channels"), ctx("create"));
      const d = r.data as { channels: unknown[]; count: number; returned: number; truncated: boolean };
      expect(d.count).toBe(LIST_CAP.channels + 12);
      expect(d.returned).toBe(LIST_CAP.channels);
      expect(d.channels.length).toBe(LIST_CAP.channels);
      expect(d.truncated).toBe(true);
    } finally {
      plot.getSnapshot.mockReturnValue(original);
    }
  });

  it("取消后零执行；未知工具 unknown_tool", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = createLocalAgentAdapter({ runId: "r1", gate: fakeGate() });
    const r = await a.execute(call("plot_channels"), { source: "local_agent", runId: "r1", signal: ac.signal, scope: "create" });
    expect(r.code).toBe("cancelled");
    const r2 = await a.execute(call("time_travel"), ctx("create"));
    expect(r2.code).toBe("unknown_tool");
    expect(APPROVAL_TTL_MS).toBeGreaterThan(0);
  });
});

describe("P93-A6：工具定义按授权域裁剪下发", () => {
  it("未授权的主机工具不再发给模型（旧实现无条件发 5 支，模型看得见却调不动 → 白烧一轮再报错）", () => {
    const names = (scope: "preview" | "create" | "custom", allowed: string[]) =>
      createLocalAgentAdapter({ runId: "r9", gate: fakeGate(), scope, allowed }).definitions.map((d) => d.name);
    const host = ["fs_read", "fs_list", "web_fetch", "web_search", "shell_exec"];
    expect(names("preview", []).filter((n) => host.includes(n))).toEqual([]);
    expect(names("create", []).filter((n) => host.includes(n))).toEqual([]);
    const filesOnly = names("custom", ["files"]);
    expect(filesOnly).toEqual(expect.arrayContaining(["fs_read", "fs_list"]));
    expect(filesOnly).not.toContain("shell_exec");
    expect(filesOnly).not.toContain("web_search");
    expect(names("custom", ["shell"])).toContain("shell_exec");
    // 其余工具不受裁剪影响
    expect(names("preview", [])).toEqual(expect.arrayContaining(["settings_read", "plot_channels", "app_state"]));
    // 缺省（旧调用方不传 scope）仍按 create 行为，不缩小既有能力面
    expect(createLocalAgentAdapter({ runId: "r10", gate: fakeGate() }).definitions.map((d) => d.name)).not.toContain("fs_read");
  });
});

describe("P99a-C1：宿主自省目录的两个前端", () => {
  it("app_catalog 就是目录本身：菜单条数==声明条数，每道菜写清给什么、上限多少", async () => {
    const a = createLocalAgentAdapter({ runId: "r-cat", gate: fakeGate() });
    const r = await a.execute(call("app_catalog"), ctx("preview")); // 只读：preview 档同样放行
    expect(r).toMatchObject({ ok: true, status: "read" });
    const d = r.data as { groups: { group: string; zh: string; views: Record<string, unknown>[] }[]; usage: string };
    expect(d.groups.reduce((n, g) => n + g.views.length, 0)).toBe(CATALOG_VIEWS.length);
    for (const g of d.groups) {
      expect(g.zh.length).toBeGreaterThan(0);
      for (const v of g.views) {
        expect(typeof v.path).toBe("string");
        expect(String(v.gives).length).toBeGreaterThan(24); // 每道菜都得写清给什么字段，不许留空话
        expect(Number(v.maxBytes)).toBeGreaterThan(0);
      }
    }
    expect(d.usage).toContain("app_read");
    expect(d.usage).toContain("反射"); // 诚实声明边界：读不到的东西是不存在，不是藏起来了
  });

  it("P99a-C1b：app_read 的描述里，路径清单与目录一一对齐（不再手抄第二份）", () => {
    // 病根：这句描述曾手写 13 条路径。本批接进七面 12 条新路径后，模型看描述仍只会点老几样，
    // 而它其实读得到 3D 轨迹与编排器——一份写死的清单就是第二真相（§8-36①）。
    const desc = createLocalAgentAdapter({ runId: "r-c1b", gate: fakeGate() }).definitions
      .find((d) => d.name === "app_read")!.description;
    for (const v of CATALOG_VIEWS) {
      expect(desc, `app_read 描述里没有 ${v.path}`).toContain(v.path);
    }
    expect(desc.match(/app_catalog \(([^)]+)\)/)?.[1].split("|").length).toBe(CATALOG_VIEWS.length);
  });

  it("app_read：路径必填、未声明即拒并回全部可用路径；分页字段原样透传并教怎么翻", async () => {
    const a = createLocalAgentAdapter({ runId: "r-read", gate: fakeGate() });
    expect((await a.execute(call("app_read", {}), ctx("create"))).code).toBe("invalid_args");
    const bad = await a.execute(call("app_read", { path: "settings" }), ctx("create"));
    expect(bad).toMatchObject({ ok: false, status: "not_executed", code: "unknown_path" });
    expect((bad.data as { all: string[] }).all).toHaveLength(CATALOG_VIEWS.length);
    // 详情视图缺 id：把菜单原文抄来也必须给出 next-step，而不是回一个空对象
    expect((await a.execute(call("app_read", { path: "protocols/<id>" }), ctx("create"))).code).toBe("needs_id");
    expect((await a.execute(call("app_read", { path: "protocols/nonexistent" }), ctx("create"))).code).toBe("unknown_id");

    plot.getSnapshot.mockReturnValue({ channels: [0, 1, 2].map((i) => ({ id: `c${i}`, name: `通道${i}`, tplId: "t1", fieldId: "f1", visible: true, color: "#000" })) });
    const p1 = await a.execute(call("app_read", { path: "channels", limit: 2 }), ctx("create"));
    const d = p1.data as { cursor: number; total: number; returned: number; truncated: boolean; nextCursor: number | null; bytes: number; hint?: string };
    expect(d).toMatchObject({ cursor: 0, total: 3, returned: 2, truncated: true, nextCursor: 2 });
    expect(d.bytes).toBeGreaterThan(0);
    expect(d.hint).toContain("cursor=2"); // 回执自己教它怎么翻页，不用模型猜偏移
    const p2 = await a.execute(call("app_read", { path: "channels", cursor: 2, limit: 2 }), ctx("create"));
    const d2 = p2.data as { truncated: boolean; nextCursor: number | null; returned: number };
    expect(d2).toMatchObject({ returned: 1, truncated: false, nextCursor: null });
    plot.getSnapshot.mockReset(); // 归还默认实现，别污染后面的用例
  });

  it("app_state 是目录的投影：同一段内容两处读到的一模一样（§8-37 只读版复发预防）", async () => {
    const a = createLocalAgentAdapter({ runId: "r-par", gate: fakeGate() });
    const st = await a.execute(call("app_state"), ctx("create"));
    const d = st.data as Record<string, { items?: unknown[]; total?: number } & Record<string, unknown>>;
    const ch = await readCatalog("channels", { limit: OVERVIEW_LIMIT });
    if (!ch.ok) throw new Error("channels 视图应可读");
    expect(d.channels).toEqual(ch.data); // 逐字段相等＝真的同一个读者
    const rt = await readCatalog("runtime");
    if (!rt.ok) throw new Error("runtime 视图应可读");
    expect(d.serial).toEqual((rt.data as { serial: unknown }).serial);
    expect(d.session?.operatorLocked).toBe((rt.data as { operatorLocked: boolean }).operatorLocked);
    expect(String(d.note)).toContain("app_read");
    expect(String(d.note)).toContain(String(OVERVIEW_LIMIT));
  });

  it("一次 app_state 只读一遍 runtime：serial 与 session 两段共用同一份快照", async () => {
    const a = createLocalAgentAdapter({ runId: "r-once", gate: fakeGate() });
    plot.getSnapshot.mockClear();
    await a.execute(call("app_state"), ctx("create"));
    // runtime 一遍（counts.channels）+ channels 段一遍 = 2。旧写法 serial 与 session 各读一次
    // runtime，两次 getSnapshot 之间用户加/解锁就会产出一条自相矛盾的回执。
    expect(plot.getSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("P99a-D1b：任务模板（workflow）在写入期就查工具存在性", () => {
  const tpl = (steps: unknown[]) => ({ kind: "workflow", name: "巡检台", payload: { goal: "先看通道再调采样率", steps } });

  it("引用不存在的工具 → unknown_tool_ref（而不是存下来等运行时撞 unknown_tool）", async () => {
    const a = createLocalAgentAdapter({ runId: "r-tpl", gate: fakeGate() });
    const bad = await a.execute(call("save_plugin", tpl([{ tool: "plot_channels" }, { tool: "no_such_tool" }])), ctx("create"));
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("unknown_tool_ref");
    expect((bad.data as { unknown: string[] }).unknown).toEqual(["no_such_tool"]);
    // 回执必须教它下一步：模型自己工具列表里的名字就是合法名字
    expect(String((bad.data as { hint: string }).hint)).toContain("工具列表");
    // 只存了一支工具都没查过的坏包：库里不该多出一条僵尸模板
    const store = await import("../plugins/pluginStore");
    expect(store.getSnapshot().plugins.some((p) => p.pkg.name === "巡检台")).toBe(false);
  });

  it("全部步骤都存在 → 装成 workflows 产物，且 capabilities 由元表派生（不含 serial.send）", async () => {
    const a = createLocalAgentAdapter({ runId: "r-tpl2", gate: fakeGate() });
    const r = await a.execute(call("save_plugin", tpl([{ tool: "plot_channels", note: "看现有通道" }])), ctx("create"));
    expect(r.ok).toBe(true);
    const store = await import("../plugins/pluginStore");
    const id = (r.data as { pluginId: string }).pluginId;
    const rec = store.getPlugin(id);
    expect(rec?.pkg.contributions.workflows).toHaveLength(1);
    expect(rec?.pkg.capabilities).toEqual(["workflow.compose"]);
    expect(rec?.pkg.capabilities).not.toContain("serial.send");
    // 模板不会被自动应用成任何运行态：它只是库里一份可载入的说明
    const extStore = await import("../ai/extensionStore");
    expect(extStore.getSnapshot().exts.filter((e) => e.pluginRef === id)).toHaveLength(0);
  });
});
