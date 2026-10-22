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
