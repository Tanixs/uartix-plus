/**
 * P99b-N5：主题的**纯函数层**（零 import，与 `rootVars.ts` 同族叶子）。
 *
 * 为什么单独一层（详设 §2/§8-48）：这批把"内置主题"从样式表那一层搬到与插件主题同级的位置，
 * 于是"哪枚主题在画""它算亮还是暗""哪些键没人供"三件事第一次需要**同时**回答。
 * 写在组件或 extRuntime 里就没法在 node 下测，而这三问每一条都会直接落到界面上说的话。
 *
 * 三条口径写死在这里：
 *  1. **差量合法，但缺的键必须有人兜底**（详设 §1-2：17 项核心色键今天只存在于主题文件里，
 *     内置下台后没声明的键就真的没有值）——兜底分暗/亮两层，选哪层由明暗归属决定；
 *  2. 明暗归属三层优先序：自带声明 → 自己给的 `--bg` 亮度算 → 沿用上一次（并要说出来用了哪一层）；
 *  3. 本模块**不读 DOM、不读 store**：所有输入都是参数，所以每条判定都能被断言反驳。
 */

export type ThemeScheme = "dark" | "light";

/**
 * 17 项核心色键。实测（详设 §1-2）：theme.css 里逐键 grep 计数 = 0，
 * 它们**只**声明在主题文件中——这就是差量主题必须有兜底层的全部理由。
 */
export const CORE_COLOR_KEYS: readonly string[] = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--border",
  "--border-soft",
  "--text",
  "--text-dim",
  "--accent",
  "--on-accent",
  "--accent-soft",
  "--danger",
  "--warn",
  "--ok",
  "--shadow",
  "--scrollbar",
  "--scrollbar-hover",
];

/** 亮度分档：低于该值算暗。阈值本身不是重点，重点是有 8 组内置真值钉着它（themeCore.test 的 G11）。 */
export const DARK_LUMINANCE_MAX = 0.4;

/**
 * **可写入的 token 白名单**（P99b-N5 从 `features/agent/appearanceStore` 搬下来）：
 * 色板（8 主题共有）+ 语义色 + 字号/圆角/动效（theme.css `:root` 的 P55 token）。间距不开放（布局安全）。
 *
 * 为什么要搬：这批开始"哪些键算合法"同时管着三件事——AI 覆盖层、插件主题产物、样式表引用。
 * 放在 `features/agent/` 里，`features/plugins/artifact.ts` 就得反向引 agent 才能校验一个主题包
 * （方向不对，而且会把 store 的求值期副作用顺带拉进插件链路）。放在零 import 的叶子层，谁都能读。
 */
export const APPEARANCE_TOKENS = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--border",
  "--border-soft",
  "--text",
  "--text-dim",
  "--accent",
  "--on-accent",
  "--accent-soft",
  "--danger",
  "--warn",
  "--ok",
  "--shadow",
  "--scrollbar",
  "--scrollbar-hover",
  "--warn-fg",
  "--k-send",
  "--k-wait",
  "--k-frame",
  "--k-assert",
  "--k-note",
  "--k-logic",
  "--k-group",
  "--k-warn-line",
  "--fs-xs",
  "--fs-body",
  "--fs-sm",
  "--fs-md",
  "--fs-lg",
  "--radius-s",
  "--radius-m",
  "--radius-l",
  "--radius-xl",
  "--dur-snap",
  "--dur-fast",
  "--dur-base",
  "--ease",
  /* P103 批 1：表面层级（派生自 --bg-panel/--text/--border，见 theme.css 的派生块）。
     加进白名单不是"顺手放宽"——是**关掉一条重复写入通道**：白名单外的 --* 可以被
     `style_patch`/`save_theme_extension` 的 `:root` 规则写（styleSanitize 的 :root 特例
     只拒白名单键），而那种写入会被主题/基线的专属选择器压住 ⇒ 模型以为改了、界面没动
     （§8-37② 那族）。进白名单＝唯一写入者仍是合成器，且撤销语义跟着走。 */
  "--raise-1",
  "--raise-2",
  "--line-strong",
  "--scrim",
  "--ring",
  /* P103：布局类旋钮（控件高三档 / 间距 / 行高）。它们让"AI 改布局节奏"这件事第一次可达，
     值域在 appearanceStore.isValidTokenValue 里收窄（写崩等于不能用）。 */
  "--ctl-h-1",
  "--ctl-h-2",
  "--ctl-h-3",
  "--sp-0",
  "--sp-1h",
  "--sp-6",
  "--lh-ui",
  "--lh-read",
] as const;

export type AppearanceToken = (typeof APPEARANCE_TOKENS)[number];

export interface ThemeSource {
  /** 内置＝`dark`/`begonia`…；插件＝影子扩展 id（`plg:<pkg>:<contrib>`） */
  id: string;
  name: string;
  builtin: boolean;
  /** 作者声明的明暗归属：内置取文件里的 `color-scheme`，插件可带 artifact.scheme */
  scheme: ThemeScheme | null;
  vars: Record<string, string>;
  css?: string;
  /** 插件来源时它所属的包 id（启停只能走 `pluginStore.setEnabled`） */
  pluginId?: string;
  createdAt?: number;
}

export interface ParseResult {
  ok: boolean;
  vars: Record<string, string>;
  scheme: ThemeScheme | null;
  errors: string[];
}

/**
 * 解析一枚主题文件：**只**认一个 `:root[data-theme="x"]` 块，块内只收 `--*` 与 `color-scheme`。
 *
 * 出声而不是宽容（G12）：这批把主题文件从"运行时样式"降级成"数据"（`?raw` 读进来自己解析），
 * 于是任何一条真样式规则都不会再生效——静默跳过等于把用户的界面改坏而没人报。
 * 同理，块缺失/块内空表也一律判错：空表会让那枚主题"看起来全走兜底"，是一件必须说出口的事。
 */
export function parseThemeBlock(src: string, id: string): ParseResult {
  const errors: string[] = [];
  const vars: Record<string, string> = {};
  let scheme: ThemeScheme | null = null;
  // 注释先摘掉（主题文件里有解释性注释），但保留换行以便定位
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const blockRe = /:root\s*\[\s*data-theme\s*=\s*("([^"]*)"|'([^']*)')\s*\]\s*\{/g;
  const blocks: { start: number; open: number; themeId: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(stripped))) {
    blocks.push({ start: m.index, open: m.index + m[0].length, themeId: m[2] ?? m[3] ?? "" });
  }
  if (blocks.length !== 1) {
    errors.push(`主题文件 ${id} 里应当只有一个 :root[data-theme="…"] 块，实际 ${blocks.length} 个`);
    return { ok: false, vars, scheme, errors };
  }
  const blk = blocks[0];
  if (blk.themeId !== id) {
    errors.push(`主题文件 ${id} 的选择器写的是 data-theme="${blk.themeId}"：与文件名不符（本层按 id 取表，留着旧属性只会让人以为还在按属性上色）`);
  }
  const close = stripped.indexOf("}", blk.open);
  if (close < 0) {
    errors.push(`主题文件 ${id} 的块没有闭合`);
    return { ok: false, vars, scheme, errors };
  }
  const body = stripped.slice(blk.open, close);
  // 块外只许留空白：多出来的一条规则就是 ?raw 解析会静默丢掉的那种东西（R8）
  const outside = (stripped.slice(0, blk.start) + stripped.slice(close + 1)).trim();
  if (outside) {
    errors.push(`主题文件 ${id} 在 :root 块之外还有内容（${outside.slice(0, 40)}…）：本层只解析 token 块，留在这里的样式不会生效`);
  }
  for (const raw of body.split(";")) {
    const decl = raw.trim();
    if (!decl) continue;
    const sep = decl.indexOf(":");
    if (sep < 0) {
      errors.push(`主题文件 ${id} 里有一行不是声明：${decl.slice(0, 40)}`);
      continue;
    }
    const name = decl.slice(0, sep).trim();
    const value = decl.slice(sep + 1).trim();
    if (!value) {
      errors.push(`主题文件 ${id} 的 ${name} 值为空`);
      continue;
    }
    if (name.startsWith("--")) {
      vars[name] = value;
      continue;
    }
    if (name === "color-scheme") {
      if (value !== "dark" && value !== "light") {
        errors.push(`主题文件 ${id} 的 color-scheme 只认 dark/light，实际「${value}」`);
        continue;
      }
      scheme = value;
      continue;
    }
    errors.push(`主题文件 ${id} 的块里出现非 token 声明「${name}」：主题文件只放变量（详设 R8）`);
  }
  if (Object.keys(vars).length === 0) {
    errors.push(`主题文件 ${id} 一个变量都没有：那它和兜底层一模一样，不该算一枚主题`);
  }
  return { ok: !errors.length, vars, scheme, errors };
}

/** `#rgb`/`#rrggbb` → WCAG 相对亮度；解析不了返回 null（不猜颜色） */
export function relativeLuminance(color: string): number | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const chan = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = chan.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 只看主题**自己声明**的 `--bg`：没声明就返回 null（不能让兜底的 bg 冒充它自己的归属） */
export function schemeFromBg(vars: Record<string, string>): ThemeScheme | null {
  const bg = vars["--bg"];
  if (!bg) return null;
  const lum = relativeLuminance(bg);
  if (lum === null) return null;
  return lum <= DARK_LUMINANCE_MAX ? "dark" : "light";
}

export type SchemeOrigin = "declared" | "bg" | "inherit";

/** 明暗归属三层优先序（详设 S4）。返回 origin 是为了让界面能说实话：③ 那条必须点名。 */
export function resolveScheme(
  theme: Pick<ThemeSource, "scheme" | "vars">,
  prev: ThemeScheme | null,
): { scheme: ThemeScheme; origin: SchemeOrigin } {
  if (theme.scheme === "dark" || theme.scheme === "light") return { scheme: theme.scheme, origin: "declared" };
  const byBg = schemeFromBg(theme.vars);
  if (byBg) return { scheme: byBg, origin: "bg" };
  return { scheme: prev ?? "dark", origin: "inherit" };
}

/**
 * 一枚主题"覆写了几项、几项走兜底"。
 * `inherited` 只统计**核心色键**（字号/圆角那批不在主题文件里，走 theme.css 的 `:root`，不是这一问的范围）。
 */
export function themeCoverage(
  vars: Record<string, string>,
  baseline: Record<string, string>,
): { overrides: number; inherited: string[] } {
  const overrides = Object.keys(vars).length;
  const inherited = CORE_COLOR_KEYS.filter((k) => !(k in vars) && k in baseline);
  return { overrides, inherited };
}

/** 选择器预览要用的三格：从 token 表算，**不再手抄**（详设 §1-8 的 THEME_SWATCH 就是抄本） */
export function swatchOf(
  vars: Record<string, string>,
  baseline: Record<string, string>,
): { bg: string; panel: string; accent: string } {
  const pick = (k: string) => vars[k] ?? baseline[k] ?? "";
  return { bg: pick("--bg"), panel: pick("--bg-panel"), accent: pick("--accent") };
}

/** 相近的合法键名（R5 的"你可能想写的是"）：只按去掉 `--` 后的前缀/包含关系挑第一条，不猜语义 */
export function nearestKnownKey(
  key: string,
  whitelist: readonly string[],
): string | null {
  const bare = key.replace(/^--/, "").toLowerCase();
  if (!bare) return null;
  const scored = whitelist
    .map((k) => {
      const kb = k.replace(/^--/, "").toLowerCase();
      const s = kb === bare ? 0 : kb.startsWith(bare) || bare.startsWith(kb) ? 1 : kb.includes(bare) || bare.includes(kb) ? 2 : -1;
      return { k, s, len: Math.abs(kb.length - bare.length) };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.len - b.len);
  return scored[0]?.k ?? null;
}

/**
 * 差量主题的 token 键白名单校验（详设 R5）。
 * 为什么要拒：两份市场示例包写了 `--panel`/`--accent-contrast` 这种**应用里不存在**的键，
 * 校验只查"以 `--` 开头"，于是那份主题只落地了 4 项而没有任何一处说出来（详设 §1-4）。
 */
export function checkThemeVars(
  vars: Record<string, string>,
  whitelist: readonly string[],
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const allowed = new Set(whitelist);
  for (const k of Object.keys(vars)) {
    if (allowed.has(k)) continue;
    const near = nearestKnownKey(k, whitelist);
    errors.push(`未知的主题变量 ${k}${near ? `（你要写的可能是 ${near}）` : ""}`);
  }
  return { ok: !errors.length, errors, warnings: [] };
}

export interface ThemeCandidate {
  id: string;
  name: string;
  builtin: boolean;
  pluginId?: string;
}

/**
 * 「在画的这一枚」的唯一判定（详设 R1）。
 *
 * 两件事各留各的真相、这里只做合成：**内置选哪枚**＝`settings.theme`（含 `system` 解析），
 * **装了哪枚插件主题**＝插件记录的启用态（入口收敛后至多一枚）。
 * 有插件主题在启用 ⇒ 它在画；否则画内置。停用那枚插件当场回到 `settings.theme`（详设 R4）。
 *
 * `conflicts` 不是错误而是**要照实说出来**的事：存量数据里可能有多枚启用中的主题插件
 * （这批之前从没互斥过），渲染只取 `createdAt` 最新那一枚，其余原样列在面板上。
 */
export function resolveActiveTheme(input: {
  settingsTheme: string;
  sysDark: boolean;
  builtins: readonly ThemeCandidate[];
  enabledThemePlugins: readonly ThemeSource[];
}): {
  active: ThemeCandidate | null;
  builtinDrawn: ThemeCandidate | null;
  conflicts: ThemeSource[];
  /** settings 里那枚内置不存在了（改名/下架）⇒ 回落第一枚。**这个旗标就是为了让界面能说出口** */
  fellBack: boolean;
} {
  const want = input.settingsTheme === "system" ? (input.sysDark ? "dark" : "light") : input.settingsTheme;
  const found = input.builtins.find((b) => b.id === want) ?? null;
  const builtinDrawn = found ?? input.builtins[0] ?? null;
  const fellBack = !found && input.builtins.length > 0;
  const sorted = [...input.enabledThemePlugins].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
  const picked = sorted[sorted.length - 1];
  if (picked) {
    return {
      active: { id: picked.id, name: picked.name, builtin: false, pluginId: picked.pluginId },
      builtinDrawn,
      conflicts: sorted.slice(0, -1),
      fellBack,
    };
  }
  return { active: builtinDrawn, builtinDrawn, conflicts: [], fellBack };
}

/** 兜底层的名字要能上界面：不叫"基线"这种含糊词，直接说它是哪枚内置供的 */
export function baselineLabel(scheme: ThemeScheme): string {
  return scheme === "dark" ? "内置 dark（暗底）" : "内置 light（亮底）";
}

/* ================= P110-A：表面阶梯的**语义**校验（值能写进去 ≠ 写进去不弄坏界面） ================= */

/** 解析后的颜色：r/g/b 取 0~255，a 取 0~1 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** CIE L*（0~100，感知均匀）。表面档差必须用它，WCAG 比在近黑区饱和到分不出 8 档。 */
export function lstarOf(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const y = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/**
 * WCAG 对比度比（1~21）。这里只用于**提醒**：撤不撤由用户定（见 judgeSurfaceLadder 那段注释）。
 * 与 `.tools/check-contrast.cjs` 里那份是同一算法 —— 那份门禁跑在 node 里、引不了 TS，
 * 两个实现对同一组内置真值钉在 themeCore.test 里，谁漂了就红。
 */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const Y = (c: Rgba) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const [hi, lo] = Y(a) >= Y(b) ? [Y(a), Y(b)] : [Y(b), Y(a)];
  return (hi + 0.05) / (lo + 0.05);
}
/** 提醒线：与门禁给内置主题的那条同数（4.5:1）。低于它只出声，不撤 */
export const TEXT_CONTRAST_WARN = 4.5;
/** "几乎读不出字"的那条线：只用来把话说明白，判定仍然只到提醒 */
export const TEXT_CONTRAST_FLOOR = 2.0;

/** 探针要读回的键：四档基础面 + 两档派生抬升 + 方向参照的正文色 */
export const SURFACE_PROBE_KEYS = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--raise-1",
  "--raise-2",
  "--text",
] as const;
export type SurfaceProbeKey = (typeof SURFACE_PROBE_KEYS)[number];

/** 参与"哪个键不能透"的抬升档（玻璃配方只动基础档，见 appearanceTools 的 glassVars） */
export const RAISE_KEYS = ["--raise-1", "--raise-2"] as const;
/** 基础面档（alpha 在这里是**特性**：内置玻璃配方就把 --bg-panel 写成 0.72） */
export const BASE_SURFACE_KEYS = ["--bg", "--bg-panel", "--bg-inset", "--bg-titlebar"] as const;

/** 抬升档与面板档的最大档差（L*）。**这个数是量出来的不是拍的**：八枚内置主题的
 * `--raise-1/--raise-2` 实测 |Δ| 分别在 7.9~8.1 与 13.5~13.8（暗底往亮抬、亮底往暗退）。
 * 上限放到内置最大值的近两倍，留出"这套主题想要更强层级"的余量，又远低于
 * "暗色主题里写一枚接近白的 --raise-1"（用户 2026-09-27 图 3 那五处白底就是它，ΔL* ≈ 80）。
 */
export const RAISE_MAX_DELTA_L = 24;
/** 低于此值等于"抬了但看不出来"——只提醒，不撤（撤了就是替用户做审美决定） */
export const RAISE_MIN_DELTA_L = 1.2;
/** 基础档之间"倒置"的判定容差：两档几乎同色是内置 dark 的既有做法，不算违规 */
export const LADDER_INVERSION_TOLERANCE_L = 0.3;

export interface SurfaceIssue {
  key: string;
  reason: string;
  /** true = 这条会把界面弄坏，写入方应把该键撤回；false = 原样生效但照实说 */
  fatal: boolean;
}

/**
 * 表面阶梯判定：输入是**施加之后**读回的实际颜色（不是 CSS 源码字符串）。
 *
 * 为什么不在字符串层判（详设 §3′.1）：主题可以把 `--raise-1` 写成
 * `color-mix(in srgb, var(--bg-panel) 60%, transparent)` 或任何只有浏览器算得出的形式，
 * 字符串层面判不出它最终是不是半透明、是不是比面板更亮。所以这里只吃已解析的 RGBA，
 * 谁来解析（DOM 探针 / 门禁里的静态求值器）是调用方的事。
 *
 * 只判三件"确实会弄坏界面"的事，其余一律 warn（用户 2026-09-27 裁决：别把能力限太死）：
 *  ① 抬升档必须不透明——半透明的"浮起层"会透出下面的内容，就是漏底那一族；
 *  ② 抬升方向必须跟正文色同侧（暗底往亮抬、亮底往暗退），反了就把层级读成了凹陷；
 *  ③ 抬升幅度不得超出 RAISE_MAX_DELTA_L，超了就不是"抬一档"而是换了一枚颜色。
 */
export function judgeSurfaceLadder(
  colors: Partial<Record<SurfaceProbeKey, Rgba | null>>,
): SurfaceIssue[] {
  const out: SurfaceIssue[] = [];
  const get = (k: SurfaceProbeKey) => colors[k] ?? null;
  const panel = get("--bg-panel");
  const text = get("--text");

  for (const k of RAISE_KEYS) {
    const v = get(k);
    if (!v) continue;
    if (v.a < 0.999) {
      out.push({
        key: k,
        reason: `抬升档不能半透明（实测 alpha=${v.a.toFixed(2)}）：半透明的浮起层会透出下面的内容。要半透明请用 --accent-soft / --scrim`,
        fatal: true,
      });
      continue;
    }
    if (!panel || !text) continue;
    const want = Math.sign(lstarOf(text) - lstarOf(panel));
    const d = lstarOf(v) - lstarOf(panel);
    // 顺序要紧：先判"根本没动"，再判方向。`Δ=0` 的符号是 0，拿它去比方向会把
    // "与面板同色"误判成"方向反了"而撤掉一整枚本来无害的值（第一版就是这么错的，测试抓住了）。
    if (Math.abs(d) < RAISE_MIN_DELTA_L) {
      out.push({ key: k, reason: `与面板几乎同色（ΔL*=${d.toFixed(1)}）：抬升看不出来，等于没抬`, fatal: false });
    } else if (want !== 0 && Math.sign(d) !== want) {
      out.push({
        key: k,
        reason: `方向反了：这套主题的正文色比面板${want > 0 ? "亮" : "暗"}，抬升档却往${d > 0 ? "亮" : "暗"}走（ΔL*=${d.toFixed(1)}）——层级会被读成凹陷`,
        fatal: true,
      });
    } else if (Math.abs(d) > RAISE_MAX_DELTA_L) {
      out.push({
        key: k,
        reason: `抬过头：与面板差 ΔL*=${d.toFixed(1)}，超过 ${RAISE_MAX_DELTA_L}（内置八枚实测 7.9~13.8）——这不是"抬一档"，是把这块底换成了另一个颜色`,
        fatal: true,
      });
    }
  }

  const r1 = get("--raise-1");
  const r2 = get("--raise-2");
  // 一档已经判死时不再报"两档倒序"：那一档马上要被撤回，拿它当参照只会多一条噪音回执
  const raiseFatal = out.some((i) => i.fatal && (i.key === "--raise-1" || i.key === "--raise-2"));
  if (panel && r1 && r2 && !raiseFatal) {
    const d1 = Math.abs(lstarOf(r1) - lstarOf(panel));
    const d2 = Math.abs(lstarOf(r2) - lstarOf(panel));
    if (d2 < d1) {
      out.push({
        key: "--raise-2",
        reason: `二级抬升比一级还弱（|Δ|=${d2.toFixed(1)} < ${d1.toFixed(1)}）：两档阶梯倒置，卡片与弹层会分不出层`,
        fatal: false,
      });
    }
  }

  for (const k of BASE_SURFACE_KEYS) {
    const v = get(k);
    if (v && v.a < 0.999) {
      out.push({
        key: k,
        reason: `基础面是半透明的（alpha=${v.a.toFixed(2)}）：滚动口/工具条这类不画自己的底的区域会透出背板。内置玻璃配方就是这种值，所以只提醒不撤`,
        fatal: false,
      });
    }
  }

  /* 正文色压在四档表面上够不够 readable。**只提醒**：
     门禁对八枚内置主题要求 4.5:1（那条不减），但 AI/插件写的值当场判死就是"变严"，
     需要用户单独点头（红线：任何变严都要先说清）。这里先把话说到位，撤不撤由用户决定。
     `TEXT_CONTRAST_FLOOR` 以下的话术与门禁那条同一口径。 */
  for (const k of BASE_SURFACE_KEYS) {
    const surf = get(k);
    if (!surf || !text) continue;
    if (surf.a < 0.999 || text.a < 0.999) continue; // 半透明谈不上对比度，别拿合成前的数唬人
    const r = contrastRatio(text, surf);
    if (r < TEXT_CONTRAST_WARN) {
      out.push({
        key: k,
        reason: `正文色压在 ${k} 上只有 ${r.toFixed(2)}:1${r < TEXT_CONTRAST_FLOOR ? "（几乎读不出字）" : "（低于门禁给内置主题定的 4.5:1）"}：这一档表面会看不清。已照常生效，要不要撤由用户定`,
        fatal: false,
      });
    }
  }
  const inset = get("--bg-inset");
  const shell = get("--bg-titlebar");
  const canvas = get("--bg");
  if (panel && inset && shell && canvas) {
    const seq: [string, number][] = [
      ["--bg-inset", lstarOf(inset)],
      ["--bg-titlebar", lstarOf(shell)],
      ["--bg", lstarOf(canvas)],
      ["--bg-panel", lstarOf(panel)],
    ];
    const bad: string[] = [];
    // 容差 0.3 L*：内置 dark 的壳档与凹档**故意**几乎同色（`themes/dark.css` 里那条注释
    // 写着"与凹档几乎同色——即页签条与外壳同色，这是 VS Code 暗色的做法，可接受"）。
    // 判"相等即违规"会给暗色用户的每一次 patch 塞一条假提醒。
    for (let i = 1; i < seq.length; i++) {
      if (seq[i][1] < seq[i - 1][1] - LADDER_INVERSION_TOLERANCE_L) bad.push(`${seq[i - 1][0]}>${seq[i][0]}`);
    }
    if (bad.length) {
      out.push({
        key: "--bg-panel",
        reason: `表面阶梯倒置（${bad.join("、")}）：凹<壳<画布<面板 这条不成立，外壳会向前浮而不是向后退。只提醒——整套阶梯是四枚键的事，逐键撤会撤出更怪的中间态`,
        fatal: false,
      });
    }
  }
  return out;
}

/**
 * 画布类组件判断"当前是不是暗色"的**唯一口径**：读 `documentElement.dataset.scheme`，
 * 那是 `applyStyleExts()` 按 S4 三层优先序算完写下的一个投影。
 *
 * 为什么要有这个函数（本批实测第四条账）：以前有三处各写一遍"按主题**名字**判明暗"——
 * `widgetBridge` 的 `theme==="dark"||theme==="navy"||theme==="glaze"`、FrameCanvas 的
 * `dataset.theme!=="light"`、XRayPanel 的 `dataset.theme==="dark"`。同级之后 id 可能是
 * `plg:uartix.theme.ink:main`，按名字判就全判错（暗色插件主题被当成亮色画）。
 * 名字不是明暗，算出来的那个值才是。
 */
export function isDarkScheme(schemeAttr: string | undefined | null): boolean {
  return schemeAttr !== "light";
}
