/**
 * P103 批2：chromeStore（工具栏三段排序/显隐）单测。
 * 钉住两条防线：段名非法/缺失时归一化永不丢段；三段全藏被拦回全显（工具栏不能没有回头路）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const load = async () => {
  vi.resetModules();
  return await import("./chromeStore");
};

describe("P103 批2 · chromeStore", () => {
  beforeEach(() => storage.clear());

  it("默认：三段全显、默认序", async () => {
    const s = await load();
    expect(s.getChrome()).toEqual({ order: ["connect", "session", "layout"], hidden: [] });
  });

  it("排序：子集合法，缺段按默认序补尾；非法与重复段名剔除", async () => {
    const s = await load();
    s.patchChrome({ order: ["layout", "connect"] });
    expect(s.getChrome().order, "缺的 session 必须补尾，不许丢段").toEqual(["layout", "connect", "session"]);
    s.patchChrome({ order: ["session", "bogus" as never, "session", "layout"] });
    expect(s.getChrome().order).toEqual(["session", "layout", "connect"]);
  });

  it("显隐：hide 生效；三段全藏被归一化拦回全显", async () => {
    const s = await load();
    s.patchChrome({ hidden: ["session"] });
    expect(s.getChrome().hidden).toEqual(["session"]);
    s.patchChrome({ hidden: ["connect", "session", "layout"] });
    expect(s.getChrome().hidden, "全藏必须被拦——工具栏空了就没有回头的入口").toEqual([]);
  });

  it("reset 回默认；持久化写在 vs.chrome", async () => {
    const s = await load();
    s.patchChrome({ order: ["layout"], hidden: ["session"] });
    const raw = JSON.parse(storage.get("vs.chrome") ?? "{}") as { order?: string[]; hidden?: string[] };
    expect(raw.order?.[0]).toBe("layout");
    expect(raw.hidden).toEqual(["session"]);
    s.resetChrome();
    expect(s.getChrome()).toEqual({ order: ["connect", "session", "layout"], hidden: [] });
  });

  it("存档里有不认识的新段名/脏数据也能安全加载（向后兼容）", async () => {
    storage.set("vs.chrome", JSON.stringify({ order: ["future-seg", "layout"], hidden: ["future-seg"] }));
    const s = await load();
    const c = s.getChrome();
    expect(c.order).toEqual(["layout", "connect", "session"]);
    expect(c.hidden).toEqual([]);
  });
});
