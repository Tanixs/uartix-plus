/**
 * P99c-C1b：命令行只读半边的测试。
 *
 * 三条最要紧的：① **没开放的动作必须明说「未开放」**（不能回「未知工具」把人引到 MCP 那条话术上，
 * 也不能悄悄当成读命令）；② **索引没就绪时说「还没拿到」而不是「没有插件」**（后者会被读成事实）；
 * ③ **截断要报还剩几条**（A7）。其余是各命令的读数形状。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketEntry, MarketIndex } from "./marketIndex";
import { MARKET_ALLOW_HOSTS, MARKET_SCHEMA_VERSION } from "./marketIndex";

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
  plugins: [] as { id: string; name: string; version: string; state?: string }[],
  refreshes: 0,
  fetches: [] as string[],
  fetchResult: { ok: true, text: "", msg: "" } as { ok: boolean; text?: string; msg?: string },
  stage: 0,
  install: [] as string[],
  propose: 0,
  approve: 0,
  enable: 0,
}));

vi.mock("./marketStore", () => ({
  getMarketSnapshot: () => st.market,
  refreshIndex: async () => {
    st.refreshes++;
    return st.market;
  },
  fetchPackage: async (e: MarketEntry) => {
    st.fetches.push(e.id);
    return st.fetchResult.ok
      ? { ok: true, text: st.fetchResult.text ?? "", bytes: new TextEncoder().encode(st.fetchResult.text ?? "").length }
      : { ok: false, msg: st.fetchResult.msg ?? "", bytes: 0 };
  },
}));
vi.mock("../plugins/pluginStore", () => ({
  // CLI 的"本机多出来哪些包"与货架页同一份判定，状态中文名也同一份表 ⇒ mock 得把它带上
  PLUGIN_STATE_LABEL: {
    draft: "草稿", validated: "已校验", previewed: "已预览", installed_disabled: "已安装（停用）",
    enabled: "已启用", disabled: "已停用", update_pending: "待批准更新", quarantined: "已隔离",
  },
  getSnapshot: () => ({ plugins: st.plugins.map((p) => ({ pkg: { id: p.id, name: p.name, version: p.version }, state: p.state ?? "enabled" })) }),
  getPlugin: (id: string) => {
    const hit = st.plugins.find((p) => p.id === id);
    return hit ? { pkg: { id: hit.id, name: hit.name, version: hit.version } } : undefined;
  },
  stagePackage: () => {
    st.stage++;
    return { ok: true, errors: [], warnings: [], stagingId: "st-cli" };
  },
  installStaged: (sid: string) => {
    st.install.push(sid);
    return { ok: true, msg: "已装入", id: "uartix.theme.ink" };
  },
  proposeUpdate: () => {
    st.propose++;
    return { ok: true, msg: "候选已就绪" };
  },
  approveUpdate: () => {
    st.approve++;
    return { ok: true, msg: "已批准" };
  },
  setEnabled: () => {
    st.enable++;
    return { ok: true, msg: "" };
  },
}));

const { handleCli, CLI_KINDS, isCliKind } = await import("./marketCli");
const { __resetMarketPendingForTest } = await import("./marketPending");
const { parseMarketIndex } = await import("./marketIndex");

/** 过**生产校验器**的包体（与下面 entry() 的 id/版本/能力一致；不一致就是另一条判定了） */
const PKG_BASE = {
  format: "uartix-plugin",
  schemaVersion: 2,
  id: "uartix.theme.ink",
  version: "1.0.0",
  name: "墨夜",
  hostApi: "^1.0",
  capabilities: ["theme.tokens"],
  contributions: { themes: [{ id: "main", entry: "main.json" }] },
  artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#0b1020" } } },
  provenance: { createdBy: "user", reviewed: false },
};
const pkgText = (over: Record<string, unknown> = {}) => JSON.stringify({ ...PKG_BASE, ...over });
const PKG_JSON = pkgText();

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
    schemaVersion: MARKET_SCHEMA_VERSION, name: "测试货架", generatedAt: "2026-09-21T00:00:00Z", source: "s",
    categories: { theme: "外观与主题", widget: "桌面小部件" }, entries,
  };
  // 白名单引契约那一份 + localhost（测试环境）：抄一份字面量的话，加域时这里会悄悄漏掉 npm 条目
  const r = parseMarketIndex(raw, [...MARKET_ALLOW_HOSTS, "localhost"]);
  if (!r.ok) throw new Error(`夹具本身坏了：${r.errors.join(" / ")}`);
  st.market = { ...st.market, status: "ready", index: r.index, error: "" };
}

beforeEach(() => {
  st.market = {
    status: "idle", index: null, error: "", viaMirror: false, elapsedMs: 0, fetchedAt: 0, favorites: [], appVersion: "0.4.1",
  };
  st.plugins = [];
  st.refreshes = 0;
  st.fetches.length = 0;
  st.fetchResult = { ok: true, text: PKG_JSON, msg: "" };
  st.stage = 0;
  st.install.length = 0;
  st.propose = 0;
  st.approve = 0;
  st.enable = 0;
  __resetMarketPendingForTest();
});

describe("P99c-C1b · 通道边界", () => {
  it("前缀判定与清单同源：cli. 开头才是命令行动作", () => {
    expect(isCliKind("cli.market_list")).toBe(true);
    expect(isCliKind("get_status")).toBe(false);
    expect(CLI_KINDS.every((k) => isCliKind(k))).toBe(true);
  });

  it("没开放的动作说「未开放」并点名只有哪几条（不回未知工具，也不当读命令）", async () => {
    await expect(handleCli("cli.plugin_uninstall", { id: "uartix.theme.ink" })).rejects.toThrow(/未开放/);
    await expect(handleCli("cli.plugin_uninstall", {})).rejects.toThrow(CLI_KINDS[0]);
  });

  it("装包这条永远不进 MCP 工具清单（Q7：模型够不到货架这条链）", async () => {
    const { ALL_TOOL_DEFS } = await import("../mcp/mcpTools");
    for (const k of ["cli.plugin_install", "cli.plugin_status"]) {
      expect(CLI_KINDS).toContain(k as (typeof CLI_KINDS)[number]);
      expect(ALL_TOOL_DEFS.some((t) => t.name === k)).toBe(false);
    }
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
      total: number; onShelf: { local: string; shelf: string; state: string }[];
      offShelf: { id: string; name: string; version: string; state: string }[]; offShelfNote: string;
    };
    expect(r.total).toBe(2);
    expect(r.onShelf[0].state).toBe("有更新");
    expect(r.onShelf[0]).toMatchObject({ local: "0.9.0", shelf: "1.0.0" });
    expect(r.offShelf.map((x) => x.id)).toEqual(["user.local.thing"]);
    // P99b-N6：多出来那批也带齐四样（界面点开的那张清单与这条 --json 同一个出处）
    expect(r.offShelf[0]).toEqual({ id: "user.local.thing", name: "自己的包", version: "1.0.0", state: "已启用" });
    expect(r.offShelfNote).toContain("只按 id 对照");
  });
});

describe("P99c-C1c · 装包这条异步半边", () => {
  it("install 一次调用只回 token，不当场给结论（桥只等 3 秒，慢的在应用里跑）", async () => {
    readyIndex([entry()]);
    const r = (await handleCli("cli.plugin_install", { id: "uartix.theme.ink" })) as {
      ok: boolean; token: string; msg: string; note: string;
    };
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/-/);
    expect(r.note).toContain("受理不等于装好");
    expect(r.msg, "回话里不许出现『已装入』这种结论").not.toContain("已装入");
  });

  it("索引还没拿到 ⇒ 明确说没开工，一条请求都不建", async () => {
    const r = (await handleCli("cli.plugin_install", { id: "uartix.theme.ink" })) as { ok: boolean; token: string; note: string };
    expect(r.ok).toBe(false);
    expect(r.token).toBe("");
    expect(r.note).toBe("没有开始任何取回");
    expect(st.fetches.length).toBe(0);
  });

  it("货架上没这条 id ⇒ 说清楚并指向 list，不去取任何东西", async () => {
    readyIndex([entry()]);
    const r = (await handleCli("cli.plugin_install", { id: "uartix.theme.nope" })) as { ok: boolean; msg: string };
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("货架上没有");
    expect(r.msg).toContain("list --query");
    expect(st.fetches.length).toBe(0);
  });

  it("status 认 token：新装跑完是 done，且全程没叫 setEnabled", async () => {
    readyIndex([entry()]);
    const started = (await handleCli("cli.plugin_install", { id: "uartix.theme.ink" })) as { token: string };
    let r = (await handleCli("cli.plugin_status", { token: started.token })) as Record<string, unknown>;
    for (let i = 0; i < 20 && r.phase === "working"; i++) {
      await new Promise((k) => setTimeout(k, 5));
      r = (await handleCli("cli.plugin_status", { token: started.token })) as Record<string, unknown>;
    }
    expect(r.phase).toBe("done");
    expect(r.ok).toBe(true);
    expect(st.install, "新装：暂存之后落地一次").toEqual(["st-cli"]);
    expect(st.enable, "装完绝不自动启用").toBe(0);
    expect(String(r.text)).toContain("停用");
  });

  it("status 不认的 token ⇒ gone + 一句「本机没动过」，不编个阶段出来", async () => {
    const r = (await handleCli("cli.plugin_status", { token: "no-such-token" })) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.phase).toBe("gone");
    expect(String(r.msg)).toContain("重跑");
  });

  it("覆盖已有版本：停在 awaiting_you，批准前 proposeUpdate 与 installStaged 都零次", async () => {
    readyIndex([entry({ version: "2.0.0" })]);
    st.plugins = [{ id: "uartix.theme.ink", name: "墨夜", version: "1.0.0" }];
    st.fetchResult = { ok: true, text: pkgText({ version: "2.0.0" }) };
    const started = (await handleCli("cli.plugin_install", { id: "uartix.theme.ink" })) as { token: string };
    let r = (await handleCli("cli.plugin_status", { token: started.token })) as Record<string, unknown>;
    for (let i = 0; i < 20 && r.phase === "working"; i++) {
      await new Promise((k) => setTimeout(k, 5));
      r = (await handleCli("cli.plugin_status", { token: started.token })) as Record<string, unknown>;
    }
    expect(r.phase).toBe("awaiting_you");
    expect(r.ok).toBe(false);
    expect(r.awaiting).toBe(1);
    expect(st.propose, "提前建候选会把状态翻成 update_pending，等于批准前先把在跑的版本摘下来").toBe(0);
    expect(st.install.length).toBe(0);
  });
});
