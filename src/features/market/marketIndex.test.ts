/**
 * P99b-N1：索引契约的测试。
 *
 * 这批的价值全在"错的东西必须被拒且说得出为什么"，所以每条正向断言都配一条反向：
 * 白名单要有后缀边界的反例、不兼容要有"不知道≠不兼容"的反例、单条坏不能拖垮整表。
 */
import { describe, expect, it } from "vitest";
import {
  MARKET_PKG_MAX_BYTES, MARKET_SCHEMA_VERSION, categoryLabel, compat, compareInstall, compareVersions,
  hostAllowed, parseEntry, parseMarketIndex, urlHost, type MarketIndex,
} from "./marketIndex";

const HOSTS = ["raw.githubusercontent.com", "github.com", "localhost"];

function goodEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tanixs.gauge",
    name: "遥测仪表",
    author: "Tanixs",
    category: "widget",
    description: { zh: "把三个通道做成大字仪表。", en: "Three channels as big digits." },
    version: "1.2.0",
    minAppVersion: "0.4.1",
    updated: "2026-09-20",
    packageUrl: "https://raw.githubusercontent.com/Tanixs/uartix-market/main/pkg/gauge.uartix.json",
    sha256: "a".repeat(64),
    bytes: 18342,
    capabilities: ["ui.widget"],
    screenshots: ["https://raw.githubusercontent.com/Tanixs/uartix-market/main/img/gauge-1.png"],
    homepage: "https://github.com/Tanixs/uartix-market",
    ...over,
  };
}

describe("域白名单", () => {
  it("精确与子域放行；后缀像但不是子域的必须拒", () => {
    expect(hostAllowed("raw.githubusercontent.com", HOSTS)).toBe(true);
    expect(hostAllowed("codeload.github.com", HOSTS)).toBe(true);
    expect(hostAllowed("RAW.GITHUBUSERCONTENT.COM", HOSTS)).toBe(true);
    // 这一条是整个白名单机制的存在理由：少了 `.` 边界就形同虚设
    expect(hostAllowed("evilgithub.com", HOSTS)).toBe(false);
    expect(hostAllowed("github.com.evil.io", HOSTS)).toBe(false);
    expect(hostAllowed("", HOSTS)).toBe(false);
    expect(hostAllowed("localhost:1420".split(":")[0], HOSTS)).toBe(true);
  });

  it("urlHost 解析不了回空串（调用方按不知道处理，不猜成安全）", () => {
    expect(urlHost("https://raw.githubusercontent.com/a/b")).toBe("raw.githubusercontent.com");
    expect(urlHost("javascript:alert(1)")).toBe("");
    expect(urlHost("")).toBe("");
  });
});

describe("版本与兼容性：不兼容要有证据", () => {
  it("compareVersions 逐段比，非 x.y.z 回 null", () => {
    expect(compareVersions("0.4.2", "0.4.1")).toBe(1);
    expect(compareVersions("0.4.1", "0.4.1")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.4", "0.4.0")).toBeNull();
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBeNull();
  });

  it("只有确认装不上才 no；缺字段/格式怪一律 unknown", () => {
    expect(compat({ minAppVersion: "9.9.9" }, "0.4.1")).toBe("no");
    expect(compat({ minAppVersion: "0.4.1" }, "0.4.1")).toBe("yes");
    expect(compat({ minAppVersion: "0.3.0" }, "0.4.1")).toBe("yes");
    expect(compat({ minAppVersion: "" }, "0.4.1")).toBe("unknown");
    expect(compat({ minAppVersion: "v0.4" }, "0.4.1")).toBe("unknown");
  });
});

describe("单条解析", () => {
  it("一条全合法的条目解析成功，且未提供的可选字段不留空键", () => {
    const r = parseEntry(goodEntry(), HOSTS);
    expect(r.error).toBeUndefined();
    const e = r.entry!;
    expect(e.id).toBe("tanixs.gauge");
    expect(e.sha256).toBe("a".repeat(64));
    expect(e.screenshots).toHaveLength(1);
    expect("discussion" in e).toBe(false);
    expect("verified" in e).toBe(false);
    expect("changelogUrl" in e).toBe(false);
  });

  it("http 明文与坏 id 都拒，且理由可显示", () => {
    expect(parseEntry(goodEntry({ packageUrl: "http://raw.githubusercontent.com/a/b" }), HOSTS).error).toContain("https");
    expect(parseEntry(goodEntry({ id: "Tanixs.Gauge" }), HOSTS).error).toContain("id 非法");
    expect(parseEntry(goodEntry({ id: "nodot" }), HOSTS).error).toContain("id 非法");
  });

  it("域不在白名单要单独点名（这是最可能被误放的一项）", () => {
    const e = parseEntry(goodEntry({ packageUrl: "https://evil.example/pkg.json" }), HOSTS)!;
    expect(e.error).toContain("不在白名单");
    expect(e.error).toContain("evil.example");
  });

  it("sha256 与 bytes 都要实：非十六进制、非整数、超上限各自拒", () => {
    expect(parseEntry(goodEntry({ sha256: "deadbeef" }), HOSTS).error).toContain("sha256");
    expect(parseEntry(goodEntry({ sha256: "A".repeat(64) }), HOSTS).error).toBeUndefined(); // 大写归一后合法
    expect(parseEntry(goodEntry({ bytes: 1.5 }), HOSTS).error).toContain("bytes");
    expect(parseEntry(goodEntry({ bytes: MARKET_PKG_MAX_BYTES + 1 }), HOSTS).error).toContain("上限");
  });

  it("capabilities 必须是数组且不能出现应用不认识的能力", () => {
    expect(parseEntry(goodEntry({ capabilities: "ui.widget" }), HOSTS).error).toContain("数组");
    expect(parseEntry(goodEntry({ capabilities: ["ui.widget", "read.the.user.mailbox"] }), HOSTS).error).toContain("read.the.user.mailbox");
  });

  it("截图清单整体合法才算合法：非数组、超上限、坏地址各自都拒得出口", () => {
    expect(parseEntry(goodEntry({ screenshots: "x" }), HOSTS).error).toContain("截图");
    // 静默截到 8 张＝作者少给了 4 张没人知道；宁可拒了让人改（索引是我们 CI 生成的，出现这个就是生成器坏了）
    const many = parseEntry(goodEntry({ screenshots: Array.from({ length: 12 }, (_, i) => `https://raw.githubusercontent.com/a/b${i}.png`) }), HOSTS);
    expect(many.error).toContain("超过");
    expect(many.entry).toBeUndefined();
    const mixed = parseEntry(goodEntry({ screenshots: ["https://raw.githubusercontent.com/a/ok.png", "http://raw.githubusercontent.com/a/bad.png"] }), HOSTS);
    expect(mixed.error).toContain("https");
    expect(mixed.entry).toBeUndefined();
  });

  it("同源相对路径只给包与截图；// 开头是协议相对地址，按外链拒", () => {
    expect(parseEntry(goodEntry({ packageUrl: "/market/pkg/a.uartix.json", screenshots: ["/market/img/a.png"] }), HOSTS).error).toBeUndefined();
    expect(parseEntry(goodEntry({ packageUrl: "//cdn.example/a.json" }), HOSTS).error).toContain("https");
    expect(parseEntry(goodEntry({ screenshots: ["//cdn.example/a.png"] }), HOSTS).error).toContain("https");
    // 点了就出网的字段不给相对路径
    expect(parseEntry(goodEntry({ homepage: "/docs/a" }), HOSTS).error).toContain("homepage");
  });

  it("外链字段也要过白名单（描述里给个钓鱼链接不算合规）", () => {
    expect(parseEntry(goodEntry({ homepage: "http://github.com/x" }), HOSTS).error).toContain("homepage");
    expect(parseEntry(goodEntry({ discussion: "https://evil.example/d" }), HOSTS).error).toContain("discussion");
  });
});

describe("整份索引", () => {
  const envelope = (entries: unknown[], over: Record<string, unknown> = {}) => ({
    schemaVersion: MARKET_SCHEMA_VERSION,
    name: "Uartix+ 社区插件库",
    generatedAt: "2026-09-22T00:00:00Z",
    source: "https://github.com/Tanixs/uartix-market",
    categories: { widget: "小部件", theme: "外观与主题" },
    entries,
    ...over,
  });

  /** 取解析成功的索引；失败就直接把 errors 抛成断言失败（免得下面全在 undefined 上假绿） */
  function okIndex(raw: unknown): MarketIndex {
    const r = parseMarketIndex(raw, HOSTS);
    if (!r.ok) throw new Error(`索引本该解析成功：${r.errors.join(" / ")}`);
    return r.index;
  }

  it("好索引全通过；未登记分类照实显示标签", () => {
    const idx = okIndex(envelope([goodEntry(), goodEntry({ id: "tanixs.alt", name: "另一支", category: "theme" })]));
    expect(idx.entries.map((e) => e.id)).toEqual(["tanixs.gauge", "tanixs.alt"]);
    expect(idx.dropped).toEqual([]);
    expect(categoryLabel({ categories: { widget: "小部件" } }, "widget")).toBe("小部件");
    expect(categoryLabel({ categories: { widget: "小部件" } }, "mystery")).toBe("mystery");
  });

  it("一条坏不拖垮整表：坏的被丢且带原因，好的照常上架", () => {
    const idx = okIndex(envelope([goodEntry(), goodEntry({ id: "tanixs.broken", bytes: 0 })]));
    expect(idx.entries).toHaveLength(1);
    expect(idx.dropped).toHaveLength(1);
    expect(idx.dropped[0].id).toBe("tanixs.broken");
    expect(idx.dropped[0].reason).toContain("bytes");
  });

  it("同 id 重复只留第一条，后一条进 dropped", () => {
    const idx = okIndex(envelope([goodEntry(), goodEntry()]));
    expect(idx.entries).toHaveLength(1);
    expect(idx.dropped[0].reason).toContain("重复");
  });

  /** 断言"整份被拒"并回错误文本；解析成功就是断言失败（免得测了个空气） */
  function errOf(raw: unknown): string {
    const r = parseMarketIndex(raw, HOSTS);
    if (r.ok) throw new Error("这份索引本该被整份拒，却解析成功了");
    return r.errors.join(" / ");
  }

  it("信封坏了就整份拒（残缺清单会被当事实）", () => {
    expect(errOf(null)).toContain("对象");
    expect(errOf([])).toContain("对象");
    expect(errOf(envelope([], { categories: "widget" }))).toContain("categories");
    expect(errOf(envelope([], { categories: { widget: "" } }))).toContain("标签");
    expect(errOf({ categories: { a: "A" }, entries: [] })).toContain("schemaVersion");
  });

  it("版本比应用新与比应用旧，话术不同且都不猜内容", () => {
    expect(errOf(envelope([], { schemaVersion: MARKET_SCHEMA_VERSION + 1 }))).toContain("升级");
    expect(errOf(envelope([], { schemaVersion: 0 }))).toContain("过旧");
    // 正向对照：空货架不是坏货架——"没有内容"与"读不懂"必须分得开
    expect(parseMarketIndex(envelope([]), HOSTS).ok).toBe(true);
  });
});

describe("compareInstall：与本机库的对照只有一份映射", () => {
  const e = { id: "tanixs.gauge", version: "1.2.0" };

  it("未装 / 同版 / 有更新 / 本机比货架新，四种分得清", () => {
    expect(compareInstall(e, undefined)).toBe("absent");
    expect(compareInstall(e, "1.2.0")).toBe("same");
    expect(compareInstall(e, "1.1.0")).toBe("update");
    expect(compareInstall(e, "1.3.0")).toBe("newer-than-shelf");
    expect(compareInstall(e, "0.9.9")).toBe("update");
  });

  it("徽章与装链共用它（同一输入不可能一个说 same 一个说 install）", () => {
    // 空串本机版本＝没装：走 absent，不当"同版本"处理
    expect(compareInstall(e, "")).toBe("absent");
  });
});
