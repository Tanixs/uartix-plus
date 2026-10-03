/**
 * P133-G 的守卫：**删到空是一张真表，不是坏档**。
 *
 * 事故（用户原话「模型设置的删除供应商删除不了！」）不是某个 handler 没接上，
 * 而是三处一起把"空"当成了不可能：
 *  - `removeProvider` 删空就 `commit(seed())`——整张预置表原地复活；
 *  - `removeModel` 删最后一个模型时 `return`——垃圾桶按下去什么都不发生；
 *  - `load()` 见空表也回 seed——就算前两条放行了，重启又回来。
 * 三条叠在一起的实际效果是：**第一家供应商永远删不掉**（它名下有一个模型，
 * 而那个模型删不掉）。
 *
 * 为什么"空"可以是真的：`activeRef()` 本来就返回 null，chatStore / agentRun /
 * 哨兵三处都有"没配就不发并说去哪配"的守卫。假装空表不存在的一直只有删除这条路。
 *
 * 载入方式同 aiProfileStore.test：先桩 localStorage（node 没有），再 await import。
 * 用例**按顺序**跑（同 P115-F6 那面：状态是共享的模块快照），最后一条才把表删空。
 */
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const KEY = "vs.aiProfiles";

const {
  addModel,
  addProvider,
  activeRef,
  editingPair,
  getAiProfiles,
  removeModel,
  removeProvider,
} = await import("../ai/aiProfileStore");

describe("P133-G · 删除供应商与删除模型", () => {
  it("①名下有模型时，不级联就是拒绝（不是静默成功）", () => {
    const p = addProvider({ label: "拒绝家", baseUrl: "https://a.example.com/v1", apiKey: "sk-a" });
    addModel({ providerId: p.id, model: "a-one", label: "a-one" });
    const r = removeProvider(p.id, false);
    expect(r.ok, "拒绝分支又变成死代码了").toBe(false);
    expect(r.reason).toBe("has_models");
    expect(getAiProfiles().providers.some((x) => x.id === p.id), "被拒了还把人家删了").toBe(true);
  });

  it("②级联那条把名下模型一起带走，且其它家一根毛都不掉", () => {
    const before = getAiProfiles();
    const p = before.providers.find((x) => x.label === "拒绝家")!;
    const r = removeProvider(p.id, true);
    expect(r.ok).toBe(true);
    expect(r.droppedModels).toHaveLength(1);
    const after = getAiProfiles();
    expect(after.providers.some((x) => x.id === p.id)).toBe(false);
    expect(after.models.some((m) => m.providerId === p.id), "级联删了这家却没带走它的模型：孤儿").toBe(false);
    expect(after.models.length, "别家的模型被一起卷走了").toBe(before.models.length - 1);
  });

  it("③删掉当前选中的那家 ⇒ 指针落到还活着的那家，且两个指针指同一对", () => {
    const cur = getAiProfiles();
    const mine = addProvider({ label: "指针家", baseUrl: "https://b.example.com/v1", apiKey: "sk-b" });
    addModel({ providerId: mine.id, model: "b-one", label: "b-one" });
    const withMine = getAiProfiles();
    expect(withMine.activeProviderId).toBe(cur.activeProviderId);
    removeProvider(cur.activeProviderId, true);
    const after = getAiProfiles();
    expect(after.activeProviderId, "指针还停在被删掉的那家上").toBe(mine.id);
    const anchor = after.models.find((m) => m.id === after.activeModelId);
    expect(anchor?.providerId, "activeModelId 指向的模型不属于 activeProviderId").toBe(after.activeProviderId);
  });

  it("④删掉表里最后一个模型：真的少了，不是静默 return", () => {
    const before = getAiProfiles();
    expect(before.models.length).toBeGreaterThan(0);
    for (const m of before.models.slice(0, -1)) removeModel(m.id);
    expect(getAiProfiles().models, "倒数第二层没删干净，最后一条测不到东西").toHaveLength(1);
    const last = getAiProfiles().models[0];
    removeModel(last.id);
    const after = getAiProfiles();
    expect(after.models, "删最后一个模型又是按下去什么都不发生").toEqual([]);
    expect(after.activeModelId).toBe("");
    expect(after.providers.length, "模型删光了不该把供应商也变没").toBeGreaterThan(0);
    expect(activeRef(after)).toBeNull();
    expect(editingPair(after), "表空了还回 seed 造一对表里不存在的行 = 幻影").toBeNull();
  });

  it("⑤删掉最后一家：表真空，不复活预置表", () => {
    const before = getAiProfiles();
    expect(before.providers.length).toBeGreaterThan(0);
    for (const p of before.providers) removeProvider(p.id, true);
    const after = getAiProfiles();
    expect(after.providers, "删空就 commit(seed())：这就是「删除不了」的真身").toEqual([]);
    expect(after.models).toEqual([]);
    expect(after.activeProviderId).toBe("");
    expect(after.activeModelId).toBe("");
    expect(activeRef(after), "空表上 activeRef 必须说\"没配好\"").toBeNull();
    // 落到盘上的也得是空的：写回 seed 的话下一句读档就又是假的
    expect(JSON.parse(store.get(KEY) ?? "{}")).toMatchObject({ providers: [], models: [] });
  });

  it("⑥空表存过盘 ⇒ 读回来还是空（半张表仍然整表退 seed）", async () => {
    store.set(KEY, JSON.stringify({ providers: [], models: [], activeProviderId: "", activeModelId: "" }));
    vi.resetModules();
    const fresh = await import("../ai/aiProfileStore");
    expect(fresh.getAiProfiles().providers, "重启把删空的那家又请回来了").toEqual([]);
    expect(fresh.activeRef()).toBeNull();

    // 有模型却没有供应商：这才是"坏档"，半张表比空表危险（它会让人以为配好了）
    store.set(KEY, JSON.stringify({ providers: [], models: [{ id: "orphan", providerId: "nope", model: "x" }], activeProviderId: "", activeModelId: "" }));
    vi.resetModules();
    const half = await import("../ai/aiProfileStore");
    expect(half.getAiProfiles().providers.length, "半张表该退回 seed").toBeGreaterThan(0);

    // 根本没有这张表（第一次启动）：仍然按预置建一家
    store.delete(KEY);
    vi.resetModules();
    const first = await import("../ai/aiProfileStore");
    expect(first.getAiProfiles().providers.length).toBe(1);
  });

  it("⑦从空表建第一家 ⇒ 指针落到新建的那一对（取证 09 照出来的）", () => {
    // 空表上 addProvider/addModel 不会自己动指针，于是表里有一行、指针却指着空串：
    // 发送侧靠 activeRef() 的"第一个可用"兜底还能发，但选择器会说"选模型"、
    // 上下文那行会说"没有当前模型"——表里明明有一行，那是假话。
    expect(getAiProfiles().providers).toEqual([]);
    const p = addProvider({ label: "第一家", baseUrl: "https://c.example.com/v1", apiKey: "sk-c" });
    expect(getAiProfiles().activeProviderId).toBe(p.id);
    const m = addModel({ providerId: p.id, model: "c-one", label: "c-one" });
    const st = getAiProfiles();
    expect(st.activeModelId).toBe(m!.id);
    expect(st.activeProviderId).toBe(p.id);
    expect(activeRef(st), "配齐了还说没配好").toBeTruthy();
    // 表非空时再加一家，指针必须**不动**（加东西不是改选择）
    const other = addProvider({ label: "第二家", baseUrl: "https://d.example.com/v1", apiKey: "sk-d" });
    const after = getAiProfiles();
    expect(after.activeProviderId, "多加一家就把用户正在用的那对换掉了").toBe(p.id);
    expect(after.activeModelId).toBe(m!.id);
    expect(after.providers.some((x) => x.id === other.id)).toBe(true);
  });
});
