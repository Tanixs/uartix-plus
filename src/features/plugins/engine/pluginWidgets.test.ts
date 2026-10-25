/**
 * P174-R4：小部件的可见性台账与接线。
 *
 * 这里钉的是"启用才出现、关闭只是本次会话、详情里能再打开"——不是样式。
 */
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));

const v = await import("./widgetVisibility");
const layer = readFileSync(join(here, "PluginWidgetLayer.tsx"), "utf8");
const view = readFileSync(join(here, "PluginViewPanel.tsx"), "utf8");
const section = readFileSync(join(here, "PluginEngineSection.tsx"), "utf8");
const app = readFileSync(join(here, "..", "..", "..", "App.tsx"), "utf8");
const manifest = readFileSync(join(here, "manifest.ts"), "utf8");
const draft = readFileSync(join(here, "..", "..", "agent", "draftTools.ts"), "utf8");

describe("可见性台账", () => {
  it("hide/show 通知订阅者；同一 key 幂等", () => {
    let n = 0;
    const off = v.subscribeWidgetVisibility(() => n++);
    const key = v.widgetKey("a.b", "clock");
    expect(v.isWidgetHidden(key)).toBe(false);
    v.hideWidget(key);
    v.hideWidget(key);
    expect(v.isWidgetHidden(key)).toBe(true);
    expect(n).toBe(1);
    v.showWidget(key);
    expect(v.isWidgetHidden(key)).toBe(false);
    expect(n).toBe(2);
    off();
  });
});

describe("命名（旧裁定：不叫桌宠）", () => {
  it("新引擎/新 UI/给 AI 的话里都不再引入 pet 产物或「桌宠」分类；无边框只是 widgets 的表现", () => {
    for (const [name, src] of [["manifest", manifest], ["layer", layer], ["section", section], ["draft", draft]] as const) {
      expect(src, name).not.toMatch(/桌宠|contributes\.pet|ui\.pet|onPet:/);
    }
    expect(manifest).toContain("transparent?: boolean");
  });
});

describe("接线", () => {
  it("App 挂了主窗口小部件层；面板视图支持 widget 的 bare iframe", () => {
    expect(app).toContain("<PluginWidgetLayer />");
    expect(view).toContain('kind?: "panel" | "widget"');
    expect(view).toContain("bare?: boolean");
    expect(view).toContain("contributes.widgets");
  });
  it("小部件层按 enabled+trusted 过滤，并支持拖动位置持久化", () => {
    expect(layer).toContain("panelEnabled(entry)");
    expect(layer).toContain("vs.pluginWidgets.v1");
    expect(layer).toContain("pointermove");
  });
  it("插件详情能重新显示被关掉的小部件", () => {
    expect(section).toContain("小部件");
    expect(section).toContain("showWidget(key)");
  });
});
