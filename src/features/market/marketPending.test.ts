/**
 * P99c-C1c：装包那张**异步小表**自己的测试（端到端形状在 `marketCli.test.ts`，这里只测表）。
 *
 * 四件最要紧的：① 过期与淘汰要说得出口（`expired` 而不是假装还在跑）；② 表满淘汰最旧的，
 * 不静默丢；③ `accept`/`reject` 只对"等你确认"这一条成立，别的状态下都不许动本机；
 * ④ 同一个 id 连点两次是两条独立记录（不合并也不覆盖——那是"哪一条算数"的第二真相）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketEntry } from "./marketIndex";

const st = vi.hoisted(() => ({
  index: null as { entries: MarketEntry[] } | null,
  plugins: new Map<string, string>(),
  install: [] as string[],
  propose: [] as string[],
  approve: [] as string[],
  enable: 0,
}));

vi.mock("./marketStore", () => ({
  getMarketSnapshot: () => ({ index: st.index }),
  fetchPackage: async (e: MarketEntry) => ({
    ok: true,
    text: JSON.stringify({
      format: "uartix-plugin", schemaVersion: 2, id: e.id, version: e.version, name: e.name,
      hostApi: "^1.0", capabilities: e.capabilities,
      contributions: { themes: [{ id: "main", entry: "main.json" }] },
      artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#0b1020" } } },
      provenance: { createdBy: "user", reviewed: false },
    }),
    bytes: 900,
  }),
}));
vi.mock("../plugins/pluginStore", () => ({
  getPlugin: (id: string) => (st.plugins.has(id) ? { pkg: { id, version: st.plugins.get(id) } } : undefined),
  stagePackage: () => ({ ok: true, errors: [], warnings: [], stagingId: `st-${st.install.length + 1}` }),
  installStaged: (sid: string) => {
    st.install.push(sid);
    return sid.startsWith("st-") ? { ok: true, msg: "已装入", id: "uartix.theme.ink" } : { ok: false, msg: "暂存不存在或已过期" };
  },
  proposeUpdate: (id: string) => {
    st.propose.push(id);
    return { ok: true, msg: "候选已就绪" };
  },
  approveUpdate: (id: string) => {
    st.approve.push(id);
    return { ok: true, msg: "已批准" };
  },
  setEnabled: () => {
    st.enable += 1;
    return { ok: true, msg: "" };
  },
}));

const {
  acceptMarketInstall, awaitingMarketInstalls, marketPendingSnapshot, readMarketPending,
  rejectMarketInstall, requestMarketInstall, __resetMarketPendingForTest,
} = await import("./marketPending");

function entry(over: Partial<MarketEntry> = {}): MarketEntry {
  const base: MarketEntry = {
    id: "uartix.theme.ink", name: "墨夜", author: "uartix", category: "theme",
    description: { zh: "深蓝夜视" }, version: "1.0.0",
    packageUrl: "https://raw.githubusercontent.com/a/b/main/i.uartix.json", sha256: "b".repeat(64),
    bytes: 900, capabilities: ["theme.tokens"], screenshots: [], minAppVersion: "0.4.0", updated: "2026-09-20",
  };
  return { ...base, ...over };
}

/** 等后台那一半跑完（不 sleep 固定时长：轮到自己出结果为止） */
async function settle(token: string) {
  for (let i = 0; i < 50; i++) {
    const v = readMarketPending(token);
    if (!("phase" in v) || v.phase !== "working") return v;
    await new Promise((k) => setTimeout(k, 2));
  }
  return readMarketPending(token);
}

beforeEach(() => {
  st.index = { entries: [entry()] };
  st.plugins.clear();
  st.install.length = 0;
  st.propose.length = 0;
  st.approve.length = 0;
  st.enable = 0;
  __resetMarketPendingForTest();
});

describe("P99c-C1c · 小表自己", () => {
  it("新装一路跑到 done，落地一次、启用零次", async () => {
    const { token } = requestMarketInstall("uartix.theme.ink");
    const v = await settle(token);
    expect("phase" in v && v.phase).toBe("done");
    expect(st.install).toEqual(["st-1"]);
    expect(st.enable, "装完不许自动启用").toBe(0);
  });

  it("覆盖停在 awaiting_you；reject 之后本机一次没动，且再点装入说不在等待状态", async () => {
    st.index = { entries: [entry({ version: "2.0.0" })] };
    st.plugins.set("uartix.theme.ink", "1.0.0");
    const { token } = requestMarketInstall("uartix.theme.ink");
    const v = await settle(token);
    expect("phase" in v && v.phase).toBe("awaiting_you");
    expect(st.propose.length + st.install.length).toBe(0);
    expect(awaitingMarketInstalls().map((x) => x.token)).toEqual([token]);
    expect(rejectMarketInstall(token).ok).toBe(true);
    const after = readMarketPending(token);
    expect("phase" in after ? after.phase : "").toBe("rejected");
    const late = acceptMarketInstall(token);
    expect(late.ok).toBe(false);
    expect(late.code).toBe("not_awaiting");
    expect(st.approve.length, "拒了之后再点也不该补一次覆盖").toBe(0);
  });

  it("accept 走到底：propose 与 approve 各一次，回执带「已批准」", async () => {
    st.index = { entries: [entry({ version: "2.0.0" })] };
    st.plugins.set("uartix.theme.ink", "1.0.0");
    const { token } = requestMarketInstall("uartix.theme.ink");
    await settle(token);
    const r = acceptMarketInstall(token);
    expect(r.ok).toBe(true);
    expect(st.propose).toEqual(["uartix.theme.ink"]);
    expect(st.approve).toEqual(["uartix.theme.ink"]);
    expect(r.msg).toContain("已批准");
  });

  it("同一个 id 连发两次是两条记录，不合并也不互相覆盖", async () => {
    const a = requestMarketInstall("uartix.theme.ink");
    const b = requestMarketInstall("uartix.theme.ink");
    expect(a.token).not.toBe(b.token);
    await settle(a.token);
    await settle(b.token);
    expect(marketPendingSnapshot().length).toBe(2);
  });

  it("表满淘汰最旧的：那条之后问不到，且说的是「重跑」不是「失败」", async () => {
    const first = requestMarketInstall("uartix.theme.ink");
    await settle(first.token);
    for (let i = 0; i < 8; i++) await settle(requestMarketInstall("uartix.theme.ink").token);
    const gone = readMarketPending(first.token);
    expect("code" in gone ? gone.code : "").toBe("expired");
    expect("msg" in gone ? gone.msg : "").toContain("重跑");
    expect(marketPendingSnapshot().length).toBeLessThanOrEqual(8);
  });

  it("过 TTL 就作废（等确认的窗口不是无限的）", async () => {
    st.index = { entries: [entry({ version: "2.0.0" })] };
    st.plugins.set("uartix.theme.ink", "1.0.0");
    const { token } = requestMarketInstall("uartix.theme.ink");
    await settle(token);
    const rec = marketPendingSnapshot()[0];
    vi.spyOn(Date, "now").mockReturnValue(rec.expiresAt + 1);
    expect("code" in readMarketPending(token) ? readMarketPending(token).code : "").toBe("expired");
    expect(acceptMarketInstall(token).code).toBe("expired");
    expect(st.approve.length, "过期后不许再覆盖本机").toBe(0);
    vi.restoreAllMocks();
  });

  it("索引没拿到时不开工，且说的是「还没拿到」", () => {
    st.index = null;
    const r = requestMarketInstall("uartix.theme.ink");
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("索引还没拿到");
    expect(marketPendingSnapshot().length).toBe(0);
  });
});
