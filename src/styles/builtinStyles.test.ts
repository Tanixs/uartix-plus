/**
 * P131-D 内置 style 包通道的守卫。
 *
 * 两条判据各管一种"安静地坏掉"：
 *  ① 装载表与磁盘上的文件必须一一对上（门 K 也判这条，这里从**运行时的视角**再判一次——
 *     门读的是文件，运行时读的是打包器解析后的 `?raw`，两者之间还有一层 vite）；
 *  ② 内置的组件层要过与第三方 CSS **同一台净化器**。这条是"内置没有理由比插件松"的兑现：
 *     第三方 CSS 进宿主前要判 html/body、fixed 落槽、越权 z-index、外链 url()，
 *     自己写的这份如果绕过去，就等于把同一层规则分成"查过的"和"没查过的"两种。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_STYLE_IDS, builtinStyleCss, hasBuiltinStyle } from "./builtinStyles";
import { BUILTIN_THEME_IDS } from "./builtinThemes";
import { guardStyleText } from "../features/styles/styleSanitize";
import { THEME_CSS_MAX_BYTES } from "../features/plugins/artifact";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readdirSync } = (await import(fsSpec)) as unknown as { readdirSync: (p: string) => string[] };
const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };
const dir = fileURLToPath(new URL("./builtinStyles", import.meta.url));

describe("P131-D · 内置 style 包通道", () => {
  it("装载表与磁盘上的文件一一对上（登记了没文件 / 有文件没登记，都判红）", () => {
    const onDisk = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, "")).sort();
    expect([...BUILTIN_STYLE_IDS].sort(), "登记表与磁盘不一致").toEqual(onDisk);
    expect(onDisk.length, "一份内置 style 包都没有，这条通道就是空话").toBeGreaterThan(0);
  });

  it("登记的 id 必须是真存在的内置主题，且装载出来的 CSS 非空", () => {
    for (const id of BUILTIN_STYLE_IDS) {
      expect((BUILTIN_THEME_IDS as readonly string[]).includes(id), `${id} 不是内置主题，谁也不会画它的组件层`).toBe(true);
      expect(hasBuiltinStyle(id)).toBe(true);
      expect(builtinStyleCss(id).length, `${id} 装载出来是空的`).toBeGreaterThan(1000);
    }
    expect(builtinStyleCss("no-such-theme")).toBe("");
    expect(hasBuiltinStyle("no-such-theme")).toBe(false);
  });

  /** 与 `marketContent` 那条"自家主题包零 error 零 warning"同一把尺：内置的不能更松 */
  it("每份内置 style 包过与第三方 CSS 同一台净化器：零 error 也零 warning", () => {
    for (const id of BUILTIN_STYLE_IDS) {
      const css = builtinStyleCss(id);
      const g = guardStyleText(css, THEME_CSS_MAX_BYTES, []);
      expect(g.problems, `${id} 的内置组件层没过净化器：${g.problems.slice(0, 6).join("；")}`).toEqual([]);
      expect(g.ok).toBe(true);
      expect(g.ruleCount, `${id} 的规则数应当与文件里的选择器段一致`).toBeGreaterThan(30);
    }
  });

  it("每条选择器都锁在自己的主题上（漏一条就会涂到别的主题上，门 K 之外的第二道）", () => {
    for (const id of BUILTIN_STYLE_IDS) {
      const css = builtinStyleCss(id).replace(/\/\*[\s\S]*?\*\//g, "");
      const want = `[data-theme="${id}"]`;
      for (const m of css.matchAll(/([^{}]*)\{/g)) {
        const sel = m[1].trim();
        if (!sel || sel.startsWith("@")) continue;
        for (const part of sel.split(",").map((x) => x.trim())) {
          expect(part.startsWith(want) || part.startsWith(`:root${want}`), `${id}: 选择器没锁主题 → ${part.slice(0, 60)}`).toBe(true);
        }
      }
    }
  });
});
