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
      // data-tour 是组件手写的锚点；data-panel 是 dockview 的页签 id，它必须注册过
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
