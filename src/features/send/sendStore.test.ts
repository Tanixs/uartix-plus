/**
 * P121-B · 发送谱 store 的契约。
 *
 * 钉的四件事都是这个仓库付过账的形状：
 *  - **权限面在 store 收口**（P121-A 刚在 commandStore 补了两处漏的，这里从第一行起就不留）；
 *  - 删参数前先查"还有字段引用它吗"——引用静默悬空的症状是预览突然一直报错，
 *    而用户看不出是谁被删了（P113-E 快照引用同族）；
 *  - 撤销/重做走快照栈，与 `templateStore` 同一语义；
 *  - 导入按重名加序号合并，不覆盖用户的东西（`templateStore.importTemplates` 同语义）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendField } from "./sendTypes";

const lock = vi.hoisted(() => ({ value: false }));
vi.mock("../operator/lock", () => ({ guardLocked: () => lock.value }));

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});
vi.stubGlobal("structuredClone", (v: unknown) => JSON.parse(JSON.stringify(v)));

let store: typeof import("./sendStore");

const field = (over: Partial<SendField>): SendField =>
  ({
    id: `f${Math.random().toString(36).slice(2, 7)}`,
    name: "F",
    type: "uint8",
    endian: "big",
    role: "data",
    source: { kind: "const", bytes: [0] },
    ...over,
  }) as SendField;

beforeEach(async () => {
  vi.resetModules();
  mem.clear();
  lock.value = false;
  store = await import("./sendStore");
});

describe("sendStore", () => {
  it("新建谱给的是能用的空壳，id 唯一", () => {
    const a = store.addTemplate("A");
    const b = store.addTemplate("B");
    expect(a).not.toBe(b);
    const t = store.getTemplate(a)!;
    expect(t).toMatchObject({ name: "A", fields: [], params: [], checksum: null });
  });

  it("字段可增、可改、可删、可换位", () => {
    const id = store.addTemplate("拖");
    store.addField(id, field({ id: "h", name: "HDR" }));
    store.addField(id, field({ id: "d", name: "DATA" }));
    store.addField(id, field({ id: "t", name: "FTR" }), 1);
    expect(store.getTemplate(id)!.fields.map((f) => f.id)).toEqual(["h", "t", "d"]);
    store.moveField(id, 2, 0);
    expect(store.getTemplate(id)!.fields.map((f) => f.id)).toEqual(["d", "h", "t"]);
    store.patchField(id, "h", { name: "帧头" });
    expect(store.getTemplate(id)!.fields.find((f) => f.id === "h")!.name).toBe("帧头");
    store.removeField(id, "t");
    expect(store.getTemplate(id)!.fields.map((f) => f.id)).toEqual(["d", "h"]);
  });

  it("moveField 越界不动（拖到带外不该把字段变没）", () => {
    const id = store.addTemplate("边界");
    store.addField(id, field({ id: "a" }));
    store.moveField(id, 0, 9);
    store.moveField(id, -1, 0);
    expect(store.getTemplate(id)!.fields).toHaveLength(1);
  });

  it("删参数：有字段引用时**拒绝并点名**，不静默留悬空引用", () => {
    const id = store.addTemplate("引用");
    store.patchTemplate(id, { params: [{ id: "p1", name: "速度", type: "int", def: "0" }] });
    store.addField(id, field({ id: "f", name: "SPD", source: { kind: "param", paramId: "p1" } }));
    const r = store.removeParam(id, "p1");
    expect(r.ok).toBe(false);
    expect((r as { usedBy: string[] }).usedBy).toEqual(["SPD"]);
    expect(store.getTemplate(id)!.params).toHaveLength(1);
    store.removeField(id, "f");
    expect(store.removeParam(id, "p1").ok).toBe(true);
    expect(store.getTemplate(id)!.params).toHaveLength(0);
  });

  it("撤销 / 重做沿快照栈走回去", () => {
    const id = store.addTemplate("撤");
    store.addField(id, field({ id: "x" }));
    expect(store.getTemplate(id)!.fields).toHaveLength(1);
    store.undo();
    expect(store.getTemplate(id)!.fields).toHaveLength(0);
    store.redo();
    expect(store.getTemplate(id)!.fields).toHaveLength(1);
  });

  it("Operator 只读锁：每个写方法都拦得住", () => {
    const id = store.addTemplate("锁");
    lock.value = true;
    store.addField(id, field({ id: "nope" }));
    store.patchTemplate(id, { name: "改了" });
    store.removeParam(id, "whatever");
    store.undo();
    store.importTemplates([{ id: "z", name: "导入", note: "", fields: [], params: [], checksum: null, textMode: "hex", createdAt: 0, nextSeq: 0 }]);
    expect(store.getTemplate(id)!.name).toBe("锁");
    expect(store.getTemplate(id)!.fields).toHaveLength(0);
    expect(store.getSnapshot()).toHaveLength(1);
    lock.value = false;
    store.addField(id, field({ id: "ok" }));
    expect(store.getTemplate(id)!.fields).toHaveLength(1);
  });

  it("导入：重名加序号，坏结构整条跳过而不是半条进来", () => {
    store.addTemplate("已存在");
    const good = { id: "g", name: "已存在", note: "", fields: [field({ id: "a" })], params: [], checksum: null, textMode: "hex" as const, createdAt: 1, nextSeq: 0 };
    const added = store.importTemplates([
      good,
      { id: "bad", name: "坏谱" } as unknown as never,
    ]);
    expect(added).toBe(1);
    expect(store.getSnapshot().map((t) => t.name)).toEqual(["已存在", "已存在 (2)"]);
  });

  it("坏数据不带着跑：解析失败即清键（与 commandStore 同一条兜底）", async () => {
    mem.set("vs.sendTemplates", "{ this is not json");
    vi.resetModules();
    const fresh = await import("./sendStore");
    expect(fresh.getSnapshot()).toEqual([]);
    expect(mem.has("vs.sendTemplates")).toBe(false);
  });

  it("副本不共享引用：改副本不碰原件", () => {
    const id = store.addTemplate("原");
    store.addField(id, field({ id: "a", name: "A" }));
    const copy = store.duplicateTemplate(id);
    store.patchField(copy, "a", { name: "改了" });
    expect(store.getTemplate(id)!.fields[0].name).toBe("A");
    expect(store.getTemplate(copy)!.fields[0].name).toBe("改了");
  });
});
