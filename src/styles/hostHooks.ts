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

/**
 * P148：**签名槽表**。P143 那 12 枚（+ 3 枚故意不在 `:root` 给值的）此前只活在 `theme.css` 的注释里，
 * 而提示词对模型**一个字都没提**（P147 §4 实测：`prompts.ts` 里 `--ctl-` 零命中）——
 * 结果就是模型每次都走最贵的那条路（逐类点名），永远写不出"一条槽改约 1,120 只控件"的主题。
 * 这张表是那份知识的唯一出处：`hostHooks.test.ts` 拿它和 CSS 双向闭合，`prompts.ts` 拿它生成话术。
 *
 * `defaultAtRoot:false` 那三枚是**有意的**：它们靠各基元自己的 `var()` 兜底
 * （`.btn` 的焦点环 +1px、`.seg` 的 -2px），在 `:root` 写死就等于把所有基元压成同一档。
 */
export const CTL_SLOTS: ReadonlyArray<{ name: string; defaultAtRoot: boolean; gloss: string }> = [
  { name: "--ctl-fill-hover", defaultAtRoot: true, gloss: "控件静置→悬停的填充档" },
  { name: "--ctl-fill-active", defaultAtRoot: true, gloss: "按下去那一瞬的填充档" },
  { name: "--ctl-fill-selected", defaultAtRoot: true, gloss: "选中/开着（.on、[aria-selected]）的填充档" },
  { name: "--ctl-fill-primary-hover", defaultAtRoot: true, gloss: "主按钮悬停底色" },
  { name: "--ctl-fill-primary-active", defaultAtRoot: true, gloss: "主按钮按下底色" },
  { name: "--ctl-line-hover", defaultAtRoot: true, gloss: "描边悬停档" },
  { name: "--ctl-ring", defaultAtRoot: true, gloss: "焦点环颜色" },
  { name: "--ctl-ring-w", defaultAtRoot: true, gloss: "焦点环粗细" },
  { name: "--ctl-press", defaultAtRoot: true, gloss: "按下的位移/缩放（普通控件）" },
  { name: "--ctl-press-tight", defaultAtRoot: true, gloss: "按下的位移/缩放（20px 小键一档）" },
  { name: "--ctl-lift", defaultAtRoot: true, gloss: "悬停抬起（多数主题为 none）" },
  { name: "--ctl-focus-outline", defaultAtRoot: true, gloss: "键盘焦点轮廓" },
  { name: "--ctl-ring-offset", defaultAtRoot: false, gloss: "焦点环外扩（各基元不同档，故意不在 :root 给值）" },
  { name: "--ctl-input-focus", defaultAtRoot: false, gloss: "输入框聚焦时的边框（基元自带兜底）" },
  { name: "--ctl-focus-border", defaultAtRoot: false, gloss: "聚焦边框色（同上，与 --ctl-input-focus 分给不同基元）" },
  { name: "--ctl-focus-halo", defaultAtRoot: false, gloss: "聚焦光晕（同上）" },
  { name: "--ctl-track", defaultAtRoot: false, gloss: "开关轨道：关（缺省 = --border）" },
  { name: "--ctl-track-on", defaultAtRoot: false, gloss: "开关轨道：开（缺省 = --accent）" },
  { name: "--ctl-knob", defaultAtRoot: false, gloss: "开关旋钮（缺省 = 白）" },
  { name: "--ctl-knob-shadow", defaultAtRoot: false, gloss: "开关旋钮的投影（缺省 = 宿主今天那档）" },
];

/**
 * 签名总线**排除**的那几个角色：它们是拖拽把手与分隔线，不是"按得动的东西"。
 * 命中标的（`uiSurface` 的命中区审计）与覆盖率仪表（`.tools/ctl-coverage.mjs`）都必须读这一份，
 * 否则会出现"总线不认它、审计却拿 24px 去量一条 1px 的分隔条"这种自相矛盾（P148 之前正是如此）。
 */
export const CTL_BUS_EXCLUSIONS = ['[data-ctl="sash"]', '[role="separator"]', "[data-pdrag]"] as const;

/** `[data-ctl]` 那一支的完整可点选择器（排除项内联，两个消费方共用同一个串） */
export const CTL_BUS_HOOK = `[data-ctl]:not([data-ctl="sash"]):not([role="separator"]):not([data-pdrag])`;

export function isCtlHook(v: string): v is CtlHook {
  return (CTL_HOOKS as readonly string[]).includes(v);
}

export function isElevTier(v: string): boolean {
  return (ELEV_TIERS as readonly number[]).includes(Number(v));
}
