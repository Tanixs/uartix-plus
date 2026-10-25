/**
 * P174-R2：v3 插件发布内容的纯部分。
 *
 * 真正出网在 Rust；这里只钉 README 的必填事实（名字、版本、id、贡献面），
 * 免得发出去的仓库连"装什么"都说不清。
 */
import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "./pluginEngine";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
const { buildReadmeV3 } = await import("./pluginPublish");

function p(): InstalledPlugin {
  return {
    id: "uartix.yolo",
    manifest: {
      name: "YOLO 训练工作台",
      version: "0.1.0",
      description: "数据集到部署",
      author: "uartix",
      license: "MIT",
      contributes: {
        panels: [{ id: "train", title: "YOLO 训练", entry: "panel.html" }],
        commands: [{ id: "yolo.train", title: "开始训练" }],
        themes: [{ id: "dark", title: "暗色", entry: "theme.css" }],
      },
    },
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
  } as unknown as InstalledPlugin;
}

describe("buildReadmeV3", () => {
  it("写明名称/版本/id/作者/许可证与贡献面", () => {
    const r = buildReadmeV3(p(), { name: "YOLO（显示名）", updatedAt: 1 });
    expect(r).toContain("# YOLO（显示名）");
    expect(r).toContain("`0.1.0`");
    expect(r).toContain("uartix.yolo");
    expect(r).toContain("MIT");
    expect(r).toContain("YOLO 训练");
    expect(r).toContain("开始训练");
    expect(r).toContain("暗色");
    expect(r).toContain("uartix-plugin");
  });
});
