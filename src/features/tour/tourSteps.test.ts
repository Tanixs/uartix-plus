/**
 * P99a-D2：入门引导（tour）的防腐门禁。
 *
 * 为什么单独一个文件而不是塞进 `helpCoverage.test.ts`：那边扫的是"帮助对功能的描述"，
 * 这边扫的是**引导自己的结构事实**——步数、编号、高亮选择器。而 tour 历来在门禁之外：
 * 欢迎语写"接下来 8 步"、`TourOverlay` 显示"共 9 步"、标题手工编号到第 7 步，三处口径
 * 各说各话，没有任何东西发现过。
 *
 * 选择器尤其要紧：`TourOverlay` 找不到目标时是**静默降级成居中卡片**
 * （`TourOverlay.tsx:45,63-64,96-98`），步骤照样能翻过去，只是不再指着任何东西。
 * 界面一改，引导就会悄悄从"手把手指"退化成"漂浮说明文"，肉眼看不出来。
 */
import { describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
// tourSteps 只为 do() 引这两个模块；它们会拉起 store（求值期摸 localStorage），测试里不需要真身
vi.mock("../ai/appBus", () => ({ requestOpenPanel: vi.fn() }));
vi.mock("../protocol/templateStore", () => ({ getSnapshot: () => ({ demoRunning: false }), toggleDemo: vi.fn() }));

const { TOUR_STEPS } = await import("./tourSteps");
import { PRIMARY_TIERS } from "../agent/scopeTiers";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync, statSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/[/\\]features[/\\]tour[/\\]?$/, "");

/** 全量扫一遍 src 的源文本：选择器这种东西只有"哪个组件真的写了这个属性"才算数 */
const allSrc = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) {
        if (name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(name)) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(SRC_ROOT);
  return out.join("\n");
})();

/** 内容步 = 去掉欢迎与完成（它们不带"第 N 步"编号） */
const numbered = TOUR_STEPS.filter((s) => s.id !== "welcome" && s.id !== "done");

describe("入门引导的结构事实不得手写", () => {
  it("欢迎语里的步数 == 真实内容步数（改了步骤忘了改文案就红）", () => {
    const welcome = TOUR_STEPS[0];
    expect(welcome.id).toBe("welcome");
    // 口径：欢迎卡自己与收尾卡都不算"带你走的步"，所以是 length-2
    const content = TOUR_STEPS.length - 2;
    expect(welcome.body.zh, `欢迎语该说"接下来 ${content} 步"`).toContain(`接下来 ${content} 步`);
    expect(welcome.body.zh).not.toMatch(/<(b|i|code)[ >]/);
  });

  it("「第 N 步」编号连续且与数组下标一致", () => {
    numbered.forEach((s, i) => {
      expect(s.title.zh, `第 ${i + 1} 个内容步（${s.id}）的编号不对`).toContain(`第 ${i + 1} 步`);
    });
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].title.zh).toContain("完成");
  });

  it("每一步的 id 唯一（do() 与埋点都按 id 找步骤）", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("带选择器的步骤：选择器必须真的能指到界面上的东西", () => {
    for (const s of TOUR_STEPS) {
      if (!s.selector) continue;
      // data-tour 是组件手写的锚点；data-panel 由 App 挂在面板内容根上（挂没挂上另有守卫，见文件末）
      const m = /^\[([^\]=]+)="([^"]+)"\]$/.exec(s.selector);
      expect(m, `步骤 ${s.id} 的选择器写法不认识：${s.selector}`).toBeTruthy();
      const [, attr, value] = m!;
      const hit =
        attr === "data-panel"
          ? new RegExp(`^\\s*${value}:\\s*\\(\\)`, "m").test(allSrc)
          : allSrc.includes(`${attr}="${value}"`) || allSrc.includes(`${attr}='${value}'`);
      expect(hit, `步骤 ${s.id} 的高亮目标 ${s.selector} 在源码里不存在（界面会静默降级成漂浮卡片）`).toBe(true);
    }
  });

  it("AI 那一步要把三个授权档都说全（改名不收文案＝骗新手）", () => {
    const ai = TOUR_STEPS.find((s) => s.id === "ai");
    expect(ai, "引导里没有 AI 这一步了").toBeTruthy();
    for (const t of PRIMARY_TIERS) {
      expect(ai!.body.zh, `引导里的授权档少了「${t.label}」`).toContain(t.label);
      expect(ai!.body.en, `引导英文少了档位「${t.label}」`).toBeTruthy();
    }
  });

  it("每一步都有正文、不超载，且不带标记符号（浮层是纯文本渲染）", () => {
    for (const s of TOUR_STEPS) {
      expect(s.body.zh.length, `步骤 ${s.id} 正文为空`).toBeGreaterThan(20);
      expect(s.body.zh.length, `步骤 ${s.id} 正文 ${s.body.zh.length} 字，该搬去帮助`).toBeLessThan(600);
      // `TourOverlay` 用 {tx(body.zh)} 直出文本：写 <b> 会原样显示成尖括号，写 \n 会被折成空格
      expect(s.body.zh, `步骤 ${s.id} 正文里有 HTML 标记，浮层会原样显示`).not.toMatch(/<\/?[a-z]/);
      expect(s.body.zh, `步骤 ${s.id} 正文里有换行，浮层会把它折成空格`).not.toContain("\n");
    }
  });
});

/* ================= P99b-N6 · 第 9 步（装东西的地方）专属 =================
 * 上面那条通用守卫只管"选择器在源码里存在"；这里要管的是**它存在在哪颗上**——
 * `data-tour="plugins"` 写在随便哪个别的按钮上，那条通用守卫照样绿，而高亮会框错东西。
 */
describe("P99b-N6 · 入门引导里市场那一步", () => {
  const ids = numbered.map((s) => s.id);

  it("排在「让它造东西」之后：先讲 AI 造的，再讲别人造的（两条信任链不要混着讲）", () => {
    expect(ids).toContain("market");
    expect(ids.indexOf("market"), "市场那一步的位置变了").toBe(ids.indexOf("create") + 1);
  });

  it("锚点确实挂在标题栏那颗「插件管理」上", () => {
    const m = numbered.find((s) => s.id === "market");
    expect(m?.selector).toBe('[data-tour="plugins"]');
    const tb = readFileSync(fileURLToPath(new URL("../../shell/TitleBar.tsx", import.meta.url)), "utf8");
    expect(/title="插件管理"[\s\S]{0,220}data-tour="plugins"/.test(tb), "锚点不在「插件管理」那颗按钮上").toBe(true);
  });

  it("这一步要说清两件用户会撞上的事：装来是停用态、覆盖要人确认", () => {
    const zh = numbered.find((s) => s.id === "market")!.body.zh;
    expect(zh).toContain("停用态");
    expect(zh).toContain("确认卡");
    // 「打开那一页才联网」是市场的招牌承诺，引导里说了就得在这儿钉住
    expect(zh).toMatch(/打开那一页时才?联网/);
  });
});

/* ================= P102 · 面板锚点必须真的挂在 DOM 上 =================
 * 上面那条通用守卫查的是"这个 key 在面板注册表里存在"，它**替运行时作了保**：
 * dockview 升到 8 之后 `panel.window` / `panel.type` 两个成员都不存在了，
 * `App.tsx` 里那句 `if (p.window && p.type)` 从此恒假 ⇒ `data-panel` 一次都没写过，
 * 三个面板步全部静默降级成漂浮卡片，而这条守卫一直是绿的（用户看到的正是这个现象）。
 * 所以这里钉的是**赋值那一行本身**：属性有没有写、写到哪个元素上。
 */
describe("P102 · data-panel 锚点真的挂得上（不是「注册过」就算数）", () => {
  const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
  const overlay = readFileSync(
    fileURLToPath(new URL("./TourOverlay.tsx", import.meta.url)),
    "utf8",
  );

  it("App.tsx 里挂锚点的那行走的是 dockview 真的有的成员", () => {
    expect(app, "data-panel 又不挂了 ⇒ 引导的面板步会静默降级成漂浮卡片").toMatch(
      /setAttribute\(\s*"data-panel"\s*,/,
    );
    expect(app, "锚点没挂在面板内容根上（主题作用域会连页签条一起框进去）").toContain(
      "view.content.element",
    );
    expect(app, "又回去读那个不存在的 p.window 了").not.toMatch(/\.window\s*&&/);
    // 恒假取值的另一半：`p.type` 也不在 IDockviewPanel 上，靠 as unknown as 按住 tsc
    expect(app, "as unknown as 那对强转回来了，它正是把这条死路按住的东西").not.toMatch(
      /as unknown as \{[^}]*window/,
    );
  });

  it("面板类步骤把聚光灯扩到停靠框外框（只框内容区看着像没高亮）", () => {
    const panelSteps = TOUR_STEPS.filter((s) => s.selector?.startsWith("[data-panel="));
    expect(panelSteps.length, "引导里没有面板步了？那这条守卫要跟着删").toBeGreaterThan(0);
    for (const s of panelSteps) {
      expect(s.frame, `步骤 ${s.id} 没声明 frame：环只会框内容区`).toBe(true);
    }
    expect(overlay, "TourOverlay 没实现 frame，声明了也没用").toMatch(
      /closest\(["']\.dv-groupview["']\)/,
    );
  });
});
