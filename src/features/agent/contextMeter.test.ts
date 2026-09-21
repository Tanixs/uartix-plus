/**
 * P98-M4：上下文用量口径单测。
 *
 * 这批补的是"能力存在、出口不存在"：`ContextStat` 七个字段与自动折叠阶梯 P95 就都有了，
 * 但 UI 只有一个没有分母的「上下文 N KB」，也没有手动压缩。所以这里钉两件事：
 * ① 用量读数必须**带分母**且档位阈值单一来源（运行卡与输入区用量条共用 `ctxGauge`）；
 * ② 手动压缩只调小既有预算、有下限、到顶就如实说"不能再压"，不许静默空转。
 */
import { describe, expect, it } from "vitest";
import { CTX_DANGER_RATIO, CTX_WARN_RATIO, REQUEST_SOFT_LIMIT, ctxGauge, fmtKb } from "./context";
import { HISTORY_CHAR_BUDGET, MIN_HISTORY_BUDGET, tightenHistoryBudget } from "./sessionLog";

describe("ctxGauge", () => {
  it("文本必须带分母：光报用了多少，用户判断不了还剩多少", () => {
    const g = ctxGauge(REQUEST_SOFT_LIMIT / 2);
    expect(g.pct).toBe(50);
    expect(g.text).toContain("50%");
    expect(g.text).toContain("/");
    expect(g.text).toContain(fmtKb(REQUEST_SOFT_LIMIT)); // 分母真的出现在文案里
  });

  it("0 字节也是 0%，不是 NaN 或负数", () => {
    const g = ctxGauge(0);
    expect(g).toEqual({ pct: 0, text: expect.stringContaining("0%"), level: "ok" });
  });

  it("超过软顶夹到 100%（进度条不能溢出容器）", () => {
    expect(ctxGauge(REQUEST_SOFT_LIMIT * 3).pct).toBe(100);
  });

  it("warn / danger 阈值只认 context.ts 这一份常量", () => {
    expect(ctxGauge(REQUEST_SOFT_LIMIT * (CTX_WARN_RATIO - 0.05)).level).toBe("ok");
    expect(ctxGauge(REQUEST_SOFT_LIMIT * CTX_WARN_RATIO).level).toBe("warn");
    expect(ctxGauge(REQUEST_SOFT_LIMIT * CTX_DANGER_RATIO).level).toBe("danger");
    expect(CTX_DANGER_RATIO).toBeGreaterThan(CTX_WARN_RATIO);
  });

  it("fmtKb：KB 与 MB 分界不出现 1024 KB 这种读不懂的写法", () => {
    expect(fmtKb(1024)).toBe("1 KB");
    expect(fmtKb(1024 * 1024)).toBe("1.0 MB");
    expect(fmtKb(1024 * 1023)).toBe("1023 KB");
  });
});

describe("tightenHistoryBudget（手动压缩＝调小既有预算，不另写算法）", () => {
  it("一档减半，可连压到下限", () => {
    let b = HISTORY_CHAR_BUDGET;
    const seen = [b];
    for (let i = 0; i < 6; i++) {
      b = tightenHistoryBudget(b);
      seen.push(b);
    }
    expect(seen.slice(0, 3)).toEqual([12000, 6000, 3000]);
    expect(b).toBe(MIN_HISTORY_BUDGET);
    expect(seen.every((x) => x >= MIN_HISTORY_BUDGET)).toBe(true);
  });

  /** 这条是"不许有按了没反应的按钮"的机器保证：到顶时返回原值，UI 据此禁用 */
  it("已到下限再压返回原值 ⇒ 调用方能判断出「这一按无事发生」并提前禁用", () => {
    expect(tightenHistoryBudget(MIN_HISTORY_BUDGET)).toBe(MIN_HISTORY_BUDGET);
    expect(tightenHistoryBudget(MIN_HISTORY_BUDGET - 999)).toBe(MIN_HISTORY_BUDGET);
  });

  it("缺省参数＝从完整预算开始压（调用方不传也能用）", () => {
    expect(tightenHistoryBudget()).toBe(HISTORY_CHAR_BUDGET / 2);
  });

  it("下限必须是正数且明显小于默认预算，否则「压缩」根本没有档位可走", () => {
    expect(MIN_HISTORY_BUDGET).toBeGreaterThan(0);
    expect(MIN_HISTORY_BUDGET * 2).toBeLessThan(HISTORY_CHAR_BUDGET);
  });
});
