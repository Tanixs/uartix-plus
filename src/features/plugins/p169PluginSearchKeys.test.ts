import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
const DIALOG = "features/plugins/PluginLibraryDialog.tsx";
const CSS = "styles/theme.css";

describe("P169 · 插件搜索快捷键", () => {
  it("/ 聚焦搜索，输入框内不劫持；Esc 清空而不是关设置", () => {
    const src = read(DIALOG);
    expect(src).toContain('e.key !== "/"');
    expect(src).toContain('t.tagName === "INPUT"');
    expect(src).toContain("searchRef.current?.focus()");
    expect(src).toContain('e.key === "Escape" && query');
    expect(src).toContain("aria-keyshortcuts=\"/\"");
  });

  it("空查询时显示 / 提示，查询后让位给清空按钮", () => {
    const src = read(DIALOG);
    expect(src).toContain("{!query && <kbd className=\"plg-search-kbd\"");
    expect(read(CSS)).toContain(".plg-search-kbd {");
  });
});
