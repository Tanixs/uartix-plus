/**
 * B6 单测：「+ 面板」分组元数据 + 最近使用。
 *
 * 完整性分两层：
 * - **编译期**：panelMenu.ts 的 `_AllPanelsGrouped` 用类型约束保证「每个 PanelId 都落在某个分组里」，
 *   漏一个就 tsc 报错（比运行期断言更早、更难绕过）。
 * - **运行期**（本文件）：分组非空、键唯一、id 不重复、最近使用的顺序/去重/上限/脏数据容错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_GROUPS,
  getRecentPanels,
  panelGroupLabel,
  panelGroupOf,
  pushRecentPanel,
} from "./panelMenu";

describe("PANEL_GROUPS", () => {
  it("每组非空且带中文/英文名", () => {
    expect(PANEL_GROUPS.length).toBeGreaterThan(0);
    for (const g of PANEL_GROUPS) {
      expect(g.ids.length).toBeGreaterThan(0);
      expect(g.zh.trim()).not.toBe("");
      expect(g.en.trim()).not.toBe("");
    }
  });

  it("分组键唯一", () => {
    const keys = PANEL_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("面板 id 不跨组重复", () => {
    const flat = PANEL_GROUPS.flatMap((g) => g.ids as readonly string[]);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("panelGroupOf 能反查所属分组", () => {
    expect(panelGroupOf("plot3d")?.key).toBe("visual");
    expect(panelGroupOf("orchestrator")?.key).toBe("auto");
    expect(panelGroupOf("nope")).toBeUndefined();
  });

  it("面板总数与清单一致（19 个内置面板）", () => {
    expect(PANEL_GROUPS.flatMap((g) => g.ids as readonly string[])).toHaveLength(19);
  });

  it("分组名随语言切换", () => {
    const g = PANEL_GROUPS[0];
    const zh = panelGroupLabel(g);
    expect([g.zh, g.en]).toContain(zh);
  });
});

describe("最近使用面板", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Node 环境无 localStorage：读取返回空数组而不抛错", () => {
    expect(getRecentPanels()).toEqual([]);
  });

  it("写入在无 localStorage 时静默降级，仍返回正确顺序", () => {
    expect(pushRecentPanel("plot2d")).toEqual(["plot2d"]);
    expect(() => getRecentPanels()).not.toThrow();
  });

  describe("有 localStorage 时", () => {
    const mem = new Map<string, string>();
    const stub = () =>
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
      });

    it("最近在前、去重、上限 3", () => {
      mem.clear();
      stub();
      pushRecentPanel("plot2d");
      pushRecentPanel("console");
      pushRecentPanel("table");
      expect(getRecentPanels()).toEqual(["table", "console", "plot2d"]);
      // 重复使用只前移，不新增
      pushRecentPanel("plot2d");
      expect(getRecentPanels()).toEqual(["plot2d", "table", "console"]);
      // 第四项挤掉最旧的
      pushRecentPanel("sentinel");
      expect(getRecentPanels()).toEqual(["sentinel", "plot2d", "table"]);
    });

    it("脏数据（非法 JSON / 非数组 / 未知面板）被过滤且不抛错", () => {
      mem.clear();
      stub();
      mem.set("vs.panels.recent", "{oops");
      expect(getRecentPanels()).toEqual([]);
      mem.set("vs.panels.recent", JSON.stringify({ a: 1 }));
      expect(getRecentPanels()).toEqual([]);
      mem.set("vs.panels.recent", JSON.stringify(["plot2d", "nope-panel", 7]));
      expect(getRecentPanels()).toEqual(["plot2d"]);
    });
  });
});
