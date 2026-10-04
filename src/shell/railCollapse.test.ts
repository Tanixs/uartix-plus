/**
 * P145 · 左侧活动导轨可以整条收起（用户："能不能加一个把左边导轨收起来的按钮"）。
 *
 * 钉四件事，每件都对应一个会静默坏掉的地方：
 *  1. **布局分母真的少 48**——CSS 不渲染 `.rail2` 而 dockview 还按旧宽度排，
 *     结果就是"画布右边整条压在看不见的地方"（P3 那批的老病，`RailPanel.tsx:182` 记过）；
 *  2. **二级面板跟着归零**——条都收了还留着面板占宽，就是留一扇没有把手的门；
 *  3. **把手长在导轨之外**——开关若挂在 `.rail2` 里，收起后用户就再也打不开它；
 *  4. **收起态落盘**——"常驻"是这套导轨既有语义（开着哪一项都会记住）。
 */
import { describe, expect, it, vi } from "vitest";

const fsSpec = "node:fs";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string | URL, e?: string) => string };

// railState 在**求值期**就读 localStorage（stripOpen = readStrip()），静态 import 会提升到
// stub 之前 ⇒ 先 stub 再动态导入（同法见 defaultLayout.test.ts:16-32）
const LS = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => LS.get(k) ?? null,
  setItem: (k: string, v: string) => LS.set(k, v),
  removeItem: (k: string) => LS.delete(k),
});
vi.stubGlobal("document", { documentElement: { style: { zoom: "100%" } } });
vi.stubGlobal("window", {
  innerWidth: 1200,
  innerHeight: 800,
  dispatchEvent: () => {},
  addEventListener: () => {},
});

const { SHELL_CHROME, gridSize } = await import("./defaultLayout");
const rail = await import("./railState");
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("P145 导轨收起：分母、面板、把手、落盘", () => {
  it("默认展开，收起时 stripWidth() 归零并落盘；再点回来分毫复位", () => {
    expect(rail.railStrip(), "新键默认必须是展开（默认收起等于偷偷改用户的界面）").toBe(true);
    expect(rail.stripWidth()).toBe(SHELL_CHROME.railW);

    rail.toggleRailStrip();
    expect(rail.railStrip()).toBe(false);
    expect(rail.stripWidth(), "收起后必须还给画布 0px 而不是负数或旧值").toBe(0);
    expect(LS.get(rail.RAIL_STRIP_KEY), "收起态不落盘，重启就弹回展开——那不是常驻").toBe("0");

    rail.toggleRailStrip();
    expect(rail.stripWidth()).toBe(SHELL_CHROME.railW);
    expect(LS.get(rail.RAIL_STRIP_KEY)).toBe("1");
  });

  it("二级面板开着时收起整条，railWidth() 也必须归零（面板不能独自占着宽度）", () => {
    rail.toggleRailPanel("views");
    expect(rail.railPanel()).toBe("views");
    const openW = rail.railWidth();
    expect(openW, "反空断言：面板没占宽，这条判据就是空转").toBeGreaterThan(0);

    rail.toggleRailStrip();
    expect(rail.railWidth(), "导轨条收起后二级面板仍报宽度：画布会被一条不存在的面板挤窄").toBe(0);

    rail.toggleRailStrip();
    expect(rail.railWidth(), "重新展开必须回到原来那一项的宽度（记住开着哪一项是这里的既有语义）").toBe(openW);
    rail.toggleRailPanel(null);
  });

  it("gridSize 的分母：少一条导轨就多 48px，且默认参数下读数一字不变", () => {
    const full = gridSize(0);
    const collapsed = gridSize(0, 0);
    expect(collapsed.w - full.w, "收起导轨没有把整条宽度还给画布").toBe(SHELL_CHROME.railW);
    expect(full.h, "收起左右导轨不该动垂直尺寸").toBe(collapsed.h);
    // 既有调用方（不传第二个参数）必须与改动前逐位相同——这条是"默认值即旧行为"的保险
    expect(full.w).toBe(gridSize(0, SHELL_CHROME.railW).w);
  });

  it("通知：收起 / 展开各推一次重排（App 的订阅回调靠它调 api.layout）", () => {
    let hits = 0;
    const off = rail.subscribeRail(() => { hits++; });
    rail.toggleRailStrip();
    rail.toggleRailStrip();
    off();
    expect(hits, "导轨开合不通知订阅方，dockview 就会按旧宽度排着").toBeGreaterThanOrEqual(2);
    rail.toggleRailStrip();
    rail.toggleRailStrip();
  });

  it("把手长在导轨之外：开关在身份栏，SideRail 收起时整块不渲染（不是 display:none）", () => {
    const bars = read("./TopBars.tsx");
    expect(bars, "身份栏里没有那颗开关").toContain("onClick={toggleRailStrip}");
    expect(bars, "开关必须有按压态（aria-pressed），否则读屏不知道导轨在不在").toContain("aria-pressed={!railOn}");

    const side = read("./SideRail.tsx");
    expect(side, "SideRail 里不该再有第二个收起入口（同一件事两个把手就是两本账）").not.toContain("toggleRailStrip");
    expect(side, "收起必须是**不渲染**：留着 DOM 就有'看不见却能 Tab 进去'的键盘陷阱").toMatch(
      /if \(!strip\) return null;/,
    );
    expect(side).not.toMatch(/rail2[^"]*display:\s*none/);
  });

  it("宽度只有一个出处：SHELL_CHROME.railW 与 CSS 的 .rail2 flex-basis 仍是一回事", () => {
    const css = read("../styles/theme.css");
    const m = /\.rail2\s*\{[^}]*?flex:\s*0 0 (\d+)px/.exec(css);
    expect(m, "`.rail2` 的 flex-basis 写法变了，这条判据要跟着改，不许删").toBeTruthy();
    expect(Number(m![1]), "CSS 与布局常量漂开：画布会按一个宽度排、按另一个宽度画").toBe(SHELL_CHROME.railW);
    expect(SHELL_CHROME.railW).toBe(48);
  });
});
