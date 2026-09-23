/**
 * P99c-C2 守卫：`propose_market_install` 只能"把计划讲清楚"，一个字节都不许写进本机。
 *
 * 这批的风险不在功能上，在**形状**上：AI 看得见货架（N6 的 `market.entries`）之后，
 * 差的只是"提名"这一步。一旦这一步顺手把包落地，就变成"AI 装了插件、用户以为是自己装的"
 * ——那是拿自省面当审批面的后门。所以这里的钉全部围绕三件事：
 *  ① assess **不联网**（批准卡上那句只能用已在内存里的货架声明拼，不能为了拼它去下载包）；
 *  ② execute 只叫 `planMarketInstall`，装链那三步（stage / apply / pending）一次都不许碰；
 *  ③ 失败不许粉成"已提名"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** 货架上的一条（够用就行；真契约由 marketIndex 那批测试钉） */
const ENTRY = {
  id: "uartix.theme.npm",
  name: "示例主题",
  author: "someone",
  category: "theme",
  description: { zh: "一条用于测试的货架条目" },
  version: "1.2.0",
  packageUrl: "https://raw.githubusercontent.com/o/r/pkg.uartix.json",
  sha256: "a".repeat(64),
  bytes: 2048,
  // 真能力 id：契约层按 `PLUGIN_CAPS` 校验过，所以走到 `capFacts` 的一定是这里已登记的那几个
  capabilities: ["ui.widget"],
  screenshots: [],
  minAppVersion: "0.1.0",
  updated: "2026-09-20",
};

const st = vi.hoisted(() => ({
  index: null as unknown,
  refreshCalls: 0,
  planCalls: 0,
  writeCalls: 0,
  /** 内核返回的那一份计划：默认"过得去"，坏例各条自己覆盖 */
  plan: {} as Record<string, unknown>,
}));

vi.mock("../market/marketStore", () => ({
  getMarketSnapshot: () => ({
    status: "ready",
    error: "",
    index: st.index ? { entries: [st.index], dropped: [], name: "t", source: "s", generatedAt: "", categories: {} } : null,
  }),
  // 视图与工具都不许替用户联网刷新（N6 那条第一承诺的延续）
  refreshIndex: vi.fn(async () => {
    st.refreshCalls += 1;
    throw new Error("守卫夹具：这里绝不该被调用");
  }),
  // 也不许绕过内核自己去取包（那会跳过哈希/字节/能力三条判定）
  fetchPackage: vi.fn(async () => {
    throw new Error("守卫夹具：取包只能经装链内核");
  }),
}));

vi.mock("../market/marketInstall", async () => {
  const mod = (await vi.importActual("../market/marketInstall")) as Record<string, unknown>;
  return {
    // describePlan / describeFacts / factsFromEntry 用**真身**：回执那句要真是内核拼的
    ...mod,
    planMarketInstall: vi.fn(async () => {
      st.planCalls += 1;
      return st.plan;
    }),
    stageMarketPlan: vi.fn(() => {
      st.writeCalls += 1;
      throw new Error("守卫夹具：C2 不许暂存");
    }),
    applyMarketStage: vi.fn(() => {
      st.writeCalls += 1;
      throw new Error("守卫夹具：C2 不许落地");
    }),
  };
});

vi.mock("../market/marketPending", () => ({
  marketPendingSnapshot: () => [],
  requestMarketInstall: vi.fn(() => {
    st.writeCalls += 1;
    throw new Error("守卫夹具：C2 不写 pending 表");
  }),
}));

/**
 * 插件库整层挡掉：`marketInstall` 真实模块静态引它（`installStaged` 等四支），
 * 而它在求值期就摸 `localStorage`（node 环境没有）。挡成"碰一下就计数并抛"，
 * 顺带让"这支工具不动插件库"这件事有了一个可数的探针。
 */
vi.mock("../plugins/pluginStore", () => {
  const boom = (what: string) => () => {
    st.writeCalls += 1;
    throw new Error(`守卫夹具：C2 不许${what}`);
  };
  return {
    getPlugin: () => undefined,
    stagePackage: boom("暂存"),
    installStaged: boom("入库"),
    proposeUpdate: boom("提更新候选"),
    approveUpdate: boom("批准更新"),
  };
});

/** 一份"计划过了"的内核回执（字段够用即可，真契约由 marketInstall.test 钉） */
const okPlan = () => ({
  ok: true,
  code: "ok",
  msg: "",
  entry: ENTRY,
  manifest: null,
  action: "install",
  currentVersion: "",
  host: "raw.githubusercontent.com",
  sizeText: "2.0 KB",
  sha12: "aaaaaaaaaaaa",
  caps: [{ id: "ui.widget", name: "小部件", note: "", blocked: false }],
  diff: { extra: [], missing: [] },
});

const entry = async () => {
  const { marketToolEntries } = (await import("./marketTools")) as typeof import("./marketTools");
  return marketToolEntries.find((e) => e.name === "propose_market_install")!;
};

const ctx = () =>
  ({
    callId: "c1",
    runId: "r1",
    scratch: { artifacts: new Map(), leaseRequested: false },
    allowedDomains: [],
    hasDomain: () => true,
    policy: { scope: "create", authorized: () => true, operatorLocked: false, deviceContext: "sim" },
  }) as never;

beforeEach(() => {
  st.index = ENTRY;
  st.refreshCalls = 0;
  st.planCalls = 0;
  st.writeCalls = 0;
  st.plan = okPlan();
});

describe("P99c-C2 · propose_market_install 只讲计划", () => {
  it("entry 装配齐：中文名、参数摘要、schema 都在（缺一条就静默显示裸常量）", async () => {
    const e = await entry();
    expect(e, "注册表里没有这支工具").toBeTruthy();
    expect(e.labelZh.trim().length).toBeGreaterThan(1);
    expect(typeof e.summarize).toBe("function");
    expect(e.parameters).toMatchObject({ type: "object", required: ["entryId"], additionalProperties: false });
    expect(e.summarize!({ entryId: "uartix.theme.npm" }, false)).toContain("uartix.theme.npm");
  });

  it("策略元组钉死：protected_config（每档逐次批准）+ 不碰设备 + 真的可重复调", async () => {
    const e = await entry();
    const got = await e.assess!({ entryId: ENTRY.id }, ctx());
    if (!("meta" in got)) throw new Error(`assess 直接拒了：${JSON.stringify(got.refuse)}`);
    expect(got.meta).toMatchObject({ effect: "protected_config", mayTouchDevice: false, idempotent: true, reversible: true });
    expect(got.plan, "批准卡上没有计划那句话，用户批的是个谜").toContain(ENTRY.name);
    expect(got.plan).toContain(ENTRY.version);
    expect(got.plan).toContain("停用");
  });

  it("assess 一个字都不下载：批准卡那句只由内存里的货架声明拼", async () => {
    const e = await entry();
    await e.assess!({ entryId: ENTRY.id }, ctx());
    expect(st.planCalls, "assess 去跑装链＝为拼一句话把包下载了").toBe(0);
    expect(st.refreshCalls, "assess 替用户刷新索引＝打开那一页才联网的承诺没了").toBe(0);
  });

  it("货架还没取过：直接拒，并指回「打开那一页」，不替用户联网", async () => {
    st.index = null;
    const e = await entry();
    const got = await e.assess!({ entryId: ENTRY.id }, ctx());
    expect("refuse" in got, "没有货架还放行＝execute 里现场联网下载").toBe(true);
    expect(JSON.stringify(got)).toContain("插件市场");
    expect(st.refreshCalls).toBe(0);
  });

  it("id 不在货架上：unknown_id + 给出可选项，且不跑装链", async () => {
    const e = await entry();
    const r = await e.execute({ entryId: "no.such.pkg" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_id");
    expect((r.data as { want: string[] }).want).toContain(ENTRY.id);
    expect(st.planCalls).toBe(0);
  });

  it("execute 只叫只读半边：一次计划、零次写", async () => {
    const e = await entry();
    const r = await e.execute({ entryId: ENTRY.id }, ctx());
    expect(r.ok).toBe(true);
    expect(r.status).toBe("validated");
    expect(st.planCalls).toBe(1);
    expect(st.writeCalls, "碰到 stage/apply/pending 中的任何一步＝AI 自己把包装上了").toBe(0);
    const data = r.data as { installed?: boolean; staged?: boolean; next?: string; text?: string };
    expect(data.installed, "回执暗示已安装＝谎报").toBeFalsy();
    expect(data.staged, "回执暗示已暂存＝谎报").toBeFalsy();
    expect(data.text).toContain("示例主题");
    expect(data.next).toContain("插件市场");
    expect(data.next, "命令行那条路也得说清（C1c 已经能装）").toContain("uartix plugin install");
  });

  it("计划不过就照实回：内核原话进回执，不粉成「已提名」", async () => {
    st.plan = {
      ...okPlan(),
      ok: false,
      code: "undeclared_capability",
      action: "same",
      msg: "包里带着货架没声明的能力：serial.send——已拒绝入库",
    };
    const e = await entry();
    const r = await e.execute({ entryId: ENTRY.id }, ctx());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("undeclared_capability");
    expect(JSON.stringify(r.data)).toContain("serial.send");
    expect(st.writeCalls).toBe(0);
  });

  it("源文本反向钉：这支工具里没有装链动词，也没有启用插件的入口", async () => {
    const src = read("./marketTools.ts");
    for (const verb of [
      "stageMarketPlan(", "applyMarketStage(", "stagePackage(", "installStaged(",
      "proposeUpdate(", "approveUpdate(", "requestMarketInstall(", "setEnabled(",
    ]) {
      expect(src, `marketTools.ts 里出现了写侧调用 ${verb}＝这支工具不再只是提名`).not.toContain(verb);
    }
    // 探针自证（§8-43②）：读到的必须是真文件，空串会让上面整段永远绿
    expect(src.length).toBeGreaterThan(500);
  });

  it("批准卡那句与内核那句同出一处：两处各自拼一遍就会漂", () => {
    const install = read("../market/marketInstall.ts");
    expect(install).toContain("export function describeFacts");
    expect(install).toMatch(/function describePlan\([^)]*\)[^{]*\{[\s\S]{0,200}describeFacts\(/);
    expect(read("./marketTools.ts")).toContain("describeFacts");
  });
});
