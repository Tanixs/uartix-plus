/**
 * P88b-1 §7：副作用分类与审批策略契约。
 * 危险性由工具声明的 effect class 与执行时上下文决定，绝不信任模型提交的 risk 字段。
 * 策略输出四值：allow / preview_only / require_local_approval / deny。
 * 四类人工确认例外（HANDOVER §6.3）：实车下发、删除/覆盖用户已定义对象、不可逆操作、安全边界（急停/校准）。
 */
import type { Sensitivity } from "../settings/settingsSchema";
import type { RunScope } from "./types";

export type EffectClass =
  | "read" // 零副作用观察
  | "analysis" // 只读计算（可写报告草稿，不动运行配置）
  | "draft_write" // 新建可逆草稿/新对象（不覆盖既有）
  | "config_write" // 修改可撤销的应用配置
  | "destructive_write" // 删除/覆盖用户已定义对象
  | "device_send" // 向设备发送（含实车/仿真未知）
  | "safety_boundary" // 急停、校准等安全边界
  | "irreversible" // 不可恢复数据清除、无快照覆盖
  | "protected_config" // 受保护设置（权限/端点/开关）
  | "secret"; // 读取/写入秘密

export interface ToolPolicyMeta {
  effect: EffectClass;
  /** 幂等：重复执行结果一致（可安全重试） */
  idempotent: boolean;
  /** 可逆：宿主有可靠快照/撤销路径 */
  reversible: boolean;
  /** 目标是否可能是实车（未知时按 true 处理，不得猜成仿真） */
  mayTouchDevice: boolean;
  /**
   * P133-H：这条调用的**每一个决定后果的参数都由宿主钉死**（模型只能从枚举里挑一档），
   * 不是它自己能拼出来的命令行。`repo_check` 是唯一的用户；`shell_exec` 拿的是自由文本，
   * 所以永远不算。只有这一类才允许在全权执行档跳过逐次批准。
   */
  hostBounded?: boolean;
}

export type PolicyDecision = "allow" | "preview_only" | "require_local_approval" | "deny";

export interface PolicyContext {
  /** 自动执行档位（详设 §4.3）：preview=仅预览 create=常规创造 custom=自定义范围；字面量单源于 types.RunScope */
  scope: RunScope;
  /** 本任务授权范围内的键/对象；null 表示未做细粒度授权 */
  authorized: (key: string) => boolean;
  /** 当前应用锁（Operator 锁等） */
  operatorLocked: boolean;
  /** 设备上下文：real=实车已连接，sim=仿真/无设备，unknown=无法判定 */
  deviceContext: "real" | "sim" | "unknown";
  /**
   * P133-H（用户裁决 2026-10-04：「不要老是限制的太死，这样用户会觉得麻烦」）：
   * 用户挑了「全权执行」——八个能力域一个没勾掉。这一位说的就是这件事，
   * 由装配侧从档位算出来，模型碰不到（`decide` 的调用点只有工具管线一处）。
   */
  fullAuthority: boolean;
}

/**
 * 主机端策略判定（可信代码，模型不能调用）。
 * 顺序：秘密 → 安全边界/实车/不可逆/破坏性（人工批准）→ 受保护配置 → 档位 → 允许。
 *
 * P133-H 放宽的是**软件内部、宿主留了退路**的那两类，边界写在下面，一条不多放：
 *  - `destructive_write` 且 `reversible` ⇒ 全权档直接执行。凭据是宿主真存了旧内容
 *    （`agent_tools.rs` 的快照表 + `agent_fs_restore`），不是"应该能撤销吧"；
 *  - `irreversible` 且 `hostBounded` ⇒ 全权档直接执行。今天只有 `repo_check`：
 *    argv 全部来自宿主常量表、无 shell、cwd 必须在白名单内、超时钳死，且它自己还有总开关。
 * 仍然逐次批准的：`secret`（直接拒）、`safety_boundary`（急停/校准）、`protected_config`
 * （AI 自己的权限开关与端点——能力面开放、权限面封闭）、实车或判不清的 `device_send`、
 * 以及一切"没快照又没钉死"的不可逆操作。
 */
export function decide(meta: ToolPolicyMeta, ctx: PolicyContext): PolicyDecision {
  if (meta.effect === "secret") return "deny";
  if (meta.effect === "safety_boundary" || meta.effect === "irreversible" || meta.effect === "destructive_write") {
    if (ctx.fullAuthority && meta.reversible && meta.effect === "destructive_write") return "allow";
    if (ctx.fullAuthority && meta.hostBounded === true && meta.effect === "irreversible") return "allow";
    return "require_local_approval";
  }
  if (meta.effect === "device_send") {
    // 无法判断是否实车时不可猜成仿真（HANDOVER §6.3）
    if (ctx.deviceContext === "real" || ctx.deviceContext === "unknown") return "require_local_approval";
    // 自定义档位：仅当用户勾选 device 域才自动发送（real/unknown 永远人工批准）
    if (ctx.scope === "custom") return ctx.authorized("device") ? "allow" : "require_local_approval";
    return ctx.scope === "create" ? "allow" : "preview_only";
  }
  if (meta.effect === "protected_config") return "require_local_approval";
  if (ctx.operatorLocked && meta.effect !== "read" && meta.effect !== "analysis") return "deny";
  if (ctx.scope === "preview") return meta.effect === "read" || meta.effect === "analysis" ? "allow" : "preview_only";
  if (meta.effect === "config_write" || meta.effect === "draft_write") {
    // 自定义档位：按勾选域裁决；常规创造默认全部授权（宿主侧 authorized 恒真，此处兜底校验）
    return ctx.authorized("config") ? "allow" : "require_local_approval";
  }
  return "allow";
}

/** 设置键 → effect class（受保护/秘密键不得借“设置修改”绕过批准） */
export function settingsEffect(sensitivity: Sensitivity, reversible: boolean): EffectClass {
  if (sensitivity === "secret") return "secret";
  if (sensitivity === "protected") return "protected_config";
  return reversible ? "config_write" : "protected_config";
}
