/**
 * P104-B7 首启欢迎卡的防腐门禁。
 *
 * 这条批次的特殊之处：交付物里有一张**真实截图**。像素不是代码——
 * 十道门没有一道看得懂图片，改名、删元素、把东西挪走，图都不会红。
 * 本文件就是补那一段：把"图与事实不符"里**可判**的那半判掉。
 *
 * 三条判据，各管一类漂移：
 *  ① 徽标锚点还在源码里 —— 指着一个已经不存在的东西；
 *  ② 图上印着的词 == 那一行今天的名字 —— 图上写「协议」而界面上已经改口；
 *  ③ 底图尺寸 == `SHOT_W/SHOT_H` —— 徽标坐标是**比例**，图换了尺寸就集体漂。
 *
 * 判据②第一版只查"这个词还在 `src` 里吗"，证伪当场被推翻（详见 `SHOT_FACTS` 的注释）：
 * 工具栏那颗改了名，同一句话还留在隔壁 tooltip 里，门没红。所以现在按**文件 + 声明行**比。
 * 读文件而不是 import：`PANEL_TITLES()` / `RAIL_ITEMS` 都要拉起居列 store，
 * 测试环境里那些模块的求值期副作用比它们的名字更贵。
 */
import { describe, expect, it } from "vitest";
import {
  SHOT_FACTS,
  SHOT_H,
  SHOT_W,
  WELCOME_SEEN_KEY,
  WELCOME_SLIDES,
  type WelcomeSlide,
} from "./welcomeSlides";

/* node: 模块走"变量说明符"动态导入：`src` 的 tsconfig 不挂 @types/node，
   直接 `from "node:fs"` 会被 tsc 判"找不到模块"（`tourSteps.test.ts` 同一写法同一理由）。 */
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync, statSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[/\\]shell[/\\]?$/, "");

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const readSrc = (rel: string) => stripComments(readFileSync(`${SRC_ROOT}${rel}`, "utf8"));

/** 全量源码（去注释、排除测试）：锚点与文案只有"组件真的写了这一行"才算数 */
const allSrc = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) {
        if (name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        out.push(stripComments(readFileSync(p, "utf8")));
      }
    }
  };
  walk(SRC_ROOT);
  return out.join("\n");
})();

const withBadges = WELCOME_SLIDES.filter((s: WelcomeSlide) => s.badges?.length);

describe("欢迎卡的徽标必须还指着界面上的东西", () => {
  it("卡 2 有徽标，且编号与要点一一对应", () => {
    expect(withBadges.length, "一张带徽标的卡都没有——这条守卫瞎了").toBe(1);
    for (const s of withBadges) {
      const b = s.badges!;
      expect(b.length, `${s.id}：徽标数与要点数不等（图上的 ② 会对不上正文的第 2 条）`).toBe(
        s.leads.length,
      );
      expect(b.map((x) => x.n).sort()).toEqual(s.leads.map((_, i) => i + 1).sort());
      for (const x of b) {
        expect(x.x, `${s.id} 徽标 ${x.n} 的 x 不在 0~1`).toBeGreaterThan(0);
        expect(x.x).toBeLessThan(1);
        expect(x.y, `${s.id} 徽标 ${x.n} 的 y 不在 0~1`).toBeGreaterThan(0);
        expect(x.y).toBeLessThan(1);
      }
    }
  });

  it("每个徽标的锚点真的写在源码里（锚点没了 = 图在指一个不存在的东西）", () => {
    for (const s of withBadges) {
      for (const b of s.badges!) {
        const hit =
          b.anchor.kind === "panel"
            ? new RegExp(`^\\s*${b.anchor.value}:\\s*\\(\\)`, "m").test(allSrc)
            : new RegExp(`className=["'\`][^"'\`]*\\b${b.anchor.value}\\b`).test(allSrc);
        expect(
          hit,
          `徽标 ${b.n}（${s.id}）指着 ${b.anchor.kind}=${b.anchor.value}，源码里已经找不到它了 —— 要么改锚点，要么重拍图（npm run welcome:snap）`,
        ).toBe(true);
      }
    }
  });
});

describe("截图里印着的词必须还是那一行今天的名字", () => {
  /** 声明行的两种写法：`"键名": 值` 与 `键名: 值`（railState 那种 `{ key: "link", zh: "接入" }` 走前者） */
  const declares = (line: string, key: string) =>
    line.includes(`"${key}"`) || line.includes(`${key}:`);

  it.each(SHOT_FACTS.map((f) => [f.word, f.file, f.key] as const))(
    "「%s」还写在 %s 的 %s 那一行",
    (word, file, key) => {
      let lines: string[] = [];
      try {
        lines = stripComments(readFileSync(`${SRC_ROOT}${file}`, "utf8")).split("\n");
      } catch {
        expect.fail(`${file} 已经不在了 —— 图上印着的「${word}」无处可查，重拍图或把声明处补回来`);
      }
      expect(
        lines.some((l) => declares(l, key) && l.includes(word)),
        `底图上印着「${word}」，但 ${file} 的 ${key} 那一行已经不叫这个了 —— 改文案就要重拍图（npm run welcome:snap），别把过期图留着`,
      ).toBe(true);
    },
  );

  it("事实表本身不许空着（空表 = 这条守卫静默通过）", () => {
    expect(SHOT_FACTS.length).toBeGreaterThanOrEqual(15);
  });
});

describe("底图与坐标口径", () => {
  /** PNG 头部：8 字节签名 + 4 长度 + 4 "IHDR"，其后 4 字节宽、4 字节高（大端）。
   *  只声明用到的两个方法，不引 Buffer 类型（`src` 的 tsconfig 没有 @types/node）。 */
  const pngSize = (file: string) => {
    const buf = readFileSync(
      fileURLToPath(new URL(`../assets/welcome/${file}`, import.meta.url)),
    ) as unknown as {
      subarray(a: number, b: number): { toString(enc: string): string };
      readUInt32BE(a: number): number;
    };
    expect(buf.subarray(12, 16).toString("ascii"), `${file} 不是 PNG（缺 IHDR）`).toBe("IHDR");
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };

  it("两张底图的真实尺寸 == SHOT_W × SHOT_H（坐标是比例，图换了尺寸会集体漂）", () => {
    for (const f of ["proto-light.png", "proto-dark.png"]) {
      expect(pngSize(f), f).toEqual({ w: SHOT_W, h: SHOT_H });
    }
  });

  /**
   * "两张卡等高"是 CSS 里的两个数凑出来的，不是代码能保证的：
   * `.wlc-shotbox` 的宽 × 底图长宽比 必须等于 `.wlc-body` 那方定高舞台。
   * 谁改了其中一边（比如把底图加宽到 560），翻卡就会重新跳起来，而肉眼只看到"有点怪"。
   * 与 `defaultLayout.test.ts` 里 CSS↔TS 那条同一手法。
   */
  it("定高舞台的高度 == 底图宽 × 长宽比（改一边忘了另一边 = 翻卡又跳）", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/theme.css", import.meta.url)), "utf8");
    const grab = (sel: string, prop: string) => {
      const block = new RegExp(`\\.${sel}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1] ?? "";
      const line = new RegExp(`${prop}:\\s*([^;]+);`).exec(block)?.[1] ?? "";
      // 取这一行里**最后一个** px：`.wlc-shotbox` 写的是 `min(100%, 520px)`，
      // 那个 520 才是底图宽；`100%` 没有 px，不会被误取。
      const all = [...line.matchAll(/([0-9.]+)px/g)];
      return all.length ? Number(all[all.length - 1][1]) : NaN;
    };
    const shotW = grab("wlc-shotbox", "width");
    const stage = grab("wlc-body", "height");
    expect(shotW, ".wlc-shotbox 的宽度没读到（写法变了要同步改这条）").toBeGreaterThan(0);
    expect(stage, ".wlc-body 的定高没读到（改成 min-height 就等于放弃约束）").toBeGreaterThan(0);
    expect(Math.abs(stage - shotW * (SHOT_H / SHOT_W)), "两张卡会差出这个高度").toBeLessThan(1);
  });
});

describe("首启只有一个标记", () => {
  it("vs.tour.seen 已经从代码里退场（B7 撤了自动弹，那个键只剩写没有读）", () => {
    expect(allSrc.includes("vs.tour.seen"), "又冒出第二个「首启标记」——两处真相等着漂移").toBe(false);
    expect(WELCOME_SEEN_KEY).toBe("vs.welcome.seen");
  });

  it("欢迎卡承诺的两个快捷键还绑在 App 上", () => {
    const app = readSrc("App.tsx");
    expect(app, "Ctrl+K 不再开 AI 了，卡上那行小字是错的").toMatch(/e\.key === "k"/);
    expect(app, "命令面板不再绑 Ctrl+Shift+P 了，卡上那行小字是错的").toMatch(/e\.key === "p"/);
    expect(app).toMatch(/shiftKey/);
  });
});
