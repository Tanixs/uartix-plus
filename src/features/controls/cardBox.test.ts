import { describe, expect, it } from "vitest";
import { applyCardBox, boxPx } from "./cardBox";

/**
 * 回归锁：卡片拖成一条（2026-11）。
 *
 * 旧实现提交 resize 前把 `style.width/height` 一起清空，指望 React 重渲染补回来；
 * React 只重写"值发生变化"的属性，只改一轴的场景另一轴就停在 `auto`，
 * 而 `.ctl-card` 是 `container-type: size`（尺寸包含、无内容内在尺寸）→ 塌成一条。
 * 这组用例钉住新口径：只写、不清，且两轴永远一起写。
 */
describe("card box writer", () => {
  const el = () => ({ style: { width: "", height: "" } });

  it("writes both axes even when only one of them changed", () => {
    const target = el();
    applyCardBox(target, 4, 3, 68, 8);
    expect(target.style).toEqual({ width: "264px", height: "196px" });

    // 只改高度：宽度值没变。旧路径在这里清空后 React 不会再写宽度。
    applyCardBox(target, 4, 1, 68, 8);
    expect(target.style.width, "宽度轴必须被重新写回，不能留空给 auto").toBe("264px");
    expect(target.style.height).toBe("60px");
  });

  it("never leaves an empty or invalid size in the DOM", () => {
    const cases: Array<[number, number, number]> = [
      [NaN, 2, 128],
      [0, -1, 60],
      [Infinity, 3, 196],
      [-4, 0.4, 60],
    ];
    for (const [w, h, wantH] of cases) {
      const target = el();
      applyCardBox(target, w, h, 68, 8);
      expect(target.style.width).toMatch(/^\d+px$/);
      expect(target.style.height).toMatch(/^\d+px$/);
      expect(target.style.width).toBe("60px");
      expect(target.style.height).toBe(`${wantH}px`);
    }
  });

  it("quantizes edges to whole cells", () => {
    expect(boxPx(2.4, 68, 8)).toBe(128);
    expect(boxPx(2.6, 68, 8)).toBe(196);
    expect(boxPx(1, 68, 8)).toBe(60);
  });
});
