/**
 * R19：市场状态判据。
 *
 * 这一层的输出是「安装」还是「更新 0.2.0 → 0.2.3」，差别在于用户点下去有没有用。
 * 版本比较的边界（缺位、预发布、非数字、段数不同）如果错了，表现是"明明有新版却不给按钮"
 * 或者"点更新结果原地重装同版本"——两种都得靠测试钉住，不能靠手点。
 */
import { describe, expect, it } from "vitest";
import type { GhRepo } from "./ghSearch";
import { compareVersions, filterRepos, installedNote, marketStateOf, sortRepos, type MarketInstalled } from "./marketStatus";

const repo = (full: string, stars = 0, updated = "2026-10-01T00:00:00Z"): GhRepo =>
  ({ full, owner: full.split("/")[0], name: full.split("/")[1], stars, updated } as GhRepo);

const on: MarketInstalled = { version: "0.2.0", enabled: true, trusted: true };

describe("compareVersions", () => {
  it("按段比数字，不是按字符串比", () => {
    // 字符串比会得出 "1.10.0" < "1.2.0"，那正好是要防的那类错
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.3", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.3")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("短的按 0 补齐，v 前缀认", () => {
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("同数字时预发布算更旧（1.0.0 > 1.0.0-beta）", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("认不出的形状返回 null，不猜", () => {
    for (const bad of ["", "1.2.3.4", "a.b.c", "1.x.3", "nightly", "1..2", "1.2."]) {
      expect(compareVersions(bad, "1.0.0")).toBeNull();
    }
  });

  it("带连字符的预发布是合法形状，不算「认不出」", () => {
    expect(compareVersions("1.2.3-a-b-c-d-e", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("marketStateOf", () => {
  it("没装过就是没装过", () => {
    expect(marketStateOf(undefined, "9.9.9")).toBe("absent");
    expect(marketStateOf(undefined, "")).toBe("absent");
  });

  it("读不到远端版本时不报「可更新」", () => {
    // 这条是整个判据的取向：猜错的代价是用户点下去什么也没发生
    expect(marketStateOf(on, "")).toBe("installed");
    expect(marketStateOf(on, undefined)).toBe("installed");
    expect(marketStateOf(on, "0.2")).toBe("installed"); // 认不出的形状也不催更新
  });

  it("远端更高才给更新，本机更新时不催降版本", () => {
    expect(marketStateOf(on, "0.2.3")).toBe("updatable");
    expect(marketStateOf(on, "0.2.0")).toBe("installed");
    expect(marketStateOf(on, "0.1.9")).toBe("behind");
  });
});

describe("filterRepos", () => {
  const list = [repo("a.one/p1"), repo("a.two/p2"), repo("a.three/p3")];
  const state: Record<string, ReturnType<typeof marketStateOf>> = {
    "a.one/p1": "absent",
    "a.two/p2": "updatable",
    "a.three/p3": "installed",
  };
  const stateOf = (r: GhRepo) => state[r.full];

  it("全部不改集合，也不改顺序", () => {
    expect(filterRepos(list, "all", stateOf).map((r) => r.full)).toEqual(["a.one/p1", "a.two/p2", "a.three/p3"]);
  });

  it("「已安装」把可更新与本机更新都算进去", () => {
    // 用户在这一档找的是"我装过的东西"，版本差是另一档的事
    expect(filterRepos(list, "installed", stateOf).map((r) => r.full)).toEqual(["a.two/p2", "a.three/p3"]);
  });

  it("「可更新」只留真的能升的那枚", () => {
    expect(filterRepos(list, "updatable", stateOf).map((r) => r.full)).toEqual(["a.two/p2"]);
  });

  it("「没装过」不把读不到远端版本的已装项漏进来", () => {
    expect(filterRepos(list, "absent", stateOf).map((r) => r.full)).toEqual(["a.one/p1"]);
  });
});

describe("sortRepos", () => {
  it("「最近更新」保持引擎给的原序，不自己重排", () => {
    // GitHub 的返回顺序本身就是相关性/更新度信号，重排会把它打散
    const list = [repo("z/a", 1, "2026-01-01T00:00:00Z"), repo("a/b", 9, "2026-09-09T00:00:00Z")];
    expect(sortRepos(list, "updated").map((r) => r.full)).toEqual(["z/a", "a/b"]);
  });

  it("Star 多的在前，同 Star 按全名收口（否则顺序会随引擎抖动）", () => {
    const list = [repo("a/b", 5), repo("c/d", 50), repo("e/f", 5)];
    expect(sortRepos(list, "stars").map((r) => r.full)).toEqual(["c/d", "a/b", "e/f"]);
  });

  it("不改动传进来的数组", () => {
    const list = [repo("b", 1), repo("a", 2)];
    const out = sortRepos(list, "name");
    expect(out.map((r) => r.full)).toEqual(["a", "b"]);
    expect(list.map((r) => r.full)).toEqual(["b", "a"]);
  });
});

describe("installedNote", () => {
  it("没批准时不说「已启用」", () => {
    // 引擎那边面板根本不会出现，说"已启用"是假话
    expect(installedNote({ version: "1.0.0", enabled: true, trusted: false })).toBe("unapproved");
    expect(installedNote({ version: "1.0.0", enabled: false, trusted: true })).toBe("disabled");
    expect(installedNote({ version: "1.0.0", enabled: true, trusted: true })).toBe("ready");
  });
});
