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

  it("锁下不能整理布局：declumpPage 不发事件、不动卡片", async () => {
    const { store, pageId, slider, sw } = await setup();
    // 先把两张卡叠在同一个格子上，制造"整理会改动几何"的前置
    store.patchCard(pageId, slider, { x: 0, y: 0 });
    store.patchCard(pageId, sw, { x: 0, y: 0 });
    const at = (id: string) =>
      store.getSnapshot().pages.find((p) => p.id === pageId)!.cards.find((c) => c.id === id)!;
    const wasSlider = { x: at(slider).x, y: at(slider).y };
    const wasSwitch = { x: at(sw).x, y: at(sw).y };
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    locked.value = true;
    store.declumpPage(pageId);
    expect(at(slider)).toMatchObject(wasSlider);
    expect(at(sw)).toMatchObject(wasSwitch);
    expect(listener).not.toHaveBeenCalled();
    locked.value = false;
    store.declumpPage(pageId);
    expect(listener).toHaveBeenCalled();
    expect(
      at(sw).x !== wasSwitch.x || at(sw).y !== wasSwitch.y,
      "解锁后同一张重叠卡应被挪开",
    ).toBe(true);
    unsubscribe();
  });
});

describe("canvas embed schema v2", () => {
  it("adds whitelisted panel cards at their semantic minimum size", async () => {
    const store = await import("./controlsStore");
    const pageId = store.getSnapshot().activePageId;
    const r = store.addEmbedCard(pageId, "plot2d");
    expect(r.ok).toBe(true);
    // tsconfig 的 lib 是 ES2020（`npm run build` 走 `tsc`），`Array.prototype.at` 要 ES2022 ——
    // 这里用等价的索引写法，别为了测试单独放宽整个工程的 lib。
    const cards = store.activePage()!.cards;
    const card = cards[cards.length - 1]!;
    expect(card).toMatchObject({
      type: "embed",
      panelId: "plot2d",
      w: 4,
      h: 3,
      minW: 4,
      minH: 3,
      aspectLock: false,
    });
    expect(store.findEmbedCard("plot2d")?.pageId).toBe(pageId);
    expect(store.getSnapshot().version).toBe(store.CONTROLS_SCHEMA_VERSION);
  });

  it("dry-runs placement and only persists a sanitized view state", async () => {
    const store = await import("./controlsStore");
    const pageId = store.getSnapshot().activePageId;
    const before = store.getSnapshot();
    expect(store.canAddEmbedCard(pageId, "plot2d").ok).toBe(true);
    // 干跑不能发快照：否则拖拽悬停会把整张画布重渲染一遍。
    expect(store.getSnapshot()).toBe(before);

    expect(
      store.addEmbedCard(pageId, "plot2d", {
        xMin: 1,
        xMax: 2,
        yMin: -1,
        yMax: 1,
        follow: false,
      }).ok,
    ).toBe(true);
    expect(store.findEmbedCard("plot2d")?.card.viewState).toEqual({
      xMin: 1,
      xMax: 2,
      yMin: -1,
      yMax: 1,
      follow: false,
    });

    // 坏视图态宁可丢掉，也不能把 NaN 写进存档。
    expect(store.addEmbedCard(pageId, "hexview", { scrollOffset: -3 }).ok).toBe(true);
    expect(store.findEmbedCard("hexview")?.card.viewState).toBeUndefined();
  });

  it("rejects unknown panels, duplicates and pages smaller than the minimum", async () => {
    const store = await import("./controlsStore");
    const pageId = store.getSnapshot().activePageId;
    expect(store.addEmbedCard(pageId, "plot3d")).toEqual({ ok: false, reason: "unknown-panel" });
    const small = store.importPage({ name: "tiny", cols: 3, rows: 3, cards: [] });
    expect(store.addEmbedCard(small, "plot2d")).toEqual({ ok: false, reason: "page-too-small" });
    expect(store.addEmbedCard(pageId, "plot2d").ok).toBe(true);
    expect(store.addEmbedCard(pageId, "plot2d")).toEqual({ ok: false, reason: "duplicate" });
  });

  it("accepts the wave-1 data panels at their own minimum sizes", async () => {
    const store = await import("./controlsStore");
    const pageId = store.importPage({ name: "wave1", cols: 12, rows: 12, cards: [] });
    const sizes = [
      ["datatable", 4, 4],
      ["xray", 4, 4],
      ["spectrum", 4, 3],
    ] as const;
    for (const [id, w, h] of sizes) {
      expect(store.addEmbedCard(pageId, id).ok).toBe(true);
      expect(store.findEmbedCard(id)?.card).toMatchObject({
        type: "embed",
        panelId: id,
        w,
        h,
        minW: w,
        minH: h,
        aspectLock: false,
      });
    }
  });

  it("accepts wave-3 targets: TX frame builder and a dynamic plugin panel", async () => {
    const store = await import("./controlsStore");
    const pageId = store.importPage({ name: "wave3", cols: 16, rows: 16, cards: [] });
    expect(store.addEmbedCard(pageId, "sendbuild").ok).toBe(true);
    expect(store.findEmbedCard("sendbuild")?.card).toMatchObject({
      type: "embed",
      panelId: "sendbuild",
      w: 5,
      h: 4,
      minW: 5,
      minH: 4,
      aspectLock: false,
    });

    // 插件面板：卡片 id 就是停靠 id，默认名由控件库传进来（这里显式给名字）
    const pluginId = "plugin-view-acme.serial-console:bode";
    const r = store.addEmbedCard(pageId, pluginId, null, "  波特率观测  ");
    expect(r.ok).toBe(true);
    expect(store.findEmbedCard(pluginId)?.card).toMatchObject({
      panelId: pluginId,
      name: "波特率观测",
      w: 5,
      h: 4,
      aspectLock: false,
    });
    expect(store.addEmbedCard(pageId, pluginId)).toEqual({ ok: false, reason: "duplicate" });
    // 视图态对插件面板没有意义，坏数据也不会落盘
    expect(store.findEmbedCard(pluginId)?.card.viewState).toBeUndefined();
  });

  it("keeps plugin panel cards on import and drops malformed plugin ids", async () => {
    const store = await import("./controlsStore");
    const report = { droppedPanels: [] as string[] };
    const pageId = store.importPage(
      {
        name: "wave3-import",
        cols: 16,
        rows: 16,
        cards: [
          { type: "embed", panelId: "plugin-view-acme.logger:tail", name: "日志" },
          { type: "embed", panelId: "plugin-view-acme.logger" },
          { type: "embed", panelId: "sendbuild" },
        ],
      },
      report,
    );
    expect(report.droppedPanels).toEqual(["plugin-view-acme.logger"]);
    const page = store.getSnapshot().pages.find((p) => p.id === pageId)!;
    const byId = new Map(
      page.cards
        .filter((c) => c.type === "embed")
        .map((c) => [(c as { panelId: string }).panelId, c]),
    );
    expect(byId.get("plugin-view-acme.logger:tail")).toMatchObject({ w: 5, h: 4, name: "日志" });
    expect(byId.get("sendbuild")).toMatchObject({ w: 5, h: 4 });
  });

  it("keeps wave-1 cards on import and still reports unknown ids", async () => {
    const store = await import("./controlsStore");
    const report = { droppedPanels: [] as string[] };
    const pageId = store.importPage(
      {
        name: "wave1-mixed",
        cols: 12,
        rows: 12,
        cards: [
          { type: "embed", panelId: "datatable" },
          { type: "embed", panelId: "xray" },
          { type: "embed", panelId: "spectrum" },
          { type: "embed", panelId: "vdev" },
        ],
      },
      report,
    );
    expect(report.droppedPanels).toEqual(["vdev"]);
    const page = store.getSnapshot().pages.find((p) => p.id === pageId)!;
    const byId = new Map(
      page.cards
        .filter((c) => c.type === "embed")
        .map((c) => [(c as { panelId: string }).panelId, c]),
    );
    expect(byId.get("datatable")).toMatchObject({ w: 4, h: 4 });
    expect(byId.get("xray")).toMatchObject({ w: 4, h: 4 });
    expect(byId.get("spectrum")).toMatchObject({ w: 4, h: 3 });
  });

  it("rejects the second heavy card when the page is full", async () => {
    const store = await import("./controlsStore");
    const page = store.importPage({ name: "full", cols: 4, rows: 3, cards: [] });
    expect(store.addEmbedCard(page, "plot2d").ok).toBe(true);
    expect(store.addEmbedCard(page, "hexview")).toEqual({ ok: false, reason: "no-space" });
  });

  it("adds the attitude view with a locked 4:3 minimum", async () => {
    const store = await import("./controlsStore");
    const pageId = store.getSnapshot().activePageId;
    expect(store.addEmbedCard(pageId, "attitude3d").ok).toBe(true);
    const cards = store.activePage()!.cards;
    const card = cards[cards.length - 1]!;
    expect(card).toMatchObject({
      type: "embed",
      panelId: "attitude3d",
      w: 4,
      h: 3,
      minW: 4,
      minH: 3,
      aspectLock: true,
    });
  });

  it("clamps an imported attitude card back to its 4:3 shape", async () => {
    const store = await import("./controlsStore");
    const pageId = store.importPage({
      name: "wide",
      cols: 20,
      rows: 12,
      cards: [
        { type: "embed", panelId: "attitude3d", x: 0, y: 0, w: 12, h: 2, name: "姿态" },
      ],
    });
    const card = store.getSnapshot().pages.find((p) => p.id === pageId)!.cards[0]!;
    // 宽高比锁 4:3：宽 12 → 高 9；不会留下 12×2 的扁条（模型会被裁掉机臂）
    expect(card).toMatchObject({ w: 12, h: 9, aspectLock: true });
  });

  it("adds the trajectory view with a locked 5x4 minimum", async () => {
    const store = await import("./controlsStore");
    const pageId = store.getSnapshot().activePageId;
    expect(store.addEmbedCard(pageId, "trajectory3d").ok).toBe(true);
    const cards = store.activePage()!.cards;
    const card = cards[cards.length - 1]!;
    expect(card).toMatchObject({
      type: "embed",
      panelId: "trajectory3d",
      w: 5,
      h: 4,
      minW: 5,
      minH: 4,
      aspectLock: true,
    });
  });

  it("clamps an imported trajectory card back to its 4:3 shape", async () => {
    const store = await import("./controlsStore");
    const pageId = store.importPage({
      name: "wide3d",
      cols: 20,
      rows: 12,
      cards: [
        { type: "embed", panelId: "trajectory3d", x: 0, y: 0, w: 12, h: 2, name: "轨迹" },
      ],
    });
    const card = store.getSnapshot().pages.find((p) => p.id === pageId)!.cards[0]!;
    expect(card).toMatchObject({ w: 12, h: 9, aspectLock: true });
  });

  it("drops unknown embed panel ids on import and reports the count", async () => {
    const store = await import("./controlsStore");
    const report = { droppedPanels: [] as string[] };
    const pageId = store.importPage(
      {
        name: "mixed",
        cols: 12,
        rows: 12,
        cards: [
          { type: "embed", panelId: "plot2d" },
          { type: "embed", panelId: "modbus" },
          { type: "embed", panelId: "plot3d" },
          { type: "embed", panelId: "trajectory3d" },
          { type: "slider", x: 0, y: 5 },
        ],
      },
      report,
    );
    expect(report.droppedPanels).toEqual(["modbus", "plot3d"]);
    const page = store.getSnapshot().pages.find((p) => p.id === pageId)!;
    expect(page.cards.filter((c) => c.type === "embed")).toHaveLength(2);
    expect(page.cards).toHaveLength(3);
  });

  it("persists v2 with embed fields and migrates v1 snapshots on load", async () => {
    const store = await import("./controlsStore");
    store.addEmbedCard(store.getSnapshot().activePageId, "hexview");
    vi.advanceTimersByTime(300);
    const saved = JSON.parse(localStorage.getItem("vs.controls")!) as {
      version: number;
      pages: { cards: Record<string, unknown>[] }[];
    };
    expect(saved.version).toBe(store.CONTROLS_SCHEMA_VERSION);
    expect(saved.pages[0].cards.some((c) => c.type === "embed" && c.panelId === "hexview")).toBe(true);

    // v1（无 version 字段）存档：读入即升到当前版本，合法内嵌卡保留
    vi.resetModules();
    localStorage.setItem(
      "vs.controls",
      JSON.stringify({
        activePageId: "p1",
        pages: [
          {
            id: "p1",
            name: "v1",
            cols: 8,
            rows: 8,
            locked: false,
            cards: [
              { id: "c1", type: "embed", panelId: "plot2d", x: 0, y: 0, w: 1, h: 1, name: "曲线" },
            ],
          },
        ],
      }),
    );
    const reloaded = await import("./controlsStore");
    expect(reloaded.getSnapshot().version).toBe(reloaded.CONTROLS_SCHEMA_VERSION);
    const migrated = reloaded.getSnapshot().pages[0].cards[0];
    expect(migrated).toMatchObject({ type: "embed", panelId: "plot2d", w: 4, h: 3 });

    // 未知 panelId 在本地恢复时静默丢弃，不留空卡
    vi.resetModules();
    localStorage.setItem(
      "vs.controls",
      JSON.stringify({
        pages: [
          {
            id: "p2",
            name: "bad",
            cols: 8,
            rows: 8,
            locked: false,
            cards: [{ id: "c2", type: "embed", panelId: "nope", x: 0, y: 0, w: 4, h: 3 }],
          },
        ],
      }),
    );
    const cleaned = await import("./controlsStore");
    expect(cleaned.getSnapshot().pages[0].cards).toHaveLength(0);
  });

  it("rejects files newer than the supported schema", async () => {
    const store = await import("./controlsStore");
    expect(store.checkControlsVersion(undefined)).toBeNull();
    expect(store.checkControlsVersion(3)).toBeNull();
    expect(store.checkControlsVersion(4)).toContain("v4");
  });
});

describe("clipboard guards", () => {
  it("never puts an embedded card on the clipboard", async () => {
    const store = await import("./controlsStore");
    const pageId = store.activePage()!.id;
    const added = store.addEmbedCard(pageId, "plot2d");
    expect(added.ok).toBe(true);
    const embedId = (added as { ok: true; cardId: string }).cardId;
    store.copyCard(pageId, embedId);
    // 内嵌卡全局单实例：复制出来必然粘贴失败，所以剪贴板保持为空，
    // 「粘贴」不会亮着一个永远失败的入口。
    expect(store.hasClipboard()).toBe(false);
    expect(store.pasteCard(pageId, 0, 0)).toBeNull();
  });

  it("refuses to paste while the Operator package is read-only", async () => {
    const store = await import("./controlsStore");
    const pageId = store.activePage()!.id;
    const cardId = store.addCard(pageId, "slider");
    store.copyCard(pageId, cardId);
    expect(store.hasClipboard()).toBe(true);
    const count = store.activePage()!.cards.length;
    locked.value = true;
    expect(store.pasteCard(pageId, 0, 0)).toBeNull();
    expect(store.activePage()!.cards).toHaveLength(count);
    locked.value = false;
    expect(store.pasteCard(pageId, 0, 0)).not.toBeNull();
    expect(store.activePage()!.cards).toHaveLength(count + 1);
  });
});

describe("commandId migration (v3)", () => {
  it("keeps a reference and treats an empty string as no mount", async () => {
    const store = await import("./controlsStore");
    const pageId = store.importPage({
      name: "P",
      cols: 8,
      rows: 8,
      cards: [
        { id: "a", type: "slider", x: 0, y: 0, w: 3, h: 2, commandId: "cmd-1" },
        { id: "b", type: "slider", x: 3, y: 0, w: 3, h: 2, commandId: "" },
      ],
    });
    const cards = store.getSnapshot().pages.find((p) => p.id === pageId)!.cards;
    expect(cards[0].commandId).toBe("cmd-1");
    // 空串不能留成"指向空 id 的失效引用"
    expect(cards[1].commandId).toBeUndefined();
  });
});

describe("slider parameter validation", () => {
  it("normalizes step, order and default in one pass", async () => {
    const store = await import("./controlsStore");
    const n = store.normalizeSliderParams({ min: 0, max: 10, step: 0, defaultValue: 5.2 });
    expect(n).toMatchObject({ min: 0, max: 10, step: 1 });
    expect(n.fixes.map((f) => [f.field, f.reason, f.value])).toEqual([
      ["step", "step", 1],
      ["defaultValue", "grid", 5],
    ]);

    // 非有限值回落，且报出来源
    const bad = store.normalizeSliderParams({ min: NaN, max: Infinity, step: 1, defaultValue: NaN });
    expect(bad).toMatchObject({ min: 0, max: 100, step: 1, defaultValue: 0 });
    expect(bad.fixes.map((f) => f.reason)).toEqual(["non-finite", "non-finite", "non-finite"]);

    // min > max：编辑 min 时保留 max（min 让位）
    const collide = store.normalizeSliderParams({ min: 200, max: 100, step: 1, defaultValue: 50 }, "max");
    expect(collide).toMatchObject({ min: 100, max: 100, defaultValue: 100 });
    expect(collide.fixes.map((f) => f.field)).toEqual(["min", "defaultValue"]);
  });

  it("clamps on patchCard and reports every correction to the caller", async () => {
    const store = await import("./controlsStore");
    const pageId = store.activePage()!.id;
    const cardId = store.addCard(pageId, "slider");
    const read = () =>
      store.getSnapshot().pages.find((p) => p.id === pageId)!.cards.find((c) => c.id === cardId)!;

    const r = store.patchCard(pageId, cardId, { min: 200 });
    expect(read()).toMatchObject({ min: 100, max: 100, defaultValue: 100 });
    expect(r.sliderFixes.map((f) => `${f.field}:${f.reason}:${f.value}`)).toEqual([
      "min:order:100",
      "defaultValue:range:100",
    ]);

    const step = store.patchCard(pageId, cardId, { step: 0 });
    expect(read()).toMatchObject({ step: 1 });
    expect(step.sliderFixes.map((f) => `${f.field}:${f.reason}:${f.value}`)).toEqual(["step:step:1"]);

    // 编辑 max 时保住 min：min=100 时把 max 改成 0，不能把区间整体压成 0。
    const order = store.patchCard(pageId, cardId, { max: 0 });
    expect(read()).toMatchObject({ min: 100, max: 100, defaultValue: 100 });
    expect(order.sliderFixes.map((f) => `${f.field}:${f.reason}:${f.value}`)).toEqual(["max:order:100"]);

    const def = store.patchCard(pageId, cardId, { defaultValue: 500 });
    expect(read()).toMatchObject({ defaultValue: 100 });
    expect(def.sliderFixes).toMatchObject([{ field: "defaultValue", reason: "range", value: 100 }]);
  });

  it("applies the same rules to group child sliders", async () => {
    const store = await import("./controlsStore");
    const pageId = store.activePage()!.id;
    const cardId = store.addCard(pageId, "group");
    const group = () => {
      const c = store.getSnapshot().pages.find((p) => p.id === pageId)!.cards.find((x) => x.id === cardId)!;
      return c.type === "group" ? c : null;
    };
    const child = group()!.children[0];
    const children = group()!.children.map((ch) =>
      ch.id === child.id ? { ...ch, min: 90, max: 10, step: 0 } : ch,
    );
    const r = store.patchCard(pageId, cardId, { children });
    expect(group()!.children[0]).toMatchObject({ min: 10, max: 10, step: 1 });
    expect(r.sliderFixes.map((f) => `${f.childId === child.id}:${f.field}:${f.reason}`)).toEqual([
      "true:step:step",
      "true:min:order",
    ]);
  });
});

describe("switch position persistence", () => {
  it("writes the clicked position into the saved card", async () => {
    const store = await import("./controlsStore");
    const pageId = store.activePage()!.id;
    const cardId = store.addCard(pageId, "switch");
    // 点击路径 = 写回卡片 state；脚本桥与编排绑定也写同一个字段。
    store.patchCard(pageId, cardId, { state: 1 });
    vi.runAllTimers();
    const saved = JSON.parse(localStorage.getItem("vs.controls")!) as {
      pages: { id: string; cards: { id: string; state?: number }[] }[];
    };
    const card = saved.pages.find((p) => p.id === pageId)!.cards.find((c) => c.id === cardId)!;
    expect(card.state).toBe(1);
  });
});
