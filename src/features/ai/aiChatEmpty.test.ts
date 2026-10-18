/**
 * P155-X · AI 空态不再有一颗孤零零的「?」。
 *
 * 服务商清单原来是独立的 HelpHint，落在「打开设置」按钮上方——一个没有上下文的问号，
 * 信息全靠悬停。试过并进 hint 行：`check-empty-copy` 该文件的空态预算（87 汉字）当场红，
 * 说明那句更像"设置页该给的清单"而不是空态该说的话——于是整枚 HelpHint 摘掉，
 * 服务商仍由「打开设置」那一步自己列。钉源码文本（同 settingsShell 的手法）。
 */
import { describe, expect, it } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const src = readFileSync(`${SRC}features/ai/AiChat.tsx`, "utf8");

describe("P155-X · AI 空态", () => {
  it("空态不再挂独立的 HelpHint（那颗孤零零的「?」）", () => {
    expect(src, "孤立的 HelpHint 又回来了").not.toContain("<HelpHint");
    // 空态只留「标题 + 两句 hint」：不往空态里堆清单（check-empty-copy 的 87 汉字预算同一意图）
    const from = src.indexOf('className="ai-empty-wrap"');
    const to = src.indexOf('className="btn primary"', from);
    const block = src.slice(from, to);
    expect((block.match(/tx\(/g) || []).length, "空态文案又长回去了（标题+hint 应为 3 处 tx）").toBe(3);
    expect(block, "被摘掉的服务商清单又从窗缝爬回来了").not.toContain("Ollama");
  });
});

