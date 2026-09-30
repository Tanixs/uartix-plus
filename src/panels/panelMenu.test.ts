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

  it("面板总数与清单一致（21 个内置面板）", () => {
    // P121-C 加了「TX组帧台」：20 → 21。这条断言存在的意义就是"加面板必须留痕"，
    // 改数字的人必须顺带确认分组、标题、帮助覆盖都跟上了
    expect(PANEL_GROUPS.flatMap((g) => g.ids as readonly string[])).toHaveLength(21);
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

/* ================= P121-C：注册完整性 =================
 * 加一枚面板要动 8 处（详设 §12.3）。分组、标题、可添加清单都有守卫，
 * 唯独 **dockview 的组件注册表**没有：`panelComponents` 是个普通对象，
 * 少一个键不会 tsc 红，症状是"清单里能选到它，选完是一块空白"。
 * 这里按源码扫一遍补上——与 `prompts.test.ts` 的"清单 == 注册表"同一族钉。
 */
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

describe("P121-C · 每枚可添加面板都真的注册了组件", () => {
  const src = readFileSync(fileURLToPath(new URL("./panels.tsx", import.meta.url)), "utf8");
  const registry = src.slice(src.indexOf("export const panelComponents = {"));

  it("注册表片段找得到（找不到就说明 panels.tsx 结构变了，下面几条没意义）", () => {
    expect(registry.length).toBeGreaterThan(200);
  });

  for (const id of PANEL_GROUPS.flatMap((g) => g.ids as readonly string[])) {
    it(`${id} 在 panelComponents 里有组件`, () => {
      expect(registry, `「+ 面板」能选到 ${id}，但注册表里没有它 ⇒ 打开是空白`).toContain(`${id}: (`);
    });
  }

  it("TX组帧台面板落在「解析与画布」分组（与帧画布同族：一个描述收到的字节，一个描述要发的）", () => {
    expect(panelGroupOf("sendbuild")?.key).toBe("parse");
    const ids = (PANEL_GROUPS.find((g) => g.key === "parse")!.ids ?? []) as readonly string[];
    expect(ids.indexOf("sendbuild")).toBeGreaterThan(ids.indexOf("framecanvas"));
  });
});
