/**
 * P174-G1：插件命令的派生判据。
 *
 * 值得钉的是**门**：停用（或权限没批）后命令必须消失，而不是留在调色板里点出一个
 * "插件没启用"的错误。另外跨插件的同名命令 id 必须唯一，否则一条会静默顶掉另一条。
 */
import { describe, expect, it } from "vitest";
import { collectPluginCommands, type CommandSource } from "./commandBridge";

const manifest = (commands: { id: string; title: string }[]) => ({
  contributes: { commands },
});

const source = (over: Partial<CommandSource> = {}): CommandSource => ({
  id: "a.b",
  name: "示例插件",
  manifest: manifest([{ id: "yolo.train", title: "开始训练" }]),
  enabled: true,
  ...over,
});

describe("collectPluginCommands", () => {
  it("启用+已批准的命令才出现；停用的整包跳过", () => {
    const got = collectPluginCommands([source(), source({ id: "c.d", enabled: false })]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pluginId: "a.b", commandId: "yolo.train", title: "开始训练", pluginTitle: "示例插件" });
    expect(got[0].paletteId).toBe("plugin:a.b:yolo.train");
  });

  it("跨插件同名命令不会撞 id（清单校验只保证包内不重复）", () => {
    const got = collectPluginCommands([
      source({ id: "a.b", name: "甲" }),
      source({ id: "c.d", name: "乙" }),
    ]);
    expect(got.map((c) => c.paletteId)).toEqual(["plugin:a.b:yolo.train", "plugin:c.d:yolo.train"]);
    expect(new Set(got.map((c) => c.paletteId)).size).toBe(2);
  });

  it("排序按 paletteId（与目录列举顺序无关，同一台机器每次都一样）", () => {
    const got = collectPluginCommands([
      source({ id: "z.z", manifest: manifest([{ id: "b.act", title: "B" }, { id: "a.act", title: "A" }]) }),
      source({ id: "a.a" }),
    ]);
    expect(got.map((c) => c.paletteId)).toEqual(["plugin:a.a:yolo.train", "plugin:z.z:a.act", "plugin:z.z:b.act"]);
  });

  it("没有命令或没有插件时返回空数组，不抛", () => {
    expect(collectPluginCommands([])).toEqual([]);
    expect(collectPluginCommands([source({ manifest: manifest([]) })])).toEqual([]);
  });
});
