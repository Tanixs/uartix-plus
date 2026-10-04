import type { InertAudit, ShapeIssue } from "./shapeAudit";
/**
 * P131-B1：渲染层审计的**判定核**（纯函数，零 DOM）。
 *
 * 为什么要有这一层（详设 §A9 / R1）：能力面放开之后，注入的 CSS 是 12 道静态门禁的**盲区**——
 * 那些门扫的是 `src/**` 的字节，而主题插件与 AI 临时层是运行时才存在的规则。
 * 静态门看不见"字压在谁身上"，只看得到源码里写死的 hex。P130 那次是手跑脚本抓到的真问题
 * （`#0078d4` 当文字压灰底 3.81:1，静态门全绿），这一层就是把它做成每次都能跑的东西。
 *
 * 分工（这条线画在"纯函数 / 采 DOM"之间，不是随便画的）：
 *  - 本模块只做**判定**：给它数字与颜色，它给结论。所以每条判据都能在 node 里被断言反驳；
 *  - 采样在 `agent/uiSurface.ts`（读活 DOM 的 computed style），那边不许藏任何阈值；
 *  - 对比度比与提醒线**引自 `themeCore`**，不在这里重抄（同一算法的第三份副本等于多一处会漂的地方）。
 */
import { contrastRatio, TEXT_CONTRAST_FLOOR, TEXT_CONTRAST_WARN, type Rgba } from "./themeCore";
import { ALL_LAYERS, NAMEABLE_SLOTS, slotFromZValue } from "./layerSlots";

/* ================= 颜色：把 computed style 的字符串变成可算的数 ================= */

/**
 * 解析**计算后**的颜色串。浏览器给的形态有限，这里只认这几种，认不了返回 null：
 * 返回 null 而不是猜一个值，是这条链全部诚实性的前提——审计报出的每个比值都要能被反驳，
 * 一个"大概是灰"的底色算出来的比值没有这个资格。
 */
export function parseRenderColor(raw: string): Rgba | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === "transparent" || s === "currentcolor") return s === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: Math.round(a * 1000) / 1000,
    };
  }
  // rgb(r g b / a)（空格斜杠式）与 rgba(r, g, b, a)（逗号式）都在这条里
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const body = fn[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    if (body.length < 3) return null;
    const num = (v: string, scale: number): number | null => {
      if (v.endsWith("%")) {
        const p = Number(v.slice(0, -1));
        return Number.isFinite(p) ? (p / 100) * scale : null;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const r = num(body[0], 255);
    const g = num(body[1], 255);
    const b = num(body[2], 255);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (body.length >= 4) {
      const av = body[3].endsWith("%") ? Number(body[3].slice(0, -1)) / 100 : Number(body[3]);
      if (!Number.isFinite(av)) return null;
      a = av;
    }
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Math.min(1, Math.max(0, a)) };
  }
  /**
   * `color(srgb r g b / a)` —— P132-D 补的一形。
   *
   * 为什么必须认：**浏览器把 `color-mix()` 的计算值就序列化成这个形态**（本仓 CSS 里 color-mix 有
   * 上百处，P132-D 又加了 `--accent-text` / `--danger-fill` 两档派生）。不认它的时候，
   * 一面真实存在的深红底会被读成"这层没有背景"，于是采样器继续往外层走，
   * 拿白面板当底去算白字 → 报出 1.00:1 的假故障（实测 `.btn.danger` 就是这条）。
   * 只认 `srgb` 与 `srgb-linear` 两种空间（线性那档按反伽马换回 8bit）；
   * `oklch` / `oklab` / `hsl` 这些**不猜**——算不出的形态照旧回 null，让"采不出"被如实报出去。
   */
  const fn2 = /^color\(\s*(srgb-linear|srgb)\s+([^)]+)\)$/.exec(s);
  if (fn2) {
    const body = fn2[2].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    if (body.length < 3) return null;
    const unit = (v: string): number | null => {
      if (v.endsWith("%")) {
        const p = Number(v.slice(0, -1));
        return Number.isFinite(p) ? p / 100 : null;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const ch = [unit(body[0]), unit(body[1]), unit(body[2])];
    if (ch.some((v) => v === null)) return null;
    const to255 = (v: number): number => {
      const x = Math.min(1, Math.max(0, v));
      if (fn2[1] === "srgb-linear") return (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
      return x * 255;
    };
    let a = 1;
    if (body.length >= 4) {
      const av = body[3].endsWith("%") ? Number(body[3].slice(0, -1)) / 100 : Number(body[3]);
      if (!Number.isFinite(av)) return null;
      a = av;
    }
    return { r: clamp255(to255(ch[0] as number)), g: clamp255(to255(ch[1] as number)), b: clamp255(to255(ch[2] as number)), a: Math.min(1, Math.max(0, a)) };
  }
  return null;
}

const clamp255 = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** 把带 alpha 的前景压到不透明的背景上（sRGB 直接混，与浏览器同源近似，够判 4.5 这条线） */
export function flattenOver(fg: Rgba, bg: Rgba): Rgba {
  const a = Math.min(1, Math.max(0, fg.a));
  return {
    r: clamp255(fg.r * a + bg.r * (1 - a)),
    g: clamp255(fg.g * a + bg.g * (1 - a)),
    b: clamp255(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

/**
 * 从最里层往外把背景合成到**不透明**。
 * 合不到底（一路透明到 html）时返回 `opaque:false` 而不是硬编一个白底：
 * 那种情况下任何比值都是假的，审计要如实说"算不出来"。
 */
export function resolveBackdrop(layers: Rgba[]): { rgb: Rgba; opaque: true } | { opaque: false } {
  let top: Rgba | null = null;
  for (const layer of layers) {
    if (layer.a >= 1) return { rgb: { ...layer, a: 1 }, opaque: true };
    top = top ? flattenOver(layer, top) : { ...layer };
  }
  return { opaque: false };
}

/* ================= 对比度 ================= */

/** 大号字的放宽线（WCAG：≥24px，或 ≥18.66px 且加粗 ⇒ 3:1）。与 4.5 那条同源，不是第二套标准 */
export const TEXT_CONTRAST_LARGE = 3.0;
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;

export function needFor(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= LARGE_TEXT_PX || (fontSizePx >= LARGE_TEXT_BOLD_PX && fontWeight >= 700);
  return large ? TEXT_CONTRAST_LARGE : TEXT_CONTRAST_WARN;
}

/** 一个"看得见字"的采样点：文字色 + 它真正压着的那层底 + 字号字重 */
export interface TextSample {
  /** 人话定位串（类名链），回执里直接给模型当选择器用 */
  selector: string;
  text: string;
  fontSizePx: number;
  fontWeight: number;
  fg: Rgba | null;
  /** 祖先背景，由内到外（含自身），已解析成 Rgba；空数组 = 采不到 */
  backdrop: Rgba[];
}

export interface ContrastIssue {
  selector: string;
  text: string;
  ratio: number;
  need: number;
  /** 计算后的实际前景（合成过 alpha） */
  fg: string;
  bg: string;
  /** 比 2.0 还低：不是"偏弱"，是读不出来 */
  severe: boolean;
}

export interface Unmeasurable {
  selector: string;
  text: string;
  reason: "no_foreground" | "no_opaque_backdrop";
}

const cssRgb = (c: Rgba) => `rgb(${c.r} ${c.g} ${c.b})`;

/** 对比度审计：返回问题清单 + 采不出来的清单（后者不许静默丢弃，回执要说数量与原因） */
export function auditContrast(samples: TextSample[]): {
  issues: ContrastIssue[];
  unmeasurable: Unmeasurable[];
} {
  const issues: ContrastIssue[] = [];
  const unmeasurable: Unmeasurable[] = [];
  for (const s of samples) {
    const back = resolveBackdrop(s.backdrop);
    if (!back.opaque) {
      unmeasurable.push({ selector: s.selector, text: s.text, reason: "no_opaque_backdrop" });
      continue;
    }
    if (!s.fg) {
      unmeasurable.push({ selector: s.selector, text: s.text, reason: "no_foreground" });
      continue;
    }
    const fg = s.fg.a >= 1 ? s.fg : flattenOver(s.fg, back.rgb);
    const ratio = contrastRatio(fg, back.rgb);
    const need = needFor(s.fontSizePx, s.fontWeight);
    if (ratio < need) {
      issues.push({
        selector: s.selector,
        text: s.text,
        ratio: Math.round(ratio * 100) / 100,
        need,
        fg: cssRgb(fg),
        bg: cssRgb(back.rgb),
        severe: ratio < TEXT_CONTRAST_FLOOR,
      });
    }
  }
  // 比值从差到好排，最该先看的排最前
  issues.sort((a, b) => a.ratio - b.ratio);
  return { issues, unmeasurable };
}

/* ================= 溢出与命中区 ================= */

/** 越过父格多少像素才算"画出去了"——与 `dev/overflowAudit.ts` 同一个数，出处在这里 */
export const OVERFLOW_TOLERANCE_PX = 2;
/** 命中区下限：B4 把全应用抬到 ≥24 之后这就是本仓自己的规矩（也与 WCAG 2.2 目标尺寸同数） */
export const HIT_TARGET_MIN_PX = 24;

export interface BoxSample {
  selector: string;
  /** 越界量（px）：孩子右缘 − 自己右缘；<= 容差的不必送进来 */
  overPx: number;
}

export function auditOverflow(samples: BoxSample[], tolerancePx = OVERFLOW_TOLERANCE_PX): BoxSample[] {
  return samples.filter((s) => s.overPx > tolerancePx).sort((a, b) => b.overPx - a.overPx);
}

export interface HitSample {
  selector: string;
  /** 元素自己的盒子（CSS px，未折 --zoom） */
  width: number;
  height: number;
  /** 缩放档：命中区写成 `calc(24px / var(--zoom))`，所以比较前要把测量值折回设备像素 */
  zoom: number;
}

export interface HitIssue {
  selector: string;
  /** 折算到 100% 缩放后的最小边（设备像素口径） */
  minSide: number;
  need: number;
}

export function auditHitTargets(samples: HitSample[], minPx = HIT_TARGET_MIN_PX): HitIssue[] {
  const out: HitIssue[] = [];
  for (const s of samples) {
    const z = Number.isFinite(s.zoom) && s.zoom > 0 ? s.zoom : 1;
    const w = s.width * z;
    const h = s.height * z;
    const side = Math.min(w, h);
    // 0 尺寸多半是"根本没布局"（隐藏态），不是命中区问题，别混进来当噪声
    if (w <= 0 || h <= 0) continue;
    if (side < minPx - 0.5) {
      out.push({ selector: s.selector, minSide: Math.round(side * 10) / 10, need: minPx });
    }
  }
  return out.sort((a, b) => a.minSide - b.minSide);
}

/* ================= 动效降级：主题不许把"减弱动效"压住 ================= */

/**
 * 宿主那条降级基线是 `html.no-motion *`（theme.css:143）。
 * 特异性 (0,1,1)：任何**类以上**的选择器写 transition/animation 都会盖过它 ⇒ 用户在
 * "减少动效"下仍然看到动画。这不是审查，是算术。
 */
export const NO_MOTION_BASELINE: [number, number, number] = [0, 1, 1];

/**
 * CSS 特异性 `[id, 类/属性/伪类, 类型/伪元素]`。
 *
 * 为什么要自己算而不是"看起来差不多"：这条判据的全部价值在于它和浏览器给的是同一个序——
 * `(0,1,1)` 那条基线是 `html.no-motion *`，判错方向等于把"用户的减弱动效被主题压住了"
 * 报成没事，或反过来把正常规则冤枉成事故。
 *
 * 口径：`.cls` / `[attr]` / `:pseudo-class`（含 `:has()`、`:not()` 本身）记中档，
 * `:has(.a)` 里那个 `.a` 也记中档（真实浏览器按参数里最特异的那个算，这样不低估）；
 * `::pseudo-element` 与裸类型名记低档。
 */
export function specificityOf(sel: string): [number, number, number] {
  const s = sel.trim();
  if (!s) return [0, 0, 0];
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
  const ids = count(s, /#[\w-]+/g);
  const classes = count(s, /\.[\w-]+/g);
  const attrs = count(s, /\[[^\]]*\]/g);
  const pseudoEls = count(s, /::[\w-]+/g);
  const pseudoCls = count(s.replace(/::[\w-]+/g, ""), /:(?!:)[\w-]+/g);
  // 类型名：把 id / 类 / 属性 / 伪类（连参数）/ 伪元素都挖掉，剩下的裸词才是类型选择器。
  // `*` 不在此列——通配选择器的特异性是**零**，把它算成 1 会让基线变成 (0,1,2)，整条判据反向。
  const rest = s.replace(/#[\w-]+|\[[^\]]*\]|\.[\w-]+|::?[\w-]+(\([^)]*\))?/g, " ");
  const types = count(rest, /[a-zA-Z][\w-]*/g);
  return [ids, classes + attrs + pseudoCls, types + pseudoEls];
}

const cmpSpec = (a: [number, number, number], b: [number, number, number]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export interface MotionIssue {
  selector: string;
  props: string[];
  specificity: [number, number, number];
}

/**
 * 扫一段 CSS 文本，报出"会压住减弱动效"的规则。
 * 只看 `transition*` / `animation*` 四类声明；`!important` 直接算赢（它确实赢）。
 * 不解析关键帧内容——那属于"有没有动"，不是"降级还在不在"。
 */
export function auditMotionOverride(css: string, baseline: [number, number, number] = NO_MOTION_BASELINE): MotionIssue[] {
  const out: MotionIssue[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    if (!/(^|[;{\s])(transition|animation)(-|\s|:)/i.test(body)) continue;
    const props = [...body.matchAll(/(transition(?:-[\w-]+)?|animation(?:-[\w-]+)?)\s*:/gi)].map((p) => p[1].toLowerCase());
    if (!props.length) continue;
    for (const rawSel of m[1].split(",")) {
      const selector = rawSel.trim().replace(/\s*\/\/.*$/, "");
      if (!selector || selector.startsWith("@")) continue;
      const spec = specificityOf(selector);
      const important = /!important/i.test(body);
      if (important || cmpSpec(spec, baseline) > 0) {
        out.push({ selector, props: [...new Set(props)], specificity: spec });
      }
    }
  }
  return out;
}

/* ================= 层槽：谁能盖住谁 ================= */

/**
 * 宿主对话框遮码所在的档（`.modal-mask` 实测 200）。
 * 注入层里 `position:fixed` + 高于这档 + 铺满视口 = 能把"清除 AI 临时覆盖"那个入口盖住。
 * 这条**不靠禁令**解决：层槽表只保证主题拿不到通知/引导/拖拽那三档，
 * 而 200 以上、2000 以下是合法区，所以这里出证据、由人决定留不留。
 */
export const HOST_DIALOG_Z = 200;

export interface LayerClashIssue {
  selector: string;
  /** 写的是什么：`var(--z-float)` / `1500` */
  zValue: string;
  /** 解析到的数值；未知槽为 null */
  zResolved: number | null;
  reason: "covers_host_dialog" | "protected_layer_in_use" | "unknown_layer_in_use";
}

/** 一条规则里是不是"铺满视口"：inset:0，或四边都钉上，或宽高都是 100% */
function coversViewport(body: string): boolean {
  if (/inset\s*:\s*0\b/i.test(body)) return true;
  const edges = ["top", "right", "bottom", "left"].filter((e) => new RegExp(`(^|[;\\s])${e}\\s*:`, "i").test(body));
  if (edges.length === 4) return true;
  return /width\s*:\s*100(\.0)?%/i.test(body) && /height\s*:\s*100(\.0)?%/i.test(body);
}

/**
 * 扫注入层文本，报出"能盖住宿主对话框"的浮层与用错了的槽。
 * 与净化器**判据不同**是故意的：净化器管"能不能写进去"，这里管"已经贴在屏幕上的东西会不会挡路"
 * （手写的插件包可以绕过写入期检查，而屏幕不会说谎）。
 */
export function auditLayerClash(css: string): LayerClashIssue[] {
  const out: LayerClashIssue[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const selector = m[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    if (!/position\s*:\s*fixed/i.test(body)) continue;
    const z = /z-index\s*:\s*([^;}]+)/i.exec(body);
    const zValue = (z?.[1] ?? "auto").trim();
    const slot = slotFromZValue(zValue);
    if (/^var\(\s*--z-[\w-]+\s*\)$/.test(zValue) && !slot) {
      out.push({ selector, zValue, zResolved: null, reason: "unknown_layer_in_use" });
      continue;
    }
    if (slot && !(slot in NAMEABLE_SLOTS)) {
      out.push({ selector, zValue, zResolved: ALL_LAYERS[slot as keyof typeof ALL_LAYERS] ?? null, reason: "protected_layer_in_use" });
      continue;
    }
    const resolved = slot ? NAMEABLE_SLOTS[slot as keyof typeof NAMEABLE_SLOTS] : Number.parseInt(zValue, 10);
    if (!Number.isFinite(resolved) || resolved <= HOST_DIALOG_Z) continue;
    if (!coversViewport(body)) continue; // 小浮层盖不住入口，报了只是噪声
    out.push({ selector, zValue, zResolved: resolved, reason: "covers_host_dialog" });
  }
  return out;
}

/* ================= 汇总 ================= */

export interface AuditResult {
  sampled: number;
  contrast: ContrastIssue[];
  unmeasurable: Unmeasurable[];
  overflow: BoxSample[];
  hitTargets: HitIssue[];
  motionOverride: MotionIssue[];
  layerClash: LayerClashIssue[];
  /** P151：形状 artifact（方底垫圆身 / 无脸投影）。不是 WCAG 阻断项，但同属"必须说出口"的账 */
  shapes: ShapeIssue[];
  /** P151：点了原生控件部件而 appearance 仍是 auto 的死规则；blind=true 表示这一面没这类控件，探测器无话可说 */
  inertWidgetRules: InertAudit;
  perf: { styleBytes: number; rules: number };
  /**
   * "有问题必须说出口"的标记。**它不是安装拦截位**（详设 A9：能力面全开＝不拦，
   * 证据面全开＝必须说）——`blocking:true` 的意思是回执里要把清单摊开、
   * 模型要把这些条讲给用户听，不是"别装"。
   */
  blocking: boolean;
}

export function summarizeAudit(input: Omit<AuditResult, "blocking">): AuditResult {
  const blocking =
    input.contrast.length > 0 ||
    input.overflow.length > 0 ||
    input.hitTargets.length > 0 ||
    input.motionOverride.length > 0 ||
    input.layerClash.length > 0 ||
    /* P146 用户那句"控件像图片粘贴"就是这一族：形状错了也是问题，不能只报文字读不读得出来 */
    input.shapes.length > 0;
  return { ...input, blocking };
}

/* P151：形状判据的实现住在 shapeAudit（零 DOM、可单测），这里整批转口——
   采集器与 AI 侧只认"判定核"这一扇门，不新增第三个命名空间。 */
export {
  auditInertWidgetRules,
  auditShadowWithoutFace,
  auditSquareBehindRounded,
} from "./shapeAudit";
export type { InertAudit, PartRuleSample, ShapeIssue, ShapeSample } from "./shapeAudit";
