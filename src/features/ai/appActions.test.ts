/**
 * 未知动作的报错话术（源码钉）：弱模型在普通对话里会把「写插件草稿」幻觉成动作块
 * （真链路是 Agent 任务的 plugin_draft_save 工具，动作词汇表里刻意没有它），用户点
 * 「执行」后看到的报错必须把人指回正路。不直接 import `appActions`——它的 import 链
 * 牵着 settingsStore（求值期读 localStorage）与 uplot（求值期要 document），在 node
 * 环境装不起；话术是纯文案，源码钉足够，行为对面由真机冒烟兜着。
 */
import { describe, expect, it } from "vitest";

/** node:fs 不进 tsconfig types；照 appActionSurface.test.ts 的手法动态 import 绕开 */
async function readThisSource(): Promise<string> {
  const fsSpec = "node:fs";
  const { readFileSync } = (await import(fsSpec)) as unknown as {
    readFileSync: (p: URL, enc: "utf8") => string;
  };
  return readFileSync(new URL("./appActions.ts", import.meta.url), "utf8");
}

describe("runAppAction 未知动作话术", () => {
  it("草稿类未知 kind 的报错带「Agent 任务」引导", async () => {
    const src = await readThisSource();
    expect(src).toMatch(/draftish[^]*?Agent 任务/);
    expect(src).toContain("插件草稿没有动作块");
  });

  it("非草稿类未知 kind 保持原来的短话术（MCP 边缘同写法）", async () => {
    const src = await readThisSource();
    expect(src).toContain("`未知动作：${kind}`");
  });
});
