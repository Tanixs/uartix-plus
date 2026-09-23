/**
 * P99b-N5：「现在哪一枚主题在画」的事实表 + 落地订阅（**零 import 叶子**）。
 *
 * 为什么不放在 `ai/extRuntime` 里让所有人去 import 它：`features/plugins/` 全目录都不准静态依赖
 * 样式运行时（P92-F 整窗白屏的根因就是 pluginStore 求值期撞进 extRuntime 未初始化的模块状态，
 * 环守卫把这条写成了禁止边）。而插件库那颗开关的 tooltip 恰恰要知道"在画的是谁"才说得出
 * "启用这颗会挤掉谁"。所以把这份状态挪到叶子里：**写的人只有一个（extRuntime），读的人随便读**。
 *
 * 与 `marketPending.ts` 同形状：内存表 + 订阅，别处只读不写。
 */

export interface ActiveThemeFacts {
  /** 在画那枚的 id（内置 id 或插件影子扩展 id）；空串＝还没落地过 */
  id: string;
  name: string;
  builtin: boolean;
  /** 它属于哪个包（插件主题才有）——启停只能拿它去 `pluginStore.setEnabled` */
  pluginId: string | null;
  scheme: "dark" | "light";
  /** 明暗归属的出处：`inherit` 那一条必须点名（主题自己没给依据） */
  schemeOrigin: "declared" | "bg" | "inherit";
  /** 这枚主题自己覆写了几项 */
  overrides: number;
  /** 没覆写、按兜底层取值的核心色键有几项 */
  inherited: number;
  /** 兜底用的是哪张表 */
  baseline: "dark" | "light";
  /** 内置那一枚（停用插件主题后回到的那个） */
  fallbackId: string | null;
  /** 同时启用中的其它主题插件：渲染只画最新那枚，其余照实点名 */
  conflicts: string[];
  /** settings 里那枚内置不存在了 ⇒ 回落第一枚，要说 */
  fellBack: boolean;
}

export const EMPTY_THEME_FACTS: ActiveThemeFacts = {
  id: "",
  name: "",
  builtin: true,
  pluginId: null,
  scheme: "dark",
  schemeOrigin: "inherit",
  overrides: 0,
  inherited: 0,
  baseline: "dark",
  fallbackId: null,
  conflicts: [],
  fellBack: false,
};

let facts: ActiveThemeFacts = EMPTY_THEME_FACTS;

/** 唯一的写者：`ai/extRuntime.applyStyleExts()` */
export function setActiveThemeFacts(next: ActiveThemeFacts): void {
  facts = next;
}

/** 当前在画的那枚（选择器、来源面板、回执共用这一个口径；§8-48） */
export function activeThemeFacts(): ActiveThemeFacts {
  return facts;
}

const listeners = new Set<() => void>();

/** 订阅"重算并落地了"（dockview 的容器类名要跟**在画那枚**的明暗，而不是跟 settings.theme） */
export function subscribeStyleApply(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notifyStyleApply(): void {
  listeners.forEach((f) => f());
}
