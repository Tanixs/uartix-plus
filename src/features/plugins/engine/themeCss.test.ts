import { describe, expect, it } from "vitest";
import { THEME_CSS_MAX_BYTES, guardThemeCss } from "./themeCss";

/**
 * 这组用例钉的是**插件主题这条通路上的净化**，不是净化器本身（那有 styleSanitize.test.ts）。
 * 区别很重要：净化器再严，只要 `readThemeCss` 那一步没调它，插件主题就是裸奔的。所以这里
 * 全部从 `guardThemeCss` 这一层进，摘掉那行调用就会红。
 */
describe("插件主题 CSS 的入口判据", () => {
  it("改全局的 CSS 一律不收（body / #root / html / *）", () => {
    for (const bad of ["body{display:none}", "#root{opacity:0}", "html{filter:invert(1)}", "*{cursor:none}"]) {
      const r = guardThemeCss(bad, "theme.css");
      expect(r.css, `${bad} 不该放行`).toBeUndefined();
      expect(r.issue).toContain("没过净化");
    }
  });

  it("@import / !important 不收（它们是「从主题里伸手到别处」的两条绳）", () => {
    expect(guardThemeCss('@import url("https://evil/x.css");.a{color:red}', "t.css").issue).toContain("没过净化");
    expect(guardThemeCss(".a{color:red !important}", "t.css").issue).toContain("没过净化");
  });

  it(":root 里换 token 要放行——那正是「主题」两个字的意思", () => {
    // reservedVars 传空 = 没有哪枚 token 是不许动的。与内置主题、AI 写主题两条既有通路一致：
    // 主题的本职就是改配色，把 --bg 也锁上会让"插件主题"只能做装饰性微调。
    const r = guardThemeCss(':root{--bg:#000;--text:#eee}\n.a{color:var(--text)}', "t.css");
    expect(r.issue).toBeUndefined();
    expect(r.css).toContain("--bg:#000");
  });

  it("但「换 token」与「改元素」是两件事：靠选择器直接改元素照样不收", () => {
    // 这条界线是净化器的全部价值所在：token 只影响引用了它的地方，`body{}` 影响整棵文档
    expect(guardThemeCss(':root{--bg:#000}\nbody{background:var(--bg)}', "t.css").css).toBeUndefined();
  });

  it("问题很多时只贴前三条（否则面板顶部那行字没法看）", () => {
    const many = ["body{a:b}", "#root{a:b}", "*{a:b}", "html{a:b}", ".a{color:red !important}"].join("\n");
    const issues = (guardThemeCss(many, "t.css").issue ?? "").split("；");
    expect(issues.length).toBeLessThanOrEqual(3);
  });

  it("正常主题放行，且给回**原文**（净化器只判不改，改写会让作者的文件与生效的对不上账）", () => {
    const css = ":root{--sea-1:#123}\n.uartix-panel{color:var(--sea-1)}";
    const r = guardThemeCss(css, "t.css");
    expect(r.issue).toBeUndefined();
    expect(r.css).toBe(css);
  });

  it("超过字节上限不收——上限是渲染重量，不是文件大小", () => {
    // 一条合法但极胖的规则：撑过 cap 之后仍然要在净化器那关报出来
    const fat = `.a{background:linear-gradient(${"#123456,".repeat(40)}#123456)}`;
    expect(guardThemeCss(fat, "t.css").css).toBeDefined(); // 先确认这个尺寸本身是合法的
    const huge = `.a{color:${"r".repeat(THEME_CSS_MAX_BYTES)}}`;
    const r = guardThemeCss(huge, "t.css");
    expect(r.css).toBeUndefined();
    expect(r.issue).toContain("没过净化");
  });

  it("报错里带得上文件名（多枚主题的插件要能看出是哪一枚挂了）", () => {
    expect(guardThemeCss("body{a:b}", "themes/sea.css").issue).toContain("themes/sea.css");
  });
});
