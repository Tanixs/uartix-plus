/**
 * P74 表达式沙箱测试：语法子集、短路、类型协同、三重帽（深度/节点/deadline）。
 * 红线：任何求值失败必须抛错（条件侧转为「不成立+日志」），绝不静默放行。
 */
import { describe, expect, it } from "vitest";
import { ExprError, evalCondExpr, evalExpr, type ExprScope } from "./expr";
import type { EvtCtx } from "./types";

function scope(vars: Record<string, number | string | boolean> = {}, evt: EvtCtx = { kind: "manual" }): ExprScope {
  return { get: (n) => vars[n], evt };
}

describe("expr 字面量与运算", () => {
  it("数字/字符串/布尔字面量", () => {
    expect(evalExpr("42", scope())).toBe(42);
    expect(evalExpr("3.5e2", scope())).toBe(350);
    expect(evalExpr('"abc"', scope())).toBe("abc");
    expect(evalExpr("'x'", scope())).toBe("x");
    expect(evalExpr("true", scope())).toBe(true);
  });

  it("四则与优先级", () => {
    expect(evalExpr("2+3*4", scope())).toBe(14);
    expect(evalExpr("(2+3)*4", scope())).toBe(20);
    expect(evalExpr("10/4", scope())).toBe(2.5);
    expect(evalExpr("10%3", scope())).toBe(1);
    expect(evalExpr("-3+5", scope())).toBe(2);
  });

  it("字符串拼接：任一侧为字符串即拼接", () => {
    expect(evalExpr('"a"+1', scope())).toBe("a1");
    expect(evalExpr('1+1+"!"', scope())).toBe("2!");
  });

  it("比较：数值/字符串/跨类型协同", () => {
    expect(evalExpr("3 > 2", scope())).toBe(true);
    expect(evalExpr('"b" > "a"', scope())).toBe(true);
    expect(evalExpr('"7" == 7', scope())).toBe(true); // 跨类型数值协同
    expect(evalExpr('"7" != 7', scope())).toBe(false);
    expect(evalExpr('"abc" > 2', scope())).toBe(false); // 非 NaN 协同：NaN 比较 → false
  });

  it("逻辑短路：&& || !", () => {
    const s = scope({ n: 0 });
    // 短路：右侧未声明变量不应抛错
    expect(evalExpr("0 && x", s)).toBe(false);
    expect(evalExpr("1 || x", s)).toBe(true);
    expect(evalExpr("!0", s)).toBe(true);
    expect(evalExpr("!!1", s)).toBe(true);
  });

  it("变量查表；未声明抛错", () => {
    expect(evalExpr("n*2", scope({ n: 21 }))).toBe(42);
    expect(() => evalExpr("nope", scope())).toThrow(ExprError);
  });

  it("evt 成员访问（含中文字段）；缺失抛错；根必须是 evt", () => {
    expect(evalExpr("evt.温度 > 50", scope({}, { kind: "frame", 温度: 60 }))).toBe(true);
    expect(evalExpr("evt.old != evt.new", scope({}, { kind: "varChanged", old: 1, new: 2 }))).toBe(true);
    expect(() => evalExpr("evt.nope", scope())).toThrow(ExprError);
    expect(() => evalExpr("foo.bar", scope())).toThrow(ExprError);
  });

  it("布尔与数学混合：条件表达式求值", () => {
    const r = evalCondExpr("evt.value >= 30 && n < 2", scope({ n: 1 }, { kind: "threshold", value: 30 }));
    expect(r.ok).toBe(true);
    const bad = evalCondExpr("missing + 1", scope());
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain("未声明");
  });
});

describe("expr 沙箱红线", () => {
  it("禁止循环/赋值/函数调用语法", () => {
    expect(() => evalExpr("while(1){}", scope())).toThrow(ExprError);
    expect(() => evalExpr("n = 5", scope())).toThrow(ExprError);
    expect(() => evalExpr("eval('1')", scope())).toThrow(ExprError); // 调用语法不存在 → 意外记号
  });

  it("括号深度帽", () => {
    const deep = "(".repeat(200) + "1" + ")".repeat(200);
    expect(() => evalExpr(deep, scope())).toThrow(ExprError);
  });

  it("语法错误定位", () => {
    expect(() => evalExpr("1 +", scope())).toThrow(ExprError);
    expect(() => evalExpr("", scope())).toThrow(ExprError);
    expect(() => evalExpr("'abc", scope())).toThrow(ExprError);
    expect(() => evalExpr("1 @ 2", scope())).toThrow(ExprError);
  });

  it("deadline：超长求值被掐断", () => {
    // 构造超长加法链（10k 节点帽在 deadline 前后都会拦住，二者任一触发即通过）
    const long = Array.from({ length: 20_000 }, (_, i) => (i === 0 ? "0" : "+1")).join("");
    let threw = false;
    try {
      evalExpr(long, scope(), 0); // deadline=0 → 一进求值即超时
    } catch (e) {
      threw = e instanceof ExprError;
    }
    expect(threw).toBe(true);
  });
});

describe("expr 白名单函数（B4b）", () => {
  it("数值函数：abs/floor/ceil/round/min/max/clamp", () => {
    expect(evalExpr("abs(-3.5)", scope())).toBe(3.5);
    expect(evalExpr("floor(1.9)", scope())).toBe(1);
    expect(evalExpr("ceil(1.1)", scope())).toBe(2);
    expect(evalExpr("round(3.14159, 2)", scope())).toBe(3.14);
    expect(evalExpr("round(2.5)", scope())).toBe(3);
    expect(evalExpr("min(3, 1, 2)", scope())).toBe(1);
    expect(evalExpr("max(3, 1, 2)", scope())).toBe(3);
    expect(evalExpr("clamp(n, 0, 100)", scope({ n: 128 }))).toBe(100);
    expect(evalExpr("clamp(n, 0, 100)", scope({ n: -5 }))).toBe(0);
  });

  it("字符串函数：len/fmt，以及与拼接混用", () => {
    expect(evalExpr("len('abc')", scope())).toBe(3);
    expect(evalExpr("fmt(3.14159, 2)", scope())).toBe("3.14");
    expect(evalExpr("fmt(2.0)", scope())).toBe("2");
    expect(evalExpr("'v=' + fmt(n, 1)", scope({ n: 1.25 }))).toBe("v=1.3");
    expect(() => evalExpr("len(123)", scope())).toThrow(ExprError);
  });

  it("if 惰性：只求值被选中的分支", () => {
    // else 分支引用未声明变量——不触发说明确实没求值
    expect(evalExpr("if(n > 0, n, missing)", scope({ n: 1 }))).toBe(1);
    expect(evalExpr("if(n > 0, missing, 9)", scope({ n: -1 }))).toBe(9);
    expect(evalExpr("if(n > 0, 'yes')", scope({ n: -1 }))).toBe(false);
  });

  it("未知函数 / 参数个数 / 非数值参数在语法或求值期报错", () => {
    expect(() => evalExpr("eval('1')", scope())).toThrow(/未知函数/);
    expect(() => evalExpr("fetch('http://x')", scope())).toThrow(/未知函数/);
    expect(() => evalExpr("abs(1, 2)", scope())).toThrow(/参数/);
    expect(() => evalExpr("clamp(1, 2)", scope())).toThrow(/参数/);
    expect(() => evalExpr("abs('abc')", scope())).toThrow(/数值/);
  });

  it("函数组合与嵌套", () => {
    expect(evalExpr("clamp(min(max(n, 0), 10), 0, 5)", scope({ n: 8 }))).toBe(5);
    expect(evalExpr("if(abs(n) > 10, max(n, 0) * 2, round(n))", scope({ n: -20 }))).toBe(0);
  });
});
