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
import { MARKET_ALLOW_HOSTS, MARKET_SCHEMA_VERSION, type InstallState, type MarketEntry, type MarketIndex } from "./marketIndex";
import type { PendingPhase, PendingView } from "./marketPending";
import {
  browseEntries, cardAction, cardFacts, compatLabel, emptyTalk, facetCategories, formatBytes, indexEndpointTalk,
  installLabel, MARKET_SORTS, MARKET_TABS, missingFavorites, mirrorEndpointTalk, mirrorEndpointVerdict, offShelfOf,
  pendingBadge, pickDescription, planQueueAllUpdates, shelfLine,
  SORT_LABEL, TAB_LABEL, tabEntries, themeEnableFacts, themeStateOf, versionHistoryText, type BrowseInput,
} from "./marketBrowse";

const fsSpec = "node:fs";
const { readFileSync } = (await import(fsSpec)) as {
  readFileSync: (p: string | URL, enc?: string) => string;
};

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

  it("没给预览图就说没给，而不是留一个空图位（说「截图」会与内容不符）", () => {
    expect(cardFacts(IDX, mkEntry(), ctx()).screenshotHint).toBe("作者没给预览图");
    const e = mkEntry({ screenshots: ["https://raw.githubusercontent.com/t/x/a.png", "https://raw.githubusercontent.com/t/x/b.png"] });
    expect(cardFacts(mkIndex([e]), e, ctx()).screenshotHint).toBe("2 张预览图");
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

  it("N5 · 「外观」页签按**能力**筛，不按作者自填的分类", () => {
    const withTheme = mkIndex([
      mkEntry({ id: "uartix.widget.plain", capabilities: ["ui.widget"] }),
      mkEntry({ id: "uartix.theme.beta", capabilities: ["theme.tokens"], category: "skin" }),
      mkEntry({ id: "uartix.panel.c", capabilities: ["ui.panel"] }),
    ]);
    const got = browseEntries(ctx({ index: withTheme, tab: "appearance" })).map((e) => e.id);
    expect(got, "分类 id 是作者自填的（写 skin 也算主题），只有能力声明被对账过").toEqual(["uartix.theme.beta"]);
  });

  it("页签与排序常量各自配齐名字，一个都不漏", () => {
    expect(MARKET_TABS.map((t) => TAB_LABEL[t])).toEqual(["发现", "收藏", "已装", "外观"]);
    expect(MARKET_SORTS.map((s) => SORT_LABEL[s])).toEqual(["最新更新", "名称", "分类"]);
  });
});

describe("marketBrowse · 下架、空态、状态行", () => {
  const idx = mkIndex([mkEntry()]);

  it("收藏里已下架的照实列出来，不静默删", () => {
    expect(missingFavorites(idx, ["uartix.theme.alpha", "uartix.gone"])).toEqual(["uartix.gone"]);
    expect(missingFavorites(null, ["x"])).toEqual(["x"]);
  });

  it("五种空态五种说法，两两不同且各自带该带的数", () => {
    const t1 = emptyTalk(ctx({ index: mkIndex([]) }), 0);
    const t2 = emptyTalk(ctx({ index: idx, query: "没有这个词" }), 0);
    const t3 = emptyTalk(ctx({ index: idx, tab: "favorites" }), 0);
    const t4 = emptyTalk(ctx({ index: idx, tab: "installed" }), 0);
    const t5 = emptyTalk(ctx({ index: idx, tab: "appearance" }), 0);
    expect([t1!.kind, t2!.kind, t3!.kind, t4!.kind, t5!.kind]).toEqual([
      "index-empty",
      "no-match",
      "no-favorites",
      "nothing-installed",
      "no-themes",
    ]);
    const texts = [t1, t2, t3, t4, t5].map((t) => t!.text);
    expect(new Set(texts).size, "共用一句\"暂无内容\"就是骗人").toBe(5);
    expect(t5!.text).toContain("theme.tokens");
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

/* ---------------- P99b-N4：市场页那颗按钮的全部组合（先写钉后写表，§8-52） ---------------- */

describe("P99b-N4 · 按钮那一格＝货架比对 × 请求相的全穷举", () => {
  /** 两份字面量表，不从源码常量派生——跟着常量比对等于"上限抬到十万也照样绿"（§8-52①） */
  const STATES: InstallState[] = ["absent", "same", "update", "newer-than-shelf"];
  const PHASES: (PendingPhase | null)[] = [null, "working", "awaiting_you", "done", "failed", "rejected"];

  function cardOf(state: InstallState, version = "1.2.0") {
    const e = mkEntry({ version });
    return cardFacts(mkIndex([e]), e, ctx({ installOf: () => state }));
  }
  function pv(phase: PendingPhase, over: Partial<PendingView> = {}): PendingView {
    return {
      token: `tk-${phase}`, entryId: "uartix.theme.alpha", phase, phaseText: "", text: `原话-${phase}`,
      code: "", createdAt: 0, expiresAt: 0, ...over,
    };
  }

  it("反空：组合数确确实是 24（少一格，下面那两条就会空跑）", () => {
    expect(STATES.length * PHASES.length).toBe(24);
  });

  it("24 格里没有一格是空的：每格都有文案、都能判得出可不可点", () => {
    for (const s of STATES) {
      for (const p of PHASES) {
        const a = cardAction(cardOf(s), p ? pv(p) : null);
        expect(a.label, `${s} × ${p ?? "无请求"} 这一格没有文案`).not.toBe("");
        expect(typeof a.enabled, `${s} × ${p ?? "无请求"} 没说能不能点`).toBe("boolean");
        expect(["idle", "busy", "you", "done", "bad"]).toContain(a.tone);
      }
    }
  });

  it("「本机比货架新」在任何一相都点不动（装它＝回退，界面与内核同向）", () => {
    for (const p of PHASES) {
      expect(cardAction(cardOf("newer-than-shelf"), p ? pv(p) : null).enabled, `newer × ${p}`).toBe(false);
    }
  });

  it("在飞与等你的那两相，卡片上点不动——动作只有确认卡那一个入口", () => {
    for (const s of STATES) {
      for (const p of ["working", "awaiting_you"] as PendingPhase[]) {
        expect(cardAction(cardOf(s), pv(p)).enabled, `${s} × ${p} 还能点就是两个入口做同一件事`).toBe(false);
      }
    }
  });

  it("失败那一格要把内核原话抬上来，不许糊成「没成」", () => {
    const a = cardAction(cardOf("absent"), pv("failed", { text: "取回失败：远端返回 404" }));
    expect(a.hint).toContain("404");
    expect(a.enabled, "失败了还不给重试").toBe(true);
  });

  it("两种收场不是同一件事：新装那一格写「未启用」，覆盖那一格抬内核那句「可回滚」（覆盖延续原启用状态）", () => {
    const a = cardAction(cardOf("absent"), pv("done", { text: "秋海棠 v1.2.0｜已装入插件库，状态：停用" }));
    expect(`${a.label} ${a.hint}`, "新装完没说没启用").toContain("未启用");
    expect(a.hint, "收场那句要抬内核原话，界面不自己复述一遍").toContain("状态：停用");
    const u = cardAction(cardOf("update"), pv("done", { text: "秋海棠 v1.2.0｜已批准并切换（旧版本进历史，可回滚）" }));
    expect(`${u.label} ${u.hint}`, "覆盖完没提旧版还能回滚").toContain("回滚");
    expect(`${u.label} ${u.hint}`, "覆盖延续原启用状态（approveUpdate 把状态接回去），这里写「未启用」就是骗人").not.toContain("未启用");
  });

  it("「更新到 v…」里那个版本号是从货架来的，不是写死的", () => {
    expect(cardAction(cardOf("update", "9.9.9"), null).label).toContain("9.9.9");
    expect(cardAction(cardOf("update", "0.3.1"), null).label).toContain("0.3.1");
  });

  it("徽标只数得出数字，0 的时候干脆不出（0 也要占位就是噪音）", () => {
    expect(pendingBadge(0)).toBe("");
    expect(pendingBadge(3)).toBe("3");
  });
});

describe("P99b-N4 · 「全部更新」的排队口径", () => {
  const cardUpd = (id: string, state: InstallState = "update") => {
    const e = mkEntry({ id });
    return cardFacts(mkIndex([e]), e, ctx({ installOf: () => state }));
  };
  const pv = (entryId: string, phase: PendingPhase): PendingView => ({
    token: `tk-${entryId}`, entryId, phase, phaseText: "", text: "", code: "", createdAt: 0, expiresAt: 0,
  });

  it("只排「有更新」的那几条，未装与本机比货架新都不算", () => {
    const cards = [cardUpd("a"), cardUpd("b", "absent"), cardUpd("c", "newer-than-shelf"), cardUpd("d")];
    const r = planQueueAllUpdates(cards, [], 8);
    expect(r.ids).toEqual(["a", "d"]);
    expect(r.skippedNotUpdatable).toBe(2);
  });

  it("已经在飞或等你的那条不重排（同一条排两次＝两张确认卡）", () => {
    const cards = [cardUpd("a"), cardUpd("b"), cardUpd("c")];
    const r = planQueueAllUpdates(cards, [pv("a", "working"), pv("b", "awaiting_you")], 8);
    expect(r.ids).toEqual(["c"]);
    expect(r.skippedInFlight).toBe(2);
  });

  it("表一次只装得下 8 条：超出的数量要报出来，不静默丢（A7）", () => {
    const cards = Array.from({ length: 11 }, (_, i) => cardUpd(`p${i}`));
    const r = planQueueAllUpdates(cards, [], 8);
    expect(r.ids.length).toBe(8);
    expect(r.overCap).toBe(3);
  });

  it("一条都没得更新时是空的，不报错也不假装排队了", () => {
    const r = planQueueAllUpdates([cardUpd("a", "same")], [], 8);
    expect(r.ids).toEqual([]);
    expect(r.overCap).toBe(0);
  });
});

describe("P99b-N5 · 「外观」页签那颗启停（三态三种说法）", () => {
  const opts = { name: "秋水", drawnName: "墨夜", installs: 1 };

  it("装了三态分立：在画 / 启用着但没在画 / 装了没启用；没装就根本不给这颗按钮", () => {
    const drawn = themeEnableFacts("drawn", opts);
    const hidden = themeEnableFacts("enabled-hidden", opts);
    const off = themeEnableFacts("installed-off", opts);
    const none = themeEnableFacts("not-installed", opts);
    expect([drawn.label, hidden.label, off.label]).toEqual(["停用", "启用这颗", "启用这颗"]);
    expect(none.show, "没装机就给一颗点了没反应的按钮，比没有按钮更糟").toBe(false);
    expect(new Set([drawn.talk, hidden.talk, off.talk]).size, "三件事共用一句就是没说清").toBe(3);
    expect(drawn.talk).toContain("回到当前选中的内置主题");
    expect(hidden.talk).toContain("没在画");
    expect(off.talk).toContain("挤掉");
    expect(off.talk).toContain("墨夜");
  });

  it("这个包还带别的东西时必须一起说（点\"启用这颗\"不该只换来一层配色）", () => {
    const r = themeEnableFacts("installed-off", { ...opts, installs: 3 });
    expect(r.talk).toContain("还带 2 项别的东西");
  });

  it("状态判据只有一处：enabled + 在画 id 对得上才算 drawn（对不上就是 enabled-hidden）", () => {
    expect(themeStateOf({ enabled: true }, "plg:a:main", "plg:a:main")).toBe("drawn");
    expect(themeStateOf({ enabled: true }, "plg:b:main", "plg:a:main")).toBe("enabled-hidden");
    expect(themeStateOf({ enabled: false }, null, "plg:a:main")).toBe("installed-off");
    expect(themeStateOf(null, "plg:a:main", "plg:a:main")).toBe("not-installed");
    expect(themeStateOf({ enabled: true }, "plg:a:main", null), "拿不到影子扩展 id 时不许冒充在画").toBe("enabled-hidden");
  });
});

/* ================= P99b-N6 · 本机多出来的那批包（详设 §4-4 / §5-Q3） ================= */
describe("P99b-N6 · offShelfOf：只按 id 对照，不猜哪个对应哪个", () => {
  const local = [
    { id: "uartix.theme.alpha", name: "名称甲", version: "1.2.0", state: "已启用" },
    { id: "user.local.two", name: "乙本地包", version: "0.2.0", state: "已停用" },
    { id: "user.local.one", name: "甲本地包", version: "0.1.0", state: "已安装（停用）" },
  ];

  it("架上的那条不算多出来；其余全留，并按 id 稳定排序", () => {
    const got = offShelfOf(IDX, local);
    expect(got.map((x) => x.id)).toEqual(["user.local.one", "user.local.two"]);
    expect(JSON.stringify(offShelfOf(IDX, local))).toBe(JSON.stringify(got));
  });

  it("没索引时本机全部算多出来（不是一片空白骗人）", () => {
    expect(offShelfOf(null, local).length).toBe(3);
  });

  it("每条带齐名字 / id / 版本 / 状态四样（界面那句「等」就是缺了这些才写的）", () => {
    expect(offShelfOf(IDX, local)[0]).toEqual({ id: "user.local.one", name: "甲本地包", version: "0.1.0", state: "已安装（停用）" });
  });
});

/* ================= P99b-N6 · 那两行地址的六种说法（详设 G3 / G10） =================
 *
 * 为什么值得穷举：这两行是"填错了不崩、但会悄悄不生效"的那类配置，界面唯一的价值就是
 * **当场说清这一条会不会被用上**。六支里任何两支共用一句话，用户就分不清"没填"与"被拒"。
 */
describe("P99b-N6 · 索引地址那一行：六种输入六种说法", () => {
  const CASES: { input: string; why: string; ok: boolean }[] = [
    { input: "", why: "没填", ok: false },
    { input: "/market/index.json", why: "同源包内", ok: true },
    { input: "https://raw.githubusercontent.com/tanixs/market/index.json", why: "白名单内的远程", ok: true },
    { input: "https://mirror.evil.example/index.json", why: "白名单外的远程", ok: false },
    { input: "http://raw.githubusercontent.com/tanixs/market/index.json", why: "http 明文", ok: false },
    { input: "https://", why: "没有域", ok: false },
  ];
  const talks = CASES.map((c) => indexEndpointTalk(c.input, MARKET_ALLOW_HOSTS));

  it("每支各说各的（两两不同），且 ok 恰好两支为真", () => {
    expect(new Set(talks.map((t) => t.say)).size, "两支共用一句话＝没说清是哪一支").toBe(CASES.length);
    expect(talks.filter((t) => t.ok).map((t) => CASES[talks.indexOf(t)].why)).toEqual(["同源包内", "白名单内的远程"]);
  });

  it("ok 一支支对着真值表（变异：把「域不在名单」折进「合规」就在这里红）", () => {
    CASES.forEach((c, i) => expect(talks[i].ok, `${c.why}（${c.input}）`).toBe(c.ok));
  });

  it("白名单外那一支要说清：被拒、清单里有谁、没有兜底", () => {
    const off = talks[3];
    expect(off.tone, "域不在名单与合规远程共用一种语气").not.toBe(talks[2].tone);
    expect(off.say).toContain("不在放行清单");
    // 域名从 MARKET_ALLOW_HOSTS 取，不抄进文案——抄了就等着过期（详设 §1-5 / R4）
    for (const h of MARKET_ALLOW_HOSTS) expect(off.say, `放行清单里少了 ${h}`).toContain(h);
    expect(off.say).toContain("不会偷偷改用应用自带的那份");
  });

  it("「同源包内」与「没填」不是一回事：前者会去看填的那条，后者才回落", () => {
    expect(talks[0].say).toContain("应用自带");
    expect(talks[1].ok, "同源相对路径是被真的取用的那一条").toBe(true);
    expect(talks[1].tone).toBe("bundled");
  });
});

describe("P99b-N6 · 镜像前缀那一行", () => {
  const HOSTS = MARKET_ALLOW_HOSTS;

  it("可用时那句承诺要说清「只换来源，不换内容」", () => {
    const t = mirrorEndpointTalk("https://github.com/tanixs/mirror/", HOSTS);
    expect(t.ok).toBe(true);
    expect(t.say).toContain("只换下载来源");
    expect(t.say).toContain("sha256");
  });

  it("末尾少一个 / 会被补上，并且界面要说这一句", () => {
    expect(mirrorEndpointVerdict("https://github.com/tanixs/mirror", HOSTS)).toMatchObject({
      usable: true,
      prefix: "https://github.com/tanixs/mirror/",
      slashed: true,
    });
    expect(mirrorEndpointTalk("https://github.com/tanixs/mirror", HOSTS).say).toContain("末尾的 / 由我们补上");
    expect(mirrorEndpointTalk("https://github.com/tanixs/mirror/", HOSTS).say).not.toContain("由我们补上");
  });

  it("五种用不上各有各的原因，「域不在名单」与「格式不对」不许混成一种语气", () => {
    const bad = ["", "http://github.com/m/", "github.com/m/", "https://", "https://mirror.evil.example/m/"].map(
      (x) => mirrorEndpointTalk(x, HOSTS),
    );
    expect(bad.filter((b) => b.ok).length, "这五支都不该说会被用上").toBe(0);
    expect(new Set(bad.map((b) => b.say)).size, "五支共用一句话").toBe(5);
    expect(bad.map((b) => b.tone)).toEqual(["unset", "invalid", "invalid", "invalid", "blocked"]);
  });

  it("镜像那句承诺与装链回执成对存在（详设 G10：删任一处就红）", () => {
    const installSrc = readFileSync(new URL("./marketInstall.ts", import.meta.url), "utf8");
    expect(mirrorEndpointTalk("https://github.com/m/", HOSTS).say).toContain("sha256");
    expect(installSrc).toContain("装前已按货架声明比对");
  });
});

/* ============ P99c-R2：出处那句话（同一颗按钮，取的是两种东西） ============ */
describe("P99c-R2 · 条目出处", () => {
  const NPM_URL = "https://registry.npmjs.org/probe/-/probe-1.0.0.tgz";

  it("自建货架那条说的是直链；带 npm 那节的话到 registry 与包名版本", () => {
    expect(cardFacts(IDX, mkEntry(), ctx()).origin).toBe("自建货架直链");
    const e = mkEntry({ packageUrl: NPM_URL, npm: { name: "@me/probe", version: "1.0.0" } });
    const origin = cardFacts(mkIndex([e]), e, ctx()).origin;
    expect(origin).toContain("npm 官方源");
    expect(origin).toContain("@me/probe@1.0.0");
  });

  it("镜像那句回显说清了 npm 条目不走镜像（否则用户以为换了源就能装它）", () => {
    const talk = mirrorEndpointTalk("https://github.com/", MARKET_ALLOW_HOSTS);
    expect(talk.ok).toBe(true);
    expect(talk.say).toContain("npm");
  });
});
