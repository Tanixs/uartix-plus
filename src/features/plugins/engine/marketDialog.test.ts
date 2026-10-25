/**
 * P174-R3/B3：市场入口不能被"清旧"顺手清掉。
 *
 * 旧货架 UI 退役了，但**插件市场这件事还在**：入口在插件管理工具栏，内容仍是 GitHub
 * `topic:uartix-plugin` 检索；弹窗外壳用回旧插件库的 `plg-overlay/plg-dialog`。
 */
import { describe, expect, it } from "vitest";
import { closeMarketDialog, isMarketDialogOpen, openMarketDialog, subscribeMarketDialog } from "./marketDialog";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(here, "..", "PluginLibraryDialog.tsx"), "utf8");
const section = readFileSync(join(here, "PluginEngineSection.tsx"), "utf8");
const market = readFileSync(join(here, "PluginMarketView.tsx"), "utf8");

describe("市场开关", () => {
  it("打开/关闭都通知订阅者", () => {
    let n = 0;
    const off = subscribeMarketDialog(() => n++);
    openMarketDialog();
    expect(isMarketDialogOpen()).toBe(true);
    closeMarketDialog();
    expect(isMarketDialogOpen()).toBe(false);
    expect(n).toBe(2);
    off();
    openMarketDialog();
    closeMarketDialog();
  });
});

describe("入口与外壳", () => {
  it("插件管理工具栏有「插件市场」按钮，且开的是同一个开关", () => {
    expect(body).toContain("openMarketDialog");
    expect(body).toContain('tx("插件市场", "Plugin market")');
  });
  it("富详情与预览图轮播：README 图、左右切换、返回", () => {
    expect(market).toContain("function RepoDetail(");
    expect(market).toContain("readmeImagesForRepo(");
    expect(market).toContain("slides.length > 1");
    expect(market).toContain("← 返回市场");
  });
  it("卡片左栏是封面砖：仓库根的 cover 优先，取不到用名字砖，不出现破图", () => {
    expect(market).toContain("function RepoCover(");
    expect(market).toContain("repoCover(");
    expect(market).toContain("plg-mkt-cover");
    expect(market).toContain("coverInitials(");
    // 封面进详情的第一张：它是"这个包长什么样"的官方答案
    expect(market).toContain("props.cover ? [props.cover, ...imgs");
  });
  it("市场弹窗仍用 GitHub 话题视图与旧插件库外壳", () => {
    expect(section).toContain("useMarketDialogOpen");
    expect(section).toContain("<PluginMarketView");
    expect(section).toContain('className="plg-overlay"');
    expect(section).toContain('className="plg-dialog"');
  });
});
