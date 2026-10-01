/**
 * P121-D3/#103 · 「这张卡绑的是谁」那行小字的五种状态。
 *
 * 卡面上只有一行 muted 小字，五种状态却要各说各的实话：没绑的不许装绑了，
 * 谱删了不许继续显示旧名字，参数删了不许说"绑着"。写成纯函数就是为了逐条钉得住。
 *
 * P122-C 把同一套判据反着问了一遍（这块参数被哪几张卡用着），也收在这个文件里：
 * 两个方向必须共用"什么叫做绑着"这一条定义，不然会出现卡面说绑着、组帧台说没绑。
 */
import { describe, expect, it } from "vitest";
import { bindingDetail, bindingLabel, isLinked, revealTargets, type BindingSpec } from "./cardBinding";

const SPEC: BindingSpec = {
  name: "泵机启动",
  params: [{ id: "p1", name: "转速" }],
  fields: [
    { name: "帧头", source: { kind: "const" } },
    { name: "目标转速", source: { kind: "param", paramId: "p1" } },
  ],
};

describe("P121 · bindingLabel", () => {
  it("不是引用式的卡 ⇒ 一个字都不多写", () => {
    expect(bindingLabel({}, SPEC)).toBe("");
    expect(bindingLabel({ paramId: "p1" }, SPEC)).toBe("");
    expect(bindingLabel({}, null)).toBe("");
  });

  it("绑得好好的 ⇒ 谱名与参数名都写出来", () => {
    const s = bindingLabel({ sendTemplateId: "st1", paramId: "p1" }, SPEC);
    expect(s).toContain("泵机启动");
    expect(s).toContain("转速");
  });

  it("谱被删了 ⇒ 说已删除，不许继续显示旧谱名", () => {
    expect(bindingLabel({ sendTemplateId: "gone", paramId: "p1" }, null)).toContain("已删除");
  });

  it("有谱没选参数 ⇒ 说清它其实不灌值（这是配置错了，不是显示错了）", () => {
    expect(bindingLabel({ sendTemplateId: "st1" }, SPEC)).toContain("没选参数");
  });

  it("参数被删 ⇒ 说参数已删除，别说成还绑着", () => {
    const s = bindingLabel({ sendTemplateId: "st1", paramId: "gone" }, SPEC);
    expect(s).toContain("参数已删除");
    expect(s).toContain("泵机启动");
  });

  it("谱改名、参数换名 ⇒ 标签跟着走（卡上存的是 id，不是烤死的名字）", () => {
    const a = bindingLabel({ sendTemplateId: "st1", paramId: "p1" }, SPEC);
    const b = bindingLabel({ sendTemplateId: "st1", paramId: "p1" }, {
      ...SPEC,
      name: "泵机启动 v2",
      params: [{ id: "p1", name: "目标转速" }],
    });
    expect(a).not.toBe(b);
    expect(b).toContain("v2");
    expect(b).toContain("目标转速");
  });
});

/** 悬浮那一句要回答的是"值最终落到哪一帧的哪一块"，包括配错了的那种 */
describe("P121 · bindingDetail", () => {
  it("绑得对 ⇒ 说清落在哪一块", () => {
    const s = bindingDetail({ sendTemplateId: "st1", paramId: "p1" }, SPEC);
    expect(s).toContain("转速");
    expect(s).toContain("目标转速");
  });

  it("参数在谱里没有任何块引用 ⇒ 明说发出去的字节不会变（这是配错了）", () => {
    const orphan: BindingSpec = { name: "泵机启动", params: [{ id: "p9", name: "流量" }], fields: SPEC.fields };
    expect(bindingDetail({ sendTemplateId: "st1", paramId: "p9" }, orphan)).toContain("不会因此改变");
  });

  it("没选参数 / 谱已删 / 参数已删 ⇒ 三种断法各说各的，不许都说成「在绑着」", () => {
    expect(bindingDetail({ sendTemplateId: "st1" }, SPEC)).toContain("没选参数");
    expect(bindingDetail({ sendTemplateId: "st1", paramId: "p1" }, null)).toContain("已删除");
    expect(bindingDetail({ sendTemplateId: "st1", paramId: "zz" }, SPEC)).toContain("没有这个参数");
    expect(bindingDetail({}, SPEC)).toBe("");
  });

  it("多块引用同一个参数 ⇒ 两块都点名，不只报第一块", () => {
    const two: BindingSpec = {
      name: "泵机启动",
      params: [{ id: "p1", name: "转速" }],
      fields: [
        { name: "转速高字节", source: { kind: "param", paramId: "p1" } },
        { name: "转速低字节", source: { kind: "param", paramId: "p1" } },
      ],
    };
    const s = bindingDetail({ sendTemplateId: "st1", paramId: "p1" }, two);
    expect(s).toContain("转速高字节");
    expect(s).toContain("转速低字节");
  });
});

describe("P122-C · revealTargets（一块的值在画布上被谁用着）", () => {
  const PAGES = [
    {
      id: "pg1",
      name: "泵机台",
      cards: [
        { id: "c1", name: "转速", sendTemplateId: "st1", paramId: "p1" },
        { id: "c2", name: "按钮", sendTemplateId: "st1", paramId: "p2" },
        // 惯导预设的卡：managed.paramId 是另一套 id 空间，撞了同一个数也不算绑着
        { id: "c3", name: "被控量", managed: { paramId: "p1" } },
      ],
    },
    {
      id: "pg2",
      name: "炉子",
      cards: [{ id: "c4", name: "转速副本", sendTemplateId: "st1", paramId: "p1" }],
    },
  ];

  it("只认 sendTemplateId + paramId 这一对", () => {
    expect(revealTargets("st1", "p1", PAGES, "pg1").map((h) => h.cardId)).toEqual(["c1", "c4"]);
    expect(revealTargets("st1", "p2", PAGES, "pg1").map((h) => h.cardId)).toEqual(["c2"]);
    expect(revealTargets("st9", "p1", PAGES, "pg1")).toEqual([]);
  });

  it("managed.paramId 相同不算绑定 —— 说成绑着就是骗人", () => {
    expect(revealTargets("st1", "p1", PAGES, "pg1").map((h) => h.cardId)).not.toContain("c3");
  });

  it("在当前页上才算\"能当场闪\"，别的页交给那句\"去那里\"", () => {
    const hits = revealTargets("st1", "p1", PAGES, "pg1");
    expect(hits.find((h) => h.cardId === "c1")!.onActivePage).toBe(true);
    expect(hits.find((h) => h.cardId === "c4")!.onActivePage, "在 pg2 上").toBe(false);
    expect(hits.find((h) => h.cardId === "c4")!.pageName).toBe("炉子");
  });

  it("没给谱或没给参数 ⇒ 空，不猜", () => {
    expect(revealTargets("", "p1", PAGES, "pg1")).toEqual([]);
    expect(revealTargets("st1", "", PAGES, "pg1")).toEqual([]);
  });
});

describe("P122-D2 · isLinked（常驻色的判据与定位用的是同一条定义）", () => {
  const FOCUS = { specId: "st1", paramId: "p1" };

  it("同一张谱 + 同一个参数才算被盯着", () => {
    expect(isLinked({ sendTemplateId: "st1", paramId: "p1" }, FOCUS)).toBe(true);
    expect(isLinked({ sendTemplateId: "st1", paramId: "p2" }, FOCUS)).toBe(false);
    expect(isLinked({ sendTemplateId: "st9", paramId: "p1" }, FOCUS)).toBe(false);
  });

  it("没盯着任何一块 ⇒ 谁都不亮；卡没绑参数也不亮", () => {
    expect(isLinked({ sendTemplateId: "st1", paramId: "p1" }, null)).toBe(false);
    expect(isLinked({}, FOCUS)).toBe(false);
    expect(isLinked({ paramId: "p1" }, FOCUS), "只有参数 id、没有谱 id ⇒ 不是这张谱的那块").toBe(false);
  });

  it("盯着一个没有参数的块 ⇒ 不许把所有没选参数的卡一起点亮", () => {
    expect(isLinked({ sendTemplateId: "st1" }, { specId: "st1", paramId: "" })).toBe(false);
  });
});
