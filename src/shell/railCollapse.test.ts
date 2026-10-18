/**
 * P145 立：左侧活动导轨可以整条收起（用户："能不能加一个把左边导轨收起来的按钮"）。
 * P155-R 改判（用户 2026-10-17："收缩导轨栏时不要把第二栏给收起来"）：**条与二级面板各自独立**。
 * 本文件跟着改判，钉四件事，每件都对应一个会静默坏掉的地方：
 *  1. **布局分母各算各的**——条收起少 48；面板开着仍占它自己的宽（P145 那版是"一起归零"，
 *     P155-R 起作废：面板在无条状态下能单独立着才是用户要的）；
 *  2. **无条状态的面板有把手**——`.rp-head` 报案名、关闭钮走 `toggleRailPanel(null)`；
 *  3. **开关长在导轨之外、图标两态接线**——开关挂在 `.rail2` 里，收起后用户就再也打不开它；
 *     图标不做两态区分，用户看不出点下去是收还是开（P155-R 用户第二条原话）；
 *  4. **收起态落盘 + 宽度常量单出处**——"常驻"是这套导轨既有语义。
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

describe("P145/P155-R 导轨收起：分母各算各的、面板有把手、开关在外", () => {
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

  it("P155-R 改判：面板开着时收起条，railWidth() 仍报面板宽（它单独立着）", () => {
    rail.toggleRailPanel("views");
    expect(rail.railPanel()).toBe("views");
    const openW = rail.railWidth();
    expect(openW, "反空断言：面板没占宽，这条判据就是空转").toBeGreaterThan(0);

    rail.toggleRailStrip();
    expect(rail.stripWidth(), "条收起要真的还 48px 给画布").toBe(0);
    expect(
      rail.railWidth(),
      "条收起后面板仍立着 ⇒ 布局分母必须继续算它的宽（旧行为在这里归零就是把面板一起藏了）",
    ).toBe(openW);

    rail.toggleRailStrip();
    expect(rail.railWidth(), "条再展开，面板宽度分毫不变").toBe(openW);
    rail.toggleRailPanel(null);
    expect(rail.railWidth(), "面板自己关了才是 0").toBe(0);
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

  it("把手与两态：开关在身份栏且图标接线 railOn；条收起时面板照渲染并有 .rp-head 关闭钮", () => {
    const bars = read("./TopBars.tsx");
    expect(bars, "身份栏里没有那颗开关").toContain("onClick={toggleRailStrip}");
    expect(bars, "开关必须有按压态（aria-pressed），否则读屏不知道导轨在不在").toContain("aria-pressed={!railOn}");
    expect(bars, "图标没有接 railOn，两态就永远只画一态").toContain("<IconRailCollapse open={railOn} />");

    const side = read("./SideRail.tsx");
    expect(side, "SideRail 里不该再有第二个收起入口（同一件事两个把手就是两本账）").not.toContain("toggleRailStrip");
    expect(side, "条收起仍必须是**不渲染**（留着 DOM 就有能 Tab 进去的键盘陷阱）").toMatch(/\{strip && \(/);
    expect(side, "P145 的整块不渲染回来了——面板要跟条各自独立").not.toMatch(/if \(!strip\) return null;/);
    expect(side, "RailPanel 必须在条收起时照渲染").toContain("<RailPanel actions={actions} />");

    const panel = read("./RailPanel.tsx");
    expect(panel, "无条状态的面板头（把手）不见了").toContain('className="rp-head"');
    expect(panel, "面板头没有关闭动作").toContain("toggleRailPanel(null)");
    expect(panel, "面板头不判 railStrip——有条时也画出来就是两份入口").toMatch(/!strip && \(/);

    const css = read("../styles/theme.css");
    expect(css, "图标两态的 .irc-closed 规则不在").toMatch(/\.irc\.irc-closed \.irc-arrow\s*\{\s*transform:\s*rotate\(180deg\)/);
  });

  it("宽度只有一个出处：SHELL_CHROME.railW 与 CSS 的 .rail2 flex-basis 仍是一回事", () => {
    const css = read("../styles/theme.css");
    const m = /\.rail2\s*\{[^}]*?flex:\s*0 0 (\d+)px/.exec(css);
    expect(m, "`.rail2` 的 flex-basis 写法变了，这条判据要跟着改，不许删").toBeTruthy();
    expect(Number(m![1]), "CSS 与布局常量漂开：画布会按一个宽度排、按另一个宽度画").toBe(SHELL_CHROME.railW);
    expect(SHELL_CHROME.railW).toBe(48);
  });
});
