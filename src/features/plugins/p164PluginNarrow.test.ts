import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const CSS = readFileSync(`${SRC}styles/theme.css`, "utf8");

describe("P164 · 插件嵌入页窄窗工具栏", () => {
  it("嵌入页成为容器，按自身宽度而不是窗口宽度响应", () => {
    expect(CSS).toContain(".set-plg-embed { container-type: inline-size; }");
    expect(CSS).toContain("@container (max-width: 900px)");
  });

  it("窄窗下搜索框独占一行，不再和筛选/动作挤一排放不下", () => {
    const start = CSS.indexOf("@container (max-width: 900px)");
    const block = CSS.slice(start, CSS.indexOf("}", CSS.indexOf("{", start)) + 1);
    expect(block).toContain(".set-plg-embed .plg-search-box { flex: 1 1 100%; max-width: none; }");
    expect(block).not.toMatch(/^\s*\.plg-search-box\s*\{/m);
  });

  it("宽窗仍保留单行工具栏的基础规则", () => {
    expect(CSS).toContain(".plg-toolbar {");
    expect(CSS).toContain("flex-wrap: wrap;");
  });
});
