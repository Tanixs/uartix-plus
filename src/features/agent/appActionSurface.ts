/**
 * P99a-F1（A4b 收口）：`run_app_action`（Agent 面）与 `run_action`（MCP 面）的**同一份执行核**。
 *
 * 为什么只并到这里为止：**两个前端的闸门本来就该不一样**，并且这一条是 §8-44 划的红线——
 * Agent 走档位/授权域 + 不可逆动作的人工批准卡；MCP 走设置里各拨一次的 `mcpAllowSend`/`mcpHighPriv`
 * （DSH `allowed-once` 口径，不逐条弹卡）。把 MCP 塞进注册表管线会让它莫名多出一套批准语义，
 * 所以并的是**两边都必须一致的那部分**：名单校验、高权限判定、后台不可代为启动的自动化、
 * 真正的 `runAppAction` 调用与结果形状。这几件以前在 `mcpServer` 的 switch 里是手写的第二份，
 * 加一个动作或改一条规则就得记得改两处。
 */
import { runAppAction } from "../ai/appActions";
import { APP_ACTION_KINDS, HIGH_ONLY } from "../ai/appActionKinds";
import { actionMeta } from "./toolCatalog";

export type AppActionSurfaceFail = {
  ok: false;
  code: "unknown_action" | "needs_high_priv" | "needs_manual" | "action_failed";
  /** 该码带出去的那句话：未知动作/高权限动作=kind 原文，失败=错误文本；needs_manual 无文本 */
  msg: string;
};
export type AppActionSurfaceOk = { ok: true; readOnly: boolean; data: unknown };
export type AppActionSurfaceResult = AppActionSurfaceOk | AppActionSurfaceFail;

/** 名单校验（与 `runAppAction` 内部那条同源：这里先拦，两个前端才能给出各自的话术）。 */
export function isKnownActionKind(kind: string): boolean {
  return (APP_ACTION_KINDS as readonly string[]).includes(kind);
}

/** 高权限**判定**只此一处；**话术**留在各边缘（Agent 说"超出授权范围"，MCP 说去哪开哪个闸）。 */
export function needsHighPriv(kind: string, granted: boolean): boolean {
  return HIGH_ONLY.has(kind) && !granted;
}

/**
 * 后台面（MCP / job 执行器）**不得代为启动**的持续自动化：编排组跑起来、虚拟设备接管管线，
 * 都是"没人看着却一直发数据"的事。本地 Agent 不受这条约束——用户就在屏幕前，且这类动作另有批准卡。
 */
export function backgroundBlockedOf(kind: string, args: Record<string, unknown>): boolean {
  const op = args.op;
  if (kind === "orchestrator") return op === "run" || (op === "enable" && args.on !== false);
  if (kind === "vdev") return op === "start";
  return false;
}

/** 两个前端共用的执行核。`background:true` 时先过"不可代为启动"那条。 */
export async function runAppActionSurface(
  kind: string,
  args: Record<string, unknown>,
  o: { highPriv: boolean; background?: boolean },
): Promise<AppActionSurfaceResult> {
  if (!isKnownActionKind(kind)) return { ok: false, code: "unknown_action", msg: kind };
  if (o.background && backgroundBlockedOf(kind, args)) return { ok: false, code: "needs_manual", msg: "" };
  if (needsHighPriv(kind, o.highPriv)) return { ok: false, code: "needs_high_priv", msg: kind };
  const r = await runAppAction(kind, args, { highPriv: o.highPriv });
  if (!r.ok) return { ok: false, code: "action_failed", msg: r.err ?? "动作执行失败" };
  const effect = actionMeta(kind)?.effect;
  return { ok: true, readOnly: effect === "read" || effect === "analysis", data: r.data ?? null };
}
