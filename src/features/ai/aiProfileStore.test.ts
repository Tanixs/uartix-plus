/**
 * P115-F6 的守卫：停用 active 那一对时，指针必须重排到 activeRef() 的落点。
 *
 * 事故：停用当前模型后行高亮仍 ✓（按钮自述「发送框正指着它」）、发送框 chip 仍显示旧名、
 * 而真发送经 `activeRef()` 静默落到第一个可用——同一件事三方各讲各的故事。
 * 修法是写入时就把指针带到唯一事实上（呼应 setActive 的"不留假状态"注释）。
 * 载入方式同 thinkingParams.test：先桩 localStorage（node 没有），再 await import。
 */
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

const {
  getAiProfiles,
  updateModel,
  updateProvider,
  addModel,
  addProvider,
  activeRef,
} = await import("../ai/aiProfileStore");

// seed = 一家 deepseek（apiKey 为空 ⇒ 在 activeRef 眼里不可用）+ 一个 enabled 模型。
// 先给 seed 家补一把钥匙让它可用，再放第二个模型当落点——否则"有落点"这个前提不成立。
updateProvider("deepseek", { apiKey: "sk-test" });
const second = addModel({ providerId: "deepseek", model: "second-model", label: "second-model" });
if (!second) throw new Error("夹具没建起来：第二个模型不存在，断言会对着空气点头（§8-52①）");

describe("P115-F6 · 停用 active 对时指针重排", () => {
  it("停用当前模型 → activeModelId 落到 activeRef 会选中的那个可用模型", () => {
    const before = getAiProfiles();
    expect(before.activeModelId).not.toBe(second.id);
    updateModel(before.activeModelId, { enabled: false });
    const after = getAiProfiles();
    expect(after.models.find((m) => m.id === before.activeModelId)?.enabled).toBe(false);
    const re = activeRef(after);
    expect(re, "没有可用对了：这条用例的前提就是还有落点").toBeTruthy();
    expect(after.activeModelId, "指针还停在已停用模型上：高亮/chip/实际发送三方讲三个故事").toBe(re!.model.id);
    expect(after.activeModelId).toBe(second.id);
  });

  it("停用的不是 active 模型时，指针不动", () => {
    const before = getAiProfiles();
    const third = addModel({ providerId: "deepseek", model: "third-model", label: "third" });
    updateModel(third!.id, { enabled: false });
    expect(getAiProfiles().activeModelId).toBe(before.activeModelId);
  });

  it("停用 active 所在供应商 → 指针落到别家的可用对", () => {
    const p2 = addProvider({ label: "另家", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" });
    addModel({ providerId: p2.id, model: "p2-model", label: "p2-model" });
    const cur = getAiProfiles();
    updateProvider(cur.activeProviderId, { enabled: false });
    const after = getAiProfiles();
    const re = activeRef(after);
    expect(re, "全部停光时指针原地保留（没有落点可去）——这条前提是有落点").toBeTruthy();
    expect(after.activeProviderId, "指针还留在被停用的供应商里").toBe(re!.provider.id);
    expect(after.activeProviderId).not.toBe(cur.activeProviderId);
  });
});
