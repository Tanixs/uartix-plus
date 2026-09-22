/**
 * P97-I5：软件能力速览（进 system prompt 的那段）不得与注册表漂移。
 *
 * 为什么要盯：`CAPABILITY_DIGEST` 里曾手写「事件 12 类 / 块 23 类」并逐个列名，
 * 与 `blockRegistry` 是**第二份真相**。实测它已经把 `flowEvt` 写成了 `flow`
 * ——模型照抄这个 kind 去 `eventAdd` 就直接调不通，而这类错误在人眼读 prompt 时看不出来。
 * 现在计数与清单都从注册表派生，本测试钉住"派生"这件事本身：
 * 哪天有人把它改回字面量，或者注册表里新增了 kind 而派生逻辑漏了它，这里就红。
 */
import { ARTIFACT_KINDS, artifactKindMeta } from "../plugins/artifact";
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


/* ================= P99a-D1b/D1c/D2：对模型的承诺不得漂在实现之外 =================
 * 这句引导里的种类清单原先是**手写文案**（不来自枚举），所以给它一条"说的都得存在、下架的不许再出现"的守卫
 * ——否则刚删掉的"脚本产物"会一直以承诺的形式留在系统提示里（§8-36① 的 prompt 版）。
 *
 * P99a-D2 改了取法：从 `buildSystemPrompt("create")` 的**渲染结果**里取这句，不再正则扫源码。
 * 扫源码的写法一旦把这句拆成字符串拼接就取到空串——那等于守卫在钉"代码长什么样"而不是"模型看到什么"，
 * 本批正好撞上（改派生拼接后 route 变空，靠"长度 > 0"这条才发现）。
 */
const route =
  /【UI 创造引导】[^\n]*/.exec(buildSystemPrompt("create", "（无）"))?.[0] ?? "";
const kindLabels = ARTIFACT_KINDS.map((k) => artifactKindMeta(k).label);

describe("UI 创造引导与产物元表对齐", () => {
  it("引导句存在，且括号里承诺的每一种都有对应的产物中文名", () => {
    expect(route.length, "创造场景的 system prompt 里没有这句引导了").toBeGreaterThan(0);
    const names = (/（([^）]+)）/.exec(route)?.[1] ?? "").split(/[ /、]+/).map((s) => s.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(kindLabels, `系统提示承诺了「${n}」，但产物元表里没有这一类`).toContain(n);
    }
  });

  it("入口说法指着真的入口：pill，不是任何「工具栏按钮」", () => {
    // 病根实例：这句曾写"引导用户打开 AI 助手工具栏的『Agent 任务』"，而那个按钮 P90-C1 就删了
    // （`AiChat.tsx:1129`）——模型照着教用户，用户找不到东西。§8-41：对模型的承诺也要守卫。
    expect(route).toContain("pill");
    expect(route, "引导又去指一个不存在的工具栏按钮了").not.toContain("工具栏");
  });

  it("已下架的产物形态不许再出现在这句引导里", () => {
    for (const gone of ["行为脚本", "动效预设", "报告视图", "工作流"]) {
      expect(route, `系统提示还在承诺已下架的「${gone}」`).not.toContain(gone);
    }
  });
});
