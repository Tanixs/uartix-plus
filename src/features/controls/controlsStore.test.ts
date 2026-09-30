import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const locked = vi.hoisted(() => ({ value: false }));
vi.mock("../operator/lock", () => ({ guardLocked: () => locked.value }));
vi.mock("../../i18n/strings", () => ({ getLocale: () => "zh" }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  locked.value = false;
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("control store validation", () => {
  it("creates a complete managed preset atomically without command payloads and respects Operator lock", async () => {
    const store = await import("./controlsStore");
    const before = store.getSnapshot();
    const parameters = [{ id: "kp", name: "Kp", min: 0, max: 10, step: 1, value: 0, unit: "" }];
    locked.value = true;
    expect(() => store.createDebugPage("调试", parameters)).toThrow();
    expect(store.getSnapshot()).toBe(before);
    locked.value = false;
    expect(() => store.createDebugPage("调试", [{ ...parameters[0], max: NaN }])).toThrow();
    expect(store.getSnapshot()).toBe(before);
    const id = store.createDebugPage("调试", parameters);
    const page = store.getSnapshot().pages.find(p => p.id === id)!;
    expect(store.getSnapshot().pages).toHaveLength(before.pages.length + 1);
    expect(store.getSnapshot().pages[0]).toBe(before.pages[0]);
    expect(page.cards).toHaveLength(8);
    expect(page.cards.every(c => !!c.managed)).toBe(true);
    expect(new Set(page.cards.map(c => c.id)).size).toBe(page.cards.length);
    expect(page.cards.filter(c => "template" in c).every(c => "template" in c && c.template === "")).toBe(true);
    expect(store.getSnapshot().activePageId).toBe(id);
  });
  it("rejects managed marker removal and identity/type changes without changing ordinary patches", async () => {
    const store = await import("./controlsStore");
    const pageId = store.createDebugPage("调试", [{ id: "kp", name: "Kp", min: 0, max: 10, step: 1, value: 0, unit: "" }]);
    const card = store.activePage()!.cards[0];
    const before = store.getSnapshot();
    const persisted = localStorage.getItem("vs.controls");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const patches = [
      { managed: undefined },
      { managed: null },
      { managed: {} },
      { managed: { ...card.managed, role: "record.start" } },
      { managed: { ...card.managed, paramId: "other" } },
      { managed: { ...card.managed, schema: "unknown" } },
      { type: "button" },
      { type: "button", managed: undefined, template: "CMD!" },
    ];
    for (const patch of patches) {
      expect(() => store.patchCard(pageId, card.id, { ...patch, name: "Rejected" })).toThrow(/managed/i);
      expect(store.getSnapshot()).toBe(before);
      expect(localStorage.getItem("vs.controls")).toBe(persisted);
      expect(listener).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
    store.patchCard(pageId, card.id, { managed: { ...card.managed }, type: card.type, name: "Renamed", defaultValue: 1 });
    expect(store.findCardById(card.id)!.card).toMatchObject({ managed: card.managed, type: "slider", name: "Renamed", defaultValue: 1 });
    const ordinaryId = store.addCard(pageId, "slider");
    store.patchCard(pageId, ordinaryId, { type: "button", managed: undefined, template: "CMD!", name: "Ordinary" });
    expect(store.findCardById(ordinaryId)!.card).toMatchObject({ type: "button", managed: undefined, template: "CMD!", name: "Ordinary" });
    unsubscribe();
  });

  it("rejects importPage under Operator lock before persistence or publication", async () => {
    const store = await import("./controlsStore");
    const before = store.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const write = vi.spyOn(localStorage, "setItem");
    locked.value = true;
    expect(() => store.importPage({ name: "Imported", cards: [] })).toThrow(/Operator/);
    expect(store.getSnapshot()).toBe(before);
    expect(write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    locked.value = false;
    const id = store.importPage({ name: "Imported", cards: [{ type: "button", template: "CMD!" }] });
    expect(store.activePage()).toMatchObject({ id, name: "Imported", cards: [{ type: "button", template: "CMD!", managed: undefined }] });
    unsubscribe();
  });

  it("drops unknown group child types without changing valid children", async () => {
    const { sanitizeChildren } = await import("./controlsStore");
    expect(sanitizeChildren([{ kind: "unknown" }, { kind: "monitor", id: "m", varName: "x" }]))
      .toMatchObject([{ id: "m", kind: "monitor", varName: "x" }]);
  });
});

/**
 * P121-F · 只读锁按字段拆：配置拦、运行态放。
 *
 * 这条锁原先整函数地漏着，但不能一把加上去：开关卡翻档、编排器驱动卡片都要写 `state`，
 * 整函数拦锁的症状是"只读发行包里的开关卡点不动"。所以判据是字段级的，
 * 而且混进任何一个配置字段就整份拒绝——半生效的写入既难解释也没法撤销。
 */
describe("P121-F · 控制画布的只读锁按字段拆", () => {
  const setup = async () => {
    const store = await import("./controlsStore");
    if (!store.activePage()) store.addPage();
    const pageId = store.activePage()!.id;
    const slider = store.addCard(pageId, "slider");
    const sw = store.addCard(pageId, "switch");
    const at = (id: string) =>
      store.activePage()!.cards.find((c) => c.id === id) as unknown as Record<string, unknown>;
    return { store, pageId, slider, sw, at };
  };

  it("锁下改模板 / 名字 / 引用 / 开机位置一律不生效", async () => {
    const { store, pageId, slider, at } = await setup();
    const was = { ...at(slider) };
    locked.value = true;
    store.patchCard(pageId, slider, { template: "STOLEN!" });
    store.patchCard(pageId, slider, { name: "改名" });
    store.patchCard(pageId, slider, { sendTemplateId: "sp-x", paramId: "p-1" });
    store.patchCard(pageId, slider, { defaultValue: 42 });
    expect(at(slider).template, "只读包里能把一张卡发的字节悄悄换掉").toBe(was.template);
    expect(at(slider).name).toBe(was.name);
    expect(at(slider).sendTemplateId).toBeUndefined();
    expect(at(slider).defaultValue, "defaultValue 是配置（下次开机停在哪），不是运行态").toBe(was.defaultValue);
  });

  it("锁下翻开关照样生效：那是操作员的本职", async () => {
    const { store, pageId, sw, at } = await setup();
    locked.value = true;
    store.patchCard(pageId, sw, { state: 1 });
    expect(at(sw).state).toBe(1);
  });

  it("混着写就整份拒绝，不留半生效", async () => {
    const { store, pageId, sw, at } = await setup();
    locked.value = true;
    store.patchCard(pageId, sw, { state: 1, template: "STOLEN!" });
    expect(at(sw).state, "一份 patch 里有一个配置字段，运行态那半也不该落").toBe(0);
    locked.value = false;
    store.patchCard(pageId, sw, { state: 1 });
    expect(at(sw).state, "解锁后同一份写法要能写进去").toBe(1);
  });

  it("锁下不能加卡 / 删卡 / 加页，但换页（导航）照走", async () => {
    const { store, pageId } = await setup();
    const pages = store.getSnapshot().pages.length;
    const cards = store.activePage()!.cards.length;
    locked.value = true;
    expect(store.addCard(pageId, "button"), "加卡返回空串，调用方据此不往下写").toBe("");
    store.removeCard(pageId, store.activePage()!.cards[0].id);
    store.addPage();
    expect(store.activePage()!.cards).toHaveLength(cards);
    expect(store.getSnapshot().pages).toHaveLength(pages);
    // 先解锁建第二页，再锁上试翻页：换页是导航，不是改配置
    locked.value = false;
    store.addPage();
    const second = store.activePage()!.id;
    locked.value = true;
    store.setActivePage(pageId);
    expect(store.activePage()!.id, "只读包里操作员当然要能翻到别的控制页").toBe(pageId);
    store.setActivePage(second);
    expect(store.activePage()!.id).toBe(second);
  });
});
