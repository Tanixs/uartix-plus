/**
 * P143-B：宿主自己的**语义词汇表**（`data-ctl` / `data-elev`）。
 *
 * 为什么要有这一层：主题组件层一直靠"猜类名"过日子——宿主有 253 个类目前缀，一枚主题想给
 * "所有可交互控件"同一套签名，就得逐类补规则（流利蓝那份只盖住 38 个，剩下 185 个仍在画中性态），
 * 而 dockview 的 `.dv-*` 更是第三方资产，版本一升级就静默失效（§8-58 那次三面同死）。
 * 这一层给的是**不随类名漂**的两个钩子：`data-ctl` 说"这个可点物是什么角色"，
 * `data-elev` 说"这块表面落在哪一档"（档位就是 P136 那族 `--elevation-*`）。
 *
 * **这条通道对静态门禁是隐形的**：死规则门只提取 `\.类名`（check-dead-classes.cjs:65），
 * 门 J3 同样只看类名（check-style.cjs:716）。写了 `[data-ctl="tab"]` 而宿主没人挂这个属性，
 * 没有任何一道门会红——所以词汇表必须带一本**双向闭合测试**（hostHooks.test.ts），
 * 由这张表当唯一判据：表里没有的值不许出现在 CSS 里，表里有的值必须有宿主写入点。
 */

/**
 * 控件角色。两类才进这张表：
 *  ① 元素名与 ARIA role 说不清"这个可点物是什么"的（div 当页签、div 当表头、label 包出来的开关）；
 *  ② 明明是原生 `<button>`、但签名要**按角色分档**的（导轨与身份栏那批 20px 小键要按得比
 *     24px 默认控件更明显，见 theme.css 里 `--ctl-press-tight` 那条总线分支）。
 * 其余原生 `<button>` / `<input>` / `select` 不进这张表——签名总线用元素选择器直接覆盖它们
 * （见 theme.css 的 `:where(button, …)` 那一段），给它们再挂一遍属性就是把第二套真相写进 DOM。
 */
export const CTL_HOOKS = [
  "menu", // 菜单容器本体（`.ctx-menu` / `.sb-menu` / `.cmdk` …）：一屋子的行共用一套 hover 档
  "tool", // 导轨 / 身份栏上的一枚动作（都是 `<button>`，挂它是为了"小控件按得更明显"那一档）
  "tab", // 页签（含 dockview 那种第三方 DOM）
  "tablist", // 一整条页签带（dockview 画的，宿主只能从翻译表拿到它）
  "item", // 二级面板 / 列表里可选中的一条
  "col", // 表头那一格（点它排序，但它是个 div）
  "seg", // 两段式开关的其中一段（div，不是 radio 也不是 button）
  "disc", // 点一下展开/收起的东西
  "sash", // 停靠分隔条（拖）
] as const;

export type CtlHook = (typeof CTL_HOOKS)[number];

/** 表面档位：与 P136 `--elevation-0..4` 同一套数字，别起第二套深度词汇 */
export const ELEV_TIERS = [0, 1, 2, 3, 4] as const;

export function isCtlHook(v: string): v is CtlHook {
  return (CTL_HOOKS as readonly string[]).includes(v);
}

export function isElevTier(v: string): boolean {
  return (ELEV_TIERS as readonly number[]).includes(Number(v));
}
