/**
 * P158-A · 设置页成品感的形状钉。
 *
 * 四项都是"看起来差一口气"的具体来源：主题卡预览太素、另存布局被旧列容器挤断、
 * 添加供应商折成半截、卡片是可点的却没有手型。钉 CSS 与调用形状，观感归截图。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

const CSS = "styles/theme.css";
const SETTINGS = "features/settings/SettingsModal.tsx";
const MODEL = "features/settings/ModelSettingsPage.tsx";
const DIALOG = "features/plugins/PluginLibraryDialog.tsx";

describe("P158-A · 设置页细节", () => {
  it("主题卡预览 44px + 两条微缩文字线", () => {
    const css = read(CSS);
    expect(css, "主题卡预览又缩回小窗了").toMatch(/\.theme-swatch \{[^}]*height: 44px/);
    expect(css, "预览里的微缩文字线不见了").toMatch(/\.theme-swatch \.theme-panel::before/);
    expect(css, "预览里的第二条微缩文字线不见了").toMatch(/\.theme-swatch \.theme-panel::after/);
  });

  it("另存布局回到一行（row 容器 + 输入框可缩）", () => {
    const css = read(CSS);
    expect(css, "没有 set-save-layout 规则").toContain(".set-save-layout {");
    expect(css, "输入框没有可缩约束，长名字会把按钮挤出去").toMatch(/\.set-save-layout \.input \{[^}]*min-width: 0/);
    expect(read(SETTINGS), "调用点没挂上 set-save-layout").toContain('className="qk-fgroup set-save-layout"');
  });

  it("添加供应商是整行虚线 ghost，不再半截换行", () => {
    const css = read(CSS);
    expect(css, "没有 msp-add 规则").toContain(".msp-add {");
    expect(css, "不是虚线 ghost").toMatch(/\.msp-add \{[^}]*flex: 1 0 100%[^}]*border-style: dashed/);
    const src = read(MODEL);
    expect(src, "添加按钮不再是 primary（会跟整行 ghost 打架）").not.toContain('className="btn sm primary"');
    expect(src).toContain('className="btn sm msp-add"');
  });

  it("可点卡片有手型光标", () => {
    const css = read(CSS);
    expect(css).toMatch(/\.theme-card,\s*\.preset-card,\s*\.layout-slot \{ cursor: pointer; \}/);
  });
});

describe("P158-B · 插件详情两栏与危险区", () => {
  it("宽卡两栏（container query 收单列），不再把内容挤在左半张卡里", () => {
    const css = read(CSS);
    expect(css, "详情没有容器查询上下文").toMatch(/\.plg-detail \{[^}]*container-type: inline-size/);
    expect(css, "两栏网格不见了").toMatch(/\.plg-cols \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(240px, 300px\)/);
    expect(css, "窄卡没有收单列").toContain("@container (max-width: 720px)");
  });

  it("危险区成区：红调底 + 自己的标题 + 描边卸载（不再整块实红）", () => {
    const css = read(CSS);
    expect(css, "没有 danger-zone 规则").toContain(".plg-danger-zone {");
    expect(css, "卸载仍是实心红块").toMatch(/\.plg-danger-zone \.plg-actions \.btn\.danger \{[^}]*background: transparent/);
    const src = read(DIALOG);
    expect(src, "JSX 没有危险区").toContain('className="plg-danger-zone"');
    expect(src, "P157-E1 的危险组入口被拆没了").toContain('className="plg-actions plg-danger"');
  });

  it("空态有类型图标；插件行有轻 hover", () => {
    expect(read(DIALOG), "空态还是只有一行字").toMatch(/className="plg-empty">\s*<IconPuzzle \/>/);
    expect(read(CSS), "行没有 hover 回应").toContain(".plg-item:hover { border-color: var(--line-strong); }");
  });
});
