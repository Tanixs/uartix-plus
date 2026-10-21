import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const DIALOG = readFileSync(`${SRC}features/plugins/PluginLibraryDialog.tsx`, "utf8");
const CSS = readFileSync(`${SRC}styles/theme.css`, "utf8");

describe("P173 · 插件搜索结果键盘导航", () => {
  it("搜索框 ↓/↑ 进首/末条，Enter 打开第一条详情", () => {
    expect(DIALOG).toContain("focusResult(\"first\")");
    expect(DIALOG).toContain("focusResult(\"last\")");
    expect(DIALOG).toContain("list[0] && !selMode");
    expect(DIALOG).toContain("setDetailId(list[0].pkg.id)");
  });

  it("列表项之间 ↑/↓/Home/End 移动，Esc 回搜索框", () => {
    expect(DIALOG).toContain("focusResult(\"next\")");
    expect(DIALOG).toContain("focusResult(\"prev\")");
    expect(DIALOG).toContain("focusResult(\"first\")");
    expect(DIALOG).toContain("focusResult(\"last\")");
    expect(DIALOG).toContain("searchRef.current?.focus()");
  });

  it("焦点范围限定在插件列表，不抓详情里的同名按钮", () => {
    expect(DIALOG).toContain("listRef.current?.querySelectorAll<HTMLButtonElement>(\".plg-item-main\")");
  });

  it("快捷键提示不再用 text-faint（audit 3.19 不达标）", () => {
    const start = CSS.indexOf(".plg-search-kbd {");
    const block = CSS.slice(start, CSS.indexOf("}", start));
    expect(block).toContain("color: var(--text-dim)");
  });
});
