import { describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const { searchSettings } = await import("./settingsSearch");
type SettingsTabLike = import("./settingsSearch").SettingsTabLike;

const tabs: SettingsTabLike[] = [
  { key: "general", label: "通用", group: "基础" },
  { key: "appearance", label: "外观", group: "基础", sub: "配色与覆盖层" },
  { key: "workspace", label: "工作区", group: "基础" },
  { key: "ai", label: "AI 服务", group: "AI 与 Agent" },
  { key: "ext", label: "插件管理", group: "扩展" },
  { key: "mcp", label: "集成", group: "扩展" },
  { key: "about", label: "About", group: "Misc" },
];

describe("P163 · 设置搜索", () => {
  it("页面名/分组/说明可命中，前缀优先", () => {
    expect(searchSettings("外观", tabs)[0]).toMatchObject({ kind: "tab", tab: "appearance" });
    expect(searchSettings("插件", tabs)[0]).toMatchObject({ kind: "tab", tab: "ext" });
    expect(searchSettings("appear", tabs)[0]).toMatchObject({ kind: "tab", tab: "appearance" });
    expect(searchSettings("扩展", tabs).length).toBeGreaterThanOrEqual(2);
  });

  it("注册设置项命中并映射到正确页面", () => {
    const theme = searchSettings("主题", tabs);
    expect(theme.some((h) => h.kind === "setting" && h.tab === "appearance" && h.label === "主题")).toBe(true);
    const mcp = searchSettings("MCP", tabs);
    expect(mcp.some((h) => h.kind === "setting" && h.tab === "mcp")).toBe(true);
    expect(mcp.filter((h) => h.kind === "setting").every((h) => h.tab === "mcp")).toBe(true);
  });

  it("不渲染在设置页的 market 组不误导（搜镜像为空）", () => {
    expect(searchSettings("镜像", tabs)).toEqual([]);
  });

  it("空查询、无匹配、limit 与大小写", () => {
    expect(searchSettings("   ", tabs)).toEqual([]);
    expect(searchSettings("zzz-not-found", tabs)).toEqual([]);
    expect(searchSettings("MCP", tabs, 2)).toHaveLength(2);
    expect(searchSettings("mcp", tabs).length).toBe(searchSettings("MCP", tabs).length);
  });
});

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

describe("P163 · 设置导航接线", () => {
  it("导航有搜索框、结果列表、Esc/Enter 与清空", () => {
    const src = read("features/settings/SettingsModal.tsx");
    expect(src).toContain("searchSettings");
    expect(src).toContain('className="set-nav-search"');
    expect(src).toContain('className="set-nav-results"');
    expect(src).toContain("set-nav-hit");
    expect(src).toContain('"Escape"');
    expect(src).toContain('"Enter"');
    expect(src).toContain('className="set-nav-search-clear"');
  });

  it("结果/空态/清空有样式", () => {
    const css = read("styles/theme.css");
    expect(css).toContain(".set-nav-search {");
    expect(css).toContain(".set-nav-hit-label {");
    expect(css).toContain(".set-nav-empty {");
  });
});
