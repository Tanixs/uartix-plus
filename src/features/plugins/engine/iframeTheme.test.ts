/**
 * P174-R18：面板主题桥的判据。
 *
 * 这块的东西一旦错了，表现是"某个面板的输入框是白的、按钮是灰的、和整机不搭"，
 * 而没人会怀疑到注入的那段样式上。所以测试盯三件事：
 *  1. **值不能截断样式块**（主题 token 可能是插件作者写的，`;` `}` `<` 一律不进）；
 *  2. **基础层必须是零特异性**（插件自己的规则要能盖过它），伪元素除外（`:where()` 不吃伪元素）；
 *  3. **名字必须是 `--uartix-*`**（撞名会把插件自己的 `--bg` 覆盖掉，那是比难看更坏的故障）。
 */

import { describe, expect, it } from "vitest";
import { iframeThemeCss, readHostTheme, safeCssValue, type IframeTheme } from "./iframeTheme";

const theme: IframeTheme = {
  vars: {
    "--uartix-bg": "#101014",
    "--uartix-text": "#e8e8ee",
    "--uartix-accent": "#4c8dff",
    "--uartix-border": "#2a2a33",
  },
  scheme: "dark",
  font: '"Segoe UI", system-ui',
};

describe("safeCssValue", () => {
  it("能截断规则或开新标签的字符一律不收", () => {
    for (const bad of ["red; body{display:none}", "a{b}", "</style><style>", "x>y", "1px solid {"]) {
      expect(safeCssValue(bad)).toBe("");
    }
  });

  it("外链与表达式不收", () => {
    expect(safeCssValue("url(https://evil/x.png)")).toBe("");
    expect(safeCssValue("URL (https://evil)")).toBe("");
    expect(safeCssValue("@import url(x)")).toBe("");
    expect(safeCssValue("expression(alert(1))")).toBe("");
  });

  it("正常的颜色、派生色、尺寸与缓动照常放行", () => {
    for (const ok of ["#101014", "rgb(16 16 20)", "color-mix(in srgb, #fff 8%, transparent)", "6px", "120ms", "cubic-bezier(0.2, 0.8, 0.3, 1)"]) {
      expect(safeCssValue(ok)).toBe(ok);
    }
  });

  it("空、纯空白、超长都判不可用（超长的那条宁可退回兜底色）", () => {
    expect(safeCssValue("")).toBe("");
    expect(safeCssValue("   ")).toBe("");
    expect(safeCssValue("a".repeat(400))).toBe("");
  });
});

describe("readHostTheme", () => {
  it("没有 document 时给出可用的空壳，而不是抛（Node 侧与首帧之前都会走到）", () => {
    const t = readHostTheme();
    expect(t.vars).toEqual({});
    expect(["light", "dark"]).toContain(t.scheme);
    expect(t.font.length).toBeGreaterThan(0);
    // 空壳也能直接产样式：兜底色接管，不该留下 undefined
    const css = iframeThemeCss(t);
    expect(css).not.toContain("undefined");
  });
});

describe("iframeThemeCss", () => {
  const css = iframeThemeCss(theme);

  it("宿主 token 以 --uartix-* 落到根上，且值就是传进来的那份", () => {
    expect(css).toContain("--uartix-bg: #101014;");
    expect(css).toContain("--uartix-accent: #4c8dff;");
    expect(css).toContain("--uartix-text: #e8e8ee;");
  });

  it("绝不裸写宿主那几个名字：覆盖 :root 的 --bg 会把插件自己的变量抢走", () => {
    // 别名块里出现 --bg 是允许的（那是给老面板的兜底别名），但它必须是 var(--uartix-bg, …) 的形式
    const alias = /--bg:\s*([^;]+);/.exec(css);
    expect(alias).toBeTruthy();
    expect(alias![1]).toContain("var(--uartix-bg,");
  });

  it("常用别名齐活：面板里那些 --fg / --line / --accent 不用改名字也能跟主题", () => {
    for (const k of ["--bg", "--panel", "--inset", "--fg", "--dim", "--faint", "--line", "--accent", "--on-accent", "--ok", "--warn", "--bad"]) {
      expect(css).toContain(`${k}: var(--uartix-`);
    }
  });

  it("基础层全是零特异性：插件写 input { … } 就盖得过（伪元素不吃 :where()，单独放行）", () => {
    const selectors = css
      .split("}")
      .map((chunk) => chunk.split("{")[0].trim().split("\n").pop()!.trim())
      .filter((sel) => sel && !sel.startsWith("--") && !sel.startsWith("/*"));
    const offenders = selectors.filter(
      (sel) => !sel.startsWith(":where(") && !/^::(selection|-webkit-scrollbar(-thumb|-track)?)$/.test(sel),
    );
    expect(offenders).toEqual([]);
    expect(selectors.length).toBeGreaterThan(10);
  });

  it("控件、按钮、卡片、滚动条都画了：这是「面板贴主题」那句话的实际内容", () => {
    for (const sel of [
      ":where(body)",
      ":where(button, input, select, textarea)",
      ":where(.btn)",
      ":where(.btn.primary)",
      ":where(.input)",
      ":where(.card)",
      "::-webkit-scrollbar-thumb",
    ]) {
      expect(css).toContain(sel);
    }
    // 主钮用宿主的强调色实底，不是插件自带的那种灰
    expect(css).toMatch(/:where\(\.btn\.primary\) \{[^}]*background: var\(--uartix-accent,/);
  });

  it("color-scheme 跟着明暗走：原生下拉与滚动条的底色才不会反过来", () => {
    expect(iframeThemeCss({ ...theme, scheme: "light" })).toContain("color-scheme: light");
    expect(iframeThemeCss(theme)).toContain("color-scheme: dark");
  });

  it("小部件不刷整页底色：透明无边框那种形态靠的就是这一条", () => {
    const bare = iframeThemeCss(theme, { paintPage: false });
    expect(bare).toMatch(/:where\(html\) \{ background: transparent/);
    expect(bare).toMatch(/:where\(body\) \{[^}]*background: transparent/);
    // 但变量与控件照旧桥过去——透明不等于没有主题
    expect(bare).toContain("--uartix-bg: #101014;");
    expect(bare).toContain(":where(.btn)");
    expect(bare).toContain("color-scheme: dark");
  });

  it("脏值进不来：一条被污染的 token 整条丢掉，而不是多出一条规则", () => {
    const poisoned = iframeThemeCss({
      ...theme,
      vars: { "--uartix-bg": "#000; } body { display: none", "--uartix-text": "</style><script>alert(1)</script>", "--uartix-warn": "#d29922" },
    });
    expect(poisoned).not.toContain("display: none");
    expect(poisoned).not.toContain("<script>");
    expect(poisoned.match(/<\//g)).toBe(null);
    // 脏的那两条压根不落块（落个截断过的半截值更容易看出事故），干净的照常
    expect(poisoned).not.toContain("--uartix-bg:");
    expect(poisoned).not.toContain("--uartix-text:");
    expect(poisoned).toContain("--uartix-warn: #d29922;");
    // 别名仍然指向兜底色：面板不会因为没有背景而变成白块
    expect(poisoned).toMatch(/--bg: var\(--uartix-bg, #/);
  });

  it("变量名也要认形状：不是 --uartix-* 的键不收（防有人从别处塞一条任意声明）", () => {
    const odd = iframeThemeCss({ ...theme, vars: { "--bg": "#000", "background": "#000", "--uartix-x": "#111" } });
    expect(odd).not.toContain("--bg: #000");
    expect(odd).not.toContain("background: #000;");
    expect(odd).toContain("--uartix-x: #111;");
  });
});
