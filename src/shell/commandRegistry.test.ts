import { describe, expect, it } from "vitest";
import { buildCommands, filterCommands, type PaletteDeps } from "./commandRegistry";
import { panelGroupsAddable } from "../panels/panelMenu";
import { WORKSPACE_META } from "./workspaceMeta";
import { RAIL_ITEMS } from "./railState";

/**
 * B9 命令面板的注册表测试。
 *
 * 只测**派生关系与排序**，不测渲染 —— 渲染要真挂载 + 键盘，成本高收益低（组件本身很简单）。
 * 真正值得钉的是那条硬规矩：**条目必须从已有事实源派生**。
 * 手抄一份面板清单不会报错，只会让某个新面板"在命令面板里凭空不存在"，
 * 而这种缺失没人会去对 —— 所以这里断言的是"数量与内容等于事实源"，不是"等于我抄的数"。
 */

function depsWith(over: Partial<PaletteDeps> = {}): PaletteDeps {
  const ran: string[] = [];
  const d: PaletteDeps = {
    panelTitleOf: (id) => `标题:${id}`,
    openPanel: () => ran.push("openPanel"),
    openPanels: [],
    applyPreset: () => ran.push("preset"),
    resetLayout: () => ran.push("reset"),
    editLayout: () => ran.push("edit"),
    slots: [],
    applySlot: () => ran.push("slot"),
    openRail: () => ran.push("rail"),
    toggleConnect: () => ran.push("connect"),
    connected: false,
    toggleRecord: () => ran.push("record"),
    recording: false,
    toggleDemo: () => ran.push("demo"),
    demoOn: false,
    openAi: () => ran.push("ai"),
    openMarket: () => ran.push("market"),
    openSettings: () => ran.push("settings"),
    openHelp: () => ran.push("help"),
    restartTour: () => ran.push("tour"),
    setTheme: () => ran.push("theme"),
    setLocale: () => ran.push("locale"),
    setZoom: () => ran.push("zoom"),
    locale: "zh",
    zoom: 100,
    extensionCommands: [],
    profileCommands: [],
    ...over,
  };
  return d;
}

const addableIds = () => panelGroupsAddable().flatMap((g) => g.ids);

describe("buildCommands：条目从事实源派生，不另立清单", () => {
  it("面板条目数 = panelGroupsAddable 的 id 数（加面板就自动多一条）", () => {
    const ids = addableIds();
    const panelCmds = buildCommands(depsWith()).filter((c) => c.id.startsWith("panel:"));
    expect(panelCmds).toHaveLength(ids.length);
    expect(panelCmds.map((c) => c.id.slice("panel:".length))).toEqual([...ids]);
  });

  it("已退役的 templates 不进面板条目（沿用入口过滤，不在这里再判一次）", () => {
    const cmds = buildCommands(depsWith());
    expect(cmds.some((c) => c.id === "panel:templates")).toBe(false);
    // 但"协议"导轨项还在 —— 内容搬进去了，入口没消失
    expect(cmds.some((c) => c.id === "rail:templates")).toBe(true);
  });

  it("预设条目 = WORKSPACE_META 全量；导轨条目 = RAIL_ITEMS 全量", () => {
    const cmds = buildCommands(depsWith());
    expect(cmds.filter((c) => c.id.startsWith("preset:"))).toHaveLength(WORKSPACE_META().length);
    expect(cmds.filter((c) => c.id.startsWith("rail:"))).toHaveLength(RAIL_ITEMS.length);
  });

  it("命名槽由注入决定：给了就有，删了就没（不缓存第二份列表）", () => {
    const withSlots = buildCommands(depsWith({ slots: [{ id: "s1", name: "我的布局" }] }));
    expect(withSlots.some((c) => c.id === "slot:s1")).toBe(true);
    expect(buildCommands(depsWith()).some((c) => c.id.startsWith("slot:"))).toBe(false);
  });

  it("连接 / 录制 / 演示源 的标题随状态变，而不是写死一个动词", () => {
    /* 断言的是"标题跟着状态走"这个不变量，不是某个具体字串 ——
       `tx()` 在运行时读真实 locale（node 下恒为 zh），把英文文案写进断言
       等于测了一件本模块并不控制的事。 */
    const off = buildCommands(depsWith());
    const on = buildCommands(depsWith({ connected: true, recording: true, demoOn: true }));
    const title = (cmds: ReturnType<typeof buildCommands>, id: string) =>
      cmds.find((c) => c.id === id)?.title;
    for (const id of ["link:connect", "link:record", "link:demo"]) {
      expect(title(on, id), id).toBeTruthy();
      expect(title(on, id), id).not.toBe(title(off, id));
    }
  });

  it("语言切换只改「切换语言」那一条的指向（它是唯一按 locale 决定文案的动作）", () => {
    const zh = buildCommands(depsWith({ locale: "zh" })).find((c) => c.id === "locale");
    const en = buildCommands(depsWith({ locale: "en" })).find((c) => c.id === "locale");
    expect(zh?.title).not.toBe(en?.title);
    expect(zh?.keywords).toBe(en?.keywords);
  });

  it("「已打开」标注来自 openPanels，不自己数 dockview", () => {
    const cmds = buildCommands(depsWith({ openPanels: ["console"] }));
    expect(cmds.find((c) => c.id === "panel:console")?.hint).toBeTruthy();
    expect(cmds.find((c) => c.id === "panel:table")?.hint).toBeUndefined();
  });
});

describe("P174-G1：插件贡献的命令", () => {
  it("命令条目原样进「插件」分组，run 是 App 注入的那一个", () => {
    let ran = "";
    const cmds = buildCommands(
      depsWith({
        extensionCommands: [
          { id: "plugin:a.b:yolo.train", title: "开始训练", hint: "示例插件", run: () => { ran = "ok"; } },
        ],
      }),
    );
    const c = cmds.find((x) => x.id === "plugin:a.b:yolo.train");
    expect(c).toBeTruthy();
    expect(c).toMatchObject({ group: "插件", title: "开始训练", hint: "示例插件" });
    c!.run();
    expect(ran).toBe("ok");
  });

  it("没有插件命令就不多出一个空分组（插件全停用后分组跟着消失）", () => {
    expect(buildCommands(depsWith()).some((c) => c.group === "插件")).toBe(false);
  });

  it("跨插件的同名命令按 pluginId 区分，且都能按插件 id 搜到", () => {
    const cmds = buildCommands(
      depsWith({
        extensionCommands: [
          { id: "plugin:a.b:yolo.train", title: "开始训练", run: () => {} },
          { id: "plugin:c.d:yolo.train", title: "开始训练", run: () => {} },
        ],
      }),
    );
    expect(cmds.filter((c) => c.id.startsWith("plugin:"))).toHaveLength(2);
    expect(filterCommands(cmds, "a.b").map((c) => c.id)).toContain("plugin:a.b:yolo.train");
  });
});

describe("P174-B2：工作场景命令", () => {
  it("场景命令进「工作场景」分组，run 原样保留；没有场景就不出现空分组", () => {
    let ran = "";
    const cmds = buildCommands(
      depsWith({
        profileCommands: [
          { id: "profile:apply:p1", title: "应用场景：YOLO", hint: "使用中", run: () => { ran = "ok"; } },
        ],
      }),
    );
    const c = cmds.find((x) => x.id === "profile:apply:p1");
    expect(c).toMatchObject({ group: "工作场景", title: "应用场景：YOLO", hint: "使用中" });
    c!.run();
    expect(ran).toBe("ok");
    expect(buildCommands(depsWith()).some((x) => x.group === "工作场景")).toBe(false);
  });

  it("中英文关键词都能搜到场景命令", () => {
    const cmds = buildCommands(
      depsWith({ profileCommands: [{ id: "profile:save-current", title: "把当前状态保存为场景", run: () => {} }] }),
    );
    expect(filterCommands(cmds, "workspace").some((c) => c.id === "profile:save-current")).toBe(true);
    expect(filterCommands(cmds, "场景").some((c) => c.id === "profile:save-current")).toBe(true);
  });
});

describe("filterCommands：排序与检索", () => {
  const list = buildCommands(depsWith());
  const titles = (r: typeof list) => r.map((c) => c.title);

  it("空查询返回原序（截到 limit），不做任何打分", () => {
    expect(filterCommands(list, "")).toEqual(list.slice(0, 40));
    expect(filterCommands(list, "   ")).toEqual(list.slice(0, 40));
  });

  it("整串命中排在纯子序列命中之前", () => {
    const r = filterCommands(list, "演示源");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].title).toContain("演示源");
  });

  it("英文关键词要能捞到中文标题（中文界面下用户会打英文）", () => {
    const r = filterCommands(list, "demo");
    expect(titles(r).some((t) => t.includes("演示源"))).toBe(true);
  });

  it("面板 id 也能搜：plot 找到 2D 曲线", () => {
    const r = filterCommands(list, "plot");
    expect(r.some((c) => c.id === "panel:plot2d")).toBe(true);
  });

  it("隔很远的子序列不能盖过贴着命中的", () => {
    const r = filterCommands(list, "zoom");
    expect(r[0].id.startsWith("zoom:")).toBe(true);
  });

  it("limit 生效，且无匹配返回空而不是全量", () => {
    expect(filterCommands(list, "z", 3)).toHaveLength(3);
    expect(filterCommands(list, "zzzzqqqq")).toEqual([]);
  });
});
