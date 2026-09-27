/**
 * P110-B5 的守卫：思考档位参数与输出预算阶梯。
 *
 * 这两件事都容易写成"看着接了线、其实没接"，所以每条都配了反面对照（§8-52）：
 * 只测"有档位时会发"而不测"没档位时什么都不多发"，就会允许一个猜出来的默认值溜进去。
 */
import { describe, expect, it, vi } from "vitest";

/**
 * 载入方式有讲究：档案表在求值期会经 `settingsStore.load()` 读 localStorage（node 没有），
 * 而 ESM 的 import 会**跑在 stubGlobal 之前**——所以先桩、再 await import。
 * （静态 import 那种写法我这次先踩过一遍，报的是 localStorage is not defined。）
 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
type AiModelProfile = import("../ai/aiProfileStore").AiModelProfile;
const { thinkingLabels, thinkingParamsFor } = await import("../ai/aiProfileStore");
const { MAX_TOKENS_LADDER, ladderFrom, nextMaxTokens } = await import("./turnError");

const model = (over: Partial<AiModelProfile>): AiModelProfile => ({
  id: "m",
  providerId: "p",
  label: "m",
  model: "m",
  contextTokens: 128_000,
  maxOutputTokens: 8_192,
  thinkingLevels: [],
  defaultThinking: "",
  enabled: true,
  createdAt: 0,
  ...over,
});

describe("thinkingParamsFor：档位名 → 要下发的参数", () => {
  const withLevels = model({
    thinkingLevels: [
      { label: "off", params: {} },
      { label: "low", params: { reasoning_effort: "low" } },
      { label: "high", params: { thinking: { type: "enabled", budget_tokens: 8192 } } },
    ],
    defaultThinking: "low",
  });

  it("选中哪一档就发那一档写死的参数", () => {
    expect(thinkingParamsFor(withLevels, "high")).toEqual({
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
    expect(thinkingParamsFor(withLevels, "low")).toEqual({ reasoning_effort: "low" });
  });

  it("选了个不存在的档位名 ⇒ 退回档案自己的 defaultThinking，而不是猜一档", () => {
    // 真实场景：上一台模型选了 "max"，换到这台只有 off/low/high
    expect(thinkingParamsFor(withLevels, "max")).toEqual({ reasoning_effort: "low" });
  });

  it("没配档位的模型：什么都不多发（不许塞一个我们以为通用的默认值）", () => {
    expect(thinkingParamsFor(model({}), "high")).toBeNull();
    expect(thinkingParamsFor(model({ thinkingLevels: [{ label: "off", params: {} }] }), "off")).toEqual({});
  });

  it("档位名对不上且没有默认档 ⇒ null（不是空对象——空对象会让'开了思考'这件事说不清）", () => {
    expect(thinkingParamsFor(model({ thinkingLevels: [{ label: "a", params: { x: 1 } }] }), "b")).toBeNull();
  });

  it("返回的是副本：改它不许污染档案表", () => {
    const got = thinkingParamsFor(withLevels, "low")!;
    got.reasoning_effort = "被改了";
    expect(withLevels.thinkingLevels[1].params.reasoning_effort).toBe("low");
  });

  it("thinkingLabels：没档位就是空数组 ⇒ 界面上那枚选择器整个不出现", () => {
    expect(thinkingLabels(model({}))).toEqual([]);
    expect(thinkingLabels(withLevels)).toEqual(["off", "low", "high"]);
    expect(thinkingLabels(null)).toEqual([]);
  });
});

describe("输出预算阶梯：从档案的上限往下退，不再拿三个硬编码数试", () => {
  it("4k 的模型不该先撞 16384", () => {
    expect(ladderFrom(4096)).toEqual([4096, 2048, 1024]);
    // 旧行为：起点固定 16384，第一台小模型要失败两次才降到能用的数
    expect(ladderFrom(4096)[0]).toBeLessThan(MAX_TOKENS_LADDER[0]);
  });

  it("逐级下调；已经最低就返回 null（不许原地打转白重试）", () => {
    const cap = 8192;
    const first = nextMaxTokens(cap, true, cap);
    expect(first).toBe(4096);
    expect(nextMaxTokens(2048, true, cap)).toBeNull();
  });

  it("不是截断类失败就不降档（shrink=false）", () => {
    expect(nextMaxTokens(8192, false, 8192)).toBeNull();
  });

  it("拿不到档案时退回旧阶梯，行为与改前一致", () => {
    expect(nextMaxTokens(16384, true)).toBe(8192);
    expect(nextMaxTokens(8192, true)).toBe(4096);
    // 已在最低档 ⇒ null（这条才是"不再白试"的判据；我上一版写成 `4096 < 4096 ? null : 4096`
    // 那种自证自的式子，等于没断言——自己抓回来）
    expect(nextMaxTokens(4096, true)).toBeNull();
  });

  it("上限异常小也不会算出 0 档（0 会让请求体没有 max_tokens 语义）", () => {
    for (const n of ladderFrom(1)) expect(n).toBeGreaterThanOrEqual(256);
  });
});
