/**
 * P174-R7②：「运行日志」那一面的判据。
 *
 * 这一面错了不会报错，只会"看不见"：轮转把最新那行截掉了、账本漏了一类事件、
 * 过滤器把 `EACCES` 这种大小写不同的搜不出来、跟随滚动把人从第 3 行拽回底部——
 * 每一种都是"用户以为自己没有日志"。所以这些形状全部在这里钉死。
 */

import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  LEVEL_ORDER,
  describeJournalEvent,
  filterLines,
  formatHostLine,
  hhmmss,
  hostLinesOfAll,
  ledgerLinesOf,
  logBatchText,
  newlyFailed,
  renderText,
  statusOf,
  type OutputLine,
} from "./outputModel";
import type { JournalEvent } from "./journal";
import type { InstalledPlugin } from "./pluginEngine";

const line = (over: Partial<OutputLine>): OutputLine => ({
  at: 1000,
  channel: "host",
  pluginId: "a.b",
  pluginName: "AB",
  level: "info",
  text: "hello",
  ...over,
});

/** 只填这一面真正读到的字段，其余按 never 交出去（引擎对象要 Tauri 才能造，这里不造整只）。 */
function fakeEntry(id: string, name: string, logs: { at: number; level: string; text: string }[], phase = "running", pid?: number): InstalledPlugin {
  return { id, manifest: { name }, logs, phase, ...(pid === undefined ? {} : { pid }) } as unknown as InstalledPlugin;
}

describe("logBatchText（落盘的那一批长什么样）", () => {
  it("每行带 ISO 时刻与级别，批次以换行结尾", () => {
    const out = logBatchText([{ at: 0, level: "warn", text: "低热" }]);
    expect(out.startsWith("[1970-01-01T00:00:00.000Z] [warn] 低热\n")).toBe(true);
  });

  it("空批得到空串——上层据此不碰磁盘", () => {
    expect(logBatchText([])).toBe("");
  });

  it("行内混进来的换行被压平：一行日志必须占一行文件", () => {
    const out = formatHostLine({ at: 0, level: "raw", text: "a\r\nb" });
    expect(out.endsWith("a\nb")).toBe(true);
    // 头部那一段（时刻 + 级别）也必须在同一行上
    expect(out.split("\n")[0]).toContain("[raw]");
  });
});

describe("describeJournalEvent（账本每一类事件都要有话说）", () => {
  const nameOf = (id: string) => (id === "a.b" ? "AB" : "");
  const trust = { version: "1.0.0", digest: "d", grantedAt: 5, grantedSummary: ["读工作区", "起 python"] };
  const item = { version: "1.0.0", digest: "d", installedAt: 1, source: "local", enabled: false } as const;

  const cases: [JournalEvent, string][] = [
    [{ t: "install", at: 1, id: "a.b", item }, "安装 AB v1.0.0（local）"],
    [{ t: "uninstall", at: 1, id: "a.b" }, "卸载 AB"],
    [{ t: "enable", at: 1, id: "a.b" }, "启用 AB"],
    [{ t: "disable", at: 1, id: "a.b" }, "停用 AB"],
    [{ t: "theme", at: 1, key: "plg:a.b:x" }, "切换主题 plg:a.b:x"],
    [{ t: "theme", at: 1, key: "" }, "切换主题 （回到内置）"],
    [{ t: "approve", at: 1, id: "a.b", trust }, "批准 AB v1.0.0 的权限（2 项）"],
    [{ t: "command", at: 1, id: "a.b", command: "yolo.status", ok: true }, "执行命令 yolo.status：有结果"],
    [{ t: "command", at: 1, id: "a.b", command: "yolo.stop", ok: false }, "执行命令 yolo.stop：无结果/出错"],
    [{ t: "profile", at: 1, id: "p1", name: "车间", action: "apply" }, "场景「车间」已应用"],
    [{ t: "profile", at: 1, id: "p1", name: "车间", action: "revert" }, "场景「车间」已回退"],
    [{ t: "root", at: 1, id: "a.b", spec: "$WS", path: "D:/ws", forWrite: true }, "绑定 $WS → D:/ws（AB · 写）"],
    [{ t: "root", at: 1, id: "", spec: "$EXT:deploy", path: "", forWrite: false }, "绑定 $EXT:deploy → （清除）（用户自己 · 只读）"],
  ];

  for (const [ev, want] of cases) {
    it(`${ev.t} → ${want}`, () => {
      expect(describeJournalEvent(ev, nameOf).text).toBe(want);
    });
  }

  it("没登记过的插件 id 不能显示成空（宁可用 id 本人）", () => {
    expect(describeJournalEvent({ t: "enable", at: 1, id: "x.y" }, nameOf).text).toBe("启用 x.y");
  });

  it("命令失败是 error 级，成功是 info 级（级别过滤器靠这个才分得开）", () => {
    expect(describeJournalEvent({ t: "command", at: 1, id: "a.b", command: "c", ok: false }, nameOf).level).toBe("error");
    expect(describeJournalEvent({ t: "command", at: 1, id: "a.b", command: "c", ok: true }, nameOf).level).toBe("info");
  });

  it("卸载是 warn 级：它不是错，但值得在「警告及以上」里被看见", () => {
    expect(LEVEL_ORDER[describeJournalEvent({ t: "uninstall", at: 1, id: "a.b" }, nameOf).level]).toBeGreaterThan(LEVEL_ORDER.info);
  });
});

describe("两个通道不是一条总线", () => {
  it("账本行带 ledger 标记，主题行的插件归属是空串", () => {
    const out = ledgerLinesOf([{ t: "theme", at: 7, key: "k" }, { t: "enable", at: 8, id: "a.b" }] as JournalEvent[], (i) => i);
    expect(out.map((l) => l.channel)).toEqual(["ledger", "ledger"]);
    expect(out[0].pluginId).toBe("");
    expect(out[1].pluginId).toBe("a.b");
  });

  it("宿主行按时间汇成一列（多插件并行时读的顺序就是这个）", () => {
    const entries = [
      fakeEntry("a.b", "AB", [{ at: 5, level: "info", text: "a5" }]),
      fakeEntry("c.d", "CD", [{ at: 1, level: "info", text: "c1" }, { at: 9, level: "error", text: "c9" }]),
    ];
    const out = hostLinesOfAll(entries);
    expect(out.map((l) => l.text)).toEqual(["c1", "a5", "c9"]);
    expect(out[2].level).toBe("error");
    expect(out.every((l) => l.channel === "host")).toBe(true);
  });
});

describe("filterLines（三条判据都会静默出错）", () => {
  const all = [
    line({ text: "EACCES 拒绝", level: "error", at: 3 }),
    line({ text: "started", level: "info", at: 2 }),
    line({ text: "debug 一点", level: "debug", at: 1 }),
    line({ channel: "ledger", pluginId: "", text: "切换主题", level: "info", at: 4 }),
  ];

  it("通道之间不串门", () => {
    expect(filterLines(all, { channel: "host", pluginId: "", minLevel: null, query: "" })).toHaveLength(3);
    expect(filterLines(all, { channel: "ledger", pluginId: "", minLevel: null, query: "" })).toHaveLength(1);
  });

  it("级别是「及以上」而不是等值", () => {
    const out = filterLines(all, { channel: "host", pluginId: "", minLevel: "warn", query: "" });
    expect(out.map((l) => l.level)).toEqual(["error"]);
    expect(filterLines(all, { channel: "host", pluginId: "", minLevel: "info", query: "" })).toHaveLength(2);
  });

  it("关键词大小写不敏感，插件名也能搜，纯空白当没输入", () => {
    expect(filterLines(all, { channel: "host", pluginId: "", minLevel: null, query: "eacces" })).toHaveLength(1);
    expect(filterLines(all, { channel: "host", pluginId: "", minLevel: null, query: "AB" })).toHaveLength(3);
    expect(filterLines(all, { channel: "host", pluginId: "", minLevel: null, query: "   " })).toHaveLength(3);
  });

  it("账本里没有插件归属的行（主题）在「全部插件」下可见、按插件筛时消失", () => {
    expect(filterLines(all, { channel: "ledger", pluginId: "", minLevel: null, query: "" })).toHaveLength(1);
    expect(filterLines(all, { channel: "ledger", pluginId: "a.b", minLevel: null, query: "" })).toHaveLength(0);
  });
});

describe("newlyFailed（只在「新落到 failed」那一次喊）", () => {
  const failed = (error = "") => ({ id: "a.b", phase: "failed", error, manifest: { name: "AB" }, logs: [] }) as unknown as InstalledPlugin;

  it("starting → failed 报，且带上失败原因", () => {
    const out = newlyFailed({ "a.b": "starting" }, [failed("宿主 8 秒内没有回应 ready")]);
    expect(out).toEqual([{ id: "a.b", name: "AB", error: "宿主 8 秒内没有回应 ready" }]);
  });

  it("已经 failed 的不再重复报（否则每次刷新都喊一遍）", () => {
    expect(newlyFailed({ "a.b": "failed" }, [failed()])).toEqual([]);
  });

  it("回收与正常停止不喊：那是设计里的正常路径", () => {
    const stopped = { id: "a.b", phase: "stopped", manifest: { name: "AB" }, logs: [] } as unknown as InstalledPlugin;
    const running = { id: "a.b", phase: "running", manifest: { name: "AB" }, logs: [] } as unknown as InstalledPlugin;
    expect(newlyFailed({ "a.b": "running" }, [stopped])).toEqual([]);
    expect(newlyFailed({}, [running])).toEqual([]);
  });
});

describe("statusOf / renderText / hhmmss", () => {
  it("starting 与 running 都算「在跑」，failed 不算", () => {
    const s = statusOf([
      fakeEntry("a", "A", [{ at: 1, level: "error", text: "炸了" }], "running", 11),
      fakeEntry("b", "B", [], "starting"),
      fakeEntry("c", "C", [], "failed"),
    ]);
    expect(s.running.map((r) => r.id)).toEqual(["a", "b"]);
    expect(s.running[0].pid).toBe(11);
    expect(s.errored).toBe(1);
  });

  it("成文每行是「[级别] 插件 · 文本」，有时刻才带时刻（可直接贴进工单）", () => {
    expect(renderText([line({ at: 0, level: "warn", text: "低热" })])).toBe("[warn] AB · 低热");
    expect(renderText([line({ at: 1700000000000, text: "x" })])).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d \[info\] AB · x$/);
  });

  it("没有时刻的行不假装知道时间", () => {
    expect(hhmmss(0)).toBe("--:--:--");
  });

  it("通道清单就两个，且都有中英两句话", () => {
    expect(CHANNELS.map((c) => c.id)).toEqual(["host", "ledger"]);
    for (const c of CHANNELS) expect(c.zh && c.en).toBeTruthy();
  });
});
