/**
 * P99c-C1b：命令行只读半边的测试。
 *
 * 三条最要紧的：① **没开放的动作必须明说「未开放」**（不能回「未知工具」把人引到 MCP 那条话术上，
 * 也不能悄悄当成读命令）；② **索引没就绪时说「还没拿到」而不是「没有插件」**（后者会被读成事实）；
 * ③ **截断要报还剩几条**（A7）。其余是各命令的读数形状。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketEntry, MarketIndex } from "./marketIndex";

const st = vi.hoisted(() => ({
  market: {
    status: "idle" as "idle" | "loading" | "ready" | "failed",
    index: null as MarketIndex | null,
    error: "",
    viaMirror: false,
    elapsedMs: 0,
    fetchedAt: 0,
    favorites: [] as string[],
    appVersion: "0.4.1",
  },
  plugins: [] as { id: string; name: string; version: string }[],
  refreshes: 0,
}));

vi.mock("./marketStore", () => ({
  getMarketSnapshot: () => st.market,
  refreshIndex: async () => {
    st.refreshes++;
    return st.market;
  },
}));
vi.mock("../plugins/pluginStore", () => ({
  getSnapshot: () => ({ plugins: st.plugins.map((p) => ({ pkg: { id: p.id, name: p.name, version: p.version } })) }),
}));

const { handleCli, CLI_KINDS, isCliKind } = await import("./marketCli");
const { parseMarketIndex } = await import("./marketIndex");

function entry(over: Partial<MarketEntry> = {}): MarketEntry {
  const base: MarketEntry = {
    id: "uartix.theme.ink", name: "墨夜", author: "uartix", category: "theme",
    description: { zh: "深蓝夜视", en: "ink night" }, version: "1.0.0",
    packageUrl: "/market/pkg/theme-ink.uartix.json", sha256: "b".repeat(64), bytes: 671,
    capabilities: ["theme.tokens"], screenshots: ["/market/img/ink-night.png"],
    minAppVersion: "0.4.1", updated: "2026-09-20",
  };
  return { ...base, ...over };
}

function readyIndex(entries: MarketEntry[]) {
  const raw = {
    schemaVersion: 1, name: "测试货架", generatedAt: "2026-09-21T00:00:00Z", source: "s",
    categories: { theme: "外观与主题", widget: "桌面小部件" }, entries,
  };
  const r = parseMarketIndex(raw, ["raw.githubusercontent.com", "github.com", "localhost"]);
  if (!r.ok) throw new Error(`夹具本身坏了：${r.errors.join(" / ")}`);
  st.market = { ...st.market, status: "ready", index: r.index, error: "" };
}

beforeEach(() => {
  st.market = {
    status: "idle", index: null, error: "", viaMirror: false, elapsedMs: 0, fetchedAt: 0, favorites: [], appVersion: "0.4.1",
  };
  st.plugins = [];
  st.refreshes = 0;
});

describe("P99c-C1b · 通道边界", () => {
  it("前缀判定与清单同源：cli. 开头才是命令行动作", () => {
    expect(isCliKind("cli.market_list")).toBe(true);
    expect(isCliKind("get_status")).toBe(false);
    expect(CLI_KINDS.every((k) => isCliKind(k))).toBe(true);
  });

  it("没开放的动作说「未开放」并点名只有哪几条（不回未知工具，也不当读命令）", async () => {
    await expect(handleCli("cli.plugin_install", { id: "uartix.theme.ink" })).rejects.toThrow(/未开放/);
    await expect(handleCli("cli.plugin_install", {})).rejects.toThrow(CLI_KINDS[0]);
  });
});

describe("P99c-C1b · 四条读命令", () => {
  it("status 不碰网络也答得出状态（桥只等 3 秒）", async () => {
    st.market = { ...st.market, status: "failed", error: "拉不到索引（1.2 s）：超时" };
    const r = (await handleCli("cli.market_status", {})) as Record<string, unknown>;
    expect(r.status).toBe("failed");
    expect(r.error).toContain("超时");
    expect(r.entries).toBe(0);
    expect(st.refreshes, "status 不该顺手拉索引").toBe(0);
  });

  it("索引没就绪：起一次拉取，说「还没拿到」而不是「没有插件」", async () => {
    const r = (await handleCli("cli.market_list", {})) as { cards: unknown[]; total: number; note: string };
    expect(r.cards).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.note).toContain("还没拿到");
    expect(r.note).not.toContain("没有插件");
    expect(st.refreshes).toBe(1);
  });

  it("list 的卡片每个字都从索引来，与界面共用同一份派生", async () => {
    readyIndex([entry()]);
    const r = (await handleCli("cli.market_list", {})) as {
      cards: { id: string; name: string; category: string; caps: string[]; install: string; size: string }[];
      total: number;
      categories: string[];
    };
    expect(r.total).toBe(1);
    expect(r.cards[0].name).toBe("墨夜");
    expect(r.cards[0].category).toBe("外观与主题");
    expect(r.cards[0].size).toBe("671 B");
    expect(r.cards[0].install).toBe("未安装");
    expect(r.categories.join("|")).toContain("外观与主题 1");
  });

  it("list 截断必须报还剩几条（A7）", async () => {
    readyIndex(
      Array.from({ length: 4 }, (_, i) => entry({ id: `uartix.theme.t${i}`, name: `题${i}` })),
    );
    const r = (await handleCli("cli.market_list", { limit: 2 })) as { shown: number; total: number; truncated: string };
    expect([r.shown, r.total]).toEqual([2, 4]);
    expect(r.truncated).toContain("还有 2 条");
  });

  it("list 的搜索与分类走派生层：筛没了给的是「没命中 + 货架有几条」", async () => {
    readyIndex([entry()]);
    const hit = (await handleCli("cli.market_list", { query: "墨" })) as { total: number };
    expect(hit.total).toBe(1);
    const miss = (await handleCli("cli.market_list", { query: "不存在的词" })) as { total: number; note: string };
    expect(miss.total).toBe(0);
    expect(miss.note).toContain("其实有 1 条");
  });

  it("info 的能力带人话与不放行标记，并带那句列表不等于背书", async () => {
    readyIndex([entry({ verified: true })]);
    const r = (await handleCli("cli.market_info", { id: "uartix.theme.ink" })) as {
      caps: { name: string; note: string; blocked: boolean }[]; note: string; screenshots: number; sha256_12: string;
    };
    expect(r.caps[0].name.length).toBeGreaterThan(1);
    expect(r.caps[0].note.length).toBeGreaterThan(3);
    expect(r.sha256_12).toBe("b".repeat(12));
    expect(r.screenshots).toBe(1);
    expect(r.note).toContain("不代表内容安全");
  });

  it("info 找不到 id 就说清楚并指向 list（不发一个空壳让人以为没内容）", async () => {
    readyIndex([entry()]);
    await expect(handleCli("cli.market_info", { id: "uartix.nope" })).rejects.toThrow(/货架上没有/);
  });

  it("installed 按 id 分成在架上与不在架上，不猜对应关系", async () => {
    readyIndex([entry()]);
    st.plugins = [
      { id: "uartix.theme.ink", name: "墨夜", version: "0.9.0" },
      { id: "user.local.thing", name: "自己的包", version: "1.0.0" },
    ];
    const r = (await handleCli("cli.plugins_installed", {})) as {
      total: number; onShelf: { local: string; shelf: string; state: string }[]; offShelf: { id: string }[]; offShelfNote: string;
    };
    expect(r.total).toBe(2);
    expect(r.onShelf[0].state).toBe("有更新");
    expect(r.onShelf[0]).toMatchObject({ local: "0.9.0", shelf: "1.0.0" });
    expect(r.offShelf.map((x) => x.id)).toEqual(["user.local.thing"]);
    expect(r.offShelfNote).toContain("只按 id 对照");
  });
});
