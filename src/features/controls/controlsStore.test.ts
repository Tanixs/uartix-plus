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
