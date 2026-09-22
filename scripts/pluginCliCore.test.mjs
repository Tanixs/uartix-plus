/**
 * P99c-C1b：命令行 CLI 纯逻辑测试（解析 / 通道 / 渲染）。
 * 这里最硬的一条是「只发 cli. 前缀」：命令行与 MCP 两条通道各自收窄，
 * 才是 Q7「AI 只读不装」真正落地的形状——任何一侧放宽，另一侧的钉就白设。
 */
import { describe, expect, it } from "vitest";

const core = await import("./plugin-cli-core.ts");
const { COMMANDS, USAGE, argsFor, kindFor, parseArgs, render } = core;

describe("plugin-cli · 通道只发 cli. 一族", () => {
  it("每条命令都落在 cli. 命名空间里", () => {
    const kinds = Object.values(COMMANDS);
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    expect(kinds.every((k) => k.startsWith("cli."))).toBe(true);
    expect(kindFor("list")).toBe("cli.market_list");
  });

  it("没有 install / update / remove：写侧要等任务面，不在这条通道上", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(["info", "installed", "list", "status"]);
    expect(USAGE).toContain("装包与更新暂时不在命令行里");
  });
});

describe("plugin-cli · 参数解析不猜默认值", () => {
  it("空参数与 --help 都出用法（不默认执行一条命令）", () => {
    expect(parseArgs([]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("没这个命令、缺 id、坏 --limit、不认识的选项，各自报对", () => {
    expect(() => parseArgs(["nope"])).toThrow(/没有这个命令/);
    expect(() => parseArgs(["info"])).toThrow(/要跟一个货架 id/);
    expect(() => parseArgs(["list", "--limit", "abc"])).toThrow(/正整数/);
    expect(() => parseArgs(["list", "--nope", "x"])).toThrow(/不认识选项/);
    expect(() => parseArgs(["list", "--query"])).toThrow(/后面要跟一个值/);
    expect(() => parseArgs(["info", "a", "b"])).toThrow(/只接受一个 id/);
    expect(() => parseArgs(["info", "a", "--query", "q"])).toThrow(/info 不接受/);
  });

  it("参数只带这条命令用得上的字段", () => {
    expect(argsFor(parseArgs(["info", "uartix.theme.ink"]))).toEqual({ id: "uartix.theme.ink" });
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
