import { getCommand } from "./commandStore";
import type { CommandItem } from "./commandStore";
import type { ControlCard } from "./controlsStore";

/**
 * 命令挂载（引用式，schema v3）。
 *
 * 单链：**命令 → 发送谱 → 卡片**。卡片只存 `commandId`，不存命令内容的拷贝，
 * 所以命令改名/改模板/换谱，挂着的卡当场跟着变；命令被删则是"失效引用"——
 * 卡片保留、发送被拦下并说明原因，等用户换绑或解绑。
 *
 * 为什么只有这四种卡：挂载的语义是"这张卡就发这一条命令"。开关（两档各有模板）、
 * 键盘遥控（四个方向各有模板）、组合控件（每个子项各有模板）一卡对应多条指令，
 * 挂一条命令没有确定语义，宁可不开放，也不做一个"只挂进第一档"的隐式约定。
 */
export const MOUNTABLE_TYPES = ["slider", "button", "joystick", "keymon"] as const;
export type MountableType = (typeof MOUNTABLE_TYPES)[number];

export function isMountable(card: Pick<ControlCard, "type">): boolean {
  return (MOUNTABLE_TYPES as readonly string[]).includes(card.type);
}

export type MountedState =
  | { kind: "none" }
  /** 有 commandId 但命令已经不在了：发送必须被拦下，不能静默发旧字节 */
  | { kind: "missing" }
  | { kind: "ok"; item: CommandItem };

export function mountedState(
  card: Pick<ControlCard, "commandId">,
): MountedState {
  if (!card.commandId) return { kind: "none" };
  const item = getCommand(card.commandId);
  return item ? { kind: "ok", item } : { kind: "missing" };
}

/** 挂载能覆盖的字段（四种卡的交集；别的卡没有这些键也不影响读取） */
export interface MountTarget {
  commandId?: string;
  template?: string;
  sendMode?: "ascii" | "hex";
  script?: string;
  useScript?: boolean;
  sendTemplateId?: string;
}

/**
 * 把所挂命令的发送字段覆盖到卡上（不改 store、不落盘）。
 * `mountOverrides` 是命令自身的参数覆盖值：只在这一帧的发送里带上，
 * 不写回卡片——写回去就成了"卡片里又存了一份命令参数"的第二真相。
 */
export function withMountedCommand<T extends MountTarget>(
  card: T,
): T & { mountOverrides?: Record<string, string> } {
  const state = mountedState(card);
  if (state.kind !== "ok") return card;
  const { item } = state;
  return {
    ...card,
    template: item.template,
    sendMode: item.sendMode,
    script: item.script,
    useScript: !!item.scriptEnabled && !!item.script,
    // 命令是唯一真相：命令没引用谱，就绝不能留着卡上旧的谱引用
    sendTemplateId: item.sendTemplateId,
    mountOverrides: item.overrides,
  } as T & { mountOverrides?: Record<string, string> };
}
