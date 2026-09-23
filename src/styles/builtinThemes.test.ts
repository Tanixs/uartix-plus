/**
 * P99b-N5：内置主题装载层的守卫（详设 §7 的 G7 运行期那一半）。
 *
 * 这里钉的是"降级成数据之后还剩什么"：解析不许报错、清单与设置页那份 `THEME_LIST` 不许各说一套、
 * 两张兜底表必须自己就是完整的（17 项核心色键齐全，否则它兜不住任何东西）。
 */
import { describe, expect, it, vi } from "vitest";
import { CORE_COLOR_KEYS } from "./themeCore";
import {
  BASELINE_VARS,
  BUILTIN_THEME_ERRORS,
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  baselineFor,
  builtinTheme,
  isBuiltinThemeId,
} from "./builtinThemes";

// settingsStore 在模块初始化时就摸 localStorage；静态 import 会提升到 stub 之前（同 helpCoverage 的写法）
const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});
const { THEME_LIST } = await import("../features/settings/settingsStore");
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

describe("P99b-N5 · 装载层出声（解析错误不静默）", () => {
  it("八枚内置主题装载期零解析错误", () => {
    expect(BUILTIN_THEME_ERRORS, "主题文件里出现了 ?raw 解析不了 / 会静默丢掉的东西").toEqual([]);
    expect(BUILTIN_THEMES.length).toBe(8);
  });

  it("内置清单与设置页的 THEME_LIST 对得上（只差 system 那个元选项）", () => {
    expect([...BUILTIN_THEME_IDS].sort()).toEqual(THEME_LIST.filter((t) => t !== "system").sort());
    expect(builtinTheme("system"), "跟随系统不是第 9 枚主题").toBeNull();
    expect(isBuiltinThemeId("plg:whatever")).toBe(false);
  });
});

describe("P99b-N5 · 两张兜底表自己得是完整的（S1）", () => {
  for (const scheme of ["dark", "light"] as const) {
    it(`${scheme} 底：17 项核心色键齐全，且就是内置那一枚主题的表本身（按引用，不是抄）`, () => {
      const base = baselineFor(scheme);
      expect(CORE_COLOR_KEYS.filter((k) => !(k in base)), `${scheme} 底缺键`).toEqual([]);
      expect(base).toBe(BUILTIN_THEMES.find((t) => t.id === scheme)?.vars);
    });
  }

  it("兜底只有暗/亮两层，不多不少（Q2 裁决：两个亮色和暗色的兜底层，不是第三份中性表）", () => {
    expect(Object.keys(BASELINE_VARS).sort()).toEqual(["dark", "light"]);
  });
});

describe("P99b-N5 · 主题文件不再是运行时样式（G7 的 @import 那一半）", () => {
  it("theme.css 里一条 @import \"./themes/\" 都不许留：留着就是样式表与内联层两套真相", () => {
    const css = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");
    expect(css.match(/@import\s+["']\.\/themes\//g) ?? [], "内置主题仍在按 :root[data-theme] 上色").toEqual([]);
    expect(css, "样式表里不该再有按 data-theme 配色的规则").not.toMatch(/\[data-theme\s*=/);
  });
});
