/**
 * P151 · 形状 artifact 的**判定核**（纯函数，零 DOM）。
 *
 * 为什么单独一层：这三族判据要在 node 里被断言反驳（同 `renderAudit.ts` 的理由——
 * 采样与判定分开，否则阈值藏在采集脚本里，没人能证伪）。采样在 `agent/uiSurface.ts`
 * 与 `.tools/audit-live.mjs`，两边都不许藏判据。
 *
 * 三族都是 P146 用户在流利蓝里肉眼抓到的"控件像图片粘贴，四角有不圆润的阴影"，
 * 当时我用 `.scratch/p146-shape.mjs` 一次性脚本量出来的。这一层把它变成常驻判据。
 */

/** 一只元素及其"重合子元素"的形状事实（重合 = 盒子尺寸差 ≤2px，即圆角外壳与方角底是同一只视觉盒） */
export interface ShapeSample {
  key: string;
  box: [number, number];
  /** 自身四角最大圆角（px） */
  radius: number;
  /** 自己画了脸：底色有 alpha 或有 background-image */
  painted: boolean;
  /** 自己 `background-color` 的不透明度（0~1）；只有 `background-image` 时是 undefined */
  bgAlpha?: number;
  /** 自己有可见 box-shadow */
  shadow: boolean;
  /** 自己有有宽且有色的描边 */
  borderVisible: boolean;
  child?: { radius: number; painted: boolean; box: [number, number] } | null;
}

export interface ShapeIssue {
  kind: "square-behind-rounded" | "shadow-without-face";
  key: string;
  why: string;
}

/** 重合判定容差：2px。比它大就是两只不同的盒子，不是"方底垫圆身"。 */
export const COINCIDENT_TOL_PX = 2;
/** 圆角小于这个数就当它是方角（1px 的圆角肉眼看不出来，抓出来全是噪声） */
export const ROUNDED_MIN_PX = 2;
/**
 * 遮罩判定：底色半透明 **且** 盖住这么大比例的视口 ⇒ 它是遮罩不是脸。
 * 设置页那面 `.set-page-mask`（1440×862、alpha 0.34）里面套着 radius 8px 的 `.set-modal`，
 * 形状关系与 P146 那枚开关一模一样，但它支出来的方角是**设计**（全屏压暗就该是方的）。
 * 这条按形状与不透明度判，不按类名豁免——写死类名的豁免清单就是下一批漂移的温床。
 */
export const SCRIM_MIN_VIEWPORT_RATIO = 0.6;
export const SCRIM_MAX_ALPHA = 0.9;

const coincident = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) <= COINCIDENT_TOL_PX && Math.abs(a[1] - b[1]) <= COINCIDENT_TOL_PX;

/**
 * A · 方底垫圆身：父画了脸且是方角，子画了脸且是圆角，两只盒子重合
 * ⇒ 父的四个直角从子的圆角外面支出来。P146 那枚开关就是这么来的
 * （底色写在了 34×18 的 label 外壳上，胶囊是子 span）。
 */
export function auditSquareBehindRounded(
  samples: readonly ShapeSample[],
  viewport: [number, number] = [0, 0],
): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  const area = viewport[0] > 0 && viewport[1] > 0 ? viewport[0] * viewport[1] : 0;
  for (const s of samples) {
    const c = s.child;
    if (!c || !s.painted || !c.painted) continue;
    if (s.radius >= ROUNDED_MIN_PX) continue;
    if (c.radius < ROUNDED_MIN_PX) continue;
    if (!coincident(s.box, c.box)) continue;
    if (area > 0 && s.bgAlpha !== undefined && s.bgAlpha <= SCRIM_MAX_ALPHA
      && s.box[0] * s.box[1] >= SCRIM_MIN_VIEWPORT_RATIO * area) continue;
    out.push({
      kind: "square-behind-rounded",
      key: s.key,
      why: `方底 radius=${s.radius}px 重合在圆身 radius=${c.radius}px 上（盒 ${Math.round(s.box[0])}×${Math.round(s.box[1])}）`,
    });
  }
  return out;
}

/**
 * B · 无脸投影：元素有 box-shadow，但自己的底色与描边都是透明的
 * ⇒ 屏幕上只剩一只看不见的盒子在投影，四角一圈阴影。
 * 这条不变式在宿主侧的同名版本是"没有脸就没有影"（`hostHooks.test.ts` 末段）。
 */
export function auditShadowWithoutFace(samples: readonly ShapeSample[]): ShapeIssue[] {
  return samples
    .filter((s) => s.shadow && !s.painted && !s.borderVisible)
    .map((s) => ({
      kind: "shadow-without-face" as const,
      key: s.key,
      why: `底色与描边都透明却在投影（盒 ${Math.round(s.box[0])}×${Math.round(s.box[1])}）`,
    }));
}

/** C · 空转的部件规则：作者规则点了原生控件的部件伪元素，而 `appearance` 还是 auto ⇒ 那条规则是死代码 */
export interface PartRuleSample {
  /** 命中的选择器（含部件伪元素） */
  rule: string;
  /** 被限定元素的计算 appearance */
  appearance: string;
  /** 这条规则在页面上命中了几个元素（0 = 这一面没这类控件） */
  hits: number;
}

export interface InertAudit {
  issues: { rule: string; why: string }[];
  /** 分母：扫到了几条部件规则。0 条 = 这台探测器无话可说，**不是**"一切正常" */
  denominator: number;
  blind: boolean;
}

/**
 * C 的判据带**分母自证**：P146 那次它恒报 0，原因是取证面上根本没有 `.ctl-slider`——
 * "没东西可报"和"一条都没有"是两件事（HANDOFF §8 那条）。所以 `denominator === 0` 时
 * 返回 `blind: true`，调用方必须把它当红处理或者换面重采，不许当通过。
 */
export function auditInertWidgetRules(rules: readonly PartRuleSample[], minDenominator = 1): InertAudit {
  const denominator = rules.filter((r) => r.hits > 0).length;
  const issues = rules
    .filter((r) => r.hits > 0 && r.appearance === "auto")
    .map((r) => ({ rule: r.rule, why: "appearance:auto 下 Blink 不采纳部件伪元素的作者声明，这条规则一行都不落地" }));
  return { issues, denominator, blind: denominator < minDenominator };
}
