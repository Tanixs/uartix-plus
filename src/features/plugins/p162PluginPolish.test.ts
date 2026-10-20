import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

const DIALOG = "features/plugins/PluginLibraryDialog.tsx";
const CSS = "styles/theme.css";

describe("P162 · 插件管理视觉", () => {
  it("嵌入设置页的工具栏与页面同底色，不再是整条白色方块", () => {
    const css = read(CSS);
    const rule = css.slice(css.indexOf(".set-plg-embed .plg-toolbar"));
    const body = rule.slice(rule.indexOf("{"), rule.indexOf("}") + 1);
    expect(body).toContain("background: var(--bg)");
    expect(body).not.toContain("var(--bg-panel)");
  });

  it("搜索框有图标/清空，动作收进独立分组，市场是主按钮", () => {
    const src = read(DIALOG);
    expect(src).toContain('className="plg-search-box"');
    expect(src).toContain("IconSearch");
    expect(src).toContain('className="plg-search-clear"');
    expect(src).toContain('className="plg-toolbar-actions"');
    expect(src).toMatch(/className="btn primary"\s+onClick=\{requestOpenMarket\}/);
    const toolbar = src.slice(src.indexOf('<div className="plg-toolbar">'), src.indexOf("{selMode && ("));
    expect(toolbar).not.toContain("plg-batch-spacer");
  });

  it("筛选是分段轨道；列表卡片与行距升级", () => {
    const css = read(CSS);
    expect(css).toContain(".plg-filters {");
    expect(css).toContain("border-radius: var(--radius-pill);");
    expect(css).toContain(".plg-toolbar-actions {");
    expect(css).toContain(".plg-item-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }");
    expect(css).toContain(".plg-item { border: 1px solid var(--border); border-radius: var(--radius-l);");
  });

  it("停用包只压内容层，不再整卡发灰", () => {
    const css = read(CSS);
    expect(css).toContain(".plg-item:has(.plg-switch input:not(:checked)) .plg-cover");
    expect(css).toContain(".plg-item:has(.plg-switch input:not(:checked)) .plg-item-body");
    expect(css).not.toContain(".plg-item:has(.plg-switch input:not(:checked)) { opacity");
  });
});
