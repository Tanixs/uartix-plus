/**
 * P99a-B2：插件工具进 Agent 面的投影与派发测试。
 *
 * 钉的是四件事（详设 §5.3 / §11"最大风险"那一节）：
 *  1. 权力由宿主判：`domain/effect/mayTouchDevice` 与插件自报无关；
 *  2. 发给模型的仍是白名单投影（插件字段夹不带宿主信息）；
 *  3. 档位与授权域照常管它：仅预览拒、手工档没勾「插件库」拒；
 *  4. run 内不扩权：adapter 建好之后新登记的工具，本 run 看不见。
 *
 * 登记走 `replacePluginToolDefs`（生产 API，moduleBus 受理 tool-def 后调的就是它），
 * 不造测试专用的后门模块。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
vi.mock("../ai/appActions", () => ({ runAppAction: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));
vi.mock("../serial/serialStore", () => ({ getSnapshot: () => ({ status: "disconnected" }), subscribe: () => () => {} }));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: null }) }));
vi.mock("../plot/plotStore", () => ({
  getSnapshot: () => ({ channels: [] }),
  getChanData: () => ({ t: [], v: [] }),
  timeOrigin: () => 1000,
  sampleRate: () => 50,
}));
vi.mock("../plot/dataLease", () => ({ acquireDataLease: vi.fn(async () => true), hasDataLease: () => false }));

const { createToolRegistry } = await import("./toolRegistry");
const { pluginToolEntries } = await import("./pluginTools");
const { createLocalAgentAdapter } = await import("./agentAdapter");
const { clearAllPluginTools, addPluginToolDefs, clearPluginTools, commitToolSnapshot, describeToolChange, pluginToolChangeOf } =
  await import("../plugins/pluginToolDefs");
import type { TaskContext, ToolCall } from "./types";

const PKG = { pkgId: "user.agent.demo", pkgName: "求和插件", version: "0.1.0" };
const SCHEMA = {
  type: "object",
  properties: { n: { type: "integer" } },
  required: ["n"],
  additionalProperties: false,
};

function register(name: string, caps: string[] = ["logic.run", "agent.tool"]): void {
  addPluginToolDefs([{ ...PKG, baseName: name, description: `把 n 加一（${name}）`, parameters: SCHEMA, caps }]);
}

const ctx = (scope: TaskContext["scope"], allowed?: string[]): TaskContext => ({
  source: "local_agent",
  runId: "r1",
  signal: new AbortController().signal,
  scope,
  ...(allowed ? { allowed } : {}),
});
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  callId: `c-${Math.random().toString(36).slice(2, 9)}`,
  name,
  arguments: JSON.stringify(args),
});
const gate = { request: () => undefined, takeToken: () => null, reject: () => undefined };

beforeEach(() => {
  storage.clear();
  clearAllPluginTools();
});

describe("插件工具投影", () => {
  it("权力来自宿主：domain=plugins、effect=config_write、来源带 pkgId/version", () => {
    register("calc_sum");
    const [e] = pluginToolEntries();
    expect(e.name.startsWith("plg_")).toBe(true);
    expect(e.domain).toBe("plugins");
    expect(e.effect).toBe("config_write");
    expect(e.provenance).toMatchObject({ kind: "plugin", pkgId: PKG.pkgId, version: "0.1.0" });
    expect(e.labelZh).toBe("求和插件 · calc_sum");
  });

  it("即便包声明了 serial.send，插件工具仍标 mayTouchDevice:false（worker 桥没有发送通道）", () => {
    register("calc_sum", ["logic.run", "agent.tool", "serial.send"]);
    const [e] = pluginToolEntries();
    const assessed = e.assess ? e.assess({}, {} as never) : null;
    expect(assessed && "meta" in assessed ? assessed.meta : null).toMatchObject({
      effect: "config_write",
      mayTouchDevice: false,
      reversible: false,
    });
  });

  it("发给模型的仍是白名单投影：只有 name/description/parameters", () => {
    register("calc_sum");
    const defs = createToolRegistry(pluginToolEntries()).modelDefinitions("create", []);
    expect(defs).toHaveLength(1);
    expect(Object.keys(defs[0]).sort()).toEqual(["description", "name", "parameters"]);
    expect(defs[0].description).toContain("求和插件");
  });

  it("档位与授权域照常管：仅预览拒，手工档没勾「插件库」拒", async () => {
    register("calc_sum");
    const [entry] = pluginToolEntries();
    const a = createLocalAgentAdapter({ runId: "r1", gate, extraEntries: [entry] });
    expect((await a.execute(call(entry.name, { n: 1 }), ctx("preview"))).code).toBe("preview_only");
    expect((await a.execute(call(entry.name, { n: 1 }), ctx("custom", ["config"]))).code).toBe("unauthorized_scope");
  });

  it("参数不符插件自己声明的 schema ⇒ 拒在宿主侧（不是「模块报错」）", async () => {
    register("calc_sum");
    const [entry] = pluginToolEntries();
    const a = createLocalAgentAdapter({ runId: "r1", gate, extraEntries: [entry] });
    const missing = await a.execute(call(entry.name, {}), ctx("create"));
    expect(missing.code).toBe("invalid_tool_args");
    expect(String((missing.data as { errors: string[] }).errors.join())).toContain("n");
    const junk = await a.execute(call(entry.name, { n: 1, extra: "不在表里" }), ctx("create"));
    expect(junk.code).toBe("invalid_tool_args");
    // 参数合法但没有在线模块：这条码要分得开，否则"插件坏了"与"没启用"混成一句
    const offline = await a.execute(call(entry.name, { n: 2 }), ctx("create"));
    expect(offline.code).toBe("module_not_live");
  });

  it("run 内不扩权：adapter 建好之后再登记新工具，本 run 的工具面不变", () => {
    register("first");
    const a = createLocalAgentAdapter({ runId: "r1", gate, extraEntries: pluginToolEntries() });
    register("second");
    expect(a.definitions.filter((d) => d.name.startsWith("plg_"))).toHaveLength(1);
    expect(pluginToolEntries()).toHaveLength(2); // 面确实变了，只是本 run 看不见
  });

  it("同名再登记是覆盖不是另建一支（否则注册表见重名即抛，那会炸掉整个 run）", () => {
    register("dup");
    register("other");
    addPluginToolDefs([{ ...PKG, baseName: "dup", description: "同一支改描述", parameters: SCHEMA, caps: ["agent.tool"] }]);
    const entries = pluginToolEntries();
    expect(entries).toHaveLength(2);
    expect(() => createToolRegistry(entries)).not.toThrow();
  });
});

/* ======================= P99a-F2：批准并启用之后的工具差异 ======================= */

describe("P99a-F2：启用后的工具差异（B3 剩下的那半）", () => {
  it("差异只在 ready 那一刻算：登记过程中不产生任何变化记录", () => {
    register("a");
    register("b");
    expect(pluginToolChangeOf(PKG.pkgId)).toBeUndefined();
  });

  it("首报全部算新增，话说得出口", () => {
    register("a");
    register("b");
    expect(commitToolSnapshot(PKG.pkgId)).toMatchObject({ added: ["a", "b"], removed: [] });
    expect(describeToolChange(pluginToolChangeOf(PKG.pkgId))).toBe("工具 +2（a、b）");
  });

  it("同一版重启（清空后又报回同一批）不许谎报变化，也不擦掉上一次的真变化", () => {
    register("a");
    register("b");
    expect(commitToolSnapshot(PKG.pkgId)).toMatchObject({ added: ["a", "b"] });
    clearPluginTools(PKG.pkgId);
    register("a");
    register("b");
    expect(commitToolSnapshot(PKG.pkgId)).toBeUndefined();
    expect(pluginToolChangeOf(PKG.pkgId)).toMatchObject({ added: ["a", "b"], removed: [] });
  });

  it("换版：加的新名与掉的旧名都要报（只报增不报减是半个谎）", () => {
    register("a");
    register("b");
    commitToolSnapshot(PKG.pkgId);
    clearPluginTools(PKG.pkgId);
    register("b");
    register("c");
    const ch = commitToolSnapshot(PKG.pkgId);
    expect(ch).toMatchObject({ added: ["c"], removed: ["a"] });
    expect(describeToolChange(ch)).toBe("工具 +1（c），−1（a）");
  });

  it("一支都没收下（全被拒）算清空，不是「没变」", () => {
    register("a");
    commitToolSnapshot(PKG.pkgId);
    clearPluginTools(PKG.pkgId);
    expect(commitToolSnapshot(PKG.pkgId)).toMatchObject({ added: [], removed: ["a"] });
    expect(describeToolChange(pluginToolChangeOf(PKG.pkgId))).toBe("工具 −1（a）");
  });

  it("全清之后账本一起归零（陈旧变化不能一直挂在包里）", () => {
    register("a");
    commitToolSnapshot(PKG.pkgId);
    clearAllPluginTools();
    expect(pluginToolChangeOf(PKG.pkgId)).toBeUndefined();
    register("a");
    expect(commitToolSnapshot(PKG.pkgId)).toMatchObject({ added: ["a"], removed: [] });
  });

  it("启用回执里那句差异只在 ready 之后取一次（不在别处再算一遍）", async () => {
    const fsSpec = "node:fs";
    const { readFileSync } = (await import(fsSpec)) as unknown as {
      readFileSync: (p: string | URL, enc?: string) => string;
    };
    const src = readFileSync(new URL("../plugins/pluginStore.ts", import.meta.url), "utf8");
    expect((src.match(/commitToolSnapshot\(/g) || []).length).toBe(1);
    expect(src).toContain("describeToolChange(commitToolSnapshot(id))");
  });
});
