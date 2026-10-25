/**
 * P174-R4：旧插件系统 / 旧 AI 造物删除后的**反向守卫**。
 *
 * 删除最怕的不是"今天没删干净"，而是下一批有人顺手把某条旧边接回来：
 * 旧 store 没有类型、测试也可能恰好不覆盖那条路，于是它能一直活着而没人发现。
 * 这里只认**模块引用**与**注册表里的旧名字**，不扫注释——历史说明可以提旧名。
 */
import { describe, expect, it, vi } from "vitest";

const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});
vi.mock("../../panels/panels", () => ({ panelTitleOf: (id: string) => `标题:${id}` }));

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (p: string, opts: { withFileTypes: true }) => { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]features[/\\]plugins[/\\]?$/, "");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      sourceFiles(p, out);
    } else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 旧模块的路径后缀：只要 import/from/动态 import 还指着它们，就是旧系统回来了。 */
const FORBIDDEN_IMPORTS = [
  "plugins/pluginStore",
  "plugins/pluginManifest",
  "plugins/pluginId",
  "plugins/pluginToolDefs",
  "plugins/moduleHost",
  "plugins/moduleBus",
  "plugins/artifact",
  "ai/extensionStore",
  "ai/widgetShell",
  "ai/widgetHub",
  "ai/widgetBridge",
  "ai/WidgetFrame",
  "ai/WidgetFloats",
  "ai/WidgetDesktop",
  "ai/ExtPanel",
  "features/market",
  "./marketTools",
  "./pluginTools",
] as const;

describe("P174-R4 · 旧插件系统与旧 AI 造物不再被任何源码引用", () => {
  it("没有一处 import 还指着已删除的旧模块", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? "";
        if (FORBIDDEN_IMPORTS.some((bad) => spec.includes(bad))) hits.push(`${file.replace(SRC, "src")} → ${spec}`);
      }
    }
    expect(hits, `这些文件又把旧系统接回来了：\n${hits.join("\n")}`).toEqual([]);
  });

  it("注册表里不再有旧插件工具，动作面也不再有旧挂件动作", async () => {
    const { hostEntryNames } = await import("../agent/hostEntries");
    const { APP_ACTION_KINDS } = await import("../ai/appActionKinds");
    const names = hostEntryNames();
    for (const gone of ["save_plugin", "enable_plugin", "rollback_plugin", "list_plugins", "propose_market_install"]) {
      expect(names, `工具 ${gone} 又回到了注册表`).not.toContain(gone);
    }
    expect(APP_ACTION_KINDS as readonly string[]).not.toContain("popWidget");
    expect(APP_ACTION_KINDS as readonly string[]).not.toContain("removeWidget");
  });
});
