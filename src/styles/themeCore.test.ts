/**
 * P99b-N5 主题纯函数层的守卫（详设 §7 的 G4/G4b/G11/G12 + R5/R6 的判定部分）。
 *
 * 为什么这些能在 node 里测而组件里的不能：本层不读 DOM、不读 store，
 * 三问（谁在画 / 亮还是暗 / 哪些键没人供）都是纯参数进纯值出。
 * 真实主题文件直接从磁盘读（与 `check:theme` 同一批字节），这样"内置八枚自带的 color-scheme
 * 必须等于按 --bg 算出来的结果"这条就是**八组真值对照**，不是我自己造的例子。
 */
import { describe, expect, it } from "vitest";
import {
  CORE_COLOR_KEYS,
  baselineLabel,
  checkThemeVars,
  parseThemeBlock,
  nearestKnownKey,
  relativeLuminance,
  resolveActiveTheme,
  resolveScheme,
  schemeFromBg,
  swatchOf,
  themeCoverage,
} from "./themeCore";
import { APPEARANCE_TOKENS } from "../features/agent/appearanceStore";

// 读源文件走变量说明符的动态导入（同时绕开 tsc 缺 @types/node，同 marketStore.test 的写法）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string) => string[];
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const THEME_DIR = fileURLToPath(new URL("./themes/", import.meta.url));

function readThemeFile(id: string): string {
  return readFileSync(`${THEME_DIR}${id}.css`, "utf8");
}

const BUILTIN_IDS = ["dark", "light", "navy", "glaze", "ocean", "matcha", "amber", "begonia"];

/** 详设 §1-1 的实测事实：每个文件只有一个 token 块 + 一行 color-scheme，没有别的规则 */
describe("P99b-N5 · 内置主题文件确实是「一张 token 表」（R8 的前提）", () => {
  it("八枚都能解析，且块外/块内没有会被 ?raw 静默丢掉的东西", () => {
    const onDisk = readdirSync(THEME_DIR)
      .filter((f) => f.endsWith(".css"))
      .map((f) => f.replace(/\.css$/, ""))
      .sort();
    expect(onDisk.sort(), "磁盘上的主题文件与内置清单不再一致（加了文件没登记，或反之）").toEqual(
      [...BUILTIN_IDS].sort(),
    );
    for (const id of BUILTIN_IDS) {
      const r = parseThemeBlock(readThemeFile(id), id);
      expect(r.errors, `${id} 解析失败`).toEqual([]);
      expect(Object.keys(r.vars).length, `${id} 一个变量都没有就不算一枚主题`).toBeGreaterThan(0);
    }
  });

  it("17 项核心色键每枚内置都给齐（这就是它当初能当兜底的原因）", () => {
    for (const id of BUILTIN_IDS) {
      const { vars } = parseThemeBlock(readThemeFile(id), id);
      const missing = CORE_COLOR_KEYS.filter((k) => !(k in vars));
      expect(missing, `${id} 缺核心色键`).toEqual([]);
    }
    expect(CORE_COLOR_KEYS.length).toBe(17);
  });

  it("G11 · 自带的 color-scheme 必须等于按 --bg 算出来的结果（八组真值对照，阈值挪一格就红）", () => {
    for (const id of BUILTIN_IDS) {
      const r = parseThemeBlock(readThemeFile(id), id);
      expect(r.scheme, `${id} 没声明 color-scheme`).not.toBeNull();
      expect(schemeFromBg(r.vars), `${id}：声明与算出来的明暗不一致`).toBe(r.scheme);
    }
    // 反证：阈值真的在分档上起作用（0.4 两侧各一枚内置）
    const lums = BUILTIN_IDS.map((id) => relativeLuminance(parseThemeBlock(readThemeFile(id), id).vars["--bg"])!);
    expect(Math.min(...lums)).toBeLessThan(0.4);
    expect(Math.max(...lums)).toBeGreaterThan(0.4);
  });
});

describe("P99b-N5 · parseThemeBlock 对畸形输入出声（G12：不许静默给空表）", () => {
  const ok = `:root[data-theme="x"] {\n  color-scheme: dark;\n  --bg: #000000;\n}`;

  it("注释不吃掉声明，也不被当成值", () => {
    const r = parseThemeBlock(
      `:root[data-theme="x"] {\n  /* 解释：下面这行是底色 */\n  color-scheme: light;\n  --bg: #ffffff; /* 行尾注释 */\n}`,
      "x",
    );
    expect(r.errors).toEqual([]);
    expect(r.vars["--bg"]).toBe("#ffffff");
    expect(r.scheme).toBe("light");
  });

  it("块外的任何一条规则都判错——它留在文件里就会静默失效", () => {
    const r = parseThemeBlock(`${ok}\n.btn { color: red; }`, "x");
    expect(r.ok, "样式规则被静默丢掉就是界面坏掉而没人报").toBe(false);
    expect(r.errors.join("")).toContain("块之外");
  });

  it("两个块 / 零个块 / 块不闭合 都判错", () => {
    expect(parseThemeBlock(`${ok}\n${ok}`, "x").errors.join("")).toContain("只有一个");
    expect(parseThemeBlock(`.btn{color:red}`, "x").errors.join("")).toContain("只有一个");
    expect(parseThemeBlock(`:root[data-theme="x"] { --bg: #000;`, "x").errors.join("")).toContain("没有闭合");
  });

  it("块内出现非 token 声明判错；值为空判错；空表判错", () => {
    expect(parseThemeBlock(`:root[data-theme="x"] { --bg: #000; background: red; }`, "x").errors.join("")).toContain("非 token");
    expect(parseThemeBlock(`:root[data-theme="x"] { --bg: ; }`, "x").errors.join("")).toContain("值为空");
    expect(parseThemeBlock(`:root[data-theme="x"] { color-scheme: dark; }`, "x").errors.join("")).toContain("一个变量都没有");
  });

  it("选择器里的 id 与文件名不符要红（本层按 id 取表，不是按属性上色）", () => {
    const r = parseThemeBlock(`:root[data-theme="y"] { --bg: #000; }`, "x");
    expect(r.errors.join("")).toContain("与文件名不符");
  });

  it("color-scheme 只认 dark/light", () => {
    expect(parseThemeBlock(`:root[data-theme="x"] { --bg:#000; color-scheme: both; }`, "x").errors.join("")).toContain("只认 dark/light");
  });
});

describe("P99b-N5 · 明暗归属三层优先序（S4）", () => {
  it("① 自带声明优先", () => {
    expect(resolveScheme({ scheme: "light", vars: { "--bg": "#000000" } }, null)).toEqual({ scheme: "light", origin: "declared" });
  });

  it("② 没声明时按自己给的 --bg 算；深色算暗、浅色算亮", () => {
    expect(resolveScheme({ scheme: null, vars: { "--bg": "#0f1115" } }, null).scheme).toBe("dark");
    expect(resolveScheme({ scheme: null, vars: { "--bg": "#fbf1f2" } }, null).scheme).toBe("light");
  });

  it("③ 只改强调色的差量主题：没有 --bg 也没有声明 ⇒ 沿用上一次，并且 origin 要说出来", () => {
    const r = resolveScheme({ scheme: null, vars: { "--accent": "#123456" } }, "light");
    expect(r).toEqual({ scheme: "light", origin: "inherit" });
    expect(resolveScheme({ scheme: null, vars: { "--bg": "rgba(0,0,0,.5)" } }, "light")).toEqual({
      scheme: "light",
      origin: "inherit",
    });
  });
});

describe("P99b-N5 · 差量主题的兜底与点名（R6 / G4 / G4b）", () => {
  const darkBase = { "--bg": "#0f1115", "--bg-panel": "#161a20", "--text": "#e6e9ee", "--accent": "#4e9cef" };
  const lightBase = { "--bg": "#f5f6f8", "--bg-panel": "#ffffff", "--text": "#1c2128", "--accent": "#2f6fce" };

  it("只给 --accent 的主题：其余核心键都算「走兜底」，数要能上界面", () => {
    const { inherited, overrides } = themeCoverage({ "--accent": "#ff0000" }, darkBase);
    expect(overrides).toBe(1);
    expect(inherited).toContain("--bg");
    expect(inherited).not.toContain("--accent");
    expect(inherited.length).toBe(3);
  });

  it("预览格缺键时按兜底补，而不是画成空白（色板抄本删除后这里是唯一来源）", () => {
    const s = swatchOf({ "--accent": "#ff0000" }, lightBase);
    expect(s).toEqual({ bg: "#f5f6f8", panel: "#ffffff", accent: "#ff0000" });
  });

  it("同一枚只给 --accent 的主题，暗底与亮底取到的 --bg 必须不同（两层兜底真的会换）", () => {
    const v = { "--accent": "#ff0000" };
    expect(swatchOf(v, darkBase).bg).not.toBe(swatchOf(v, lightBase).bg);
    expect(swatchOf(v, darkBase).bg).toBe(darkBase["--bg"]);
    expect(swatchOf(v, lightBase).bg).toBe(lightBase["--bg"]);
  });

  it("兜底层在界面上说的是**哪枚内置**，不含糊叫「基线」", () => {
    expect(baselineLabel("dark")).toContain("内置 dark");
    expect(baselineLabel("light")).toContain("内置 light");
  });
});

describe("P99b-N5 · 未知 token 键拒收并给出相近名（R5）", () => {
  it("示例包那两份写的不存在的键：拒收，且建议就是应用里真有的那个名字", () => {
    const sample = { "--bg": "#f7f2f0", "--panel": "#fffaf8", "--text": "#3a2f2c", "--accent": "#c76a7a", "--accent-contrast": "#ffffff" };
    const r = checkThemeVars(sample, APPEARANCE_TOKENS);
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("--panel");
    expect(r.errors.join("")).toContain("--bg-panel");
    expect(r.errors.join("")).toContain("--accent-contrast");
    // 每条都要带"可能是哪个真名"，且给的名字确实白名单里有
    for (const e of r.errors) {
      const suggest = /可能是 (--[\w-]+)/.exec(e)?.[1];
      expect(suggest, `这条报错没给相近键名：${e}`).toBeTruthy();
      expect(APPEARANCE_TOKENS).toContain(suggest);
    }
    // 真实存在的键不许被误伤
    expect(r.errors.join("")).not.toMatch(/未知的主题变量 --bg\b/);
  });

  it("相近名按前缀优先于包含（--panel 的答复是 --bg-panel 而不是随便一条含 panel 的）", () => {
    expect(nearestKnownKey("--panel", APPEARANCE_TOKENS)).toBe("--bg-panel");
    expect(nearestKnownKey("--accent-contrast", APPEARANCE_TOKENS)).toBe("--accent");
    expect(nearestKnownKey("--nonsense-xyz", APPEARANCE_TOKENS)).toBeNull();
  });

  it("内置八枚的键全部在白名单内（白名单漏了自己的主题就是自打脸）", () => {
    for (const id of BUILTIN_IDS) {
      const { vars } = parseThemeBlock(readThemeFile(id), id);
      const r = checkThemeVars(vars, [...APPEARANCE_TOKENS]);
      expect(r.errors, `${id} 写了白名单外的键`).toEqual([]);
    }
  });
});

describe("P99b-N5 · 「在画的这一枚」只有一个（R1/R4）", () => {
  const builtins = [
    { id: "dark", name: "暗色", builtin: true },
    { id: "light", name: "亮色", builtin: true },
    { id: "begonia", name: "秋海棠", builtin: true },
  ];
  const plugin = (id: string, createdAt: number) => ({
    id,
    name: id,
    builtin: false,
    scheme: null,
    vars: {},
    pluginId: `pkg.${id}`,
    createdAt,
  });

  it("没有插件主题时画内置那一枚；有插件主题时它压过内置", () => {
    const none = resolveActiveTheme({ settingsTheme: "begonia", sysDark: false, builtins, enabledThemePlugins: [] });
    expect(none.active?.id).toBe("begonia");
    expect(none.active?.builtin).toBe(true);
    const withPlugin = resolveActiveTheme({
      settingsTheme: "begonia",
      sysDark: false,
      builtins,
      enabledThemePlugins: [plugin("plg:a", 10)],
    });
    expect(withPlugin.active?.id).toBe("plg:a");
    expect(withPlugin.active?.pluginId).toBe("pkg.plg:a");
    expect(withPlugin.builtinDrawn?.id, "内置那一枚仍要知道（停用插件后回到它）").toBe("begonia");
    expect(withPlugin.conflicts).toEqual([]);
  });

  it("停用唯一那枚 ⇒ 当场回到 settings.theme 的内置（R4「切换即还原上一层」的判定侧）", () => {
    const r = resolveActiveTheme({ settingsTheme: "dark", sysDark: false, builtins, enabledThemePlugins: [] });
    expect(r.active?.id).toBe("dark");
  });

  it("system 解析到内置两枚之一，而不是第 9 枚主题", () => {
    expect(resolveActiveTheme({ settingsTheme: "system", sysDark: true, builtins, enabledThemePlugins: [] }).active?.id).toBe("dark");
    const bright = resolveActiveTheme({ settingsTheme: "system", sysDark: false, builtins, enabledThemePlugins: [] });
    expect(bright.active?.id).toBe("light");
    expect(bright.fellBack, "system 不是回落，别把这两件事混成一句").toBe(false);
  });

  it("G2/G4b 的判定侧：多枚同时启用只画最新那枚，其余进 conflicts 照实点名（不许静默合并）", () => {
    const r = resolveActiveTheme({
      settingsTheme: "dark",
      sysDark: false,
      builtins,
      enabledThemePlugins: [plugin("plg:old", 10), plugin("plg:new", 20)],
    });
    expect(r.active?.id).toBe("plg:new");
    expect(r.conflicts.map((c) => c.id)).toEqual(["plg:old"]);
  });

  it("settings 里那枚内置不存在了 ⇒ 回落第一枚，但必须把「回落了」这件事带出去", () => {
    const r = resolveActiveTheme({ settingsTheme: "已下架的主题", sysDark: false, builtins, enabledThemePlugins: [] });
    expect(r.active?.id).toBe("dark");
    expect(r.fellBack).toBe(true);
  });
});
