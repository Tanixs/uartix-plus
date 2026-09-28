/**
 * P116 · §19 同族债的第二刀：`.ui-dropdown` 的 vh 上限。
 *
 * 事故形状（1098×824 窗口实测，无头与内置浏览器各量一次）：
 *   `max-height: calc(100vh - 16px)` 在 110% 缩放档把浮层撑到超出窗口 **74px**、
 *   125% 档 **196px** —— 底部那几项落在窗口外，看得见够不着。
 *   CSS zoom 下 vh 是"视口高 ÷ 1 再被 zoom 放大一次"的双重缩放（§19 记的就是这条），
 *   P115-F2 已经为 `.ctx-menu` 换过一刀（静态 420px），`.ui-dropdown` 当时被记成明账没动。
 *
 * 这一批的修法与 F2 不同：**按窗口 ÷ zoom 现算**，不是再抄一个静态数。
 * 理由——浮层比右键菜单能吃的高度多得多（模型清单、Agent 面板），
 * 一刀切成 420px 会让高屏上白白截短；而 `Dropdown.tsx` 本来就在算 left/top 时除过 zf。
 *
 * 手法仍是源文本钉（没有 RTL，测不到"真的点开了一次"）；
 * 但"改完到底还溢不溢出"是我在浏览器里量过的，数字写在上面，不是推理出来的。
 */
import { describe, expect, it } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
/** 去注释：注释里提一句 vh 不算"这里还写着 vh" */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/([^:])\/\/[^\n]*/g, "$1");

describe("P116 · 浮层上限按窗口 ÷ zoom 现算，不再写 vh/vw", () => {
  const code = strip(read("shared/Dropdown.tsx"));

  it("maxHeight 与 maxWidth 都按 zf 折算（少一处那一维照样溢出）", () => {
    // 数 `/ zf` 的总次数而不是某一条完整模板：maxHeight 那行多一层括号，
    // 按 `${…/ zf}px` 的形状去配会漏掉它——数换算本身才是不想让人漏的东西。
    expect(code.match(/\/ zf/g)?.length, "left/top/maxHeight/maxWidth 四处都得 ÷zoom").toBeGreaterThanOrEqual(4);
    expect(code, "没读 zoom 因子就等于没折算").toContain(
      "getComputedStyle(document.documentElement).zoom",
    );
    expect(code).toMatch(/el\.style\.maxHeight = `?\$\{Math\.max\(160, \(window\.innerHeight - 16\) \/ zf\)/);
    expect(code).toMatch(/el\.style\.maxWidth = `?\$\{Math\.min\(340, \(window\.innerWidth - 16\) \/ zf\)/);
  });

  it("上限必须写在量高度之前：翻到锚点上方那支判断用的就是这个高度", () => {
    const set = code.indexOf("el.style.maxHeight");
    const measure = code.indexOf("el.getBoundingClientRect()");
    const flip = code.indexOf("ar.top - r.height");
    expect(set, "找不到 maxHeight 赋值").toBeGreaterThan(-1);
    expect(measure).toBeGreaterThan(set);
    expect(flip).toBeGreaterThan(measure);
  });

  it("theme.css 里 `.ui-dropdown` 不再出现 vh / vw", () => {
    const css = strip(read("styles/theme.css"));
    const at = css.indexOf(".ui-dropdown {");
    expect(at, "`.ui-dropdown` 规则块找不到了").toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block, "max-height 又用回 vh：zoom 下会双重缩放（§19）").not.toMatch(/100vh/);
    expect(block, "max-width 又用回 vw：同一族").not.toMatch(/100vw/);
    expect(block).toMatch(/max-height:\s*420px/);
  });
});
