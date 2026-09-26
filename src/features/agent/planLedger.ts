/**
 * P109-C：任务计划台账（模型自己写的步骤清单）。
 *
 * 为什么要有它：这个循环的终止判据是"这一轮没有工具调用 = 收工"，这条与 DSH 一致、不该改；
 * 但它带来一个洞——模型**只回一段话**也算收工，于是出现"任务卡显示已完成、插件库里什么都没有"。
 * 光靠提示词里加一句"请自查"堵不住（那正是现在提示里 `Finish with a concise goal check.` 的作用，
 * 它没起作用）。`task_plan` 把"计划"变成宿主侧可查的**数据**，loop 就能在收工前问一句：
 * 还有 open 项吗？有就先不收工。
 *
 * 定位要说清（对标 DSH 的 plan 子系统）：这是**完成契约**，不是权限闸。
 * 它不拦任何写操作、不改变审批语义（红线 §8-44），只影响"能不能宣告完成"。
 *
 * 零依赖：loop / adapter / 工具实现都能 import 它而不成环。
 */
export type PlanStatus = "pending" | "doing" | "done" | "skipped";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanStatus;
}

const plans = new Map<string, PlanItem[]>();

/** 整表替换（模型的计划本来就是"当前快照"语义，不做增量合并） */
export function setPlan(runId: string, items: PlanItem[]): void {
  if (items.length === 0) plans.delete(runId);
  else plans.set(runId, items);
}

export function getPlan(runId: string): PlanItem[] {
  return plans.get(runId) ?? [];
}

/** 任务结束即回收：台账留在 run 记录里，进程内这份没有理由继续占着 */
export function clearPlan(runId: string): void {
  plans.delete(runId);
}

/**
 * 还有没闭环的项吗？返回一段给模型看的可读清单，没有则 null。
 * 未闭环 = `pending` 与 `doing`；`skipped` 是模型显式认账的"这项我不做了"，算闭环。
 */
export function openPlanText(runId: string): string | null {
  const open = getPlan(runId).filter((i) => i.status === "pending" || i.status === "doing");
  if (!open.length) return null;
  const total = getPlan(runId).length;
  const done = total - open.length;
  const list = open.map((i) => `- [${i.status}] ${i.id}: ${i.text}`).join("\n");
  return `${open.length}/${total} plan item(s) are still open (${done} closed). Open items:\n${list}\nEither finish them, or update task_plan with status "skipped" and say why. Do not stop with items still open.`;
}
