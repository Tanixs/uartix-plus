/**
 * P174-A8：账本归一（index / trust / settings）。
 *
 * 这三条判据守的是同一件事：**磁盘上的 JSON 可能是坏的**（用户手改、被别的程序截断、
 * 上一个版本写的形状）。坏数据的处理方式只有一种是对的——退回默认 + 说出原因，
 * 而不是"尽力保留半截"。半截数据的症状是"某个扩展在列表里显示 undefined"，
 * 没人能从那个现象反推到"账本坏了"。
 */

import { describe, expect, it } from "vitest";
import { emptyExtSettings, normalizeExtSettings, normalizeIndex, normalizeTrust } from "./store";

describe("normalizeExtSettings（工作区根）", () => {
  it("正常值原样保留", () => {
    const r = normalizeExtSettings({ workspaceRoot: "D:/YOLO-Workspace" });
    expect(r.settings.workspaceRoot).toBe("D:/YOLO-Workspace");
    expect(r.issues).toEqual([]);
  });

  it("没有这个键 ⇒ 空串（不是 undefined：下游到处在判 === \"\"）", () => {
    expect(normalizeExtSettings({}).settings.workspaceRoot).toBe("");
    expect(normalizeExtSettings(null).settings).toEqual(emptyExtSettings());
  });

  it("类型不对 ⇒ 退回默认并说明（保留一个数字当路径只会让后面每一步都错）", () => {
    const r = normalizeExtSettings({ workspaceRoot: 42 });
    expect(r.settings.workspaceRoot).toBe("");
    expect(r.issues.join()).toContain("不是字符串");
  });

  it("activeTheme：字符串原样保留；类型不对退回空（空串 = 用内置主题）", () => {
    expect(normalizeExtSettings({ activeTheme: "plg:a.b:seaglass" }).settings.activeTheme).toBe("plg:a.b:seaglass");
    expect(normalizeExtSettings({ activeTheme: 42 }).settings.activeTheme).toBe("");
    expect(normalizeExtSettings({}).settings.activeTheme).toBe("");
  });

  it("整份不是对象 ⇒ 默认 + 一句", () => {
    const r = normalizeExtSettings("oops");
    expect(r.settings).toEqual(emptyExtSettings());
    expect(r.issues.length).toBe(1);
    // 但"从来没写过"（null）不该报错：那是第一次启动的正常状态
    expect(normalizeExtSettings(null).issues).toEqual([]);
  });
});

describe("normalizeIndex（不能被坏条目带坏整本）", () => {
  it("形状不对的条目跳过并点名，好条目保留", () => {
    const r = normalizeIndex({
      items: {
        "a.b": { dir: "a.b", version: "1.0.0", digest: "x", installedAt: 5, source: "local" },
        "c.d": { dir: 42 },
      },
    });
    expect(Object.keys(r.index.items)).toEqual(["a.b"]);
    expect(r.issues.join()).toContain("c.d");
  });

  it("未知 source 退回 import（枚举外的东西不能原样进内存）", () => {
    const r = normalizeIndex({ items: { "a.b": { dir: "a.b", version: "1", source: "evil" } } });
    expect(r.index.items["a.b"].source).toBe("import");
  });

  it("整份不是对象 ⇒ 空索引 + 一句", () => {
    const r = normalizeIndex([1, 2, 3]);
    expect(r.index.items).toEqual({});
    expect(r.issues.length).toBe(1);
  });
});

describe("normalizeTrust（缺摘要的条目一律无效）", () => {
  it("缺 digest 的条目被丢掉（它无法参与判定，留着会让人以为批过了）", () => {
    const r = normalizeTrust({
      items: {
        "a.b": { id: "a.b", version: "1", digest: "d", grantedAt: 1, grantedSummary: ["写 $WS"] },
        "c.d": { id: "c.d", version: "1", grantedSummary: [] },
      },
    });
    expect(Object.keys(r.trust.items)).toEqual(["a.b"]);
    expect(r.trust.items["a.b"].grantedSummary).toEqual(["写 $WS"]);
    expect(r.issues.join()).toContain("c.d");
  });

  it("grantedSummary 里的非字符串被剔掉（它要直接渲染到界面上）", () => {
    const r = normalizeTrust({ items: { "a.b": { digest: "d", grantedSummary: ["ok", 3, null] } } });
    expect(r.trust.items["a.b"].grantedSummary).toEqual(["ok"]);
  });
});

/**
 * P174-A11：外部目录表。
 *
 * 这里最要紧的一条是"**丢的时候要说出来，并指名道姓**"：用户刚绑的目录如果因为键名不合规
 * 被静默丢掉，表现就是"我明明绑了、它就是没有"——那种故障没有任何线索可查。
 */
describe("normalizeExtSettings（外部目录）", () => {
  it("合法键原样保留；顺序无关（表不是数组）", () => {
    const r = normalizeExtSettings({ roots: { deploy: "D:/OneDrive/maixcam2_deploy", "assets-2": "D:/a" } });
    expect(r.settings.roots).toEqual({ deploy: "D:/OneDrive/maixcam2_deploy", "assets-2": "D:/a" });
    expect(r.issues).toEqual([]);
  });

  it("键名不合规 ⇒ 丢掉并点名（清单里写不出来的键，绑上也永远匹配不上）", () => {
    const r = normalizeExtSettings({ roots: { Deploy: "D:/a", "a.b": "D:/b", deploy: "D:/ok" } });
    expect(r.settings.roots).toEqual({ deploy: "D:/ok" });
    expect(r.issues.join("")).toContain("Deploy");
    expect(r.issues.join("")).toContain("a.b");
  });

  it("空值 / 非字符串 ⇒ 丢掉并说一句（空路径当已绑定会让启动前判断误放行）", () => {
    const r = normalizeExtSettings({ roots: { deploy: "   ", assets: 42, ok: "D:/ok" } });
    expect(r.settings.roots).toEqual({ ok: "D:/ok" });
    expect(r.issues.length).toBe(2);
  });

  it("表本身不是对象 ⇒ 空表 + 一句；没有这个键 ⇒ 空表（不是 undefined）", () => {
    expect(normalizeExtSettings({ roots: [] }).settings.roots).toEqual({});
    expect(normalizeExtSettings({ roots: [] }).issues.length).toBe(1);
    expect(normalizeExtSettings({}).settings.roots).toEqual({});
    // 空表与"没这个键"必须给出同一种形状：下游到处在 `for (const k of Object.keys(...))`
    expect(emptyExtSettings().roots).toEqual({});
  });
});

/**
 * A12：`enabled` 的迁移口径。
 *
 * 缺字段按"启用"算——这个字段出现之前就装着的插件本来就在用，静默藏掉一批面板，
 * 用户只会得到"我插件呢"这一种反馈，而没有任何线索。
 */
describe("normalizeIndex（enabled 迁移）", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    items: { "a.b": { dir: "a.b", version: "1.0.0", digest: "d", installedAt: 1, source: "local", ...extra } },
  });

  it("没有这个字段 ⇒ 按启用算（老账本迁移）；显式 false ⇒ 停用", () => {
    expect(normalizeIndex(item()).index.items["a.b"].enabled).toBe(true);
    expect(normalizeIndex(item({ enabled: false })).index.items["a.b"].enabled).toBe(false);
    expect(normalizeIndex(item({ enabled: true })).index.items["a.b"].enabled).toBe(true);
  });

  it("字段是别的类型（字符串/数字）⇒ 按启用算，不当成停用", () => {
    // 既不是 true 也不是 false 的值只可能来自手改或坏账本：当成"没说过"比当成"停用"安全
    expect(normalizeIndex(item({ enabled: "false" })).index.items["a.b"].enabled).toBe(true);
    expect(normalizeIndex(item({ enabled: 0 })).index.items["a.b"].enabled).toBe(true);
  });
});
