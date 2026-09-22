/**
 * P99c-C1a：市场装链**内核**测试。
 *
 * 这批的立场与 P99a-F 一样：**一个执行核，两份投影**（UI 的确认框与 CLI 的 `plugin install` 都调它）。
 * 所以测试测的是核的判定，不含任何 React：
 *  1. 货架说了什么 ≠ 包里是什么 —— 包多出一项索引没写的能力 ⇒ **拒**（提权必须先在货架露出来）；
 *  2. 装完**不自动启用**（`setEnabled` 一次都不许调，P99a-B 的红线不因有市场而松动）；
 *  3. 审批成本按 §8-44 分：**装新包不弹卡**（停用态、可卸载、一次性），
 *     **覆盖已有版本要人点头** ⇒ 内核只 `proposeUpdate` 存候选，批准权在调用方；
 *  4. 上游任一环报错（哈希/JSON/校验器）就**绝不落到 stagePackage**。
 * 每条都是"摘掉必红"的候选，收口前逐条证伪。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_LABEL } from "../plugins/pluginManifest";
import type { MarketEntry } from "./marketIndex";

const calls = vi.hoisted(() => ({
  stage: [] as unknown[],
  install: [] as string[],
  propose: [] as { id: string; manifest: unknown }[],
  approve: [] as string[],
  enable: [] as { id: string; on: boolean }[],
  fetch: [] as string[],
  existing: new Map<string, { version: string }>(),
  fetchResult: { ok: true, text: "" } as { ok: boolean; text?: string; msg?: string },
}));

vi.mock("./marketStore", () => ({
  fetchPackage: async (e: MarketEntry) => {
    calls.fetch.push(e.id);
    const r = calls.fetchResult;
    return r.ok ? { ...r, bytes: new TextEncoder().encode(r.text ?? "").length } : r;
  },
}));
vi.mock("../plugins/pluginStore", () => ({
  getPlugin: (id: string) => (calls.existing.has(id) ? { pkg: calls.existing.get(id) } : undefined),
  stagePackage: (m: unknown) => {
    calls.stage.push(m);
    return { ok: true, errors: [], warnings: [], stagingId: "st-1" };
  },
  installStaged: (sid: string) => {
    calls.install.push(sid);
    return { ok: true, msg: "已装入", id: "uartix.theme.a" };
  },
  proposeUpdate: (id: string, m: unknown) => {
    calls.propose.push({ id, manifest: m });
    return { ok: true, msg: "候选已暂存" };
  },
  approveUpdate: (id: string) => {
    calls.approve.push(id);
    return { ok: true, msg: "已批准" };
  },
  setEnabled: (id: string, on: boolean) => {
    calls.enable.push({ id, on });
    return { ok: true, msg: "" };
  },
}));

const { planMarketInstall, installMarketPackage, describePlan } = await import("./marketInstall");

function mkPkg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: "uartix-plugin",
    schemaVersion: 2,
    id: "uartix.theme.a",
    version: "1.1.0",
    name: "甲题",
    hostApi: "^1.0",
    capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#000" } } },
    provenance: { createdBy: "user", reviewed: false },
    ...over,
  });
}

function mkEntry(over: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: "uartix.theme.a",
    name: "甲题",
    author: "someone",
    category: "theme",
    description: { zh: "说明" },
    version: "1.1.0",
    packageUrl: "https://raw.githubusercontent.com/some/repo/main/pkg/a.uartix.json",
    sha256: "a".repeat(64),
    bytes: 2048,
    capabilities: ["theme.tokens"],
    screenshots: [],
    minAppVersion: "0.4.0",
    updated: "2026-09-22",
    ...over,
  };
}

beforeEach(() => {
  calls.stage.length = 0;
  calls.install.length = 0;
  calls.propose.length = 0;
  calls.approve.length = 0;
  calls.enable.length = 0;
  calls.fetch.length = 0;
  calls.existing.clear();
  calls.fetchResult = { ok: true, text: mkPkg() };
});

describe("P99c-C1a · 计划：先看清会碰到什么", () => {
  it("没装过 ⇒ action=install，要点里点名能力、来源域、哈希与「不自动启用」", async () => {
    const plan = await planMarketInstall(mkEntry());
    expect(plan.ok).toBe(true);
    expect(plan.action).toBe("install");
    const text = describePlan(plan);
    expect(text).toContain(CAP_LABEL["theme.tokens"].name); // 能力中文名来自 CAP_LABEL 那一份，不是手写
    expect(text).toContain("raw.githubusercontent.com");
    expect(text).toContain("a".repeat(12));
    expect(text).toContain("启用");               // 会说清装完还要启用（不自动生效）
  });

  it("本机同版本 ⇒ action=same；本机更高 ⇒ action=downgrade（都不许 stage）", async () => {
    calls.existing.set("uartix.theme.a", { version: "1.1.0" });
    expect((await planMarketInstall(mkEntry())).action).toBe("same");
    calls.existing.set("uartix.theme.a", { version: "9.0.0" });
    expect((await planMarketInstall(mkEntry())).action).toBe("downgrade");
    expect(calls.stage.length).toBe(0);
  });

  it("本机更低 ⇒ action=update（覆盖要人点头，所以是 update 而不是 install）", async () => {
    calls.existing.set("uartix.theme.a", { version: "1.0.0" });
    expect((await planMarketInstall(mkEntry())).action).toBe("update");
  });
});

describe("P99c-C1a · 包与货架说的是同一件事", () => {
  it("包里多出索引没声明的能力 ⇒ 拒，且 stagePackage 一次都不叫", async () => {
    calls.fetchResult = { ok: true, text: mkPkg({ capabilities: ["theme.tokens", "serial.send"] }) };
    const r = await installMarketPackage(mkEntry());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("undeclared_capability");
    expect(r.msg).toContain("serial.send");
    expect(calls.stage.length).toBe(0);
    expect(calls.install.length).toBe(0);
  });

  it("包比索引保守（少一项能力）⇒ 放过，但计划里要点名「货架上写的能力这个包没带」", async () => {
    const e = mkEntry({ capabilities: ["theme.tokens", "telemetry.read"] });
    calls.fetchResult = { ok: true, text: mkPkg({ capabilities: ["theme.tokens"] }) };
    const plan = await planMarketInstall(e);
    expect(plan.ok).toBe(true);
    expect(plan.diff.missing).toEqual(["telemetry.read"]);
    expect(describePlan(plan)).toContain("没带");
  });
});

describe("P99c-C1a · 落地的形状", () => {
  it("新装：stage→installStaged 各一次、setEnabled 零次、回执说清是停用态", async () => {
    const r = await installMarketPackage(mkEntry());
    expect(r.ok).toBe(true);
    expect(calls.stage.length).toBe(1);
    expect(calls.install).toEqual(["st-1"]);
    expect(calls.enable.length, "装完不许自动启用").toBe(0);
    expect(r.msg).toContain("停用");
  });

  it("更新：只存候选；批准权在调用方（传 approveUpdate 才批）", async () => {
    calls.existing.set("uartix.theme.a", { version: "1.0.0" });
    const staged = await installMarketPackage(mkEntry());
    expect(staged.ok).toBe(true);
    expect(calls.propose.length).toBe(1);
    expect(calls.approve.length, "默认不许自己覆盖已有版本").toBe(0);
    await installMarketPackage(mkEntry(), { approveUpdate: true });
    expect(calls.approve).toEqual(["uartix.theme.a"]);
  });

  it("同版本与降级都不许动本机", async () => {
    calls.existing.set("uartix.theme.a", { version: "1.1.0" });
    const same = await installMarketPackage(mkEntry());
    expect(same.ok).toBe(false);
    expect(same.code).toBe("already_same");
    calls.existing.set("uartix.theme.a", { version: "9.0.0" });
    expect((await installMarketPackage(mkEntry())).code).toBe("downgrade");
    expect(calls.stage.length).toBe(0);
    expect(calls.propose.length).toBe(0);
  });
});

describe("P99c-C1a · 上游一报错就绝不落地", () => {
  it("取回失败（含哈希不符）⇒ 原样带出原因，不 stage", async () => {
    calls.fetchResult = { ok: false, msg: "包哈希与索引声明不符（期望 aaaaaa…）" };
    const r = await installMarketPackage(mkEntry());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("fetch_failed");
    expect(r.msg).toContain("哈希");
    expect(calls.stage.length).toBe(0);
  });

  it("包体不是合法 JSON ⇒ code=json_bad，不 stage", async () => {
    calls.fetchResult = { ok: true, text: "{ 这不是 JSON" };
    expect((await installMarketPackage(mkEntry())).code).toBe("json_bad");
    expect(calls.stage.length).toBe(0);
  });

  it("过不了生产校验器 ⇒ 带出错误原文，不 stage", async () => {
    calls.fetchResult = { ok: true, text: mkPkg({ schemaVersion: 1 }) };
    const r = await installMarketPackage(mkEntry());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("invalid_manifest");
    expect(r.msg.length).toBeGreaterThan(0);
    expect(calls.stage.length).toBe(0);
  });

  it("包里的 id 与索引条目不是一个 ⇒ 拒（不然会装到别人头上）", async () => {
    calls.fetchResult = { ok: true, text: mkPkg({ id: "uartix.theme.other" }) };
    const r = await installMarketPackage(mkEntry());
    expect(r.ok).toBe(false);
    expect(r.code).toBe("id_mismatch");
    expect(calls.stage.length).toBe(0);
  });
});
