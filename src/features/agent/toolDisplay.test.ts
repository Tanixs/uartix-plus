import { describe, expect, it, vi } from "vitest";
// hostEntries 会把工具组（含 settingsStore/pluginStore）拉进依赖图，这些 store 在模块
// 初始化时就摸 localStorage。静态 import 会被提升到 stub 之前执行，所以这里必须用
// 项目既有的"先 stub 再 await import"写法（与 generalTools.test / uiTools.test 同一手法）。
const memStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memStorage.set(k, v),
  removeItem: (k: string) => void memStorage.delete(k),
});
// hostEntries → uiTools → uiSurface → panels 注册表：panels 会把 Plot2D 等具体面板拉进来，
// 而 Plot2D 在求值期就调 sessionStore.getSnapshot（§8-33 在册的历史包袱）。
// 与 uiTools.test / agentRun.test 同一手法：只挡这一层，不改变被测逻辑。
vi.mock("../../panels/panels", () => ({ panelTitleOf: (id: string) => `标题:${id}` }));
const { actionKindLabel, parseArgs, receiptRows, receiptStatusText, summarizeArgs, toolLabel } = await import("./toolDisplay");
// P99a-A5：中文名与参数摘要从注册表派生，`TOOL_LABEL` 那张手抄表已删；
// 这里的"全部登记"检查因此改成对 entry 本身的穷举检查（漏配＝红）
const { hostEntryByName, hostEntryNames } = await import("./hostEntries");

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
    expect(summarizeArgs("settings_preview_patch", { patch: { theme: "dark", zoom: 110 } })).toBe(
      "修改 theme、zoom",
    );
    // 摘要读的是**真实参数名**（旧 summarizeArgs 读 args.channels/args.points，
    // 而 schema 上是 channelIds/maxPoints ⇒ 真机上这行永远显示「采样 ? 通道」）
    expect(summarizeArgs("plot_window", { channelIds: ["a", "b"], maxPoints: 200 })).toBe("采样 2 通道 · 每道 200 点");
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

  it("P99a-A5：每条宿主 entry 都自带中文名与参数摘要（旧版要另抄 TOOL_LABEL，漏配只静默显示 snake_case）", () => {
    const real = [
      "settings_read", "settings_describe", "settings_apply", "settings_preview_patch",
      "plot_channels", "plot_window", "read_artifact", "run_app_action",
      "save_plugin", "enable_plugin", "list_plugins", "rollback_plugin",
      "fs_read", "fs_list", "fs_write", "web_fetch", "web_search", "shell_exec",
      "theme_read", "theme_patch", "theme_preset", "image_swatch", "save_theme_extension", "style_commit",
      "ui_inventory", "ui_inspect", "style_patch", "style_revert", "app_state",
      "app_catalog", "app_read",
    ];
    // 清单本身也要跟注册表对齐：两边谁漂了都红
    expect(hostEntryNames().sort()).toEqual([...real].sort());
    for (const name of real) {
      const e = hostEntryByName(name);
      if (!e) throw new Error(`注册表里没有工具 ${name}（清单与注册表漂了）`);
      expect(e.labelZh.trim().length, `${name} 缺中文名`).toBeGreaterThan(0);
      expect(typeof e.summarize, `${name} 缺参数摘要`).toBe("function");
      // 模型侧投影绝不能带出宿主字段
      expect(Object.keys({ name: e.name, description: e.description, parameters: e.parameters }).sort())
        .toEqual(["description", "name", "parameters"]);
    }
  });

  it("P97-I6：升版与新建在卡片上要分得出来，产物种类中文名穷举", () => {
    // 新增 ArtifactKind 而未配中文名 → 这行会红（kindZh 已收成 Record<ArtifactKind,…>，tsc 同样会拦）
    expect(summarizeArgs("save_plugin", { kind: "panel", name: "电池", update: "user.agent.x" })).toBe("更新插件「电池」");
    expect(summarizeArgs("save_plugin", { kind: "panel", name: "电池" })).toBe("保存面板插件「电池」");
    expect(summarizeArgs("save_plugin", { kind: "未知种类", name: "X" })).toBe("保存未知种类插件「X」");
    expect(summarizeArgs("rollback_plugin", { id: "user.agent.a" })).toBe("退回插件 user.agent.a 上一版");
  });

  it("P90 B5：run_app_action 摘要按 kind 中文化并带上目标名", () => {
    expect(summarizeArgs("run_app_action", { kind: "setTheme", args: { name: "begonia" } })).toBe("切换主题「begonia」");
    expect(summarizeArgs("run_app_action", { kind: "removeCard", args: { id: "card-9" } })).toBe("删除卡片「card-9」");
    expect(summarizeArgs("run_app_action", { kind: "openPanel" })).toBe("打开面板");
    expect(summarizeArgs("run_app_action", {})).toBe("执行应用动作");
  });

  it("P90 B5：未登记名可读兜底，不出现裸 snake_case / camelCase", () => {
    expect(toolLabel("brand_new_tool")).toBe("brand new tool");
    expect(toolLabel("save_plugin")).toBe("保存插件");
    expect(actionKindLabel("someFutureKind")).toBe("some future kind");
  });
});
