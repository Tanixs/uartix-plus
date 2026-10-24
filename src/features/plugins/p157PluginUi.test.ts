/**
 * P157-E1 · 插件管理页层级重排的形状钉（详设 §P157-E1）。
 *
 * 用户原话："设置页插件管理页给我优化一下，感觉层级有点混乱，不好看。"
 * 真凶两条：①页中页——设置页页头已经是「插件管理」，内容区又顶一层「本地插件库」
 * 大标题；②六节详情同权重平铺、危险动作混在信息里排成一条长队。
 * 钉的是这两条的接线形状；"看上去顺不顺"归验收截图。
 */
import { describe, expect, it } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

const DIALOG = "features/plugins/PluginLibraryDialog.tsx";

describe("P157-E1 · 插件页去页中页 + 分区与危险组", () => {
  it("「本地插件库」大标题只在弹窗模式（onClose）渲染：内嵌设置页时没有它", () => {
    const src = read(DIALOG);
    expect(src, "大标题不再是 onClose 条件渲染（页中页会回来）").toMatch(
      /\{onClose \? \(\s*<div className="plg-head">/,
    );
    const modal = read("features/settings/SettingsModal.tsx");
    expect(modal, "设置页没有以无 onClose 形态内嵌插件库").toContain("<PluginManagerBody />");
  });

  it("市场/导入住工具栏（右端），不再挂在标题行", () => {
    const src = read(DIALOG);
    const toolbar = src.indexOf('className="plg-toolbar"');
    const market = src.indexOf('{tx("插件市场"');
    expect(toolbar).toBeGreaterThan(-1);
    expect(market, "插件市场按钮不在工具栏之后（还在标题行里？）").toBeGreaterThan(toolbar);
  });

  it("详情分区升语义 h4（六节），危险动作收进 plg-danger 一组", () => {
    const src = read(DIALOG);
    const h4s = src.match(/<h4 className="plg-sec">/g) ?? [];
    expect(h4s.length, `详情分区标题应≥6 个 h4，实测 ${h4s.length}`).toBeGreaterThanOrEqual(6);
    expect(src, "危险动作组不见了（导出/复制/回滚/卸载不再成组）").toContain('className="plg-actions plg-danger"');
    const css = read("styles/theme.css");
    expect(css, "危险组没有样式").toContain(".plg-actions.plg-danger {");
    expect(css, "封面砖没有样式").toContain(".plg-cover {");
    expect(src, "行首封面砖不见了").toContain('className="plg-cover"');
  });

  it("内嵌时列表不自滚（唯一滚动口是 .set-content）", () => {
    const css = read("styles/theme.css");
    expect(css, "双层滚动会回来").toContain(".set-plg-embed .plg-list { overflow-y: visible; }");
  });
});
