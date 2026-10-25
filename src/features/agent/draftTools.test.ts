/**
 * P174-B1：草稿四工具的**边界**测试。
 *
 * 这里守的不是"功能跑通"，而是四句产品承诺：
 *  - 草稿能列、能写、能丢，但**永远不是已安装插件**（回执里 installed/runnable 恒 false）；
 *  - 丢弃是删除，必须过人工批准卡；
 *  - 转正**只排队**：绝不调用任何落盘安装函数；
 *  - 预览档不能写草稿（域门与其它写工具同一条线）。
 *
 * IO 被挡成记录器：真契约（路径越界、体积、清单校验）由 `draft.test.ts` 与
 * `manifest.test.ts` 钉，这里只验工具会不会绕过它们。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueDraftPromotion, clearDraftPromotions } from "../plugins/engine/draftRequests";
import { recordingGate, toolHarness } from "./toolTestKit";

// 与 marketTools.test 同一写法：vitest 的 node 内置模块类型不在本仓 tsconfig 里
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const st = vi.hoisted(() => ({
  appDir: "C:/app",
  entries: [] as { id: string; version: string }[],
  list: [] as unknown[],
  writes: [] as { appDir: string; name: string; files: Record<string, string> }[],
  discards: [] as { appDir: string; name: string }[],
  writeError: "" as string,
  promoteCalls: [] as { name: string; note?: string }[],
  promoteError: "" as string,
}));

vi.mock("../plugins/engine/pluginEngine", () => ({
  ensureLoaded: async () => undefined,
  getSnapshot: () => ({ appDir: st.appDir, entries: st.entries }),
  requestDraftPromotion: vi.fn(async (name: string, note?: string) => {
    st.promoteCalls.push({ name, ...(note ? { note } : {}) });
    if (st.promoteError) throw new Error(st.promoteError);
    return {
      request: {
        name,
        id: "a.b",
        title: "示例",
        version: "1.0.0",
        permissions: ["写 $WS/runs"],
        verdict: "needs-approval",
        requestedBy: "ai",
        at: 1,
      },
      plan: { id: "a.b", permissions: ["写 $WS/runs"], verdict: "needs-approval" },
    };
  }),
}));

vi.mock("../plugins/engine/draft", async () => {
  const actual = (await vi.importActual("../plugins/engine/draft")) as Record<string, unknown>;
  return {
    ...actual,
    listDrafts: vi.fn(async () => st.list),
    writeDraftFiles: vi.fn(async (appDir: string, name: string, files: Record<string, string>) => {
      st.writes.push({ appDir, name, files });
      if (st.writeError) throw new Error(st.writeError);
      return {
        entry: {
          name,
          dir: `${appDir}/.drafts/${name}`,
          id: "a.b",
          title: "示例",
          version: "1.0.0",
          issue: "",
          warnings: [],
          permissions: ["写 $WS/runs"],
          manifest: { id: "a.b", name: "示例", version: "1.0.0" },
        },
        written: Object.keys(files).length,
        bytes: 10,
      };
    }),
    discardDraft: vi.fn(async (appDir: string, name: string) => {
      st.discards.push({ appDir, name });
    }),
  };
});

const entry = (over: Record<string, unknown> = {}) => ({
  name: "a.b-v1",
  dir: "C:/app/.drafts/a.b-v1",
  id: "a.b",
  title: "示例",
  version: "1.0.0",
  issue: "",
  warnings: [],
  permissions: ["写 $WS/runs"],
  manifest: { id: "a.b", name: "示例", version: "1.0.0" },
  ...over,
});

const entries = async () => {
  const { draftToolEntries } = await import("./draftTools");
  return draftToolEntries;
};

beforeEach(() => {
  st.entries = [];
  st.list = [];
  st.writes = [];
  st.discards = [];
  st.writeError = "";
  st.promoteCalls = [];
  st.promoteError = "";
  clearDraftPromotions();
});

describe("P174-B1 · plugin_draft_* 工具面", () => {
  it("四支工具都在：中文名、参数摘要、schema 齐（缺一条就静默显示裸常量）", async () => {
    const all = await entries();
    expect(all.map((e) => e.name)).toEqual([
      "plugin_draft_list",
      "plugin_draft_save",
      "plugin_draft_discard",
      "plugin_draft_promote",
    ]);
    for (const e of all) {
      expect(e.labelZh.trim().length, `${e.name} 缺中文名`).toBeGreaterThan(1);
      expect(typeof e.summarize, `${e.name} 缺参数摘要`).toBe("function");
      expect(e.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("策略元组钉死：读不挂域；写草稿是 draft_write；丢弃是 destructive_write；转正只改内存", async () => {
    const [list, save, discard, promote] = await entries();
    expect(list).toMatchObject({ effect: "read", domain: null });
    expect(save).toMatchObject({ effect: "draft_write", domain: "plugins" });
    expect(discard).toMatchObject({ effect: "destructive_write", domain: "plugins" });
    expect(promote).toMatchObject({ effect: "config_write", domain: "plugins" });
  });

  it("列草稿：报清单与待确认状态，并带上已装版本", async () => {
    st.entries = [{ id: "a.b", version: "0.9.0" }];
    st.list = [entry({ installedVersion: "0.9.0" })];
    queueDraftPromotion({
      name: "a.b-v1",
      id: "a.b",
      title: "示例",
      version: "1.0.0",
      permissions: [],
      verdict: "needs-approval",
      requestedBy: "ai",
      at: 1,
    });
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_list");
    expect(r.ok).toBe(true);
    expect(r.status).toBe("read");
    const d = (r.data as { drafts: Record<string, unknown>[] }).drafts[0];
    expect(d).toMatchObject({ name: "a.b-v1", id: "a.b", installedVersion: "0.9.0", promotionPending: true });
  });

  it("预览档也能列草稿（只读），但写草稿被域门挡住", async () => {
    const { run } = toolHarness(await entries());
    expect((await run("plugin_draft_list", {}, { scope: "preview" })).ok).toBe(true);
    const r = await run("plugin_draft_save", { id: "a.b", files: { "plugin.json": "{}" } }, { scope: "preview" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("preview_only");
    expect(st.writes).toHaveLength(0);
  });

  it("写草稿：目录名由 id+tag 归一，回执明说没装、不能跑", async () => {
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_save", {
      id: "a.b",
      tag: "V 2!",
      files: { "plugin.json": "{}", "lib\\util.mjs": "export {}" },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("applied");
    expect(st.writes).toHaveLength(1);
    expect(st.writes[0]).toMatchObject({ appDir: "C:/app", name: "a.b-v2" });
    // 反斜杠由 draft.writeDraftFiles 归一，工具只负责把原样文件表交过去
    expect(Object.keys(st.writes[0].files)).toContain("lib\\util.mjs");
    const data = r.data as Record<string, unknown>;
    expect(data).toMatchObject({ installed: false, runnable: false, valid: true });
    expect(String(data.next)).toContain("plugin_draft_promote");
  });

  it("写草稿的参数错不落盘：files 为空或不是「路径→文本」", async () => {
    const { run } = toolHarness(await entries());
    for (const args of [{ id: "a.b" }, { id: "a.b", files: {} }, { id: "a.b", files: { "a.mjs": 1 } }, { files: { "a.mjs": "x" } }]) {
      const r = await run("plugin_draft_save", args);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("draft_args_invalid");
    }
    expect(st.writes).toHaveLength(0);
  });

  it("写盘失败如实回 draft_rejected，不粉成已写", async () => {
    st.writeError = "草稿内路径非法：../x";
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_save", { id: "a.b", files: { "../x": "boom" } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("draft_rejected");
    expect(JSON.stringify(r.data)).toContain("../x");
  });

  it("丢弃是删除：先要人工批准，批准后才真的删；参数变了要重批", async () => {
    st.list = [entry()];
    const gate = recordingGate();
    const { run } = toolHarness(await entries(), { gate });
    const first = await run("plugin_draft_discard", { name: "a.b-v1" });
    expect(first.ok).toBe(false);
    expect(first.code).toBe("needs_local_approval");
    expect(st.discards).toHaveLength(0);
    gate.approveLatest();
    const second = await run("plugin_draft_discard", { name: "a.b-v1" });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("applied");
    expect(st.discards).toEqual([{ appDir: "C:/app", name: "a.b-v1" }]);
    expect(second.data).toMatchObject({ deleted: true, installedAffected: false });
  });

  it("丢弃不存在的草稿：在批准之前就拒，不白要一次确认", async () => {
    st.list = [entry()];
    const gate = recordingGate();
    const { run } = toolHarness(await entries(), { gate });
    const r = await run("plugin_draft_discard", { name: "no.such-v9" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_draft");
    expect(gate.requests).toHaveLength(0);
    expect(st.discards).toHaveLength(0);
  });

  it("转正只排队：一次 requestDraftPromotion，零次写草稿/丢弃/安装", async () => {
    st.list = [entry()];
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_promote", { name: "a.b-v1", note: "试试新面板" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("validated");
    expect(st.promoteCalls).toEqual([{ name: "a.b-v1", note: "试试新面板" }]);
    expect(st.writes).toHaveLength(0);
    expect(st.discards).toHaveLength(0);
    const data = r.data as Record<string, unknown>;
    expect(data).toMatchObject({ pending: true, installed: false, staged: false, runnable: false });
    expect(String(data.next)).toContain("转正为插件");
  });

  it("清单不合法就不提交转正请求（计划过不了同一套校验）", async () => {
    st.list = [entry({ issue: "清单校验失败", manifest: undefined })];
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_promote", { name: "a.b-v1" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid_draft");
    expect(st.promoteCalls).toHaveLength(0);
  });

  it("转正请求失败照实回：不粉成「已提名」", async () => {
    st.list = [entry()];
    st.promoteError = "这份草稿不能转正：清单读不出来";
    const { run } = toolHarness(await entries());
    const r = await run("plugin_draft_promote", { name: "a.b-v1" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("draft_cannot_promote");
    expect(JSON.stringify(r.data)).toContain("不能转正");
  });

  it("源文本反向钉：这支工具里没有安装/落盘动词", async () => {
    const src = readFileSync(fileURLToPath(new URL("./draftTools.ts", import.meta.url)), "utf8");
    for (const verb of [
      "commitInstall(",
      "promoteDraft(",
      "commitDraftPromotion(",
      "stagePackage(",
      "installStaged(",
      "stageMarketPlan(",
      "applyMarketStage(",
    ]) {
      expect(src, `draftTools.ts 里出现了落盘调用 ${verb}＝AI 不再只是写草稿`).not.toContain(verb);
    }
    // 探针自证：读到的必须是真文件，空串会让上面整段永远绿
    expect(src.length).toBeGreaterThan(500);
  });
});
