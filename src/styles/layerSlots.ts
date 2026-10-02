/**
 * P131-B2：层槽（layer slots）——z 轴的**唯一一份**出处。
 *
 * 为什么要这张表（详设 §A6）：原来对 `position:fixed` 的态度是"全禁"，理由是"把界面盖住/劫持指针"。
 * 一刀切的代价是把一整层正常能力删了（浮层、遮罩、贴边工具条、Toast 全是 fixed）。
 * 换成层槽之后，禁的东西没变——**"用户撤不回来"才是问题**——只是表达方式变了：
 * 主题只能引用登记过的槽，而**通知档 / 引导层 / 拖拽 ghost 这三档不出槽**，
 * 所以任何主题都拿不到比它们更高的合法值。
 *
 * 这条保证要说准，别说过头：它**不**等于"撤销入口永远在最上面"。
 * 设置对话框的遮码在 200 档（宿主历史上就在那），所以一个 `position:fixed` + `--z-float`
 * 的全屏浮层仍然能盖住它——这件事交给 `theme_audit` 报 `layerClash`（证据），不靠禁令。
 * 真正硬的那条是：主题写不出比通知/引导/拖拽更高的层，因此"改坏了看不见下一步"
 * 与"拖起来没跟手"这两类不可自救不会发生。
 *
 * 两条纪律写在这里，因为它们都会被人无意中破：
 *  1. 数值只有这一份。`theme.css` 的宿主规则**引用这些变量**而不是各写各的字面量——
 *     两边都写数字就是两处真相，改一处忘一处时"槽"和"实际层级"就悄悄错开了
 *     （`layerSlots.test.ts` 逐档核对，漂一个数就红）；
 *  2. 主题侧**不许重定义** `--z-*`。能写 `:root{--z-menu:99999}` 就等于把整张表作废，
 *     所以净化器把 `--z-` 前缀一并拒（见 styleSanitize 的 `layer_slot_is_host_only`）。
 */

/** 主题/AI 可以引用的槽（名字 → 值）。名字是要写给模型看的，所以要能望文知义 */
export const NAMEABLE_SLOTS = {
  /** 面板内部抬一层：行内下拉、悬浮删除键 */
  "z-raised": 100,
  /** 浮挂件：AI 挂件、哨兵浮层 */
  "z-float": 500,
  /** 帮助气泡、贴边固定弹层 */
  "z-popup": 999,
  /** 菜单一档：右键菜单、选择器弹层、页签提示（宿主里最高的一个可引用档） */
  "z-menu": 2000,
} as const satisfies Record<string, number>;

export type SlotName = keyof typeof NAMEABLE_SLOTS;

/** 保护区（宿主自用，**不出槽**）：任何主题都拿不到比这更高的合法值 */
export const PROTECTED_LAYERS = {
  /** 提示条（撤销入口的 toast 档） */
  "z-toast": 4000,
  /** 教学引导的遮罩与聚焦环：它必须永远在最上面，否则"看不见下一步" */
  "z-tour": 5000,
  /**
   * 拖拽跟手的 ghost（portal 到 body，必须压过一切）。
   * 这档以前是两个字面量 9999 / 10000（`.drag-ghost` 与 `.pdrag-ghost` 各写一个）——
   * 两条拖拽内核的层级差 1，纯属抄来抄去，收成一个数。
   */
  "z-drag": 10000,
} as const satisfies Record<string, number>;

/** 所有真实存在的档（槽 + 保护区）：审计与门禁按这张表判"这个 var 存不存在" */
export const ALL_LAYERS = { ...NAMEABLE_SLOTS, ...PROTECTED_LAYERS } as Record<
  keyof typeof NAMEABLE_SLOTS | keyof typeof PROTECTED_LAYERS,
  number
>;

/** 主题能引用的最高值。超过它的字面 z-index 一律要有槽，不然就是越权 */
export const MAX_NAMEABLE_Z = Math.max(...Object.values(NAMEABLE_SLOTS));

/**
 * 局部堆叠的免检上限：`z-index: 1..LOCAL_Z_MAX` 是"谁压过谁的兄弟"，
 * 不参与全屏层级（本仓 CSS 里 1~6 那一堆就是这个用途），所以不必查槽。
 * 再往上就必须落槽——这条线是"局部"与"全屏"的分界，不是审查强度。
 */
export const LOCAL_Z_MAX = 99;

/** `z-index: var(--z-menu)` → "z-menu"；不是槽引用（数字、calc、别的 var）→ null */
export function slotFromZValue(value: string): string | null {
  const m = /^\s*var\(\s*(--[\w-]+)\s*\)\s*$/.exec(value);
  if (!m) return null;
  const name = m[1].slice(2);
  return name in ALL_LAYERS ? name : null;
}

/** 是不是**未知**的槽引用：`var(--z-foo)` 这种写得出但查无此档 */
export function isUnknownSlot(value: string): boolean {
  const m = /^\s*var\(\s*(--z-[\w-]+)\s*\)\s*$/.exec(value);
  if (!m) return false;
  return !(m[1].slice(2) in ALL_LAYERS);
}

/** 给模型/界面看的一句话清单（不再手写第二份，漂了就是这里改漏） */
export function slotCatalogText(): string {
  return Object.entries(NAMEABLE_SLOTS)
    .map(([name, value]) => `--${name}=${value}`)
    .join(" ");
}
