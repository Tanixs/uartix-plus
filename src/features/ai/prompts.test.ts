/**
 * P97-I5：软件能力速览（进 system prompt 的那段）不得与注册表漂移。
 *
 * 为什么要盯：`CAPABILITY_DIGEST` 里曾手写「事件 12 类 / 块 23 类」并逐个列名，
 * 与 `blockRegistry` 是**第二份真相**。实测它已经把 `flowEvt` 写成了 `flow`
 * ——模型照抄这个 kind 去 `eventAdd` 就直接调不通，而这类错误在人眼读 prompt 时看不出来。
 * 现在计数与清单都从注册表派生，本测试钉住"派生"这件事本身：
 * 哪天有人把它改回字面量，或者注册表里新增了 kind 而派生逻辑漏了它，这里就红。
 */
import { describe, expect, it } from "vitest";
import { BLOCK_REGISTRY, EVENT_REGISTRY } from "../orchestrator/blockRegistry";
import { buildSystemPrompt } from "./prompts";

const qaPrompt = buildSystemPrompt("qa", "（无）");

describe("prompts 能力速览与注册表同源", () => {
  it("每一个事件/块 kind 都以真名出现在速览里（新增 kind 自动收编，无需改文案）", () => {
    for (const kind of Object.keys(EVENT_REGISTRY)) {
      expect(qaPrompt).toContain(`${kind}(`);
    }
    for (const kind of Object.keys(BLOCK_REGISTRY)) {
      expect(qaPrompt).toContain(`${kind}(`);
    }
  });

  it("计数由注册表算出：写死的数字一改就红", () => {
    // 断言的是"计数 == 注册表长度"，而不是某个具体数字——所以加一类块不会误红，删掉派生才会红
    expect(qaPrompt).toContain(`事件 ${Object.keys(EVENT_REGISTRY).length} 类`);
    expect(qaPrompt).toContain(`块 ${Object.keys(BLOCK_REGISTRY).length} 类`);
    const brief = buildSystemPrompt("interpret", "（无）"); // 走 DIGEST_BRIEF 分支
    expect(brief).toContain(`${Object.keys(EVENT_REGISTRY).length} 类事件→${Object.keys(BLOCK_REGISTRY).length} 类块`);
  });

  it("参数字典带中文标签，且每个 kind 的 ai 说明原样进 prompt", () => {
    for (const [kind, m] of Object.entries(EVENT_REGISTRY)) {
      expect(qaPrompt).toContain(`${kind}(${m.label.zh}：${m.ai})`);
    }
    for (const [kind, m] of Object.entries(BLOCK_REGISTRY)) {
      expect(qaPrompt).toContain(`${kind}(${m.label.zh}：${m.ai})`);
    }
  });

  it("曾经的漂移点：flowEvt 不再被写成 flow", () => {
    expect(EVENT_REGISTRY).toHaveProperty("flowEvt");
    expect(qaPrompt).not.toMatch(/自定义事件（flow，/);
  });
});
