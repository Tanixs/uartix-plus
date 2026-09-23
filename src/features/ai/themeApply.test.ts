/**
 * P99b-N5 落地层的守卫（详设 §7 的 G3/G4/G4b/G5/G11 的运行期那一半）。
 *
 * 为什么必须有一整份对着**真 store 与真合成器**的测试：这批改的是"界面为什么长成这样"的
 * 唯一通路。派生层（themeCore）能证明算法对，证明不了"算法被接上了"——
 * 而历史教训就写在 `extRuntime` 自己的注释里（P98-M0 那段"两套 applied* 记账互相抹"）。
 *
 * 用真 `rootVars` / 真 `extensionStore` / 真 `settingsStore`（stub 一个 localStorage），
 * 不 mock：mock 掉的那一层等于没测。断言全部读 `effectiveRootVars()` 与 `activeThemeFacts()`，
 * 这两个就是界面实际拿到的东西。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});

const { CORE_COLOR_KEYS, parseThemeBlock } = await import("../../styles/themeCore");
const { BASELINE_VARS } = await import("../../styles/builtinThemes");
const { effectiveRootVars, rootVarLayers } = await import("../../styles/rootVars");
const extStore = await import("./extensionStore");
const settings = await import("../settings/settingsStore");
const { applyStyleExts } = await import("./extRuntime");
const { activeThemeFacts } = await import("../../styles/themeFacts");

/** 主题文件的真实形状：从磁盘那份取（不另抄色值，抄了这份测试就只是在测自己） */
// tsc 这侧没有 @types/node：读文件走变量说明符（同 marketStore.test）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const darkVars = parseThemeBlock(readFileSync(fileURLToPath(new URL("../../styles/themes/dark.css", import.meta.url)), "utf8"), "dark").vars;
const begoniaVars = parseThemeBlock(readFileSync(fileURLToPath(new URL("../../styles/themes/begonia.css", import.meta.url)), "utf8"), "begonia").vars;

function pickTheme(id: string) {
  settings.patch({ theme: id as never });
  applyStyleExts();
}

function themeProjection(id: string, vars: Record<string, string>, extra: { enabled?: boolean; createdAt?: number; scheme?: "dark" | "light" } = {}) {
  extStore.upsertProjection({
    id,
    type: "theme",
    name: id,
    desc: "",
    version: "1.0.0",
    enabled: extra.enabled ?? true,
    createdAt: extra.createdAt ?? 1000,
    pluginRef: `pkg.${id}`,
    vars,
    ...(extra.scheme ? { scheme: extra.scheme } : {}),
  });
}

beforeEach(() => {
  for (const e of extStore.getSnapshot().exts) extStore.removeProjection(e.id);
  settings.patch({ theme: "begonia" });
  applyStyleExts();
});

describe("P99b-N5 · 内置主题也走合成器那一层（S2/S3）", () => {
  it("没有插件主题时，17 项核心色键照样齐全，且值就是选中的那枚内置", () => {
    pickTheme("dark");
    const eff = effectiveRootVars();
    for (const k of CORE_COLOR_KEYS) expect(eff[k], `核心键 ${k} 没值`).toBeTruthy();
    expect(eff["--bg"]).toBe(darkVars["--bg"]);
    expect(rootVarLayers().map((l) => l.id)).toEqual(["theme-baseline", "active-theme"]);
  });

  it("G5/R4 · 停掉唯一那枚插件主题 ⇒ 当场回到内置那一枚（不是\"要重启\"）", () => {
    pickTheme("begonia");
    themeProjection("plg:a:main", { "--bg": "#101010", "--accent": "#abcdef" });
    applyStyleExts();
    expect(effectiveRootVars()["--accent"]).toBe("#abcdef");
    extStore.removeProjection("plg:a:main");
    applyStyleExts();
    expect(effectiveRootVars()["--accent"], "撤不回去就是 P98-M0 那类事故的复发").toBe(begoniaVars["--accent"]);
    expect(activeThemeFacts().builtin).toBe(true);
  });
});

describe("P99b-N5 · 一次只画一枚（R1/R2 渲染侧）", () => {
  it("G3 · 两枚同时启用（存量/绕过入口）⇒ 只画最新那枚，其余进 conflicts 点名", () => {
    themeProjection("plg:old:main", { "--accent": "#111111" }, { createdAt: 10 });
    themeProjection("plg:new:main", { "--accent": "#222222" }, { createdAt: 20 });
    applyStyleExts();
    const eff = effectiveRootVars();
    expect(eff["--accent"], "两枚混一层就是详设 §1-9 那个混血主题").toBe("#222222");
    const f = activeThemeFacts();
    expect(f.id).toBe("plg:new:main");
    expect(f.conflicts).toEqual(["plg:old:main"]);
  });

  it("在画那枚的 CSS 只此一份：另一枚的作用域 CSS 不许拼接进来", () => {
    extStore.upsertProjection({
      id: "plg:css-a:main", type: "theme", name: "plg:css-a:main", desc: "", version: "1", enabled: true,
      createdAt: 10, pluginRef: "pkg.a", vars: { "--accent": "#111111" }, css: ".aa { color: red; }",
    });
    extStore.upsertProjection({
      id: "plg:css-b:main", type: "theme", name: "plg:css-b:main", desc: "", version: "1", enabled: true,
      createdAt: 20, pluginRef: "pkg.b", vars: { "--accent": "#222222" }, css: ".bb { color: blue; }",
    });
    applyStyleExts();
    expect(activeThemeFacts().id).toBe("plg:css-b:main");
    // 无 DOM 时不落地样式元素，但事实层必须只认一枚；这一句钉的是"只有一枚进 facts"
    expect(activeThemeFacts().conflicts).toEqual(["plg:css-a:main"]);
  });
});

describe("P99b-N5 · 差量主题的兜底真的按明暗换层（Q2 裁决 / G4b）", () => {
  const onlyAccent = { "--accent": "#ff005c" };

  it("亮色内置在画时，只改强调色的插件主题用的是亮底", () => {
    pickTheme("begonia");
    themeProjection("plg:x:main", onlyAccent, { scheme: "light" });
    applyStyleExts();
    expect(effectiveRootVars()["--bg"]).toBe(BASELINE_VARS.light["--bg"]);
    expect(effectiveRootVars()["--accent"]).toBe("#ff005c");
    expect(activeThemeFacts().inherited).toBeGreaterThan(0);
  });

  it("暗色内置在画时同一枚主题用的是暗底（两层兜底不是只有一张表）", () => {
    pickTheme("begonia");
    themeProjection("plg:x:main", onlyAccent, { scheme: "dark" });
    applyStyleExts();
    expect(effectiveRootVars()["--bg"]).toBe(BASELINE_VARS.dark["--bg"]);
    expect(BASELINE_VARS.dark["--bg"]).not.toBe(BASELINE_VARS.light["--bg"]);
  });

  it("只改强调色、又没声明明暗 ⇒ 沿用在画那枚的底，并且 facts 说出这个出处（不许悄悄猜暗色）", () => {
    pickTheme("begonia");
    themeProjection("plg:x:main", onlyAccent);
    applyStyleExts();
    const f = activeThemeFacts();
    expect(f.schemeOrigin).toBe("inherit");
    expect(f.baseline).toBe("light");
  });

  it("声明优先于算：一份浅底插件主题声明 dark 时按它说的走", () => {
    pickTheme("begonia");
    themeProjection("plg:x:main", { "--bg": "#fafafa" }, { scheme: "dark" });
    applyStyleExts();
    const f = activeThemeFacts();
    expect(f.scheme).toBe("dark");
    expect(f.schemeOrigin).toBe("declared");
    expect(effectiveRootVars()["--bg"]).toBe("#fafafa");
  });
});

describe("P99b-N5 · 市场示例那种 6 键主题（详设 §1-4 的那两枚）", () => {
  it("示例包改名后的键集合过产物校验，装上后核心键仍然齐全", async () => {
    const { validateManifest } = await import("../plugins/pluginManifest");
    const src = readFileSync(fileURLToPath(new URL("../../../market/pkg/theme-begonia.uartix.json", import.meta.url)), "utf8");
    const v = validateManifest(JSON.parse(src));
    expect(v.errors, "示例主题自己就过不了校验，货架上那就是个坏包").toEqual([]);
    const vars = (JSON.parse(src).artifacts["main.json"] as { vars: Record<string, string> }).vars;
    themeProjection("plg:shelf:main", vars);
    applyStyleExts();
    const eff = effectiveRootVars();
    for (const k of CORE_COLOR_KEYS) expect(eff[k], `${k} 空着——兜底没接上`).toBeTruthy();
    expect(eff["--bg"]).toBe(vars["--bg"]);
    // 示例主题自带 --bg 是浅粉，明暗归属应算成亮底
    expect(activeThemeFacts().schemeOrigin).toBe("bg");
    expect(activeThemeFacts().baseline).toBe("light");
  });
});
