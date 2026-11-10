/**
 * P180-UI-1：命令树的层级必须"去掉文字也看得懂"。
 *
 * 旧实现每层只有 `marginLeft: 10px`，色、字重、底全同 ⇒ 用户原话
 * 「每一层颜色或者阴影都一样」。这条测试钉的是**机制**而不是像素：
 * 缩进只能由 `.cmd-kids` 的 token 给、深度只能经 `data-depth` 取色阶，
 * 组件里不许再出现手写数字或字符图标（✎ / ⚡ / 📐 / ＋）。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));
const tree = readFileSync(join(here, "CommandLibrary.tsx"), "utf8");
const css = readFileSync(join(here, "..", "..", "styles", "theme.css"), "utf8");

describe("命令树层级编码", () => {
  it("缩进不使用内联 marginLeft（旧病：每层 +10px 写死在组件里）", () => {
    expect(tree).not.toContain("style={{ marginLeft");
  });

  it("子块走 .cmd-kids，深度经 data-depth 交给样式表", () => {
    expect(tree).toContain('className="cmd-kids"');
    expect(tree).toContain("data-depth={lvl}");
    expect(tree).toContain("Math.min(depth, 3)");
  });

  it("深度阶梯有四档 token（字重 / 色阶 / 底色），且 4 档以后不再变淡", () => {
    expect(css).toContain("--depth-step:");
    expect(css).toContain("--depth-rail-x:");
    for (const d of ["0", "1", "2", "3"]) {
      expect(css, `缺 data-depth="${d}" 的读数`).toContain(`[data-depth="${d}"]`);
    }
    expect(css).toContain("--d-w:");
  });

  it("引导线是结构线而不是边框（G 门：边框只许降）", () => {
    expect(css).toContain(".cmd-kids::before");
  });

  it("叶子命令不再用字符图标（✎）与 emoji（⚡ / 📐），加号一律 SVG", () => {
    for (const ch of ["✎", "⚡", "📐", "＋"]) {
      expect(tree, `组件里还有字符图标 ${ch}`).not.toContain(ch);
    }
    expect(tree).toContain("<IconEdit />");
    expect(tree).toContain("<IconPlus />");
  });

  it("窄栏（<=260）收紧步长，避免第 3 层被挤成一两个字", () => {
    expect(css).toContain("@container (max-width: 260px)");
    expect(css).toContain("container-type: inline-size");
  });
});
