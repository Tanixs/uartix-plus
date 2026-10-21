import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const FACES = readFileSync(fileURLToPath(new URL("../../.tools/audit-faces.mjs", import.meta.url)), "utf8");
const CSS = readFileSync(fileURLToPath(new URL("../styles/theme.css", import.meta.url)), "utf8");
const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../.tools/audit-baseline.json", import.meta.url)), "utf8"),
) as { surfaces: string[] };
const CENSUS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../.tools/class-census.json", import.meta.url)), "utf8"),
) as { faces: Record<string, number> };

describe("P168 · audit 面加深", () => {
  it("插件详情与设置搜索态都有驱动和打开判据", () => {
    expect(FACES).toContain('id: "settings-plugins"');
    expect(FACES).toContain('seed: "plugin"');
    expect(FACES).toContain('drive: "pluginDetail"');
    expect(FACES).toContain('require: ".plg-detail"');
    expect(FACES).toContain('id: "settings-search"');
    expect(FACES).toContain('drive: "settingsSearch"');
    expect(FACES).toContain('require: ".set-nav-hit"');
  });

  it("基线确实采到了这两个面，而不是只写在 SURFACES 里", () => {
    expect(BASELINE.surfaces).toEqual(expect.arrayContaining(["settings-plugins", "settings-search"]));
  });

  it("普查也覆盖新面，种子里的 theme id 不被当成面", () => {
    expect(CENSUS.faces).toHaveProperty("settings-plugins");
    expect(CENSUS.faces).toHaveProperty("settings-search");
    expect(CENSUS.faces).not.toHaveProperty("main");
  });

  it("新面暴露的搜索溢出与筛选对比度已修，基线归零", () => {
    expect(CSS).toMatch(/\.set-nav-results \{[^}]*width: 100%; min-width: 0;/);
    expect(CSS).toMatch(/\.set-nav \.set-nav-hit \{[^}]*box-sizing: border-box;/);
    expect(CSS).toContain(".plg-filters .plg-fchip.on { color: var(--text)");
    expect(CSS).toContain(".set-apr-val { flex: 0 1 auto; min-width: 62px; max-width: 55%;");
  });
});
