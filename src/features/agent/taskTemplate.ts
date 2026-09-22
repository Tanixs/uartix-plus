/**
 * P99a-D1b：任务模板（`workflow` 产物的新语义，详设 §7.1）。
 *
 * **它不是宏执行器。**旧形状叫"工作流"却没有任何执行点，等于创造面上摆着一个假承诺；
 * 现在它老实做成"可复用的任务说明"：把目标 + 建议步骤拼成一段话，交给 Agent 按正常
 * 门禁、授权档、批准卡去跑。一步都不会替用户执行，也不新增任何绕过注册表的通道。
 *
 * 这里的函数全是纯的：`knownTools`（本机有哪些工具）由调用方给——本模块被插件库这种
 * 轻量 UI 引用，静态 import 注册表会把整条 agent 图拖进求值期（§8-33）。
 */
import type { WorkflowArtifact } from "../plugins/artifact";

/** 模板里一条步骤拼给模型的样子：`N. tool {json} —— note`。 */
function stepLine(n: number, s: WorkflowArtifact["steps"][number]): string {
  const args = s.args && Object.keys(s.args).length ? ` ${JSON.stringify(s.args)}` : "";
  return `${n}. ${s.tool}${args}${s.note ? ` —— ${s.note}` : ""}`;
}

/** 模板里出现的工具名（去重、保序），供存在性检查用。 */
export function templateTools(t: WorkflowArtifact): string[] {
  return [...new Set(t.steps.map((s) => s.tool))];
}

/** 本机没有的工具名（模板装进来之后工具面可能又变了，所以载入时还要再查一次）。 */
export function unknownTemplateTools(t: WorkflowArtifact, knownTools: readonly string[]): string[] {
  const known = new Set(knownTools);
  return templateTools(t).filter((x) => !known.has(x));
}

/**
 * 拼成发给 Agent 的那段话。末尾两句是刻意的：
 * ① 说明"建议步骤"不是硬指令，模型该在不适用时停下来问；
 * ② 声明写操作仍走当前授权档——模板不是一把免批准的钥匙。
 */
export function templateToPrompt(t: WorkflowArtifact, src: { name: string; version: string }): string {
  const lines = t.steps.map((s, i) => stepLine(i + 1, s)).join("\n");
  return [
    `按这个任务模板来做：${t.goal.trim()}`,
    "",
    "建议步骤（工具名来自本机注册表）：",
    lines,
    "",
    `模板由插件「${src.name}」v${src.version} 提供。步骤是建议不是硬指令：某步不适用就停下来问我，别硬凑。`,
    "所有写操作仍按当前授权档与批准设置执行，需要批准的就照常弹卡。",
  ].join("\n");
}
