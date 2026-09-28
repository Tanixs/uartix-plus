import { describe, expect, it, vi } from "vitest";

/**
 * P104-B0：dev-only 启动覆盖的守卫测试。
 * 这里钉的不是「功能可用」，而是**「生产构建里它必须不存在」**——
 * 一个能改主题/改布局/清存档的 URL 入口若漏进产物，等于给出去一个远程改用户环境的口子。
 *
 * localStorage 要先 stub 再动态 import：settingsStore 在求值期就读它（:148 那句没包 try/catch），
 * 这是项目既有约定，见 settingsTools.test.ts 同法。removeItem 也补上，
 * 否则 applyDevBoot 的清布局分支会被 try/catch 静默吞掉，测了等于没测。
 */
vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const { applyDevBoot, devBootEnabled, devOpenRequest, devWelcomeAt, hasDevBoot, parseDevBoot, DEV_SETTINGS_TABS, ZOOM_STEPS, LAYOUT_KEY } =
  await import("./bootOverrides");
const { WELCOME_SEEN_KEY } = await import("../shell/welcomeSlides");
const { RAIL_PANEL_KEY } = await import("../shell/railState");
const settings = await import("../features/settings/settingsStore");
describe("devBootEnabled：生产侧必须 inert", () => {
  it("dev=true / prod=false 才启用", () => {
    expect(devBootEnabled({ dev: true, prod: false })).toBe(true);
  });
  it("prod=true 一律关（哪怕 dev 也为真）", () => {
    expect(devBootEnabled({ dev: true, prod: true })).toBe(false);
  });
  it("两个标志都缺 ⇒ 关（默认拒绝，不是默认放行）", () => {
    expect(devBootEnabled({})).toBe(false);
    expect(devBootEnabled(undefined)).toBe(false);
  });
});

describe("parseDevBoot：白名单", () => {
  it("合法 preset 生效，且默认连带清布局", () => {
    const o = parseDevBoot("?preset=analyze");
    expect(o.preset).toBe("analyze");
    expect(o.resetLayout).toBe(true);
  });
  it("?layout=keep 时保留存档", () => {
    expect(parseDevBoot("?preset=analyze&layout=keep").resetLayout).toBe(false);
  });
  it("白名单外的 preset 整个丢掉（不写脏值）", () => {
    const o = parseDevBoot("?preset=rm -rf");
    expect(o.preset).toBeUndefined();
    expect(o.resetLayout).toBe(false);
    expect(hasDevBoot(o)).toBe(false);
  });
  it("zoom 只认档位表；95/120/0/NaN 全丢", () => {
    expect(parseDevBoot("?zoom=125").zoom).toBe(125);
    for (const bad of ["95", "120", "0", "abc", ""]) {
      expect(parseDevBoot(`?zoom=${bad}`).zoom).toBeUndefined();
    }
  });
  it("档位表与 settingsStore.normalize 的白名单同序", () => {
    expect(ZOOM_STEPS).toEqual([90, 100, 110, 125]);
  });
  it("theme 走 THEME_LIST", () => {
    expect(parseDevBoot("?theme=navy").theme).toBe("navy");
    expect(parseDevBoot("?theme=%2e%2e%2fx").theme).toBeUndefined();
  });
  /** P105-F：英文界面要能被拍到，所以 `?lang=` 与 `?theme=` 同级。 */
  it("lang 走 LOCALE_LIST，白名单外整个丢掉", async () => {
    const { LOCALE_LIST } = await import("../i18n/strings");
    expect(parseDevBoot("?lang=en").lang).toBe("en");
    for (const loc of LOCALE_LIST) expect(parseDevBoot(`?lang=${loc}`).lang).toBe(loc);
    expect(parseDevBoot("?lang=fr").lang).toBeUndefined();
    expect(hasDevBoot(parseDevBoot("?lang=fr"))).toBe(false);
  });
  /**
   * B7 改判：原来这两条钉的是 `?tour=0 → tourOff`（压制"首启自动弹引导"）。
   * 自动弹被撤掉了，那个参数没有可压的东西 ⇒ 断言对象换成新的取证入口。
   * 不是放松：新的两条把 `0` 与 `1` 两侧都钉住了，旧的只钉了一侧。
   */
  it("welcome=0 / welcome=1 各认一头，其它值不认", () => {
    expect(parseDevBoot("?welcome=0").welcomeOff).toBe(true);
    expect(parseDevBoot("?welcome=1").welcomeForce).toBe(true);
    expect(parseDevBoot("?welcome=maybe").welcomeOff).toBeUndefined();
    expect(parseDevBoot("?welcome=maybe").welcomeForce).toBeUndefined();
  });
  it("?tour=0 不再是任何开关（自动弹已撤，留着会以为它还在管某件事）", () => {
    expect(parseDevBoot("?tour=0").tourAt).toBeUndefined();
    expect(hasDevBoot(parseDevBoot("?tour=0"))).toBe(false);
  });
  /** 无头截图点不动圆点，所以第几张卡必须能从 URL 指定（devWelcomeAt 与 ?tour=N 同一个理由）。 */
  it("devWelcomeAt：dev 下 ?welcome=N 给下标，生产恒 undefined", () => {
    expect(devWelcomeAt("?welcome=2", { dev: true, prod: false })).toBe(1);
    expect(devWelcomeAt("?welcome=9", { dev: true, prod: false })).toBe(8);
    expect(devWelcomeAt("?welcome=1", { dev: true, prod: false })).toBeUndefined();
    expect(devWelcomeAt("", { dev: true, prod: false })).toBeUndefined();
    expect(devWelcomeAt("?welcome=2", { dev: false, prod: true })).toBeUndefined();
  });
  it("空查询串什么都不生效", () => {
    expect(hasDevBoot(parseDevBoot(""))).toBe(false);
    expect(hasDevBoot(parseDevBoot("?"))).toBe(false);
  });
});

describe("applyDevBoot：真实副作用", () => {
  it("dev 下 preset/theme/zoom 真的写进 settings 快照", () => {
    const applied = applyDevBoot("?preset=calib&theme=navy&zoom=90", { dev: true, prod: false });
    expect(applied.preset).toBe("calib");
    const s = settings.getSnapshot();
    expect(s.workspace).toBe("calib");
    expect(s.theme).toBe("navy");
    expect(s.zoom).toBe(90);
  });
  it("prod 标志下一个字都不改", () => {
    settings.patch({ workspace: "proto", theme: "begonia", zoom: 100 });
    applyDevBoot("?preset=calib&theme=navy&zoom=125", { dev: false, prod: true });
    const s = settings.getSnapshot();
    expect(s.workspace).toBe("proto");
    expect(s.theme).toBe("begonia");
    expect(s.zoom).toBe(100);
  });
  it("?lang=en 真的改到 settings；prod 下不动它", () => {
    settings.patch({ locale: "zh" });
    applyDevBoot("?lang=en", { dev: false, prod: true });
    expect(settings.getSnapshot().locale).toBe("zh");
    applyDevBoot("?lang=en", { dev: true, prod: false });
    expect(settings.getSnapshot().locale).toBe("en");
    applyDevBoot("?lang=fr", { dev: true, prod: false });
    expect(settings.getSnapshot().locale).toBe("en");
    settings.patch({ locale: "zh" });
  });
  it("白名单外的值不改对应项（但合法项照常生效）", () => {
    settings.patch({ workspace: "proto", zoom: 100 });
    applyDevBoot("?preset=bogus&zoom=95", { dev: true, prod: false });
    const s = settings.getSnapshot();
    expect(s.workspace).toBe("proto");
    expect(s.zoom).toBe(100);
  });
  it("welcome=0 置 vs.welcome.seen；welcome=1 清掉它；不带则不动", () => {
    storage.delete(WELCOME_SEEN_KEY);
    applyDevBoot("?welcome=0", { dev: true, prod: false });
    expect(storage.get(WELCOME_SEEN_KEY)).toBe("1");

    applyDevBoot("?welcome=1", { dev: true, prod: false });
    expect(storage.has(WELCOME_SEEN_KEY)).toBe(false);

    storage.set(WELCOME_SEEN_KEY, "1");
    applyDevBoot("?theme=navy", { dev: true, prod: false });
    expect(storage.get(WELCOME_SEEN_KEY)).toBe("1");
    storage.delete(WELCOME_SEEN_KEY);
  });
  it("rail=link 展开导轨那一项；白名单外的值不写", () => {
    storage.delete(RAIL_PANEL_KEY);
    expect(parseDevBoot("?rail=link").rail).toBe("link");
    applyDevBoot("?rail=link", { dev: true, prod: false });
    expect(storage.get(RAIL_PANEL_KEY)).toBe("link");

    storage.delete(RAIL_PANEL_KEY);
    expect(parseDevBoot("?rail=bogus").rail).toBeUndefined();
    applyDevBoot("?rail=bogus", { dev: true, prod: false });
    expect(storage.has(RAIL_PANEL_KEY)).toBe(false);
  });
  /**
   * `?iface=` 认的取值必须与导轨/胶囊用的那份接口清单一致。
   * 这里**读源码文本**而不是 import `linkSummary.ts`：那个模块 value-import 了 serialStore，
   * 一引进来就把 Tauri 事件与 invoke 拖进这个测试 —— 与 `defaultLayout.test.ts`
   * 拿 CSS 当事实源同一手法，比对的是"两处写法有没有漂"。
   */
  it("?iface 认的取值 == IFACE_ITEMS（改名会红；漏一种只是拍不到那一张）", async () => {
    // 变量说明符：`src` 的 tsconfig 不挂 @types/node，写字面量会被 tsc 判"找不到模块"
    // （`tourSteps.test.ts` / `welcome.test.ts` 同一写法同一理由）
    const fsSpec = "node:fs";
    const urlSpec = "node:url";
    const { readFileSync } = (await import(fsSpec)) as unknown as {
      readFileSync: (p: string, enc?: string) => string;
    };
    const { fileURLToPath } = (await import(urlSpec)) as unknown as {
      fileURLToPath: (u: string | URL) => string;
    };
    const src = readFileSync(
      fileURLToPath(new URL("../features/serial/linkSummary.ts", import.meta.url)),
      "utf8",
    );
    const list = /IFACE_ITEMS[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    const kinds = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(kinds.length, "从 linkSummary.ts 抠不出 IFACE_ITEMS —— 写法变了要同步改这条").toBeGreaterThan(3);
    for (const k of kinds) expect(parseDevBoot(`?iface=${k}`).iface).toBe(k);
    expect(parseDevBoot("?iface=bogus").iface).toBeUndefined();
  });
  it("带 preset 时清掉已存布局；?layout=keep 时保留", () => {
    storage.set(LAYOUT_KEY, '{"panels":[]}');
    applyDevBoot("?preset=analyze", { dev: true, prod: false });
    expect(storage.has(LAYOUT_KEY)).toBe(false);

    storage.set(LAYOUT_KEY, '{"panels":[]}');
    applyDevBoot("?preset=analyze&layout=keep", { dev: true, prod: false });
    expect(storage.has(LAYOUT_KEY)).toBe(true);
  });
  it("B13①：重置必须连 v2 备份与 corrupt 一起清，否则 preset 静默失效", () => {
    /* 键升到 v3 之后，启动读的是 `v3 ?? v2`。如果 reset 只删 v3，
       那份 v2 备份就会在下次启动被当旧档读回来 —— applyDefaultLayout 根本不跑，
       表现是"?preset= 没生效"而且不报任何错。这条钉住那个形状。 */
    storage.set(LAYOUT_KEY, '{"v":3,"layout":{"panels":[]}}');
    storage.set("vs.layout.v2", '{"panels":[]}');
    storage.set("vs.layout.corrupt", '{broken');
    applyDevBoot("?preset=analyze", { dev: true, prod: false });
    expect(storage.has(LAYOUT_KEY)).toBe(false);
    expect(storage.has("vs.layout.v2")).toBe(false);
    expect(storage.has("vs.layout.corrupt")).toBe(false);
  });
  it("prod 下绝不碰存档", () => {
    storage.set(LAYOUT_KEY, '{"panels":[]}');
    applyDevBoot("?preset=analyze", { dev: false, prod: true });
    expect(storage.has(LAYOUT_KEY)).toBe(true);
  });
});

/**
 * P111-A2：`?open=` —— 把"打开态"摆给无头截图看。
 *
 * 这条入口存在的理由写在 `bootOverrides.ts` 的注释里：P110-B3/B4 交出去之前我一眼没看，
 * 而当时那句"看不了"是假的，缺的只是"启动后自动打开它"这一句话。
 * 于是它要钉住的还是同两件事：**prod 里必须不存在**，以及**脏值不能把界面开成空白**。
 */
describe("?open=settings/ai：取证要的那个打开态", () => {
  it("视图与页 key 一起给", () => {
    expect(parseDevBoot("?open=settings/ai")).toMatchObject({ open: "settings", settingsTab: "ai" });
    expect(devOpenRequest("?open=settings/ai", { dev: true, prod: false })).toEqual({ view: "settings", tab: "ai" });
  });
  it("只给视图也认（?open=ai 是浮窗助手，不是设置页）", () => {
    expect(devOpenRequest("?open=ai", { dev: true, prod: false })).toEqual({ view: "ai", tab: undefined });
  });
  it("未知视图整个丢；未知页 key 只丢 key、保留视图", () => {
    // 把 "bogus" 原样递进 SettingsModal 会得到一个**空白内容区**（它是 useState(initialTab ?? "general")），
    // 那比拍不到更坏：看图的人会以为这一页本来就是空的。
    expect(parseDevBoot("?open=bogus").open).toBeUndefined();
    expect(parseDevBoot("?open=settings/bogus")).toMatchObject({ open: "settings" });
    expect(parseDevBoot("?open=settings/bogus").settingsTab).toBeUndefined();
  });
  it("prod 恒为 undefined（一个能弹开任何界面的 URL 入口不该进产物）", () => {
    expect(devOpenRequest("?open=settings/ai", { dev: false, prod: true })).toBeUndefined();
    expect(devOpenRequest("?open=ai", { dev: true, prod: true })).toBeUndefined();
    expect(devOpenRequest("", { dev: true, prod: false })).toBeUndefined();
    // 缺省 env 走 import.meta.env：vitest 里那是 dev=true，所以**不能**拿缺省调用去证 prod-inert，
    // 上面两条显式给 prod=true 的才是那条纪律的落点（与 devWelcomeAt 同一写法同一理由）。
  });
  it("hasDevBoot 认得它 —— 否则 ?open= 单独出现时整层短路", () => {
    expect(hasDevBoot(parseDevBoot("?open=ai"))).toBe(true);
  });
  it("DEV_SETTINGS_TABS == SettingsModal 的 tabs key 列表（改名会红）", async () => {
    // 与上面 ?iface 那条同一手法：读源文本逐项比，不 import 组件（那会把半个应用拉进取证层）。
    const fsSpec = "node:fs";
    const urlSpec = "node:url";
    const { readFileSync } = (await import(fsSpec)) as unknown as {
      readFileSync: (p: string, enc?: string) => string;
    };
    const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };
    const src = readFileSync(
      fileURLToPath(new URL("../features/settings/SettingsModal.tsx", import.meta.url)),
      "utf8",
    );
    const block = /const tabs: \{[^}]*\}\[\] = \[([\s\S]*?)\n {2}\];/.exec(src)?.[1] ?? "";
    const literal = [...block.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
    expect(literal.length, "从 SettingsModal 抠不出 tabs —— 写法变了要同步改这条").toBeGreaterThan(5);
    const inModal = new Set([...literal, settings.SETTINGS_TAB_PLUGINS]);
    const inDev = new Set<string>(DEV_SETTINGS_TABS);
    for (const k of inModal) expect(inDev.has(k), `设置页有「${k}」这一页，?open= 却开不到`).toBe(true);
    for (const k of inDev) expect(inModal.has(k), `?open= 白名单里的「${k}」在设置页已经不存在了，删掉它`).toBe(true);
  });
});
