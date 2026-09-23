/**
 * P99b-N5 · 外观选择器派生层（详设 §4① 的"这一面先分派生层"）。
 *
 * 这一格界面历史上说过两次谎，都在这里钉住：
 *  1. 选择器的"选中"只看 `settings.theme`，被插件主题压住时它显示"自己选中"而界面其实是别的（§1-8）；
 *  2. 色板是手抄的 `THEME_SWATCH`（九行字面量 + 一句"与 theme.css 保持一致"的注释）——抄本就是一份
 *     等着过期东西（§1-8 同一处）。现在预览格从 token 表算，抄本没了，所以要钉"不许再出现字面量色板"。
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_THEME_IDS } from "../../styles/builtinThemes";
import { CORE_COLOR_KEYS } from "../../styles/themeCore";
import type { PluginRecord } from "../plugins/pluginStore";
import type { PickerInput } from "./themePicker";

const stubStore = new Map<string, string>();
// themePicker 静态引 pluginStore，而它在模块求值期就摸 localStorage ⇒ 先 stub 再 await import（同 helpCoverage）
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});

function rec(id: string, state: PluginRecord["state"], vars: Record<string, string>, extraKeys: Record<string, unknown> = {}): PluginRecord {
  return {
    pkg: {
      format: "uartix-plugin",
      schemaVersion: 2,
      id,
      version: "0.1.0",
      name: `包 ${id}`,
      hostApi: "^1.0",
      capabilities: ["theme.tokens"],
      contributions: { themes: [{ id: "main", entry: "main.json" }], ...extraKeys },
      artifacts: { "main.json": { kind: "theme", vars } },
      provenance: { createdBy: "user", reviewed: false },
    },
    state,
    nonce: "n",
    config: {},
    versions: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as PluginRecord;
}

const { drawnTalk, themeCards, themeButtonTalk } = await import("./themePicker");

const base = (over: Partial<PickerInput> = {}): PickerInput => ({
  settingsTheme: "begonia",
  sysDark: false,
  drawnId: "begonia",
  drawnName: "begonia",
  drawnPluginId: null,
  records: [],
  labelOf: (id) => `中${id}`,
  ...over,
});

describe("P99b-N5 · 一张列表、一枚在画（同级裁决）", () => {
  it("内置八枚 + 「跟随系统」都在，且都标着内置、没有 pluginId（没有卸载入口可言）", () => {
    const cards = themeCards(base());
    const builtinCards = cards.filter((c) => c.builtin);
    expect(builtinCards.map((c) => c.key).filter((k) => k !== "system").sort()).toEqual([...BUILTIN_THEME_IDS].sort());
    expect(cards.some((c) => c.key === "system"), "跟随系统那一格没了").toBe(true);
    for (const c of builtinCards) {
      expect(c.pluginId, `内置 ${c.key} 带着插件包 id，等于给它挂了卸载/停用`).toBeNull();
    }
  });

  it("只有 1 枚 drawn；被「跟随系统」代表的那枚内置另标 serving（两件事不混成一个勾）", () => {
    const sysDark = themeCards(base({ settingsTheme: "system", sysDark: true, drawnId: "dark", drawnName: "dark" }));
    expect(sysDark.filter((c) => c.drawn).map((c) => c.key)).toEqual(["system"]);
    expect(sysDark.filter((c) => c.serving).map((c) => c.key)).toEqual(["dark"]);
    const plain = themeCards(base());
    expect(plain.filter((c) => c.drawn).map((c) => c.key)).toEqual(["begonia"]);
    expect(plain.find((c) => c.key === "begonia")?.serving).toBe(true);
  });

  it("内置名字走传入的 labelOf（i18n 在组件手里），插件主题用记录里的名字", () => {
    const cards = themeCards(base({ records: [rec("user.t", "installed_disabled", { "--accent": "#fff" })] }));
    expect(cards.find((c) => c.builtin && c.key === "begonia")?.name).toBe("中begonia");
    expect(cards.find((c) => !c.builtin)?.name).toBe("包 user.t");
  });

  it("装了但没启用的主题也在列表里，并明说\"点它会启用插件\"", () => {
    const cards = themeCards(base({ records: [rec("user.t", "installed_disabled", { "--accent": "#fff" })] }));
    const off = cards.find((c) => c.key.startsWith("plg:user.t"));
    expect(off).toBeTruthy();
    expect(off?.enabled).toBe(false);
    expect(off?.drawn).toBe(false);
    expect(off?.talk).toContain("启用插件");
    expect(off?.talk).not.toContain("停用");
  });

  it("同包还带别的产物时，那颗卡必须说清\"会一起装载什么\"", () => {
    const cards = themeCards(
      base({ records: [rec("user.t", "installed_disabled", { "--accent": "#fff" }, { widgets: [{ id: "w", entry: "w.json" }] })] }),
    );
    const off = cards.find((c) => c.key.startsWith("plg:user.t"));
    expect(off?.alsoShips).toEqual(["小部件"]);
    expect(off?.talk).toContain("小部件");
  });

  it("已启用但被更晚一枚挤掉（存量数据）也要看得见，不许只显示一个亮开关", () => {
    const cards = themeCards(
      base({
        drawnId: "plg:user.new:main",
        drawnName: "新那枚",
        drawnPluginId: "user.new",
        records: [rec("user.old", "enabled", { "--accent": "#111" }), rec("user.new", "enabled", { "--accent": "#222" })],
      }),
    );
    const old = cards.find((c) => c.key === "plg:user.old:main");
    expect(old?.enabled).toBe(true);
    expect(old?.drawn, "在画那枚是插件，内置那格不许还亮着").toBe(false);
    expect(old?.talk).toContain("没在画");
    expect(cards.filter((c) => c.drawn).map((c) => c.key)).toEqual(["plg:user.new:main"]);
  });

  it("差量主题的\"几项沿用兜底\"报的是真数，且预览格不是空白（缺键按底补）", () => {
    const cards = themeCards(base({ records: [rec("user.t", "installed_disabled", { "--accent": "#abcdef" })] }));
    const c = cards.find((x) => x.key.startsWith("plg:user.t"))!;
    expect(c.overrides).toBe(1);
    expect(c.inherited).toBe(CORE_COLOR_KEYS.length - 1);
    expect(c.swatch.accent).toBe("#abcdef");
    expect(c.swatch.bg, "预览格画成空白等于骗人说这主题没底色").toBeTruthy();
  });

  it("浅底插件主题的预览用亮底、深底用暗底（Q2 那两层在这儿也分得开）", () => {
    const mk = (vars: Record<string, string>) =>
      themeCards(base({ records: [rec("user.t", "installed_disabled", vars)] })).find((c) => c.key.startsWith("plg:user.t"))!;
    const light = mk({ "--bg": "#fafafa" });
    const dark = mk({ "--bg": "#0d0d0d" });
    expect(light.scheme).toBe("light");
    expect(dark.scheme).toBe("dark");
    expect(light.swatch.panel).not.toBe(dark.swatch.panel);
  });
});

describe("P99b-N5 · 来源面板那句话要说全（R6/S1/S4 的 ③）", () => {
  const facts = {
    name: "墨夜",
    builtin: false,
    scheme: "dark" as const,
    schemeOrigin: "bg" as const,
    overrides: 6,
    inherited: 11,
    baseline: "dark" as const,
    conflicts: [] as string[],
    fellBack: false,
    fallbackId: "begonia",
  };

  it("差量主题：覆写几项 + 几项沿用哪张底，两句都在", () => {
    const s = drawnTalk(facts);
    expect(s).toContain("覆写 6 项");
    expect(s).toContain("11 项沿用暗底兜底");
    expect(s).toContain("回到内置「begonia」");
  });

  it("明暗归属是\"沿用\"来的，必须点名（不然是系统在替用户决定底色）", () => {
    expect(drawnTalk({ ...facts, schemeOrigin: "inherit" })).toContain("没给明暗依据");
  });

  it("多枚同时启用与内置回落都各有一句", () => {
    expect(drawnTalk({ ...facts, conflicts: ["a", "b"] })).toContain("2 枚");
    expect(drawnTalk({ ...facts, fellBack: true })).toContain("已不存在");
    expect(drawnTalk({ ...facts, builtin: true })).not.toContain("停用这枚插件主题");
  });

  it("两颗按钮的话分开：停用那枚 vs 启用另一枚（同一句会让人点错）", () => {
    expect(themeButtonTalk("drawn", "墨夜")).toContain("回到当前选中的内置主题");
    expect(themeButtonTalk("other", "秋水")).toContain("挤掉");
  });
});
