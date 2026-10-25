import { describe, expect, it } from "vitest";
import { parsePresetDoc, parseTaskDoc, composeTaskPrompt } from "./pluginContrib";

describe("P174-R5 · 预设 / 任务模板的包内数据解析", () => {
  it("预设：{layout,note} 或直接一份布局本体都能认；不像布局就拒", () => {
    const wrapped = parsePresetDoc(JSON.stringify({ layout: { panels: {}, groups: {} }, note: "专注模式" }));
    expect(wrapped.ok).toBe(true);
    expect(wrapped.note).toBe("专注模式");
    expect((wrapped.layout as { panels: unknown }).panels).toBeTruthy();

    const bare = parsePresetDoc(JSON.stringify({ groups: { a: 1 } }));
    expect(bare.ok).toBe(true);

    expect(parsePresetDoc("不是 json").ok).toBe(false);
    expect(parsePresetDoc(JSON.stringify({ hello: 1 }))).toMatchObject({ ok: false });
    expect(parsePresetDoc(JSON.stringify([1, 2, 3])).ok).toBe(false);
  });

  it("任务：必须有 goal；steps 里的坏条目被丢掉但不整体失败", () => {
    const ok = parseTaskDoc(JSON.stringify({ goal: "把温度通道画出来", steps: [{ tool: "plot_channels" }, { tool: "addChannel", args: { tpl: "t" }, note: "加温度" }, { nope: 1 }] }));
    expect(ok.ok).toBe(true);
    expect(ok.goal).toBe("把温度通道画出来");
    expect(ok.steps?.map((s) => s.tool)).toEqual(["plot_channels", "addChannel"]);

    expect(parseTaskDoc(JSON.stringify({ steps: [] }))).toMatchObject({ ok: false });
    expect(parseTaskDoc("{坏").ok).toBe(false);
  });

  it("拼给 AI 的那段话：目标 + 步骤，末尾两句是承诺边界（建议不硬执行、写操作照常批准）", () => {
    const text = composeTaskPrompt(
      { goal: "巡检一遍", steps: [{ tool: "plot_channels", args: { x: 1 }, note: "看通道" }] },
      { pluginName: "演示插件", title: "巡检" },
    );
    expect(text).toContain("巡检一遍");
    expect(text).toContain("1. plot_channels {\"x\":1} —— 看通道");
    expect(text).toContain("演示插件");
    expect(text).toContain("步骤是建议不是硬指令");
    expect(text).toContain("需要批准的就照常弹卡");
  });
});
