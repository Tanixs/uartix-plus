/**
 * P99a-D1b：任务模板的拼话与存在性检查（详设 §7.1 的"要么有投影，要么消失"落到 workflow 上）。
 *
 * 这批最容易自我欺骗的地方是把"工作流"改个名就当完成了：真正兑现的承诺是
 * **① 引用不存在的工具在校验期就红（不是运行时撞 unknown_tool）；② 它只填输入框、不代发**。
 * 下面两条源码钉就是钉这两点，纯函数部分钉"拼出来的话没漏步骤、没夹带指令越权"。
 */
import { describe, expect, it } from "vitest";
import { templateToPrompt, unknownTemplateTools, templateTools } from "./taskTemplate";

// 读源文本走一段式动态导入（变量说明符同时绕开 vite 的字面量解析与 tsc 缺 @types/node）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
/** 相对**本测试文件**取源码（相对 URL 比手拼 repo root 稳，跨平台也不会算错一层） */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const tpl = {
  goal: "把三个通道的采样率统一到 50Hz 并开曲线",
  steps: [
    { tool: "plot_channels", note: "先看现有通道" },
    { tool: "run_app_action", args: { kind: "setSampleRate", args: { hz: 50 } } },
  ],
};

describe("taskTemplate", () => {
  it("拼出来的任务说明：目标在前、步骤带参数与备注、末尾声明不绕过门禁", () => {
    const p = templateToPrompt(tpl, { name: "巡检台", version: "0.2.0" });
    expect(p).toContain(tpl.goal);
    expect(p).toContain("1. plot_channels —— 先看现有通道");
    expect(p).toContain(`2. run_app_action ${JSON.stringify(tpl.steps[1].args)}`);
    expect(p).toContain("巡检台");
    // 这两句是"模板≠提权通道"的承诺，删了它模板就成了免批准的借口
    expect(p).toContain("所有写操作仍按当前授权档与批准设置执行");
    expect(p).toContain("步骤是建议不是硬指令");
  });

  it("去重后再查存在性；本机没有的工具名点名回传", () => {
    expect(templateTools({ goal: "g", steps: [tpl.steps[0], tpl.steps[0], tpl.steps[1]] })).toEqual(["plot_channels", "run_app_action"]);
    expect(unknownTemplateTools(tpl, ["plot_channels", "run_app_action"])).toEqual([]);
    expect(unknownTemplateTools(tpl, ["plot_channels"])).toEqual(["run_app_action"]);
  });

  // 「save_plugin 查工具存在性」用**行为**钉（agentAdapter.test.ts 里真调一次工具看回执码），
  // 这里不再补一份源码正则：同一件事两条检查，改一次实现就要同步两处（§8-36①）。

  it("载入只填输入框：桥与 UI 两侧都不许出现自动发送", () => {
    const dlg = read("../plugins/PluginLibraryDialog.tsx");
    expect(dlg).toMatch(/loadTemplate[\s\S]{0,900}pushDraft\(/);
    expect(dlg).not.toMatch(/loadTemplate[\s\S]{0,900}(requestAsk|startRun)/); // 不代发
    const chat = read("../ai/AiChat.tsx");
    expect(chat).toMatch(/consumeDraft\(\)[\s\S]{0,80}setInput\(d\)/);
  });
});
