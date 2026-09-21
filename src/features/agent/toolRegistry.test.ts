/**
 * P99a-A1/A3：注册表与执行管线的语义单测。
 * 钉住的四件事，都是旧结构里"没有任何东西在强制"的那几处（详设 §1.2）：
 * ① 发给模型的清单只可能带三个字段；② 授权域同时管"看得见"和"调得动"；
 * ③ 批准与策略判定在管线里，handler 连 gate 都拿不到；④ 未派发/抛错不得静默。
 */
import { describe, expect, it, vi } from "vitest";
import {
  adapterFromEntries, argsHash, createToolRegistry, defaultMeta, defineTool, newRunScratch, pluginToolName,
  runToolCall, toolLabelOf, type AgentToolEntry, type PipelineHooks, type ToolCtx,
} from "./toolRegistry";
import type { PolicyContext } from "./toolPolicy";
import type { Domain } from "./scopeTiers";
import type { TaskContext, ToolCall, ToolReceipt } from "./types";

const HOST = { kind: "host" } as const;

function entry(over: Partial<AgentToolEntry> & { name: string }): AgentToolEntry {
  return defineTool({
    description: "test tool",
    parameters: { type: "object", properties: {} },
    labelZh: "测试工具",
    effect: "read",
    domain: null,
    provenance: HOST,
    execute: () => ({ ok: true, status: "read", data: { hi: 1 } }),
    ...over,
  });
}

function ctx(over: Partial<ToolCtx> & { signal?: AbortSignal } = {}): ToolCtx {
  const base: ToolCtx = {
    source: "local_agent",
    runId: "run-1",
    callId: "c-base",
    scratch: newRunScratch(),
    signal: over.signal ?? new AbortController().signal,
    scope: "create",
    allowed: ["config", "plugins"],
    allowedDomains: ["config", "plugins"] as Domain[],
    hasDomain: (_d) => true,
    policy: { scope: "create", authorized: () => true, operatorLocked: false, deviceContext: "sim" } as PolicyContext,
  };
  return { ...base, ...over };
}

function call(name: string, args: unknown = {}): ToolCall {
  return { callId: "c1", name, arguments: JSON.stringify(args) };
}

function hooks(over: Partial<PipelineHooks> = {}): PipelineHooks & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    truncate: (r) => r,
    gate: { request: (r) => requests.push(r), takeToken: () => null, reject: () => {} },
    now: () => 1_000_000,
    newRequestId: () => "req-1",
    ...over,
  };
}

describe("defineTool / createToolRegistry", () => {
  it("名字、中文名、模型说明、参数形状四项缺一即拒（不留静默漏配）", () => {
    expect(() => entry({ name: "ab" })).toThrow(/不合法/);
    expect(() => entry({ name: "Bad_Name" })).toThrow(/不合法/);
    expect(() => entry({ name: "ok_tool", labelZh: "  " })).toThrow(/中文显示名/);
    expect(() => entry({ name: "ok_tool", description: "" })).toThrow(/说明/);
    expect(() => entry({ name: "ok_tool", parameters: { type: "array" } })).toThrow(/JSON Schema/);
  });

  it("重名直接抛：后注册者不得静默顶掉先注册者", () => {
    expect(() => createToolRegistry([entry({ name: "dup_tool" }), entry({ name: "dup_tool" })])).toThrow(/重名/);
  });

  it("插件工具名强制前缀化——撞宿主名也不会接管", () => {
    const name = pluginToolName("user.agent.Foo", "fs_read");
    expect(name.startsWith("plg_")).toBe(true);
    expect(name).not.toBe("fs_read");
    const reg = createToolRegistry([entry({ name: "fs_read" }), entry({ name })]);
    expect(reg.byName("fs_read")?.provenance).toEqual(HOST);
    expect(reg.byName(name)?.name).toBe(name);
  });

  /**
   * 截断 + 哈希这一条是 B2 补的：`defineTool` 的名字上限是 40 字符，而组合名要装下
   * `plg_ + 包名 slug + 裸名`。只截不断会有两个长名字撞成同一支工具（轻则登记被拒，
   * 重则读到别的包的实现），所以补一段 `pkgId#rawName` 的稳定短哈希。
   */
  it("长名字截断后仍然互不相同，且组合名恒 ≤40 并符合命名式", () => {
    const re = /^[a-z][a-z0-9_]{2,39}$/;
    const a = pluginToolName("user.agent.someveryverylongpackagename", "compute_average_of_all");
    const b = pluginToolName("user.agent.someveryverylongpackagename", "compute_average_of_rows");
    for (const n of [a, b, pluginToolName("x.y", "ab"), pluginToolName("", "")]) {
      expect(n.length, n).toBeLessThanOrEqual(40);
      expect(re.test(n), n).toBe(true);
    }
    expect(a).not.toBe(b);
    expect(pluginToolName("user.agent.someveryverylongpackagename", "compute_average_of_all")).toBe(a); // 确定性
  });
});

describe("模型侧投影", () => {
  it("只吐 name/description/parameters——宿主字段（execute/effect/labelZh）结构上进不了请求", () => {
    const reg = createToolRegistry([entry({ name: "proj_tool", labelZh: "投影", effect: "irreversible" })]);
    const [def] = reg.modelDefinitions("create", []);
    expect(Object.keys(def).sort()).toEqual(["description", "name", "parameters"]);
  });

  it("按域裁剪对**全部** entry 生效：无 ui 授权时既看不见也调不动", async () => {
    const exec = vi.fn(() => ({ ok: true, status: "applied" as const }));
    const reg = createToolRegistry([entry({ name: "style_patch", domain: "ui", effect: "config_write", execute: exec })]);
    // create 档只含 config+plugins（不吃 allowed），ui 域只有手工档勾上才放行——两条都不给发
    expect(reg.modelDefinitions("create", []).map((d) => d.name)).not.toContain("style_patch");
    expect(reg.visibleNames("custom", ["ui"])).toContain("style_patch");
    expect(reg.visibleNames("preview", ["ui"])).toEqual([]);
    // 模型硬调一个没发给它的工具：拒绝，且一次都不执行
    const r = await runToolCall(reg, call("style_patch"), ctx({ scope: "custom", allowed: ["config"] }), hooks());
    expect(r.code).toBe("unauthorized_scope");
    expect(exec).not.toHaveBeenCalled();
  });

  it("仅预览档：写工具仍发给模型（要能预览草稿），但执行被拦成 preview_only", async () => {
    const exec = vi.fn();
    const reg = createToolRegistry([entry({ name: "theme_patch", effect: "config_write", domain: null, execute: exec })]);
    expect(reg.modelDefinitions("preview", []).map((d) => d.name)).toContain("theme_patch");
    const r = await runToolCall(reg, call("theme_patch"), ctx({ scope: "preview", policy: { ...ctx().policy, scope: "preview" } }), hooks());
    expect(r.code).toBe("preview_only");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("管线：abort / 参数 / 策略 / 批准", () => {
  it("任务已取消：cancelled 且完全不执行 handler", async () => {
    const c = new AbortController();
    c.abort();
    const exec = vi.fn();
    const reg = createToolRegistry([entry({ name: "any_tool", execute: exec })]);
    expect((await runToolCall(reg, call("any_tool"), ctx({ signal: c.signal }), hooks())).code).toBe("cancelled");
    expect(exec).not.toHaveBeenCalled();
  });

  it("参数不是对象（数组/裸标量/坏 JSON）一律拒绝，不当成空对象继续跑", async () => {
    const reg = createToolRegistry([entry({ name: "any_tool" })]);
    expect((await runToolCall(reg, { callId: "x", name: "any_tool", arguments: "[1,2]" }, ctx(), hooks())).code).toBe("invalid_json");
    expect((await runToolCall(reg, { callId: "x", name: "any_tool", arguments: "42" }, ctx(), hooks())).code).toBe("invalid_json");
    expect((await runToolCall(reg, { callId: "x", name: "any_tool", arguments: "{oops" }, ctx(), hooks())).code).toBe("invalid_json");
    // 空参数是合法的（无参工具）
    expect((await runToolCall(reg, { callId: "x", name: "any_tool", arguments: "" }, ctx(), hooks())).ok).toBe(true);
  });

  it("不认识的工具有名可指（旧 if 链只回 unknown_tool，排查时看不出是谁）", async () => {
    const reg = createToolRegistry([entry({ name: "known_tool" })]);
    const r = await runToolCall(reg, call("typo_tool"), ctx(), hooks());
    expect(r).toMatchObject({ ok: false, status: "not_executed", code: "unknown_tool", data: { tool: "typo_tool" } });
  });

  it("require_local_approval：先要批准、不执行；给令牌后同参数才执行", async () => {
    const exec = vi.fn(() => ({ ok: true, status: "applied" as const }));
    const reg = createToolRegistry([entry({ name: "clear_page", effect: "destructive_write", execute: exec })]);
    // 自管的 gate：批准卡按哈希发令牌，同时自己记下请求条数
    const requests: unknown[] = [];
    const granted = new Set<string>();
    const h = hooks({ gate: { request: (r) => { requests.push(r); granted.add((r as { argsHash: string }).argsHash); }, takeToken: (_rid, _t, hash) => (granted.has(hash) ? "ok" : null), reject: () => {} } });
    const first = await runToolCall(reg, call("clear_page", { page: "a" }), ctx(), h);
    expect(first.code).toBe("needs_local_approval");
    expect(requests).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
    const second = await runToolCall(reg, call("clear_page", { page: "a" }), ctx(), h);
    expect(second.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    // 换了参数＝哈希变了＝重新要批准，旧令牌不覆盖新参数
    const third = await runToolCall(reg, call("clear_page", { page: "b" }), ctx(), h);
    expect(third.code).toBe("needs_local_approval");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("批准请求绑定 (runId,tool,argsHash) 并带 TTL 与中文计划", async () => {
    const reg = createToolRegistry([entry({
      name: "remove_card", effect: "destructive_write",
      planFor: (a) => `删除卡片 ${String(a.id ?? "")}`,
    })]);
    const h = hooks();
    await runToolCall(reg, call("remove_card", { id: "card-9" }), ctx(), h);
    const req = h.requests[0] as Record<string, unknown>;
    expect(req).toMatchObject({ runId: "run-1", tool: "remove_card", effect: "destructive_write", plan: "删除卡片 card-9", createdAt: 1_000_000, expiresAt: 1_000_000 + 5 * 60 * 1000 });
    expect(req.argsHash).toBe(argsHash({ id: "card-9" }));
  });

  it("Operator 锁：非只读一律 deny，且不弹批准卡（锁就是锁）", async () => {
    const exec = vi.fn();
    const reg = createToolRegistry([entry({ name: "write_cmd", effect: "draft_write", execute: exec })]);
    const h = hooks();
    const locked = ctx({ policy: { scope: "create", authorized: () => true, operatorLocked: true, deviceContext: "sim" } });
    const r = await runToolCall(reg, call("write_cmd"), locked, h);
    expect(r.code).toBe("denied_by_policy");
    expect(exec).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it("assess 让逐参数的风险说了算：内层动作要批准就批准，不要就直接跑", async () => {
    const exec = vi.fn(() => ({ ok: true, status: "applied" as const }));
    const reg = createToolRegistry([entry({
      name: "run_app_action", effect: "read",
      assess: (a) => (a.kind === "removeCard"
        ? { meta: defaultMeta("destructive_write") }
        : { meta: defaultMeta("read") }),
      execute: exec,
    })]);
    const h = hooks();
    await runToolCall(reg, call("run_app_action", { kind: "listProtocols" }), ctx(), h);
    expect(exec).toHaveBeenCalledTimes(1);
    await runToolCall(reg, call("run_app_action", { kind: "removeCard", args: { id: "x" } }), ctx(), h);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
  });

  it("assess 可以先拒：总开关关着就不该弹批准卡", async () => {
    const exec = vi.fn();
    const h = hooks();
    const reg = createToolRegistry([entry({
      name: "shell_exec", effect: "irreversible", domain: "shell",
      assess: () => ({ refuse: { ok: false, status: "not_executed" as const, code: "shell_disabled" } }),
      execute: exec,
    })]);
    const r = await runToolCall(reg, call("shell_exec", { command: "dir" }), ctx({ scope: "custom", allowed: ["shell"] }), h);
    expect(r.code).toBe("shell_disabled");
    expect(exec).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it("handler 抛错：一条可读失败回执，不吞也不当成成功", async () => {
    const reg = createToolRegistry([entry({ name: "boom_tool", execute: () => { throw new Error("内部炸了"); } })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r: ToolReceipt = await runToolCall(reg, call("boom_tool"), ctx(), hooks());
    expect(r).toMatchObject({ ok: false, status: "error", code: "tool_threw" });
    expect((r.data as { msg: string }).msg).toContain("内部炸了");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("回执裁剪与展示派生", () => {
  it("默认过裁剪出口；read_artifact 这类自我引用的工具必须显式关掉", async () => {
    const truncate = vi.fn((r: ToolReceipt) => r);
    const plain = createToolRegistry([entry({ name: "some_read" })]);
    await runToolCall(plain, call("some_read"), ctx(), hooks({ truncate }));
    expect(truncate).toHaveBeenCalledTimes(1);
    const self = createToolRegistry([entry({ name: "read_artifact", truncate: false })]);
    await runToolCall(self, call("read_artifact", { ref: "call:x" }), ctx(), hooks({ truncate }));
    expect(truncate).toHaveBeenCalledTimes(1);
  });

  it("callId 由管线附着：handler 返回里带别的 callId 也覆盖不掉", async () => {
    const reg = createToolRegistry([entry({ name: "lie_tool", execute: () => ({ ok: true, status: "read", callId: "forged" } as never) })]);
    const r = await runToolCall(reg, { callId: "real", name: "lie_tool", arguments: "{}" }, ctx(), hooks());
    expect(r.callId).toBe("real");
  });

  it("中文名从 entry 派生；没这条 entry 时兜底可读化而不是裸常量", () => {
    const reg = createToolRegistry([entry({ name: "theme_patch", labelZh: "修改外观" })]);
    expect(toolLabelOf(reg.byName("theme_patch"), "theme_patch")).toBe("修改外观");
    expect(toolLabelOf(undefined, "brand_new_tool")).toBe("brand new tool");
  });

  it("defaultMeta 保守：写类不声称自己幂等/可逆/碰不到设备", () => {
    expect(defaultMeta("read")).toEqual({ effect: "read", idempotent: true, reversible: true, mayTouchDevice: false });
    expect(defaultMeta("config_write")).toMatchObject({ idempotent: false, reversible: false, mayTouchDevice: true });
    expect(defaultMeta("device_send")).toMatchObject({ mayTouchDevice: true });
  });
});

describe("adapterFromEntries（同一管线的第二个前端）", () => {
  it("独立适配器走的还是同一条管线：批准、裁剪、门禁一个不少", async () => {
    const exec = vi.fn(() => ({ ok: true, status: "applied" as const }));
    const h = hooks();
    const a = adapterFromEntries(
      [entry({ name: "settings_apply", effect: "protected_config", execute: exec })],
      h,
      (t) => ctx({ scope: t.scope, allowed: t.allowed ?? [] }),
    );
    expect(a.definitions.map((d) => d.name)).toEqual(["settings_apply"]);
    const r = await a.execute(call("settings_apply", { zoom: 1 }), { source: "local_agent", runId: "run-1", signal: new AbortController().signal, scope: "custom", allowed: ["config"] } as TaskContext);
    expect(r.code).toBe("needs_local_approval");
    expect(exec).not.toHaveBeenCalled();
  });
});
