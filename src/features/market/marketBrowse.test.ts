/**
 * P99b-N2：市场派生层测试。
 *
 * 这批真正要钉住的只有一件事：**界面上出现的每个字，都能指回索引里的某个字段**。
 * 所以头两条测试就是"把条目改成什么样，卡片就得变成什么样"——
 * 一旦有人图省事在组件里手抄一份货架数据，这两条立刻红。
 * 其余是筛选/排序可复现、四种空态不许共用、以及"不知道就说不估计"（Q5）。
 */
import { describe, expect, it } from "vitest";
import { autoEnableBlockedCaps, CAP_LABEL } from "../plugins/pluginManifest";
import { MARKET_SCHEMA_VERSION, type MarketEntry, type MarketIndex } from "./marketIndex";
import {
  browseEntries, cardFacts, compatLabel, emptyTalk, facetCategories, formatBytes, installLabel,
  MARKET_SORTS, MARKET_TABS, missingFavorites, pickDescription, shelfLine, SORT_LABEL,
  TAB_LABEL, tabEntries, versionHistoryText, type BrowseInput,
} from "./marketBrowse";

function mkEntry(over: Partial<MarketEntry> = {}): MarketEntry {
  const base: MarketEntry = {
    id: "uartix.theme.alpha",
    name: "名称甲",
    author: "作者乙",
    category: "theme",
    description: { zh: "中文说明丙", en: "english-ding" },
    version: "1.2.0",
    packageUrl: "https://raw.githubusercontent.com/tanixs/uartix-market/main/pkg/alpha.json",
    sha256: "a".repeat(64),
    bytes: 2048,
    capabilities: ["theme.tokens"],
    screenshots: [],
    minAppVersion: "0.4.0",
    updated: "2026-09-20",
  };
  return { ...base, ...over };
}

function mkIndex(entries: MarketEntry[], categories: Record<string, string> = { theme: "外观与主题" }): MarketIndex {
  return { schemaVersion: MARKET_SCHEMA_VERSION, name: "测试货架", generatedAt: "2026-09-21T00:00:00Z", source: "s", categories, entries, dropped: [] };
}

const IDX = mkIndex([mkEntry()]);

function ctx(over: Partial<BrowseInput> = {}): BrowseInput {
  return {
    index: IDX,
    tab: "discover",
    query: "",
    category: "all",
    sort: "updated",
    lang: "zh",
    appVersion: "0.4.1",
    favorites: [],
    installOf: () => "absent",
    ...over,
  };
}

describe("marketBrowse · 卡片字段全部派生自索引", () => {
  it("条目里写什么，卡片就显示什么（组件里不许手抄货架数据）", () => {
    const e = mkEntry({
      id: "uartix.widget.rig", name: "台架三读数", author: "第三方丁", category: "widget",
      description: { zh: "说明戊", en: "text-ji" }, version: "2.7.3", updated: "2026-01-02",
      bytes: 1234, sha256: "b".repeat(64), minAppVersion: "9.9.9",
    });
    const card = cardFacts(mkIndex([e], { theme: "外观与主题" }), e, ctx());
    expect(card.name).toBe("台架三读数");
    expect(card.author).toBe("第三方丁");
    expect(card.version).toBe("2.7.3");
    expect(card.updated).toBe("2026-01-02");
    expect(card.description).toBe("说明戊");
    expect(card.otherLangDescription).toBe("text-ji");
    expect(card.sizeText).toBe("1.2 KiB");
    expect(card.sha12).toBe("b".repeat(12));
    // 分类没登记 → 照实显示原 id，不塞进"外观与主题"、也不藏掉条目
    expect(card.categoryId).toBe("widget");
    expect(card.category).toBe("widget");
  });

  it("登记过的分类用索引给的标签（标签文本也在索引里，不在代码里）", () => {
    const e = mkEntry();
    expect(cardFacts(mkIndex([e], { theme: "另一种叫法" }), e, ctx()).category).toBe("另一种叫法");
  });

  it("只有中文时另一语为空串（界面因此不显示占位，也不替作者补一段）", () => {
    const e = mkEntry({ description: { zh: "只有中文" } });
    expect(pickDescription(e, "zh")).toEqual({ text: "只有中文", other: "" });
    expect(pickDescription(e, "en")).toEqual({ text: "只有中文", other: "" });
    expect(pickDescription(mkEntry(), "en")).toEqual({ text: "english-ding", other: "中文说明丙" });
  });

  it("能力角标的中文名与「不会自动生效」标记都引插件白名单那一份", () => {
    const e = mkEntry({ capabilities: ["theme.tokens", "win.control"] });
    const blocked = new Set(autoEnableBlockedCaps());
    const caps = cardFacts(mkIndex([e]), e, ctx()).caps;
    expect(caps.map((c) => c.name)).toEqual([CAP_LABEL["theme.tokens"].name, CAP_LABEL["win.control"].name]);
    expect(caps.map((c) => c.note)).toEqual([CAP_LABEL["theme.tokens"].note, CAP_LABEL["win.control"].note]);
    expect(caps.map((c) => c.blocked)).toEqual([blocked.has("theme.tokens"), blocked.has("win.control")]);
  });

  it("verified 缺字段就是未标记，不显示「官方」", () => {
    expect(cardFacts(IDX, mkEntry(), ctx()).verified).toBe(false);
    const e = mkEntry({ verified: true });
    expect(cardFacts(mkIndex([e]), e, ctx()).verified).toBe(true);
  });

  it("没给截图就说没给，而不是留一个空图位", () => {
    expect(cardFacts(IDX, mkEntry(), ctx()).screenshotHint).toBe("作者没给截图");
    const e = mkEntry({ screenshots: ["https://raw.githubusercontent.com/t/x/a.png", "https://raw.githubusercontent.com/t/x/b.png"] });
    expect(cardFacts(mkIndex([e]), e, ctx()).screenshotHint).toBe("2 张截图");
  });
});

describe("marketBrowse · 适配性三种说法，只灰「确认装不上」（Q5）", () => {
  it("minAppVersion 高于本机才灰；相等或更低不灰", () => {
    const hi = mkEntry({ minAppVersion: "9.9.9" });
    const lo = mkEntry({ minAppVersion: "0.3.0" });
    expect(cardFacts(mkIndex([hi]), hi, ctx()).grayed).toBe(true);
    expect(cardFacts(mkIndex([lo]), lo, ctx()).grayed).toBe(false);
    expect(cardFacts(mkIndex([lo]), lo, ctx()).compatible).toBe("yes");
  });

  it("本机版本拿不到时一律 unknown 且不灰——「不知道」不等于「装不上」", () => {
    const e = mkEntry();
    const card = cardFacts(mkIndex([e]), e, ctx({ appVersion: "" }));
    expect(card.compatible).toBe("unknown");
    expect(card.grayed).toBe(false);
  });

  it("三种适配性与四种对照状态各有一句人话，且互不相同", () => {
    const compatTexts = (["yes", "no", "unknown"] as const).map(compatLabel);
    expect(new Set(compatTexts).size).toBe(3);
    const installTexts = (["absent", "same", "update", "newer-than-shelf"] as const).map(installLabel);
    expect(new Set(installTexts).size).toBe(4);
  });
});

describe("marketBrowse · 页签、搜索、分类、排序", () => {
  // 名字带 ASCII 前缀：中文名在"按拼音"与"按码位"两种排序下结果一致，测试不依赖 ICU 实现
  const a = mkEntry({ id: "uartix.a.one", name: "A 阿法", category: "theme", updated: "2026-09-01", description: { zh: "链路体检" } });
  const b = mkEntry({ id: "uartix.b.two", name: "B 北塔", category: "widget", updated: "2026-09-30" });
  const c = mkEntry({ id: "uartix.c.three", name: "C 潮汐", category: "widget", updated: "2026-09-15" });
  const idx = mkIndex([a, b, c], { theme: "外观与主题", widget: "桌面小部件" });

  it("搜索命中名称/id/作者/两种语言说明/分类标签，大小写不敏感", () => {
    for (const q of ["阿法", "UARTIX.B", "作者乙", "链路", "小部件"]) {
      expect(browseEntries(ctx({ index: idx, query: q })).length, q).toBeGreaterThan(0);
    }
    expect(browseEntries(ctx({ index: idx, query: "不存在的东西" }))).toEqual([]);
  });

  it("「最新更新」把新的排前面，同日期以 id 收尾（同一份货架两次打开顺序必须一样）", () => {
    const same = mkIndex([mkEntry({ id: "uartix.z", updated: "2026-09-30" }), mkEntry({ id: "uartix.a", updated: "2026-09-30" })]);
    expect(browseEntries(ctx({ index: same, sort: "updated" })).map((e) => e.id)).toEqual(["uartix.a", "uartix.z"]);
    expect(browseEntries(ctx({ index: idx, sort: "updated" })).map((e) => e.name)).toEqual(["B 北塔", "C 潮汐", "A 阿法"]);
  });

  it("名称排序与分类排序各按自己的键走，同类的条目挨在一起", () => {
    expect(browseEntries(ctx({ index: idx, sort: "name" })).map((e) => e.id)).toEqual(["uartix.a.one", "uartix.b.two", "uartix.c.three"]);
    expect(browseEntries(ctx({ index: idx, sort: "category" })).map((e) => e.category)).toEqual(["theme", "widget", "widget"]);
  });

  it("分类筛选只吃当前这一桶；分类计数用「筛选前」的范围，否则别的桶看着像坏了", () => {
    const input = ctx({ index: idx, category: "widget" });
    expect(browseEntries(input).map((e) => e.id)).toEqual(["uartix.b.two", "uartix.c.three"]);
    const facets = facetCategories(idx, tabEntries(input));
    expect(facets.find((f) => f.id === "widget")?.count).toBe(2);
    expect(facets.find((f) => f.id === "theme")?.count).toBe(1);
  });

  it("未登记的分类也出现在筹码里（标签回落 id，条目不消失）", () => {
    const odd = mkEntry({ category: "mystery" });
    expect(facetCategories(mkIndex([odd], {}), [odd])).toEqual([{ id: "mystery", label: "mystery", count: 1 }]);
  });

  it("收藏页签只出收藏的；已装页签只出对照结果不是 absent 的", () => {
    expect(browseEntries(ctx({ index: idx, tab: "favorites", favorites: ["uartix.b.two"] })).map((e) => e.id)).toEqual(["uartix.b.two"]);
    const installed = browseEntries(ctx({ index: idx, tab: "installed", installOf: (e) => (e.id === "uartix.a.one" ? "update" : "absent") }));
    expect(installed.map((e) => e.id)).toEqual(["uartix.a.one"]);
  });

  it("页签与排序常量各自配齐名字，一个都不漏", () => {
    expect(MARKET_TABS.map((t) => TAB_LABEL[t])).toEqual(["发现", "收藏", "已装"]);
    expect(MARKET_SORTS.map((s) => SORT_LABEL[s])).toEqual(["最新更新", "名称", "分类"]);
  });
});

describe("marketBrowse · 下架、空态、状态行", () => {
  const idx = mkIndex([mkEntry()]);

  it("收藏里已下架的照实列出来，不静默删", () => {
    expect(missingFavorites(idx, ["uartix.theme.alpha", "uartix.gone"])).toEqual(["uartix.gone"]);
    expect(missingFavorites(null, ["x"])).toEqual(["x"]);
  });

  it("四种空态四种说法，两两不同且各自带该带的数", () => {
    const t1 = emptyTalk(ctx({ index: mkIndex([]) }), 0);
    const t2 = emptyTalk(ctx({ index: idx, query: "没有这个词" }), 0);
    const t3 = emptyTalk(ctx({ index: idx, tab: "favorites" }), 0);
    const t4 = emptyTalk(ctx({ index: idx, tab: "installed" }), 0);
    expect([t1, t2, t3, t4].every((t) => t !== null)).toBe(true);
    expect(new Set([t1?.kind, t2?.kind, t3?.kind, t4?.kind]).size).toBe(4);
    expect(new Set([t1?.text, t2?.text, t3?.text, t4?.text]).size).toBe(4);
    expect(t1?.text).toContain("一条都没有");
    expect(t2?.text).toContain("1 条");
    expect(t2?.text).toContain("没有这个词");
    expect(t3?.text).toContain("收藏");
    expect(t4?.text).toContain("还没装");
    expect(emptyTalk(ctx({ index: idx }), 3)).toBeNull();
  });

  it("有搜索词与分类时，空态把命中条件念出来（用户能分清是筛没了还是没货）", () => {
    const t = emptyTalk(ctx({ index: idx, query: "秋", category: "theme" }), 0);
    expect(t?.text).toContain("搜索「秋」");
    expect(t?.text).toContain("分类「外观与主题」");
  });

  it("收藏里下架几条，收藏空态要说清楚（不然用户以为收藏丢了）", () => {
    const t = emptyTalk(ctx({ index: idx, tab: "favorites", favorites: ["uartix.gone"] }), 0);
    expect(t?.text).toContain("1 条收藏已下架");
  });

  it("版本历史不假装能列历史：契约只给当前版本就照实说", () => {
    const e = mkEntry();
    const text = versionHistoryText(e, ctx({ installOf: () => "absent" }));
    expect(text).toContain("当前版本 v1.2.0");
    expect(text).toContain("未装");
    expect(versionHistoryText(e, ctx({ installOf: () => "update" }))).toContain(installLabel("update"));
  });

  it("货架状态行带上剔除条数、耗时与是否走的镜像（不是「加载成功」就完事）", () => {
    const withDrops = { ...IDX, dropped: [{ id: "x", reason: "坏" }] };
    expect(shelfLine(withDrops, { viaMirror: false, elapsedMs: 1500 })).toContain("1 条被货架剔除");
    expect(shelfLine(IDX, { viaMirror: true, elapsedMs: 1500 })).toContain("走的镜像");
    expect(shelfLine(IDX, { viaMirror: false, elapsedMs: 1500 })).toContain("1.5 s");
    expect(shelfLine(IDX, { viaMirror: false, elapsedMs: 0 })).toContain("无剔除条目");
  });
});

describe("marketBrowse · 字节数", () => {
  it("B / KiB / MiB 各一档，负数与非有限值说「未知大小」而不是 NaN", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4.00 MiB");
    expect(formatBytes(-1)).toBe("未知大小");
    expect(formatBytes(Number.NaN)).toBe("未知大小");
  });
});
