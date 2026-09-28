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
import { buildSystemPrompt, schemaFor } from "./prompts";

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

/* ================= P115-D：知识面与"界面现在长什么样"同源 =================
 * 两条各自治一段旧病：
 * ① `openPanel` 那行的面板清单原先是手抄的 18 个 id——漏了「指标面板」，还把已退役的
 *    「协议模板」面板当成能打开的东西告诉模型（用户照着问，AI 就指一个不存在的面板）。
 *    现在它从 `panelGroupsAddable()` 派生，本测试钉的是**渲染结果 == 注册表**，
 *    按 P99a-D2 的教训：不扫源码形状，扫模型真正看到的那段文字。
 * ② 整个知识面从没写过导轨 / 全窗口设置页 / 命令面板 / 模型设置。用户问"模型在哪配"
 *    时模型只能凭印象答。这里钉几个非有不可的名字，缺一个就红。
 */
const { panelGroupsAddable } = await import("../../panels/panelMenu");
const actionSpec = schemaFor("action");
const listed = /打开面板（([^）]*)）/.exec(actionSpec)?.[1] ?? "";

describe("P115-D · 可打开面板的清单与注册表同源", () => {
  const addable = panelGroupsAddable().flatMap((g) => g.ids) as string[];

  it("渲染出的 openPanel 清单既不比注册表多，也不比它少", () => {
    expect(listed.length, "动作规范里没有 openPanel 那一行了").toBeGreaterThan(0);
    const ids = listed.split("/");
    for (const id of ids) {
      expect(addable, `清单里教了 ${id}，可它不在「可添加面板」表里（退役或改名了）`).toContain(id);
    }
    for (const id of addable) {
      expect(ids, `注册表能添加 ${id}，却没告诉模型`).toContain(id);
    }
  });

  it("已退役的 templates 不再被当成一枚可打开的面板教给用户", () => {
    expect(listed.split("/")).not.toContain("templates");
    // 但要知道它去哪了——否则用户问"协议面板呢"，模型只会说"没有这个东西"
    expect(actionSpec).toContain("「协议」已搬进左侧导轨");
  });
});

describe("P115-D · 知识面认得现在这套壳", () => {
  for (const [needle, why] of [
    ["设置 → 模型设置", "模型/密钥去哪配，AI 必须说得出（P110-B 起就不在 AI 服务那一页了）"],
    ["供应商级那枚刷新是免费的", "两种测试各自证明什么——说错就是让用户白花钱或白等"],
    ["导轨「视图」", "加面板的两处入口之一，另一处是工具栏那枚「+ 面板」下拉"],
    ["「+ 面板」", "两处入口现在都存在——只告诉模型一处，用户按模型的话找就找不到"],
    ["Ctrl+Shift+P", "命令面板是全局入口，知识面不能不知道它存在"],
    ["占满整个工作区", "设置页从弹窗改成全窗口（P111-B），旧描述会让人去找一个不存在的对话框"],
  ] as const) {
    it(`qa 速览里有「${needle}」：${why}`, () => {
      expect(qaPrompt, why).toContain(needle);
    });
  }

  it("动作规范里点名了发送总闸的实名「允许向设备发送」", () => {
    // 只说"需发送权限"，用户找不到那一行；闸名与设置页那一行的标签是同一个来源
    expect(actionSpec).toContain("允许向设备发送");
    expect(actionSpec).not.toMatch(/开关连接（需发送权限）/);
  });
});

