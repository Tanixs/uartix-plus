/**
 * P97-I3：动效配方的**唯一真相**——CSS 由这里生成，不再往 theme.css 手抄一份平行清单。
 *
 * 为什么是"生成的样式表"而不是让模型自由写 canvas JS 动画：
 *  - 性能与降级可控（全部是合成器友好的 transform/opacity，且统一被减弱动效开关压制）；
 *  - 模型只需要组合旋钮（颜色/速度/密度），不必每次重新发明一遍光效；
 *  - 出问题时一眼看得出是哪条配方，而不是几百行生成的 JS。
 *
 * 需要真 JS 动效的场景仍走已有的 `script` 扩展链（能力白名单 + 逐次批准），这里不新造执行面。
 */

export interface FxKnob {
  /** CSS 自定义属性名（模型在 decls 里直接写） */
  prop: string;
  /** 取值示例（进清单，避免模型瞎猜单位） */
  example: string;
  hint: string;
}

export interface FxRecipe {
  id: string;
  className: string;
  /** 该配方用到的 @keyframes 名（一律 fx- 前缀，与净化器的命名规则一致） */
  keyframes: string[];
  /** 一行"长什么样"，给模型选型用 */
  look: string;
  knobs: FxKnob[];
  /** 建议挂载位置（组件级样式最容易踩"挂错层"的坑） */
  mount: string;
  css: string;
}

/** 时长下限 200ms：`check:motion` 硬拦的是"快于 200ms 的无限闪烁"（光敏风险），配方一律走安全侧 */
const SAFE_MIN = "0.2s";

export const FX_RECIPES: readonly FxRecipe[] = [
  {
    id: "glow",
    className: "fx-glow",
    keyframes: ["fx-glow"],
    look: "呼吸辉光：外发光强弱往复，适合强调当前选中项/报警态",
    knobs: [
      { prop: "--fx-color", example: "#4da3ff", hint: "光色（建议取 --accent）" },
      { prop: "--fx-speed", example: "2.4s", hint: `周期，不得小于 ${SAFE_MIN}` },
      { prop: "--fx-size", example: "14px", hint: "扩散半径" },
    ],
    mount: "卡片/按钮本体（不要挂到滚动容器上，会整屏呼吸）",
    css: `@keyframes fx-glow{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb, var(--fx-color, var(--accent)) 0%, transparent)}50%{box-shadow:0 0 var(--fx-size, 14px) 0 color-mix(in srgb, var(--fx-color, var(--accent)) 55%, transparent)}}
.fx-glow{animation:fx-glow var(--fx-speed, 2.4s) ease-in-out infinite}`,
  },
  {
    id: "sheen",
    className: "fx-sheen",
    keyframes: ["fx-sheen"],
    look: "流光扫过：一道高光从左到右掠过，适合主按钮/进行中",
    knobs: [
      { prop: "--fx-color", example: "#ffffff", hint: "高光色" },
      { prop: "--fx-speed", example: "2.8s", hint: `一次掠过耗时，不得小于 ${SAFE_MIN}` },
    ],
    mount: "需要 `position:relative;overflow:hidden` 的容器（配方已自带）",
    css: `@keyframes fx-sheen{0%{transform:translateX(-120%)}60%,100%{transform:translateX(140%)}}
.fx-sheen{position:relative;overflow:hidden}
.fx-sheen::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,color-mix(in srgb, var(--fx-color, #fff) 45%, transparent) 50%,transparent 65%);transform:translateX(-120%);animation:fx-sheen var(--fx-speed, 2.8s) linear infinite;pointer-events:none}`,
  },
  {
    id: "ripple",
    className: "fx-ripple",
    keyframes: ["fx-ripple"],
    look: "点击波纹：按下时一圈向外淡出，给「按到了」的确认感",
    knobs: [
      { prop: "--fx-color", example: "var(--accent)", hint: "波纹色" },
      { prop: "--fx-speed", example: "0.55s", hint: "一次波纹时长" },
    ],
    mount: "按钮/可点卡片",
    css: `@keyframes fx-ripple{0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--fx-color, var(--accent)) 45%, transparent)}100%{box-shadow:0 0 0 12px transparent}}
.fx-ripple:active{animation:fx-ripple var(--fx-speed, .55s) ease-out}`,
  },
  {
    id: "particles",
    className: "fx-particles",
    keyframes: ["fx-particles"],
    look: "漂浮微粒：多层径向渐变点缓慢上移，纯 CSS（不引库、不开 canvas）",
    knobs: [
      { prop: "--fx-color", example: "#7cd1ff", hint: "粒子色" },
      { prop: "--fx-speed", example: "18s", hint: "上浮周期（越长越安静）" },
      { prop: "--fx-density", example: "22px", hint: "粒子间距：值越小越密" },
    ],
    mount: "面板背景层（配 z-index:-1 或放在内容之下）",
    css: `@keyframes fx-particles{0%{background-position:0 100%,0 100%}100%{background-position:0 0,60px -100%}}
.fx-particles{background-image:radial-gradient(color-mix(in srgb, var(--fx-color, var(--accent)) 70%, transparent) 1px, transparent 1px),radial-gradient(color-mix(in srgb, var(--fx-color, var(--accent)) 35%, transparent) 1px, transparent 1px);background-size:var(--fx-density, 22px) var(--fx-density, 22px);animation:fx-particles var(--fx-speed, 18s) linear infinite}`,
  },
  {
    id: "border-flow",
    className: "fx-border-flow",
    keyframes: ["fx-border-flow"],
    look: "渐变描边流动：边框色彩缓慢转圈，适合「运行中」的卡片",
    knobs: [
      { prop: "--fx-color", example: "var(--accent)", hint: "主色" },
      { prop: "--fx-color2", example: "var(--ok)", hint: "副色" },
      { prop: "--fx-speed", example: "6s", hint: `转一圈时长，不得小于 ${SAFE_MIN}` },
    ],
    mount: "卡片外框（自带 padding-box/border-box 双层背景，不需要额外元素）",
    css: `@keyframes fx-border-flow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.fx-border-flow{border:1px solid transparent;background:linear-gradient(90deg, color-mix(in srgb, var(--fx-color, var(--accent)) 60%, transparent), color-mix(in srgb, var(--fx-color2, var(--ok)) 60%, transparent), color-mix(in srgb, var(--fx-color, var(--accent)) 60%, transparent)) padding-box, linear-gradient(90deg, var(--fx-color, var(--accent)), var(--fx-color2, var(--ok))) border-box;background-size:300% 100%;animation:fx-border-flow var(--fx-speed, 6s) linear infinite}`,
  },
] as const;

/** 全部配方的样式表文本 + 减弱动效护栏（护栏只写一次，不逐条重复） */
export function fxStylesheet(): string {
  const sel = FX_RECIPES.flatMap((r) => [`.${r.className}`, `.${r.className}::after`]).join(",");
  const kill = `${sel}{animation:none;transition:none}`;
  const killScoped = `${sel.split(",").map((s) => `html.no-motion ${s}`).join(",")}{animation:none;transition:none}`;
  return [
    "/* P97-I3 动效配方：由 src/features/agent/fxRecipes.ts 生成，勿在 theme.css 里另写一份 */",
    ...FX_RECIPES.map((r) => r.css),
    `@media (prefers-reduced-motion: reduce){${kill}}`,
    killScoped,
  ].join("\n");
}

/** 给模型看的清单（与 CSS 同源，杜绝"描述与实现分叉"） */
export function fxCatalog() {
  return FX_RECIPES.map((r) => ({
    id: r.id,
    className: `.${r.className}`,
    look: r.look,
    mount: r.mount,
    knobs: r.knobs.map((k) => `${k.prop}=${k.example}（${k.hint}）`),
  }));
}

/**
 * 把配方装进主文档。**显式调用**（App 启动时一次），不做模块顶层副作用——
 * 求值期动手是 dev 白屏的老路（HANDOFF §8-33）。
 * 只注入 @keyframes 与类定义：没有元素引用它们时，运行时开销为零。
 */
export function installFxStylesheet(): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector("style[data-ai-fx]")) return false;
  const node = document.createElement("style");
  node.dataset.aiFx = "1";
  node.textContent = fxStylesheet();
  document.head.appendChild(node);
  return true;
}
