import { describe, expect, it } from "vitest";
import { PLUGIN_TOPIC, hasPluginTopic, parseSearchResponse, searchUrl, tarballUrl } from "./ghSearch";

/**
 * P174-A14：GitHub 话题检索的契约。
 *
 * 这些用例守的是"搜索结果被读错"这一类问题：读错了不会报错，只会让列表里出现
 * 一堆没有描述、点进去 404 的卡片，而用户以为"这个市场是空的/坏的"。
 */
describe("searchUrl", () => {
  it("默认带话题；关键词放在前面（GitHub 的 qualifier 位置不敏感，可读性优先）", () => {
    const u = searchUrl({ text: "yolo" });
    expect(u).toContain("https://api.github.com/search/repositories?q=");
    expect(decodeURIComponent(u)).toContain(`yolo topic:${PLUGIN_TOPIC}`);
    expect(u).toContain("sort=updated");
  });

  it("关键词里的引号/换行先洗掉（否则查询会变成另一条，现象是搜不到且不报错）", () => {
    const u = decodeURIComponent(searchUrl({ text: 'foo"bar\nbaz' }));
    expect(u).toContain("foo bar baz");
    expect(u).not.toContain('"');
  });

  it("空关键词时不留下空 qualifier（`topic:x ` 后面多个空格也算合法，但 URL 更好读）", () => {
    expect(decodeURIComponent(searchUrl({ text: "   " }))).toContain(`q=topic:${PLUGIN_TOPIC}&`);
  });

  it("perPage 夹在 1..50；关掉话题就是纯关键词（用户自己的选择）", () => {
    expect(searchUrl({ perPage: 999 })).toContain("per_page=50");
    expect(searchUrl({ perPage: 0 })).toContain("per_page=30");
    const u = decodeURIComponent(searchUrl({ text: "serial", topic: "" }));
    expect(u).toContain("q=serial&");
  });
});

describe("parseSearchResponse", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    full_name: "alice/uartix-yolo",
    name: "uartix-yolo",
    description: "YOLO 训练工作台",
    stargazers_count: 12,
    updated_at: "2026-10-20T03:04:05Z",
    default_branch: "main",
    html_url: "https://github.com/alice/uartix-yolo",
    topics: ["uartix-plugin", "yolo"],
    archived: false,
    ...over,
  });

  it("正常一条：字段齐全，`owner/name` 拆开", () => {
    const r = parseSearchResponse(JSON.stringify({ total_count: 1, items: [item()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.repos[0]).toMatchObject({ full: "alice/uartix-yolo", owner: "alice", name: "uartix-yolo", stars: 12 });
  });

  it("单条坏了只丢那一条（一支坏投稿不该让整个货架空掉）", () => {
    const r = parseSearchResponse(JSON.stringify({ total_count: 3, items: [item(), { nope: 1 }, item({ full_name: "b/c" })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.repos.map((x) => x.full)).toEqual(["alice/uartix-yolo", "b/c"]);
  });

  it("限流是一个**可识别的状态**，不是「空结果」（两者的处理方式完全不同）", () => {
    const r = parseSearchResponse(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rateLimited).toBe(true);
    expect(r.data.repos).toEqual([]);
  });

  it("不是 JSON ⇒ 明确报错（代理返回的 HTML 中间页会走到这里）", () => {
    const r = parseSearchResponse("<html>proxy</html>");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("不是 JSON");
  });

  it("信封里没有 items ⇒ 报错，而不是静默空列表", () => {
    const r = parseSearchResponse(JSON.stringify({ total_count: 0 }));
    expect(r.ok).toBe(false);
  });

  it("缺字段的条目用兜底值，不产出 undefined（`undefined` 会一路带进界面）", () => {
    const r = parseSearchResponse(JSON.stringify({ items: [{ full_name: "x/y" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.repos[0]).toMatchObject({ owner: "x", name: "y", description: "", stars: 0, defaultBranch: "main" });
    expect(r.data.repos[0].htmlUrl).toBe("https://github.com/x/y");
  });
});

describe("tarballUrl / hasPluginTopic", () => {
  it("归档直连 codeload（不欠一次 302——取回通道刻意不跟重定向）", () => {
    expect(tarballUrl({ owner: "a", name: "b", defaultBranch: "main" })).toBe(
      "https://codeload.github.com/a/b/tar.gz/refs/heads/main",
    );
  });

  it("分支名里的怪字符被剔掉（拼进 URL 前唯一一次清洗）", () => {
    expect(tarballUrl({ owner: "a", name: "b", defaultBranch: "f/x y" })).toBe(
      "https://codeload.github.com/a/b/tar.gz/refs/heads/f/xy",
    );
  });

  it("话题判定大小写不敏感", () => {
    expect(hasPluginTopic({ topics: ["UARTIX-Plugin"] } as never)).toBe(true);
    expect(hasPluginTopic({ topics: ["yolo"] } as never)).toBe(false);
  });
});
