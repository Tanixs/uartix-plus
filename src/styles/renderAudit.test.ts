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
  auditLayerClash,
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

  /**
   * P132-D：`color(srgb r g b / a)` 这一形必须认。
   * 浏览器把 `color-mix()` 的**计算值**就序列化成它——不认，一面真实存在的深红底会被读成
   * "这层没有背景"，采样器继续往外层走拿白面板当底，于是白字压红钮报出 1.00:1 的假故障。
   */
  it("color(srgb …) 与 srgb-linear：换算回 8bit；算不出的色彩空间不猜", () => {
    expect(parseRenderColor("color(srgb 1 1 1)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    // amber 的 --danger-fill 实测计算值（就是那条假故障的当事人）
    expect(parseRenderColor("color(srgb 0.731608 0.200157 0.169098)")).toEqual({ r: 187, g: 51, b: 43, a: 1 });
    expect(parseRenderColor("color(srgb 0 0.35 0.62 / 0.5)")!.a).toBe(0.5);
    expect(parseRenderColor("color(srgb 50% 20% 10%)")).toEqual({ r: 128, g: 51, b: 26, a: 1 });
    // srgb-linear 走反伽马：线性 0.0203 ≈ sRGB 0.15（→ 38.99，取整 39）。
    // 刻意挑不落在 .5 边界上的数：0.21404114 那条正好卡在 127.49/127.50，测的是舍入不是换算。
    expect(parseRenderColor("color(srgb-linear 0.0203 0.0203 0.0203)")).toEqual({ r: 39, g: 39, b: 39, a: 1 });
    expect(parseRenderColor("color(srgb-linear 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    // 这些**不猜**：作者形态与没实现的空间一律 null，让"采不出"被如实报出去
    expect(parseRenderColor("color(oklch 0.7 0.1 230)")).toBeNull();
    expect(parseRenderColor("color(srgb)")).toBeNull();
    expect(parseRenderColor("color(srgb 1 2)")).toBeNull();
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

describe("层槽：谁能盖住谁", () => {
  it("fixed + 铺满视口 + 高于对话框档 → 报 covers_host_dialog", () => {
    const r = auditLayerClash(".veil{position:fixed;inset:0;z-index:var(--z-float)}");
    expect(r).toHaveLength(1);
    expect(r[0].selector).toBe(".veil");
    expect(r[0].zResolved).toBe(500);
    expect(r[0].reason).toBe("covers_host_dialog");
  });

  it("低于对话框档的不报；不铺满视口的也不报（报了只是噪声）", () => {
    expect(auditLayerClash(".tip{position:fixed;inset:auto 12px 40px auto;z-index:var(--z-raised)}")).toHaveLength(0);
    expect(auditLayerClash(".pop{position:fixed;top:10px;left:10px;width:120px;height:60px;z-index:1500}")).toHaveLength(0);
    expect(auditLayerClash(".full{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1500}")).toHaveLength(1);
  });

  it("保护区与未知槽单独报因（写入期被净化器拦过，这里兜手写包那条路）", () => {
    const prot = auditLayerClash(".a{position:fixed;inset:0;z-index:var(--z-toast)}");
    expect(prot[0].reason).toBe("protected_layer_in_use");
    const unk = auditLayerClash(".a{position:fixed;inset:0;z-index:var(--z-nope)}");
    expect(unk[0].reason).toBe("unknown_layer_in_use");
    expect(unk[0].zResolved).toBeNull();
  });

  it("没写 z-index 的 fixed 不报（它按 DOM 序排，判不了层）", () => {
    expect(auditLayerClash(".a{position:fixed;inset:0}")).toHaveLength(0);
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
    layerClash: [],
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

/**
 * P132-C · 采集器与判据的名字不能各改各的。
 *
 * `.tools/audit-live.mjs` 是在页面里按 **URL + 导出名** 调这两个模块的（这样基线跑的才是产品那份判据，
 * 不是第二套）。问题是：CI 没有浏览器，那道门只读基线 JSON——**改个名字不会让任何门变红**，
 * 只会让下一次采集悄悄失败或写出假账。所以这里把"采集器用到的每个名字"钉回导出表上。
 */
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, existsSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, e?: string) => string;
  existsSync: (p: string) => boolean;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as { fileURLToPath: (u: string | URL) => string };
/** 采集器按 `ui.xxx` / `ra.xxx` 调生产模块，也按 `import("/src/…")` 取模块本体 */
const harness = readFileSync(fileURLToPath(new URL("../../.tools/audit-live.mjs", import.meta.url)), "utf8");
const namesOf = (ns: string) =>
  [...new Set([...harness.matchAll(new RegExp("\\b" + ns + "\\.([A-Za-z_]\\w*)", "g"))].map((m) => m[1]))];
const imported = [...harness.matchAll(/import\("\/src\/([^"]+)"\)/g)].map((m) => m[1]);
const exportedFrom = (rel: string) => {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return new Set([...src.matchAll(/export\s+(?:const|function|interface|type)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));
};

describe("P132-C · 审计采集器依赖的导出名", () => {

  it("采集器 import 的那两个模块路径仍然真存在", () => {
    expect(imported.length, "采集器里一个 import 说明符都没抓到＝探针瞎了").toBeGreaterThan(1);
    for (const p of imported) {
      expect(existsSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url))), `模块被移走或改名：/src/${p}`).toBe(true);
    }
  });

  it("ui.* 与 ra.* 用到的每个名字都在生产模块里导出着", () => {
    const ui = exportedFrom("../features/agent/uiSurface.ts");
    const ra = exportedFrom("./renderAudit.ts");
    const uiNames = namesOf("ui");
    const raNames = namesOf("ra");
    // 探针自证：至少钉到几个真名字，不然这条绿了也是空的
    expect(uiNames.length).toBeGreaterThanOrEqual(1);
    expect(raNames.length).toBeGreaterThanOrEqual(3);
    for (const n of uiNames) expect(ui.has(n), `uiSurface 不再导出 ${n}，采集器会拿到 undefined`).toBe(true);
    for (const n of raNames) expect(ra.has(n), `renderAudit 不再导出 ${n}，采集器会拿到 undefined`).toBe(true);
  });

  it("基线文件在，且形状是采集器写出来的那种", () => {
    const b = JSON.parse(readFileSync(fileURLToPath(new URL("../../.tools/audit-baseline.json", import.meta.url)), "utf8"));
    expect(b.version, "形状换了（命中区/溢出从条数改成条目）就要同步改门与这条").toBe(2);
    expect(b.surfaces).toContain("workspace");
    for (const s of ["palette", "menu", "lbx", "ctxmenu", "hint", "model", "speclib", "hovermenu"]) {
      expect(b.surfaces, `那一面不在账上（采集器的 SURFACES 被改小了？）：${s}`).toContain(s);
    }
    const ids = Object.keys(b.themes);
    expect(ids.length).toBeGreaterThanOrEqual(9);
    for (const id of ids) {
      for (const s of b.surfaces) {
        const r = b.themes[id].surfaces[s];
        expect(r, `${id}/${s} 没有记录`).toBeTruthy();
        expect(r.sampled).toBeGreaterThan(0);
        expect(Array.isArray(r.issues)).toBe(true);
        expect(Array.isArray(r.hits), "命中区只记了个数、没记条目＝这一族等于没记账").toBe(true);
        expect(Array.isArray(r.overflow)).toBe(true);
        expect(r.hitMin, "hits 空时 hitMin 必须是 null，非空时必须是条目里的最小值")
          .toBe(r.hits.length ? Math.min(...r.hits.map((h: { minSide: number }) => h.minSide)) : null);
        expect(r.overflowWorst)
          .toBe(r.overflow.length ? Math.max(...r.overflow.map((o: { overPx: number }) => o.overPx)) : null);
      }
    }
    for (const k of ["total", "hitTargets", "overflow"]) {
      expect(typeof b.budget?.[k], `基线没有 budget.${k}（这一族没有上限＝可以无声长回来）`).toBe("number");
    }
  });

  /**
   * P132-F：字段名也要对账。上一版采集器把命中区条目写成 `{ w: h.width, h: h.height }`，
   * 而判据返回的是 `{ selector, minSide, need }`——两个 undefined 在 JSON 落盘时被静默丢掉，
   * `hitMin` 于是恒为 null，账上"有这一族"其实一条都没记。名字对上（上面那条）不代表字段对上。
   */
  const mapFields = (re: RegExp, label: string) => {
    const m = re.exec(harness);
    if (!m) throw new Error(`采集器里找不到 ${label} 那段落盘映射——写法换了请同步改这条探针`);
    return [...m[1].matchAll(/(\w+):\s*(\w+)\.(\w+)/g)].map((x) => ({ out: x[1], field: x[3] }));
  };
  const judgeKeys = (o: object, label: string) => {
    const keys = Object.keys(o);
    expect(keys.length, `${label} 返回的是空对象——探针瞎了`).toBeGreaterThan(0);
    return keys;
  };

  it("采集器写进账本的字段名，就是判据返回的那几个（抄一份就会静默丢字段）", () => {
    const hit = auditHitTargets([{ selector: ".a", width: 10, height: 10, zoom: 1 }])[0];
    const hitKeys = judgeKeys(hit, "auditHitTargets");
    const hitFields = mapFields(/hits:\s*hits\.map\(\(h\)\s*=>\s*\(\{([^)]*)\}\)\)/, "命中区");
    expect(hitFields.length).toBeGreaterThanOrEqual(3);
    for (const f of hitFields) {
      expect(hitKeys, `判据 ${JSON.stringify(hitKeys)} 里没有 ${f.field}`).toContain(f.field);
      expect(f.out, `账本把 ${f.field} 改名成了 ${f.out}——两边必须同名`).toBe(f.field);
    }

    const over = auditOverflow([{ selector: ".a", overPx: 40 }])[0];
    const overKeys = judgeKeys(over, "auditOverflow");
    const overFields = mapFields(/overflow:\s*over\.map\(\(o\)\s*=>\s*\(\{([^)]*)\}\)\)/, "溢出");
    expect(overFields.length).toBeGreaterThanOrEqual(2);
    for (const f of overFields) {
      expect(overKeys, `判据 ${JSON.stringify(overKeys)} 里没有 ${f.field}`).toContain(f.field);
      expect(f.out, `账本把 ${f.field} 改名成了 ${f.out}`).toBe(f.field);
    }

    const iss = auditContrast([
      { selector: ".x", text: "t", fontSizePx: 12, fontWeight: 400, fg: c("#0078d4"), backdrop: [c("#edebe9")] },
    ]).issues[0];
    const issKeys = judgeKeys(iss, "auditContrast");
    const issFields = mapFields(/issues:\s*c\.issues\.map\(\(i\)\s*=>\s*\(\{([^)]*)\}\)\)/, "对比度");
    expect(issFields.length).toBeGreaterThanOrEqual(4);
    for (const f of issFields) {
      expect(issKeys, `判据 ${JSON.stringify(issKeys)} 里没有 ${f.field}`).toContain(f.field);
      expect(f.out, `账本把 ${f.field} 改名成了 ${f.out}`).toBe(f.field);
    }
  });
});
