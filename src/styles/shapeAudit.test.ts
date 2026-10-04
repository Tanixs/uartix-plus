/**
 * P151 判定核的回归钉。夹具不是编的：A 是 P146 那枚开关（底色写在 34×18 方角 label 上），
 * B 是工具栏幽灵钮（透明盒带着主题的软投影），C 是滑杆（appearance:auto 下部件规则一行不落地）。
 */
import { describe, expect, it } from "vitest";
import {
  auditInertWidgetRules,
  auditShadowWithoutFace,
  auditSquareBehindRounded,
  partRuleBase,
  type ShapeSample,
} from "./shapeAudit";

const base: ShapeSample = {
  key: "x", box: [34, 18], radius: 0, painted: false, shadow: false, borderVisible: false, child: null,
};

describe("A 方底垫圆身", () => {
  it("P146 那枚开关的形状：方角外壳画了底、圆角轨道重合其上 ⇒ 必须报", () => {
    const s: ShapeSample = {
      ...base, key: "label.set-switch", painted: true, radius: 0,
      child: { radius: 8, painted: true, box: [34, 18] },
    };
    expect(auditSquareBehindRounded([s]).map((i) => i.kind)).toEqual(["square-behind-rounded"]);
  });

  it("修好之后（外壳不画底）不该报", () => {
    const s: ShapeSample = { ...base, painted: false, child: { radius: 9, painted: true, box: [34, 18] } };
    expect(auditSquareBehindRounded([s])).toEqual([]);
  });

  it("两种边界不报：父自己就是圆角；两只盒子尺寸差超过容差（那是父子各画各的）", () => {
    expect(auditSquareBehindRounded([{ ...base, painted: true, radius: 6, child: { radius: 8, painted: true, box: [34, 18] } }])).toEqual([]);
    expect(auditSquareBehindRounded([{ ...base, painted: true, child: { radius: 8, painted: true, box: [60, 40] } }])).toEqual([]);
  });

  /**
   * 设置页那面 `.set-page-mask`：1440×862 的半透明压暗层里套着 radius 8 的页面壳。
   * 形状关系与上面那枚开关一模一样，但它支出来的方角是设计——所以按"半透明 + 盖住大半视口"
   * 判它是遮罩，不写死类名（写死类名的豁免清单就是下一批漂移的温床）。
   */
  it("半透明且盖住大半视口的是遮罩，不算方底垫圆身", () => {
    const scrim: ShapeSample = {
      ...base, key: "div.set-page-mask", box: [1440, 862], painted: true, bgAlpha: 0.34,
      child: { radius: 8, painted: true, box: [1440, 862] },
    };
    expect(auditSquareBehindRounded([scrim], [1440, 900])).toEqual([]);
    // 同尺寸但**不透明**：那就是一张实底的方脸，必须照报（豁免不能被拿来藏真问题）
    expect(auditSquareBehindRounded([{ ...scrim, bgAlpha: 1 }], [1440, 900]).length).toBe(1);
    // 小盒子就算半透明也不豁免（34×18 远够不到视口比例）
    expect(auditSquareBehindRounded([{ ...base, painted: true, bgAlpha: 0.5, child: { radius: 8, painted: true, box: [34, 18] } }], [1440, 900]).length).toBe(1);
    // 没给视口 ⇒ 不启用遮罩豁免（宁可多报一条，也不让"忘了传"变成静默放行）
    expect(auditSquareBehindRounded([scrim]).length).toBe(1);
  });
});

describe("B 无脸投影", () => {
  it("透明盒带影 ⇒ 报（P146 工具栏幽灵钮）", () => {
    const s: ShapeSample = { ...base, key: "tbar .icon-btn", box: [24, 24], shadow: true };
    expect(auditShadowWithoutFace([s]).map((i) => i.kind)).toEqual(["shadow-without-face"]);
  });

  it("有脸有影不报；有描边有影也不报（脸在那儿，影就不是孤立的）", () => {
    expect(auditShadowWithoutFace([{ ...base, shadow: true, painted: true }])).toEqual([]);
    expect(auditShadowWithoutFace([{ ...base, shadow: true, borderVisible: true }])).toEqual([]);
  });
});

describe("partRuleBase：该去问谁的 appearance", () => {
  /** P152 的真实假阳性：把 `[type=range]` 一起剥掉，就会去问一只文本框，探测器从此常报假案 */
  it("留着类型选择器，只剥主题作用域", () => {
    expect(partRuleBase('input[type="range"]::-webkit-slider-thumb')).toBe('input[type="range"]');
    expect(partRuleBase('[data-theme="fluent"] .ctl-slider::-webkit-slider-runnable-track')).toBe(".ctl-slider");
    expect(partRuleBase('.p3d input[type="range"]::-moz-range-thumb')).toBe('.p3d input[type="range"]');
  });

  it("问不出是哪类控件的，返回空串让调用方跳过（宁可不判，也不拿错元素判）", () => {
    expect(partRuleBase("input::-webkit-slider-thumb")).toBe("");
    expect(partRuleBase('select::-webkit-color-swatch').trim()).toBe("");
    expect(partRuleBase('[data-theme="x"]::-moz-range-track')).toBe("");
  });
});

describe("C 空转的部件规则（分母自证）", () => {

  it("appearance:auto 的滑杆上写 ::-webkit-slider-thumb ⇒ 那条规则是死代码", () => {
    const r = auditInertWidgetRules([{ rule: '[data-theme="fluent"] .ctl-slider::-webkit-slider-thumb', appearance: "auto", hits: 3 }]);
    expect(r.issues).toHaveLength(1);
    expect(r.denominator).toBe(1);
    expect(r.blind).toBe(false);
  });

  it("appearance:none 之后同样的规则就是有效声明 ⇒ 不报", () => {
    expect(auditInertWidgetRules([{ rule: "input[type=range]::-webkit-slider-thumb", appearance: "none", hits: 5 }].map((x) => ({ ...x })))).toEqual({
      issues: [], denominator: 1, blind: false,
    });
  });

  /** 这条是 P146 那次假绿的正面教材：取证面上没有该类控件时，报 0 必须算"没在看"，不是"一切正常" */
  it("分母为 0 ⇒ blind:true，调用方不许把它当通过", () => {
    const r = auditInertWidgetRules([{ rule: ".ctl-slider::-webkit-slider-runnable-track", appearance: "auto", hits: 0 }]);
    expect(r.issues).toEqual([]);
    expect(r.blind, "这一面根本没这类控件，探测器无话可说").toBe(true);
  });
});
