/**
 * P174-R7③：待确认目录绑定这张表的判据。
 *
 * 这张表是"插件请、用户批"之间那段路的唯一落点，所以它错了的表现都很阴：
 * 引用不变 ⇒ 确认条不出现（用户点了半天没反应）；同一条请求留了两份 ⇒ 用户批准的是**旧的那次选择**；
 * 面板关了没人清 ⇒ 别的面板上挂着一条来路不明的确认条。三条都在这里钉。
 */

import { describe, expect, it } from "vitest";
import {
  clearRootBindsOf,
  pendingRootBinds,
  requestRootBind,
  subscribeRootBinds,
  takeRootBind,
  type RootBindRequest,
} from "./rootRequests";

function req(over: Partial<RootBindRequest> = {}): RootBindRequest {
  return {
    pluginId: "a.b",
    pluginName: "AB",
    spec: "$WS",
    path: "D:/ws",
    forWrite: true,
    at: 1,
    ...over,
  };
}

/** 每条用例自己清空：这是模块级状态，留着会让后一条测到前一条的残留。 */
function isolated(): void {
  clearRootBindsOf("a.b");
  clearRootBindsOf("c.d");
}

describe("rootRequests（插件请、用户批之间的那段路）", () => {
  it("登记一条就能取到，且引用变了（useSyncExternalStore 认的就是引用）", () => {
    isolated();
    const before = pendingRootBinds();
    requestRootBind(req());
    const after = pendingRootBinds();
    expect(after).toHaveLength(1);
    expect(after).not.toBe(before);
    isolated();
  });

  it("订阅者被通知，退订后不再被通知", () => {
    isolated();
    let hits = 0;
    const off = subscribeRootBinds(() => hits++);
    requestRootBind(req());
    expect(hits).toBe(1);
    off();
    requestRootBind(req({ path: "D:/other" }));
    expect(hits).toBe(1);
    isolated();
  });

  it("同一插件同一条变量只留最新一次选择（批准不能批到旧的那次）", () => {
    isolated();
    requestRootBind(req({ path: "D:/old" }));
    requestRootBind(req({ path: "D:/new" }));
    const list = pendingRootBinds();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe("D:/new");
    isolated();
  });

  it("不同变量、不同插件各留一条（别把它们并成一行）", () => {
    isolated();
    requestRootBind(req({ spec: "$WS" }));
    requestRootBind(req({ spec: "$EXT:deploy", forWrite: false }));
    requestRootBind(req({ pluginId: "c.d", pluginName: "CD" }));
    expect(pendingRootBinds()).toHaveLength(3);
    isolated();
  });

  it("取走 = 消失并返回那条；取不着的返回 null", () => {
    isolated();
    requestRootBind(req());
    expect(takeRootBind("a.b", "$WS")?.path).toBe("D:/ws");
    expect(pendingRootBinds()).toHaveLength(0);
    expect(takeRootBind("a.b", "$WS")).toBeNull();
    isolated();
  });

  it("按插件清空（面板关掉时不留孤儿条）", () => {
    isolated();
    requestRootBind(req({ pluginId: "a.b" }));
    requestRootBind(req({ pluginId: "c.d", pluginName: "CD", spec: "$EXT:x", forWrite: false }));
    clearRootBindsOf("a.b");
    const left = pendingRootBinds();
    expect(left.map((p) => p.pluginId)).toEqual(["c.d"]);
    isolated();
  });
});
