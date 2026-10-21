import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

const MODAL = "features/settings/SettingsModal.tsx";
const CSS = "styles/theme.css";

describe("P165 · 设置搜索键盘导航", () => {
  it("输入框处理上下键，Enter 打开当前高亮而不是永远第一条", () => {
    const src = read(MODAL);
    expect(src).toContain('e.key === "ArrowDown"');
    expect(src).toContain('e.key === "ArrowUp"');
    expect(src).toContain('e.key === "Home"');
    expect(src).toContain('e.key === "End"');
    expect(src).toContain("navActive");
    expect(src).toMatch(/goToSearchHit\(navHits\[Math\.min\(navActive, navHits\.length - 1\)\]\)/);
    expect(src).not.toContain("goToSearchHit(navHits[0])");
  });

  it("高亮与鼠标悬停共用同一状态，清空/换查询回到第一条", () => {
    const src = read(MODAL);
    expect(src).toContain("onMouseEnter={() => setNavActive(i)}");
    expect(src).toContain("onFocus={() => setNavActive(i)}");
    expect(src).toContain('scrollIntoView({ block: "nearest" })');
    expect(src).toContain("aria-current={i === navActive");
    expect(src).toMatch(/setNavActive\(0\);\s*\}, \[navQuery\]\)/);
  });

  it("高亮行有可见样式，不只靠 hover", () => {
    expect(read(CSS)).toMatch(/\.set-nav \.set-nav-hit\.on\s*(?:,|\{)/);
  });
});

