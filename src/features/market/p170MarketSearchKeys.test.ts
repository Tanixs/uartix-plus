import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const SRC_FILE = readFileSync(`${SRC}features/market/MarketDialog.tsx`, "utf8");

describe("P170 · 市场搜索快捷键", () => {
  it("/ 聚焦市场搜索，输入框内不劫持", () => {
    expect(SRC_FILE).toContain('e.key !== "/"');
    expect(SRC_FILE).toContain("searchRef.current?.focus()");
    expect(SRC_FILE).toContain('t.tagName === "INPUT"');
  });

  it("搜索框声明快捷键，Esc 清空而不是关市场", () => {
    expect(SRC_FILE).toContain('aria-keyshortcuts="/"');
    expect(SRC_FILE).toContain('e.key === "Escape" && query');
    expect(SRC_FILE).toContain("setQuery(\"\")");
  });
});
