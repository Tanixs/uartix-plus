/**
 * P92 D2：Agent 产物插件 id 的单测。
 * 钉死的是"中文名不再退化成残骸 id、不同主题绝不互相覆盖"这一条。
 */
import { describe, expect, it } from "vitest";
import { fnv1a, shortHash, agentPluginId, freeAgentId, isSameAgentArtifact } from "./pluginId";

describe("pluginId", () => {
  it("确定性：同一名字永远同一散列，不同名字不同散列", () => {
    expect(shortHash("AI 助手现代玻璃风")).toBe(shortHash("AI 助手现代玻璃风"));
    expect(shortHash("Glass")).toBe(shortHash("glass ".trim())); // 大小写与首尾空白归一后同名同 id
    expect(shortHash("深海蓝")).not.toBe(shortHash("琉璃紫"));
    expect(fnv1a("")).toBe(fnv1a(""));
  });

  it("产物 id 合规 ASCII 且不再退化成单字母残骸", () => {
    const id = agentPluginId("user.agent.theme", "AI 助手现代玻璃风");
    expect(id).toMatch(/^user\.agent\.theme-[0-9a-z]{1,7}$/);
    expect(id).not.toBe("user.agent.theme-ai"); // 旧 slug 的结果
    // 与 pluginManifest 的 ID_RE 同形（每段 ≤32、小写、点分至少两段）
    expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/);
  });

  it("纯中文名不再全部塌成同一个 theme-theme", () => {
    const ids = new Set(["深海蓝玻璃", "现代玻璃调蓝", "暗色高对比"].map((n) => agentPluginId("user.agent.theme", n)));
    expect(ids.size).toBe(3);
  });

  it("空名有稳定兜底", () => {
    expect(agentPluginId("user.agent.theme", "   ")).toBe("user.agent.theme-unnamed");
  });

  it("撞号找空位：base → base-2 → base-3，绝不返回已占用的 id", () => {
    const taken = new Set(["a.b", "a.b-2"]);
    expect(freeAgentId("a.b", (id) => taken.has(id))).toBe("a.b-3");
    expect(freeAgentId("a.c", (id) => taken.has(id))).toBe("a.c");
  });

  it("「是不是同一份东西再存一次」= id 与 name 同时相同", () => {
    const id = agentPluginId("user.agent.theme", "Glass");
    expect(isSameAgentArtifact({ id, name: "Glass" }, "user.agent.theme", "Glass")).toBe(true);
    expect(isSameAgentArtifact({ id, name: "Glass " }, "user.agent.theme", "Glass")).toBe(true); // 首尾空白不算改名
    // id 撞上但名字不同（哈希撞车/改名前缀巧合）→ 必须另立门户，不能覆盖
    expect(isSameAgentArtifact({ id, name: "别的主题" }, "user.agent.theme", "Glass")).toBe(false);
    expect(isSameAgentArtifact(undefined, "user.agent.theme", "Glass")).toBe(false);
  });
});
