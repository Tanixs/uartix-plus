/**
 * P96-K2：气泡收拢判据。重点是"两种角色同规则"——旧实现把限高门写死在 assistant 上，
 * 用户自己发的 3000 字长文因此无限撑高整屏（真机反馈 2）。
 */
import { describe, expect, it } from "vitest";
import { CLIP_CHARS, CLIP_LINES, SCROLL_MAX_PX, bubbleMode } from "./messageClip";

const long = "字".repeat(CLIP_CHARS + 1);
const manyLines = Array.from({ length: CLIP_LINES + 1 }, (_, i) => `行${i}`).join("\n");

describe("bubbleMode", () => {
  it("短消息一律原样（不无故收拢）", () => {
    expect(bubbleMode({ role: "user", content: "把 X 轴换成角度" })).toBe("plain");
    expect(bubbleMode({ role: "assistant", content: "好的" })).toBe("plain");
  });

  it("user 长文走内部滚动，assistant 长文走渐隐 + 展开（两种收法各有理由）", () => {
    expect(bubbleMode({ role: "user", content: long })).toBe("scroll");
    expect(bubbleMode({ role: "assistant", content: long })).toBe("clip");
  });

  it("短行很多也算长（贴日志/表格：字数不大同样顶屏）", () => {
    expect(manyLines.length).toBeLessThan(CLIP_CHARS); // 前提：这条夹具按字数是"不长"的
    expect(bubbleMode({ role: "user", content: manyLines })).toBe("scroll");
    expect(bubbleMode({ role: "assistant", content: manyLines })).toBe("clip");
  });

  it("流式中的最后一条不收拢（正在长，收拢会把新字藏住）", () => {
    expect(bubbleMode({ role: "assistant", content: long }, true)).toBe("plain");
  });

  it("JS 侧的限高值与 theme.css 对齐（防两处各写一个数）", async () => {
    // 计算式说明符：本 tsconfig 不含 @types/node，直接 import "node:fs" 会 TS2307
    const spec = "node:fs";
    const { readFileSync } = (await import(spec)) as {
      readFileSync: (p: string, enc: string) => string;
    };
    const css = readFileSync(new URL("../../styles/theme.css", import.meta.url).pathname.slice(1), "utf8");
    const block = css.match(/\.ai-msg-text\.scroll\s*\{[^}]*\}/);
    expect(block, "theme.css 里找不到 .ai-msg-text.scroll").toBeTruthy();
    expect(block![0]).toContain(`max-height: ${SCROLL_MAX_PX}px`);
  });
});
