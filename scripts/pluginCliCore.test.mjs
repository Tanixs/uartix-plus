/**
 * P99c-C1b：命令行 CLI 纯逻辑测试（解析 / 通道 / 渲染）。
 * 这里最硬的一条是「只发 cli. 前缀」：命令行与 MCP 两条通道各自收窄，
 * 才是 Q7 真正落地的形状（外来代码进本机由人批准）——任何一侧放宽，另一侧的钉就白设。
 */
import { describe, expect, it } from "vitest";

const core = await import("./plugin-cli-core.ts");
const { COMMANDS, LOCAL_COMMANDS, USAGE, argsFor, isLocalCommand, kindFor, parseArgs, pollVerdict, render, waitedOutLine } = core;

describe("plugin-cli · 通道只发 cli. 一族", () => {
  it("每条命令都落在 cli. 命名空间里", () => {
    const kinds = Object.values(COMMANDS);
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    expect(kinds.every((k) => k.startsWith("cli."))).toBe(true);
    expect(kindFor("list")).toBe("cli.market_list");
  });

  it("写侧只有 install/progress 两条，且都落在 cli. 上；update 与 remove 还没做", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(["info", "install", "installed", "list", "progress", "status"]);
    expect(COMMANDS.install).toBe("cli.plugin_install");
    expect(COMMANDS.progress).toBe("cli.plugin_status");
    expect(USAGE).toContain("覆盖已有版本");
    expect(USAGE).toContain("这里没有跳过确认的开关");
    expect(USAGE).not.toContain("--yes");
  });

  it("validate 是**本地**命令：不进 COMMANDS 那张表，也不许被映射成桥动作（P99b-N6）", () => {
    expect(LOCAL_COMMANDS).toEqual(["validate"]);
    expect(Object.values(COMMANDS).join(" ")).not.toMatch(/validate/);
    expect(isLocalCommand("validate")).toBe(true);
    expect(isLocalCommand("install")).toBe(false);
    expect(() => kindFor("validate")).toThrow(/本地命令/);
    // 用法那句"除 validate 外"必须真存在，否则"离线可跑"又变成一句口头承诺
    expect(USAGE).toContain("除 validate 外的前提");
    expect(USAGE).toContain("本地命令（不用开应用、不联网）");
  });
});

describe("plugin-cli · 参数解析不猜默认值", () => {
  it("空参数与 --help 都出用法（不默认执行一条命令）", () => {
    expect(parseArgs([]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("没这个命令、缺 id、坏 --limit、不认识的选项，各自报对", () => {
    expect(() => parseArgs(["nope"])).toThrow(/没有这个命令/);
    // P99b-N6 把这句统一成「要跟一个参数：<要什么>」——三条命令三种参数，共用一个前缀，别各写一套话
    expect(() => parseArgs(["info"])).toThrow(/要跟一个参数：货架 id/);
    expect(() => parseArgs(["progress"])).toThrow(/要跟一个参数：token/);
    expect(() => parseArgs(["install"])).toThrow(/要跟一个参数：货架 id/);
    // validate 要的是**路径**，那句提示得说清给什么（写成"货架 id"会让人去 list 里找编号）
    expect(() => parseArgs(["validate"])).toThrow(/要跟一个参数：包路径/);
    expect(parseArgs(["validate", "market/pkg/a.uartix.json"]).id).toBe("market/pkg/a.uartix.json");
    expect(() => parseArgs(["validate", "x", "--query", "y"])).toThrow(/不接受/);
    expect(() => parseArgs(["list", "--limit", "abc"])).toThrow(/正整数/);
    expect(() => parseArgs(["list", "--nope", "x"])).toThrow(/不认识选项/);
    expect(() => parseArgs(["list", "--query"])).toThrow(/后面要跟一个值/);
    expect(() => parseArgs(["info", "a", "b"])).toThrow(/只接受一个参数/);
    expect(() => parseArgs(["info", "a", "--query", "q"])).toThrow(/info 不接受/);
    expect(() => parseArgs(["list", "--wait", "5"])).toThrow(/--wait 只对 install 有意义/);
    expect(() => parseArgs(["install", "a", "--limit", "5"])).toThrow(/install 不接受/);
  });

  it("参数只带这条命令用得上的字段", () => {
    expect(argsFor(parseArgs(["info", "uartix.theme.ink"]))).toEqual({ id: "uartix.theme.ink" });
    expect(argsFor(parseArgs(["install", "uartix.theme.ink"]))).toEqual({ id: "uartix.theme.ink" });
    expect(argsFor(parseArgs(["progress", "tok-1"]))).toEqual({ token: "tok-1" });
    expect(argsFor(parseArgs(["list"]))).toEqual({});
    expect(argsFor(parseArgs(["list", "--query", "题", "--category", "theme", "--sort", "name", "--limit", "5"]))).toEqual({
      query: "题", category: "theme", sort: "name", limit: 5,
    });
    expect(argsFor(parseArgs(["status"]))).toEqual({});
  });
});

describe("plugin-cli · 输出说实话", () => {
  const parsed = (argv) => parseArgs(argv);

  it("索引没就绪时打印的是「还没拿到」那句，不是「没有插件」", () => {
    const text = render({
      parsed: parsed(["list"]),
      data: { cards: [], total: 0, note: "索引还没拿到（桥只等 3 秒）：稍后再问一次。" },
    });
    expect(text).toContain("还没拿到");
    expect(text).not.toMatch(/货架上没有|没有插件/);
  });

  it("截断那句要照原样传给人", () => {
    const text = render({
      parsed: parsed(["list"]),
      data: {
        cards: [{ id: "a", name: "甲", category: "外观与主题", version: "1.0.0", install: "未安装", caps: ["主题 token"] }],
        total: 7, shown: 1, truncated: "还有 6 条没列出（--limit 或 --query 收窄）",
      },
    });
    expect(text).toContain("货架 7 条，这里列 1 条");
    expect(text).toContain("还有 6 条");
    expect(text).toContain("甲〈外观与主题〉");
  });

  it("status 只在真走了镜像时说走镜像；失败原因原文带出来", () => {
    const base = { status: "failed", entries: 0, dropped: 0, favorites: 0, viaMirror: false, appVersion: "0.4.1", error: "超时" };
    expect(render({ parsed: parsed(["status"]), data: base })).not.toContain("走的镜像");
    expect(render({ parsed: parsed(["status"]), data: { ...base, viaMirror: true } })).toContain("走的镜像");
    expect(render({ parsed: parsed(["status"]), data: base })).toContain("上次失败：超时");
  });

  it("info 把不放行的能力标出来（与界面同一份标记，不是 CLI 自己判断）", () => {
    const text = render({
      parsed: parsed(["info", "uartix.theme.ink"]),
      data: {
        name: "墨夜", category: "外观与主题", version: "1.0.0", install: "未安装", author: "uartix",
        updated: "2026-09-20", size: "671 B", sha256_12: "b".repeat(12), screenshots: 1, compat: "与本机版本兼容",
        descZh: "深蓝夜视",
        caps: [{ name: "运行 JS", note: "在沙箱里跑作者写的脚本", blocked: true }],
        note: "列表不等于背书：条目来自当前索引，不代表内容安全。",
      },
    });
    expect(text).toContain("〔不放行〕运行 JS");
    expect(text).toContain("1 张图");
    expect(text).toContain("不代表内容安全");
  });

  it("installed 两组都要出现，且说清只按 id 对照", () => {
    const text = render({
      parsed: parsed(["installed"]),
      data: {
        total: 2,
        onShelf: [{ name: "墨夜", local: "0.9.0", shelf: "1.0.0", state: "有更新" }],
        offShelf: [{ id: "user.local.thing", name: "自己的包", version: "1.0.0" }],
        offShelfNote: "不在货架上的 1 个只按 id 对照，不猜哪个对应哪个；启停与卸载去插件库看。",
      },
    });
    expect(text).toContain("本机 2 个包");
    expect(text).toContain("本机 v0.9.0");
    expect(text).toContain("不在货架上的 1 个");
    expect(text).toContain("只按 id 对照");
  });
});

describe("P99c-C1c · 轮询的判据与终态话术", () => {
  const parsed = (argv) => parseArgs(argv);

  it("install 的用法：起请求那句不当场下结论", () => {
    const text = render({ parsed: parsed(["install", "uartix.theme.ink"]), data: { ok: true, token: "t1", msg: "已受理：墨夜 v1.0.0", note: "受理不等于装好" } });
    expect(text).toContain("已受理（还没装好");
    expect(text).toContain("受理不等于装好");
    expect(render({ parsed: parsed(["install", "x"]), data: { ok: false, token: "", msg: "货架上没有", note: "没有开始任何取回" } })).toContain("没有开始");
  });

  it("done 才是 0；working 继续问；failed/rejected/gone 收 1", () => {
    expect(pollVerdict({ phase: "done", text: "装好了" })).toMatchObject({ settled: true, exit: 0 });
    expect(pollVerdict({ phase: "working", text: "正在取回" }).settled).toBe(false);
    for (const p of ["failed", "rejected", "gone"]) {
      expect(pollVerdict({ phase: p, text: "x" }), p).toMatchObject({ settled: true, exit: 1 });
    }
  });

  it("停在「等你确认」时说的是去应用里点，而不是失败", () => {
    const v = pollVerdict({ phase: "awaiting_you", token: "tk9", text: "覆盖已有版本：墨夜 v2.0.0" });
    expect(v.settled).toBe(true);
    expect(v.exit).toBe(1);
    expect(v.line).toContain("设置 → 插件管理");
    expect(v.line).toContain("progress tk9");
    expect(v.line).not.toMatch(/失败|error/i);
  });

  it("等不到终态那句的重点是「我没等到」，不是「没装上」", () => {
    const line = waitedOutLine("tk1", 120);
    expect(line).toContain("我没等到回执");
    expect(line).toContain("不等于");
    expect(line).toContain("progress tk1");
  });

  it("认不出来的状态就照实说认不出来（不翻译成一个像样的结论）", () => {
    const v = pollVerdict({ phase: "quantum", text: "" });
    expect(v.settled).toBe(true);
    expect(v.exit).toBe(1);
    expect(v.line).toContain("不认识的状态");
    expect(v.line).toContain("quantum");
  });

  it("--wait 有默认值也有封顶（不接受「永远等」）", () => {
    expect(parseArgs(["install", "a"]).wait).toBe(120);
    expect(parseArgs(["install", "a", "--wait", "30"]).wait).toBe(30);
    expect(parseArgs(["install", "a", "--wait", "9999"]).wait).toBe(600);
    expect(() => parseArgs(["install", "a", "--wait", "0"])).toThrow(/正整数/);
  });
});
