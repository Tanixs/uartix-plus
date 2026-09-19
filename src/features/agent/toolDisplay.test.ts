import { describe, expect, it } from "vitest";
import { parseArgs, receiptRows, receiptStatusText, summarizeArgs, TOOL_LABEL } from "./toolDisplay";

describe("toolDisplay：Agent 工具人类可读展示（P88d ④）", () => {
  it("parseArgs：合法对象/坏 JSON/数组/非对象全部安全回退", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs(undefined)).toEqual({});
    expect(parseArgs("{坏")).toEqual({});
    expect(parseArgs("[1,2]")).toEqual({});
    expect(parseArgs('"str"')).toEqual({});
  });

  it("summarizeArgs：登记工具产出中文摘要，未登记返回空串", () => {
    expect(summarizeArgs("save_plugin", { kind: "panel", name: "巡检台", enable: true })).toBe(
      "保存面板插件「巡检台」并启用",
    );
    expect(summarizeArgs("settings_apply_patch", { patch: { theme: "dark", zoom: 110 } })).toBe(
      "修改 theme、zoom",
    );
    expect(summarizeArgs("plot_window", { channels: ["a", "b"], points: 200 })).toBe("采样 2 通道 · 每道 200 点");
    expect(summarizeArgs("mystery_tool", { x: 1 })).toBe("");
  });

  it("receiptStatusText：成功/失败码全部中文化，未知码回显", () => {
    expect(receiptStatusText(true, "applied")).toBe("已完成");
    expect(receiptStatusText(false, "not_executed", "preview_only")).toBe("仅预览未执行");
    expect(receiptStatusText(false, "error", "weird_code")).toBe("weird_code");
  });

  it("receiptRows：标量直列、嵌套对象折叠键名、数组限量、绝不抛错", () => {
    expect(receiptRows(null)).toEqual([]);
    expect(receiptRows(42)).toEqual([{ k: "结果", v: "42" }]);
    const rows = receiptRows({ ok: true, pluginId: "user.a.b", caps: ["ui.widget"], deep: { x: 1, y: 2 } });
    expect(rows.find((r) => r.k === "ok")?.v).toBe("true");
    expect(rows.find((r) => r.k === "caps")?.v).toContain("ui.widget");
    expect(rows.find((r) => r.k === "deep")?.v).toContain("对象 {x, y}");
  });

  it("TOOL_LABEL 覆盖 Agent 专属工具名", () => {
    for (const name of ["save_plugin", "enable_plugin", "list_plugins", "settings_apply_patch", "plot_window"]) {
      expect(TOOL_LABEL[name]).toBeTruthy();
    }
  });
});
