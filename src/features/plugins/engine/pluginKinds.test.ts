/**
 * P174-R15：按产物分类的判据。
 *
 * 这一层的错法都很安静：顺序漂了列表徽标与筛选器就各说一套；"属于"写成"等于"
 * 就会让同时贡献面板与命令的插件在「命令」筛选里消失；把「预设与模板」拆成两枚 chip
 * 之后只实现一半，用户点「预设与模板」会少看见一半。逐条钉。
 */

import { describe, expect, it } from "vitest";
import { FILTERS, filterLabel, isComposite, kindSummary, kindsOrFallback, matchesFilter, pluginKinds, type PluginKind } from "./pluginKinds";
import type { PluginManifest } from "./manifest";

const m = (c: Partial<PluginManifest["contributes"]>): Pick<PluginManifest, "contributes"> => ({ contributes: c });

describe("pluginKinds（它给你什么）", () => {
  it("按固定顺序列出全部产物（面板→主题→小部件→预设→模板→命令）", () => {
    const kinds = pluginKinds(
      m({
        commands: [{ id: "a.b.run", title: "Run" }],
        widgets: [{ id: "w", title: "W", entry: "w.html" }],
        panels: [{ id: "p", title: "P", entry: "p.html" }],
        themes: [{ id: "t", title: "T", entry: "t.css" }],
        presets: [{ id: "s", title: "S", entry: "s.json" }],
        tasks: [{ id: "k", title: "K", entry: "k.json" }],
      }),
    );
    expect(kinds).toEqual(["panel", "theme", "widget", "preset", "task", "command"]);
  });

  it("什么都没有 ⇒ 空数组（界面上由 kindsOrFallback 说「无产物」）", () => {
    expect(pluginKinds(m({}))).toEqual([]);
    expect(kindsOrFallback([])).toEqual([{ zh: "无产物", en: "No contributions" }]);
  });

  it("≥2 类才叫复合；单一产物插件不是复合", () => {
    const single = pluginKinds(m({ themes: [{ id: "t", title: "T", entry: "t.css" }] }));
    expect(isComposite(single)).toBe(false);
    const both = pluginKinds(m({ panels: [{ id: "p", title: "P", entry: "p.html" }], commands: [{ id: "c", title: "C" }] }));
    expect(isComposite(both)).toBe(true);
  });

  it("徽标最多三枚（筛选器里能看全，徽标只负责扫一眼）", () => {
    const six: PluginKind[] = ["panel", "theme", "widget", "preset", "task", "command"];
    expect(kindSummary(six)).toHaveLength(3);
    expect(kindSummary(["panel"])).toEqual(["panel"]);
  });
});

describe("matchesFilter（属于，不是等于）", () => {
  const yolo = pluginKinds(m({ panels: [{ id: "p", title: "P", entry: "p.html" }], commands: [{ id: "c", title: "C" }] }));
  const theme = pluginKinds(m({ themes: [{ id: "t", title: "T", entry: "t.css" }] }));
  const onlyTask = pluginKinds(m({ tasks: [{ id: "k", title: "K", entry: "k.json" }] }));

  it("全部 = 谁都过；面板筛选会带上「面板+命令」的复合插件", () => {
    expect(matchesFilter(theme, "all")).toBe(true);
    expect(matchesFilter(yolo, "panel")).toBe(true);
    expect(matchesFilter(yolo, "command")).toBe(true);
    expect(matchesFilter(theme, "panel")).toBe(false);
  });

  it("「预设与模板」这一枚 chip 同时收 preset 与 task", () => {
    expect(matchesFilter(onlyTask, "preset")).toBe(true);
    expect(matchesFilter(onlyTask, "task")).toBe(true);
    expect(matchesFilter(onlyTask, "panel")).toBe(false);
  });

  it("复合 = 至少两类（单一主题不算）", () => {
    expect(matchesFilter(yolo, "composite")).toBe(true);
    expect(matchesFilter(theme, "composite")).toBe(false);
  });

  it("每一种筛选值都有自己的中英标签，且两两不同", () => {
    const zh = FILTERS.map((f) => filterLabel(f).zh);
    const en = FILTERS.map((f) => filterLabel(f).en);
    expect(new Set(zh).size).toBe(FILTERS.length);
    expect(new Set(en).size).toBe(FILTERS.length);
    for (const f of FILTERS) expect(filterLabel(f).zh.trim() && filterLabel(f).en.trim()).toBeTruthy();
  });
});
