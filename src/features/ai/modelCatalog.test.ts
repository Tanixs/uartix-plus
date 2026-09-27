import { describe, expect, it, vi } from "vitest";

/**
 * P111-D：模型清单这一层的守卫。
 * `listModels` 只是 invoke 的薄壳（真逻辑在 Rust 侧，那边有 model_list_tests 钉），
 * 这里钉的是**只有前端能钉**的两件事：猜窗口的边界，以及"不编数"这条纪律。
 */
vi.resetModules();
const calls: unknown[][] = [];
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
// 与 appearanceTools.test / generalTools.test 同一手法：mock 模块本身，不去伪造
// `__TAURI_INTERNALS__`（那是 tauri 的内部协议，跟着它走等于把测试绑在版本细节上）
const invokeMock = vi.fn((cmd: string, args: unknown) => {
  calls.push([cmd, args]);
  return Promise.resolve(["glm-4.5-airx:1m", "glm-4-9b-chat"]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const { guessContextTokens, missingFrom, listModels } = await import("./modelCatalog");

describe("guessContextTokens：只认写在名字里的窗口", () => {
  it("k / m 后缀都能认，取最靠后的那一段", () => {
    expect(guessContextTokens("deepseek-v4-pro-128k")).toBe(128000);
    expect(guessContextTokens("glm-4.5-airx:1m")).toBe(1000000);
    // 尾巴才是窗口：`32b` 不是窗口（没有 k/m），`1m` 是
    expect(guessContextTokens("qwen2.5-coder-32b-instruct-1m")).toBe(1000000);
  });
  it("认不出就返回 null —— 调用方保留档案默认，绝不编一个数填进去", () => {
    expect(guessContextTokens("deepseek-v4-pro")).toBeNull();
    expect(guessContextTokens("llama-3.2-3b")).toBeNull();
    expect(guessContextTokens("gpt-4o-mini-2024-07-18")).toBeNull();
  });
  it("明显不是窗口的数一律不收（下限 1024，上限 32M）", () => {
    expect(guessContextTokens("tiny-512")).toBeNull();
    expect(guessContextTokens("huge-1g")).toBeNull();
    expect(guessContextTokens("edge-64m")).toBeNull();
    expect(guessContextTokens("ok-32m")).toBe(32000000);
  });
  it("后缀紧跟字母的不算；后面还有别的词的照认", () => {
    // 单位在真实模型名里不出现，出现就说明这不是窗口字段
    expect(guessContextTokens("weird-8kb")).toBeNull();
    // `32k-context` 这种把窗口写在中间的写法要认，否则预填等于没有
    expect(guessContextTokens("qwen-32k-context")).toBe(32000);
  });
});

describe("missingFrom：按原样比，不折叠大小写", () => {
  it("只挑档案里真没有的", () => {
    expect(missingFrom(["a", "B", "c"], ["a", "b"])).toEqual(["B", "c"]);
  });
  it("远端空表 ⇒ 没有可导入的，不报错", () => {
    expect(missingFrom([], ["a"])).toEqual([]);
  });
});

it("listModels 把密钥过同一个清洗点（P108 的边界，守卫盯的就是这一条）", async () => {
  const ids = await listModels({
    id: "p1", label: "P", baseUrl: "https://x.test/v1", apiKey: "  sk-secret\n",
    format: "chat", proxy: "", noProxy: "", enabled: true, createdAt: 0,
  } as never);
  expect(ids).toEqual(["glm-4.5-airx:1m", "glm-4-9b-chat"]);
  expect(calls[0][0]).toBe("ai_list_models");
  const args = calls[0][1] as Record<string, unknown>;
  expect(args.apiKey).toBe("sk-secret");
  // 空代理传 null 而不是 ""：宿主那边 `trim().is_empty()` 才认得"没配代理"
  expect(args).toMatchObject({ baseUrl: "https://x.test/v1", proxy: null, noProxy: null });
});
