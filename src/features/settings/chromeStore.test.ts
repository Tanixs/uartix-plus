/**
 * P103 批2 / P104-B5 / R2：chromeStore（工具栏各段排序/显隐）单测。
 * 钉住两条防线：段名非法/缺失时归一化永不丢段；全藏被拦回全显（工具栏不能没有回头路）。
 *
 * B5 改动说明（逐条）：段名单从 3 段扩到 4 段（新增 `system` = AI/插件/设置/帮助，
 * 它们原先焊在标题栏里、不归这份事实源管）。
 *
 * R2 改动说明（逐条，这次是把 B5 那一步**收回去**，不是放宽判定）：
 * 顶部拆回两条横栏后，那四颗住进**身份栏**，工具栏根本没有它们的位置。
 * 留在名单里的后果是 chrome_set 能把 `system` 排到第 2 位而画面上毫无反应——
 * 静默无效的可配置项就是第二真值，所以名单退回 3 段。下面每处 `system` 的消失
 * 都对应"法定集合变小"这一件事：
 *  · 默认序 / 补尾 / reset 三处：期望值少一个元素，判定强度不变。
 *  · 显隐用例第 51 行：B5 时"藏三段"只是部分隐藏（还剩 system 可见）所以必须允许；
 *    现在"藏三段"就是全藏，**必须被拦**——这条从"放行"翻成"拦截"，是变严不是变松。
 *  · 「旧三段存档升级」用例：三段现在就是当前形状，这条的前提没了。不删，
 *    改钉**反方向**（B5 期那份带 system 的四段存档必须安全降级），迁移面反而更宽。
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
    expect(s.getChrome()).toEqual({
      order: ["connect", "session", "layout"],
      hidden: [],
    });
  });

  it("排序：子集合法，缺段按默认序补尾；非法与重复段名剔除", async () => {
    const s = await load();
    s.patchChrome({ order: ["layout", "connect"] });
    expect(
      s.getChrome().order,
      "缺的 session 必须补尾，不许丢段",
    ).toEqual(["layout", "connect", "session"]);
    s.patchChrome({ order: ["session", "bogus" as never, "session", "layout"] });
    expect(s.getChrome().order).toEqual(["session", "layout", "connect"]);
  });

  it("显隐：藏到剩一段仍允许；三段全藏才被归一化拦回全显", async () => {
    const s = await load();
    s.patchChrome({ hidden: ["session"] });
    expect(s.getChrome().hidden).toEqual(["session"]);
    s.patchChrome({ hidden: ["connect", "session"] });
    expect(s.getChrome().hidden, "只剩一段不算空，不该被拦").toEqual([
      "connect",
      "session",
    ]);
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
    expect(s.getChrome()).toEqual({
      order: ["connect", "session", "layout"],
      hidden: [],
    });
  });

  it("B5 期那份四段存档能安全降级（system 已退役，剔除后不丢其余三段）", async () => {
    // R2 之前用户机器上存的就是这份带 system 的形状。段名单变小不是"丢段"——
    // normalize 先把未知段名剔掉再补缺，所以老存档必须原样长出三段默认序。
    storage.set(
      "vs.chrome",
      JSON.stringify({ order: ["layout", "connect", "session", "system"], hidden: ["system"] }),
    );
    const s = await load();
    expect(s.getChrome().order).toEqual(["layout", "connect", "session"]);
    expect(s.getChrome().hidden, "藏一个不存在的段不该把整条链子卡住").toEqual([]);
  });

  it("存档里有不认识的新段名/脏数据也能安全加载（向后兼容）", async () => {
    storage.set("vs.chrome", JSON.stringify({ order: ["future-seg", "layout"], hidden: ["future-seg"] }));
    const s = await load();
    const c = s.getChrome();
    expect(c.order).toEqual(["layout", "connect", "session"]);
    expect(c.hidden).toEqual([]);
  });
});
