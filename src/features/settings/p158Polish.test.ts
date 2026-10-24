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

describe("P158-C · 首启与全局", () => {
  it("欢迎舞台仍是 300px（welcome.test 的等式），光晕只给管线卡", () => {
    const css = read(CSS);
    expect(css, "舞台高度被改了（两张卡会不等高）").toMatch(/\.wlc-body \{[^}]*height: 300px/);
    expect(css, "管线卡没有光晕").toContain(".wlc-body-pipeline::before");
    expect(read("shell/Welcome.tsx"), "没有按卡区分舞台 class").toContain("wlc-body-${slide.id}");
  });

  it("选区跟 accent；按压只在非 no-motion 下", () => {
    const css = read(CSS);
    expect(css, "选区还是系统蓝").toMatch(/::selection \{[^}]*var\(--accent\)/);
    expect(css, "按压没给 no-motion 留出口").toMatch(/:root:not\(\.no-motion\) \.theme-card:active/);
  });
});
