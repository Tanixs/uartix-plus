/**
 * P157-E3 · GitHub 一键发布的牙。
 *
 * 这里钉三件最容易漂的事：
 *  ① 话题归一化必须与 Rust 同规则（大小写、空格/下划线、强制话题排第一、去重、上限 20）；
 *  ② 发布文件必须真的是"manifest + 封面 + README"，base64 解回来要与包逐字一致；
 *  ③ invoke 的键名/取值（isPrivate、owner null、话题首位）—— mock 掉 invoke 只能测"我们怎么调自己"，
 *     所以另有一条门禁把键名对着 Rust 形名核（check-invoke-args）；这里钉语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "./pluginStore";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const rec = {
  pkg: {
    format: "uartix-plugin",
    schemaVersion: 2,
    id: "user.theme.p157",
    version: "1.0.0",
    name: "P157 测试包",
    desc: "一个用于发布测试的包",
    author: "Tanix",
    homepage: "https://example.com/p157",
    cover: "data:image/jpeg;base64,AAAA",
    hostApi: "^1.0",
    capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", vars: {} } },
    provenance: { createdBy: "user", reviewed: false },
  },
  state: "enabled",
  nonce: "n",
  config: {},
  versions: [],
  createdAt: 1,
  updatedAt: 1,
} as unknown as PluginRecord;

function settings(extra: Record<string, unknown> = {}) {
  storage.set("vs.settings", JSON.stringify({ ghToken: "", ghOwner: "", ghTopic: "uartix-plugin", aiProxy: "", aiNoProxy: "", ...extra }));
}

async function fresh() {
  vi.resetModules();
  return import("./githubPublish");
}

function unb64(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

beforeEach(() => {
  storage.clear();
  invokeMock.mockReset();
});

describe("P157-E3 · 话题归一化", () => {
  it("与 Rust 同规则：小写、空格/下划线转连字符、非法字符丢弃", async () => {
    const { normalizeTopic } = await fresh();
    expect(normalizeTopic("  Uartix Plugin ")).toBe("uartix-plugin");
    expect(normalizeTopic("uartix_plugin")).toBe("uartix-plugin");
    expect(normalizeTopic("--x--")).toBe("x");
    expect(normalizeTopic("中文")).toBe("");
    expect(normalizeTopic("   ")).toBe("");
  });

  it("强制话题排第一、去重、上限 20", async () => {
    const { mergeTopics } = await fresh();
    // 输入里**故意不含**强制话题：这样"忘了并入 uartix-plugin"会当场红
    expect(mergeTopics(["Serial Tool", "Serial_Tool"])).toEqual(["uartix-plugin", "serial-tool"]);
    expect(mergeTopics([])).toEqual(["uartix-plugin"]);
    expect(mergeTopics(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe("P157-E3 · 发布文件", () => {
  it("manifest 原样可解回；README 带安装指引与话题；封面按 jpeg→jpg", async () => {
    const { buildPublishFiles } = await fresh();
    const files = buildPublishFiles(rec);
    expect(files.map((f) => f.path)).toEqual(["plugin.uartix.json", "cover.jpg", "README.md"]);

    const manifest = files.find((f) => f.path === "plugin.uartix.json")!;
    expect(JSON.parse(unb64(manifest.content))).toEqual(rec.pkg);

    const readme = unb64(files.find((f) => f.path === "README.md")!.content);
    expect(readme).toContain("# P157 测试包");
    expect(readme).toContain("plugin.uartix.json");
    expect(readme).toContain("https://github.com/topics/uartix-plugin");
    expect(files.find((f) => f.path === "cover.jpg")!.content).toBe("AAAA");
  });

  it("没有封面就不生成 cover.*（README 仍有两个文件）", async () => {
    const { buildPublishFiles } = await fresh();
    const bare = { ...rec, pkg: { ...rec.pkg, cover: undefined } } as PluginRecord;
    expect(buildPublishFiles(bare).map((f) => f.path)).toEqual(["plugin.uartix.json", "README.md"]);
  });
});

describe("P157-E3 · publishPlugin", () => {
  it("没 token 直接拒，且不触 invoke", async () => {
    settings();
    const { publishPlugin } = await fresh();
    const r = await publishPlugin(rec, { repo: "demo", isPrivate: false, topics: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain("GitHub Token");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("仓库名不合法时不触 invoke", async () => {
    settings({ ghToken: "github_pat_test_1234567890" });
    const { publishPlugin } = await fresh();
    const r = await publishPlugin(rec, { repo: "a/b", isPrivate: false, topics: "" });
    expect(r.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("发 github_publish：键名/取值对得上，强制话题排第一", async () => {
    settings({ ghToken: "github_pat_test_1234567890" });
    invokeMock.mockResolvedValue({
      login: "Tanixs",
      owner: "Tanixs",
      repo: "p157-demo",
      repoUrl: "https://github.com/Tanixs/p157-demo",
      topicUrl: "https://github.com/topics/uartix-plugin",
      topics: ["uartix-plugin", "serial-tool"],
      created: true,
      files: ["plugin.uartix.json"],
      warning: "",
    });
    const { publishPlugin } = await fresh();
    const r = await publishPlugin(rec, { repo: "p157-demo", description: "  演示  ", isPrivate: true, topics: "Serial Tool, uartix-plugin" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repoUrl).toBe("https://github.com/Tanixs/p157-demo");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("github_publish");
    expect(Object.keys(args).sort()).toEqual(["description", "files", "isPrivate", "noProxy", "owner", "proxy", "repo", "token", "topics"]);
    expect(args.token).toBe("github_pat_test_1234567890");
    expect(args.owner).toBeNull();
    expect(args.isPrivate).toBe(true);
    expect(args.description).toBe("演示");
    expect(args.topics).toEqual(["uartix-plugin", "serial-tool"]);
    expect((args.files as { path: string }[]).map((f) => f.path)).toContain("README.md");
  });

  it("Rust 侧报错原样回到 UI（不再包一层）", async () => {
    settings({ ghToken: "github_pat_test_1234567890" });
    invokeMock.mockRejectedValue("GitHub token 无效或已过期");
    const { publishPlugin } = await fresh();
    const r = await publishPlugin(rec, { repo: "demo", isPrivate: false, topics: "" });
    expect(r).toEqual({ ok: false, msg: "GitHub token 无效或已过期" });
  });
});
