/**
 * P174-R2：旧 UI 接新引擎的接线钉 + 搜索判据。
 *
 * 这一层最容易退化的不是样式，而是**悄悄又接回旧 store**：旧列表还留着，
 * 有人把那行 `display:none` 删掉，用户就会同时看到两代插件。所以这里直接扫源文本。
 */
import { describe, expect, it } from "vitest";
import { pluginMatches } from "./pluginListQuery";
import type { InstalledPlugin } from "./pluginEngine";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));
const sectionSrc = readFileSync(join(here, "PluginEngineSection.tsx"), "utf8");
const oldUiSrc = readFileSync(join(here, "..", "PluginLibraryDialog.tsx"), "utf8");

function p(over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "uartix.yolo",
    manifest: { name: "YOLO 训练工作台", description: "数据集 → 训练 → 部署", contributes: {} },
    dir: "uartix.yolo",
    version: "0.1.0",
    installedAt: 0,
    source: "import",
    enabled: true,
    verdict: "trusted",
    permissions: [],
    config: {},
    themes: [],
    phase: "idle",
    logs: [],
    ...over,
  } as InstalledPlugin;
}

describe("新引擎列表的搜索", () => {
  it("名称 / id / 描述都能命中；空查询全过", () => {
    expect(pluginMatches(p(), "")).toBe(true);
    expect(pluginMatches(p(), "yolo")).toBe(true);
    expect(pluginMatches(p(), "uartix.yolo")).toBe(true);
    expect(pluginMatches(p(), "训练")).toBe(true);
    expect(pluginMatches(p(), "zzz")).toBe(false);
  });
});

describe("旧 UI 接线", () => {
  it("旧 UI 只剩壳：挂载新引擎列表，且不再 import 旧 pluginStore", () => {
    expect(oldUiSrc).toContain('import { PluginEngineSection } from "./engine/PluginEngineSection";');
    expect(oldUiSrc).toContain("<PluginEngineSection query={query} filter={filter} />");
    expect(oldUiSrc).not.toMatch(/from "\.\/pluginStore"/);
    expect(oldUiSrc).not.toContain("ref={listRef}");
  });

  it("YOLO 这类插件在旧 UI 里可启停/批准/打开面板/卸载；草稿可转正", () => {
    for (const s of ["setEnabled(", "approve(", "uninstall(", "requestOpenPanel(", "promoteDraft(", "commitDraftPromotion("]) {
      expect(sectionSrc, s).toContain(s);
    }
    expect(sectionSrc).not.toMatch(/from ".*pluginStore"/);
  });
});

describe("R3/R4：旧插件库的批量与两栏详情", () => {
  it("详情是左主栏 + 右侧信息栏，不是一条长列", () => {
    expect(sectionSrc).toContain('className="plg-cols"');
    expect(sectionSrc).toContain('className="plg-col-main"');
    expect(sectionSrc).toContain('className="plg-col-side"');
  });
  it("多选批量：选择开关、全选/反选、批量启停卸", () => {
    expect(sectionSrc).toContain('className="plg-batch"');
    expect(sectionSrc).toContain("setEnabledSet(");
    expect(sectionSrc).toContain("uninstallMany(");
    expect(sectionSrc).toContain("全选");
    expect(sectionSrc).toContain("反选");
  });
});

describe("R2-b：旧 UI 的详情能力迁入", () => {
  it("信息/配置/版本/发布四个区块都挂在新详情里", () => {
    for (const c of ["PluginMetaEditor", "PluginConfigEditor", "PluginVersions", "PluginPublishForm"]) {
      expect(sectionSrc, c).toContain(`<${c}`);
    }
  });
  it("封面/展示信息优先用本机元信息，而不是写回 manifest", () => {
    expect(sectionSrc).toContain("metaName(p.manifest.name, meta)");
    expect(sectionSrc).toContain("meta?.cover");
    expect(sectionSrc).not.toMatch(/manifest\.name\s*=/);
  });
});
