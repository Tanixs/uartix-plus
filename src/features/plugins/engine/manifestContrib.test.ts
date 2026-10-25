import { describe, expect, it } from "vitest";
import { validateExtension, PLUGIN_FORMAT, PLUGIN_SCHEMA_VERSION } from "./manifest";

/** 一份最小清单；presets/tasks 用例会往 contributes 里塞。 */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLUGIN_FORMAT,
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: "user.demo.studio",
    version: "1.0.0",
    name: "演示",
    activation: [],
    permissions: { ui: { panel: true } },
    contributes: { panels: [{ id: "main", title: "主", entry: "p.html" }] },
    ...over,
  };
}

describe("P174-R5 · presets / tasks 贡献面", () => {
  it("合法工作区预设要 permissions.ui.layout；归一后带 id/title/entry", () => {
    const ok = validateExtension(
      base({ permissions: { ui: { panel: true, layout: true } }, contributes: { presets: [{ id: "focus", title: "专注", entry: "preset.json" }] } }),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.manifest?.contributes.presets?.[0]).toEqual({ id: "focus", title: "专注", entry: "preset.json" });

    const noPerm = validateExtension(
      base({ permissions: { ui: { panel: true } }, contributes: { presets: [{ id: "focus", title: "专注", entry: "preset.json" }] } }),
    );
    expect(noPerm.ok).toBe(false);
    expect(noPerm.errors.join()).toContain("ui.layout");
  });

  it("合法任务模板不需要额外权限；只填不发送由宿主保证", () => {
    const ok = validateExtension(base({ contributes: { tasks: [{ id: "inspect", title: "巡检", entry: "task.json" }] } }));
    expect(ok.errors).toEqual([]);
    expect(ok.manifest?.contributes.tasks?.[0]).toMatchObject({ id: "inspect", title: "巡检", entry: "task.json" });
  });

  it("entry 必须是包内 JSON；不是 .json 就拒（免得点按钮时才炸）", () => {
    const r = validateExtension(
      base({ permissions: { ui: { panel: true, layout: true } }, contributes: { presets: [{ id: "p", title: "P", entry: "preset.yaml" }] } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("JSON");
  });

  it("id 非法 / 重复 / 超上限都拒", () => {
    const dup = validateExtension(
      base({
        permissions: { ui: { panel: true, layout: true } },
        contributes: { presets: [{ id: "a", title: "A", entry: "a.json" }, { id: "a", title: "B", entry: "b.json" }] },
      }),
    );
    expect(dup.errors.join()).toContain("重复");

    const badId = validateExtension(
      base({ permissions: { ui: { panel: true, layout: true } }, contributes: { presets: [{ id: "A up", title: "X", entry: "a.json" }] } }),
    );
    expect(badId.ok).toBe(false);

    const tooMany = validateExtension(
      base({ permissions: { ui: { panel: true, layout: true } }, contributes: { presets: Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, entry: "a.json" })) } }),
    );
    expect(tooMany.ok).toBe(false);
  });

  it("标题缺省回落到 id（别渲染空按钮）", () => {
    const r = validateExtension(
      base({ permissions: { ui: { panel: true, layout: true } }, contributes: { presets: [{ id: "solo", entry: "a.json" }] } }),
    );
    expect(r.manifest?.contributes.presets?.[0].title).toBe("solo");
  });
});
