/**
 * P97-I3：动效配方。这组测试钉的是"清单即真相"——
 * 模型能看到的配方、注入的 CSS、减弱动效护栏必须出自同一份 FX_RECIPES。
 */
import { describe, expect, it } from "vitest";
import { FX_RECIPES, fxCatalog, fxStylesheet } from "./fxRecipes";

describe("fxRecipes", () => {
  it("每条配方的类名与 @keyframes 都真的出现在生成的样式表里", () => {
    const css = fxStylesheet();
    for (const r of FX_RECIPES) {
      expect(css, r.id).toContain(`.${r.className}`); // ripple 这类是 `.fx-…:active{}`，只钉"类名有规则"
      for (const kf of r.keyframes) {
        expect(css, `${r.id}/${kf}`).toContain(`@keyframes ${kf}{`);
        expect(kf, "keyframes 必须 fx- 前缀（与净化器同规则）").toMatch(/^fx-/);
      }
    }
  });

  it("减弱动效双护栏都在（系统偏好 + 应用内开关），且覆盖到 ::after 型配方", () => {
    const css = fxStylesheet();
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("html.no-motion .fx-sheen::after");
    for (const r of FX_RECIPES) expect(css).toContain(`html.no-motion .${r.className}`);
  });

  it("没有无限动画短于 200ms（check:motion 的光敏硬门），也不引外链资源", () => {
    const css = fxStylesheet();
    expect(css).not.toMatch(/url\(/i);
    for (const m of css.matchAll(/animation:[^;]*?([\d.]+)(ms|s)/g)) {
      const ms = m[2] === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
      expect(ms, css).toBeGreaterThanOrEqual(200);
    }
  });

  it("清单与 CSS 同源：模型看到的类名/旋钮都在样式表里用得上", () => {
    const css = fxStylesheet();
    const cat = fxCatalog();
    expect(cat).toHaveLength(FX_RECIPES.length);
    for (const f of cat) {
      expect(css).toContain(f.className.slice(1));
      for (const k of f.knobs) expect(css, `${f.id} 的旋钮 ${k.split("=")[0]}`)
        .toContain(k.split("=")[0]);
    }
  });
});
