/**
 * P131-B1：渲染层审计判定核的单测。
 *
 * 这一层之所以要单独存在（详设 §A9），是因为静态门禁看不见"字压在谁身上"。
 * 所以这里最重要的几条夹具**全部来自实测**，不是编的：
 *  - `#0078d4` 压 Fluent 壳档 = P130 那轮手跑脚本抓到的真故障（3.8:1 一档，静态门全绿）；
 *  - `html.no-motion *` 的特异性 = theme.css:143 那条降级基线的真实形状，
 *    判错方向等于把"用户的减弱动效被主题压住"报成没事。
 */
import { describe, expect, it } from "vitest";
import {
  auditContrast,
  auditHitTargets,
  auditMotionOverride,
  auditOverflow,
  flattenOver,
  HIT_TARGET_MIN_PX,
  needFor,
  NO_MOTION_BASELINE,
  parseRenderColor,
  resolveBackdrop,
  specificityOf,
  summarizeAudit,
} from "./renderAudit";
import type { TextSample } from "./renderAudit";

const c = (hex: string) => parseRenderColor(hex)!;

describe("parseRenderColor：认不了就说认不了", () => {
  it("hex 三/四/六/八位都能读，alpha 归到 0~1", () => {
    expect(parseRenderColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseRenderColor("#005a9e")).toEqual({ r: 0, g: 90, b: 158, a: 1 });
    expect(parseRenderColor("#005a9e80")!.a).toBeCloseTo(0.502, 2);
    expect(parseRenderColor("  #FFF  ")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("计算值两种形态（空格斜杠式 / 逗号式）与百分号 alpha", () => {
    expect(parseRenderColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseRenderColor("rgb(0 90 158 / 0.5)")!.a).toBe(0.5);
    expect(parseRenderColor("rgba(0, 90, 158, 0.25)")).toEqual({ r: 0, g: 90, b: 158, a: 0.25 });
    expect(parseRenderColor("rgb(0% 50% 100%)")).toEqual({ r: 0, g: 128, b: 255, a: 1 });
  });

  it("transparent 是透明黑，currentColor 与垃圾串返回 null（不猜颜色）", () => {
    expect(parseRenderColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseRenderColor("currentColor")).toBeNull();
    expect(parseRenderColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
    expect(parseRenderColor("")).toBeNull();
    expect(parseRenderColor("rgb(1,2)")).toBeNull();
  });
});

describe("背景合成", () => {
  it("半透明面板压到不透明底上，取到的是合成后的值", () => {
    expect(flattenOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })).toEqual({
      r: 128, g: 128, b: 128, a: 1,
    });
  });

  it("一路透明到根：如实回 opaque:false，不硬编白底", () => {
    const r = resolveBackdrop([
      { r: 255, g: 0, b: 0, a: 0.2 },
      { r: 0, g: 0, b: 255, a: 0.3 },
    ]);
    expect(r.opaque).toBe(false);
  });

  it("中间遇到不透明就停（外面那层根本不该参与）", () => {
    const r = resolveBackdrop([
      { r: 255, g: 0, b: 0, a: 0.5 },
      { r: 20, g: 20, b: 20, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    ]);
    expect(r.opaque && r.rgb).toEqual({ r: 20, g: 20, b: 20, a: 1 });
  });
});

describe("对比度审计", () => {
  const sample = (over: Partial<TextSample>): TextSample => ({
    selector: ".x",
    text: "示例文字",
    fontSizePx: 12,
    fontWeight: 400,
    fg: c("#0078d4"),
    backdrop: [c("#edebe9")],
    ...over,
  });

  it("P130 那个真故障：#0078d4 当文字压 Fluent 壳档，静态门全绿而这里判红", () => {
    const { issues, unmeasurable } = auditContrast([sample({})]);
    expect(unmeasurable).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].ratio).toBeGreaterThan(3.5);
    expect(issues[0].ratio).toBeLessThan(4.5);
    expect(issues[0].need).toBe(4.5);
    expect(issues[0].severe, "3.8 是偏弱，不是读不出").toBe(false);
    expect(issues[0].selector).toBe(".x");
  });

  it("换成 P130 最终取的值：同一个底就过了", () => {
    const { issues } = auditContrast([sample({ fg: c("#005a9e") })]);
    expect(issues).toHaveLength(0);
  });

  it("大号字走 3:1 那条线（24px 或 18.66px+700）", () => {
    expect(needFor(24, 400)).toBe(3);
    expect(needFor(18.66, 700)).toBe(3);
    expect(needFor(18.66, 600)).toBe(4.5);
    expect(needFor(12, 700)).toBe(4.5);
    const ratio35 = [sample({ fontSizePx: 26, fg: c("#8a8a8a") })];
    const { issues } = auditContrast(ratio35);
    expect(issues.every((i) => i.need === 3)).toBe(true);
  });

  it("半透明前景要先合成再算，不许拿原始 alpha 去比", () => {
    const a = auditContrast([sample({ fg: { r: 0, g: 120, b: 212, a: 0.05 } })]).issues;
    // 5% 的蓝压 #edebe9：0.05×(0,120,212) + 0.95×(237,235,233) = (225,229,232)
    expect(a[0].fg, "合成后几乎是底本身的颜色，比值应当低到判红").toBe("rgb(225 229 232)");
    expect(a[0].ratio).toBeLessThan(1.3);
    expect(a[0].severe).toBe(true);
  });

  it("采不出来的不静默丢：合不到不透明底 / 前景解析不了，各回一条原因", () => {
    const { issues, unmeasurable } = auditContrast([
      sample({ backdrop: [{ r: 1, g: 2, b: 3, a: 0.1 }] }),
      sample({ selector: ".y", fg: null }),
    ]);
    expect(issues).toHaveLength(0);
    expect(unmeasurable.map((u) => u.reason)).toEqual(["no_opaque_backdrop", "no_foreground"]);
  });

  it("清单按比值从差到好排（最该先看的排最前）", () => {
    const { issues } = auditContrast([
      sample({ selector: ".ok-ish", fg: c("#767676") }),
      sample({ selector: ".worst", fg: { r: 250, g: 250, b: 250, a: 1 } }),
    ]);
    expect(issues.map((i) => i.selector)).toEqual([".worst", ".ok-ish"]);
  });
});

describe("特异性与减弱动效", () => {
  it("宿主基线 `html.no-motion *` 就是 (0,1,1)——这条钉错方向，整判据作废", () => {
    expect(specificityOf("html.no-motion *")).toEqual(NO_MOTION_BASELINE);
    expect(NO_MOTION_BASELINE).toEqual([0, 1, 1]);
  });

  it("常见形态各归各位", () => {
    expect(specificityOf(".btn")).toEqual([0, 1, 0]);
    expect(specificityOf(".dlg .btn")).toEqual([0, 2, 0]);
    expect(specificityOf("#a .b")).toEqual([1, 1, 0]);
    expect(specificityOf(".btn:hover")).toEqual([0, 2, 0]);
    expect(specificityOf(".btn::after")).toEqual([0, 1, 1]);
    expect(specificityOf("[data-x] .a")).toEqual([0, 2, 0]);
    expect(specificityOf("div.box > p")).toEqual([0, 1, 2]);
    expect(specificityOf(".a:has(> .b)")).toEqual([0, 3, 0]);
  });

  it("低于基线的单类规则不算事故；两级类选择器压得住 ⇒ 报", () => {
    expect(auditMotionOverride(".btn{transition:all .2s ease}")).toHaveLength(0);
    const hit = auditMotionOverride(".dlg .btn{transition:transform .2s ease}");
    expect(hit).toHaveLength(1);
    expect(hit[0].selector).toBe(".dlg .btn");
    expect(hit[0].props).toEqual(["transition"]);
  });

  it("!important 直接算赢（它确实赢），animation-* 子属性同样在判据内", () => {
    expect(auditMotionOverride(".a{animation-name: fx-in !important}")).toHaveLength(1);
    const two = auditMotionOverride(".a .b{animation-duration:1s;animation-timing-function:ease}");
    expect(two[0].props.sort()).toEqual(["animation-duration", "animation-timing-function"]);
  });

  it("不碰动效的规则不报；多选择器拆开各判各的", () => {
    expect(auditMotionOverride(".a,.b .c{color:red}")).toHaveLength(0);
    const mixed = auditMotionOverride(".a, .b .c{transition:all .2s}");
    expect(mixed.map((m) => m.selector)).toEqual([".b .c"]);
  });
});

describe("溢出与命中区", () => {
  it("只报越过容差的，按越界量从大到小", () => {
    const r = auditOverflow([
      { selector: ".a", overPx: 3 },
      { selector: ".b", overPx: 40 },
      { selector: ".c", overPx: 2 },
    ]);
    expect(r.map((x) => x.selector)).toEqual([".b", ".a"]);
  });

  it("命中区按 --zoom 折回设备像素再比（24px 是本仓自己的规矩）", () => {
    expect(HIT_TARGET_MIN_PX).toBe(24);
    expect(auditHitTargets([{ selector: ".a", width: 20, height: 20, zoom: 1 }])).toHaveLength(1);
    expect(auditHitTargets([{ selector: ".a", width: 20, height: 20, zoom: 1.25 }])).toHaveLength(0);
    const one = auditHitTargets([{ selector: ".a", width: 30, height: 18, zoom: 1 }])[0];
    expect(one.minSide).toBe(18);
    expect(one.need).toBe(24);
  });

  it("0 尺寸是「没布局」不是「点不着」，别混进来当噪声", () => {
    expect(auditHitTargets([{ selector: ".hidden", width: 0, height: 0, zoom: 1 }])).toHaveLength(0);
  });

  it("坏 zoom（0 / NaN）按 1 处理，不炸也不放过", () => {
    expect(auditHitTargets([{ selector: ".a", width: 10, height: 10, zoom: 0 }])[0].minSide).toBe(10);
    expect(auditHitTargets([{ selector: ".a", width: 10, height: 10, zoom: NaN }])[0].minSide).toBe(10);
  });
});

describe("汇总", () => {
  const empty = {
    sampled: 10,
    contrast: [],
    unmeasurable: [],
    overflow: [],
    hitTargets: [],
    motionOverride: [],
    perf: { styleBytes: 0, rules: 0 },
  };

  it("干净＝blocking:false", () => {
    expect(summarizeAudit(empty).blocking).toBe(false);
  });

  it("任何一类有问题都得出来说话——包括「只有一处对比度偏弱」", () => {
    const { issues } = auditContrast([{ selector: ".x", text: "t", fontSizePx: 12, fontWeight: 400, fg: c("#0078d4"), backdrop: [c("#edebe9")] }]);
    expect(summarizeAudit({ ...empty, contrast: issues }).blocking).toBe(true);
    expect(summarizeAudit({ ...empty, hitTargets: [{ selector: ".b", minSide: 16, need: 24 }] }).blocking).toBe(true);
  });
});
