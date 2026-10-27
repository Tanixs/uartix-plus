/**
 * P174-R2：插件展示信息账本。
 *
 * 守三件事：展示覆盖不碰安装包；封面/截图必须是有预算的图片 data URL；
 * 版本号根本不在可编辑字段里（它只来自包）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const mod = await import("./pluginMeta");
const { setPluginMeta, getPluginMeta, removePluginMeta, metaName, metaDescription, META_KEY } = mod;

beforeEach(() => {
  store.clear();
  removePluginMeta("a.b");
});

const png = (bytes = 16) => `data:image/png;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;

describe("展示信息", () => {
  it("名称/描述/作者/主页覆盖；版本不在这里", () => {
    setPluginMeta("a.b", { name: " 我的插件 ", description: "换一句描述", author: "作者", homepage: "https://example.com/x" });
    const m = getPluginMeta("a.b");
    expect(metaName("原名", m)).toBe("我的插件");
    expect(metaDescription("原描述", m)).toBe("换一句描述");
    expect(m).toMatchObject({ author: "作者", homepage: "https://example.com/x" });
    expect("version" in (m as object)).toBe(false);
  });

  it("记住发布到过哪个仓库；形状不对就当没记过", () => {
    setPluginMeta("a.b", { publishedRepo: "Tanixs/uartix.yolo" });
    expect(getPluginMeta("a.b")?.publishedRepo).toBe("Tanixs/uartix.yolo");

    // 存成 URL / 带空格 / 只有一段：都不是 `owner/name`，下次打开该退回"没记过"，
    // 而不是把一坨脏字符串再填回输入框让用户以为是自己写错的
    setPluginMeta("a.b", { publishedRepo: "https://github.com/Tanixs/x" });
    expect(getPluginMeta("a.b")?.publishedRepo).toBeUndefined();
    setPluginMeta("a.b", { publishedRepo: "Tanixs" });
    expect(getPluginMeta("a.b")?.publishedRepo).toBeUndefined();
  });

  it("发布记录不挤掉展示字段，也不被展示字段抹掉", () => {
    setPluginMeta("a.b", { name: "我的插件" });
    setPluginMeta("a.b", { publishedRepo: "o/r" });
    expect(getPluginMeta("a.b")).toMatchObject({ name: "我的插件", publishedRepo: "o/r" });
    setPluginMeta("a.b", { name: undefined });
    expect(getPluginMeta("a.b")?.publishedRepo).toBe("o/r");
  });

  it("缺省回落清单；非法 id 拒绝", () => {
    expect(metaName("原名")).toBe("原名");
    expect(metaDescription("原描述", undefined)).toBe("原描述");
    expect(() => setPluginMeta("BAD", { name: "x" })).toThrow();
  });

  it("封面只收预算内的图片 data URL；截图最多 4 张", () => {
    setPluginMeta("a.b", { cover: png(64) });
    expect(getPluginMeta("a.b")?.cover?.startsWith("data:image/png")).toBe(true);
    setPluginMeta("a.b", { cover: "data:text/html;base64,AAAA" });
    expect(getPluginMeta("a.b")?.cover).toBeUndefined();
    setPluginMeta("a.b", { cover: `data:image/png;base64,${"A".repeat(400_000)}` });
    expect(getPluginMeta("a.b")?.cover).toBeUndefined();

    setPluginMeta("a.b", { screenshots: [png(), png(), png(), png(), png()] });
    expect(getPluginMeta("a.b")?.screenshots).toHaveLength(4);
  });

  it("写入会落 localStorage；remove 会清掉", () => {
    setPluginMeta("a.b", { name: "n" });
    expect(store.get(META_KEY)).toContain("a.b");
    removePluginMeta("a.b");
    expect(getPluginMeta("a.b")).toBeUndefined();
    expect(store.get(META_KEY)).not.toContain("a.b");
  });
});
