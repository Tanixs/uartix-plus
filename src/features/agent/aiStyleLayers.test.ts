/**
 * P98-M1：AI 外观痕迹的聚合出口单测。
 *
 * 钉的是用户这次真正踩到的那件事：**停用/卸载插件撤不掉 AI 的改动**，因为
 * `theme_patch`（token 覆盖层）与 `style_patch`（组件样式层）都不归插件生命周期管。
 * 所以"清除 AI 的全部临时改动"必须：① 两层一起清干净；② **不碰**插件主题层写在
 * 同一个键上的值（那是 M0 合成器的合同，在这里做端到端复核）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROOT_LAYER, dropRootVars, effectiveRootVars, submitRootVars } from "../../styles/rootVars";
import { clearOverlay, patchTokens } from "./appearanceStore";
import { applyLayer, revertAll } from "./styleScratch";
import { aiStyleFootprint, clearAiStyleLayers, subscribeAiStyle } from "./aiStyleLayers";

/** 最小 DOM stub：只给合成器与 styleScratch 用到的那几个口子 */
function stubDom() {
  const inline = new Map<string, string>();
  const style = {
    setProperty: (k: string, v: string) => inline.set(k, v),
    removeProperty: (k: string) => inline.delete(k),
    getPropertyValue: (k: string) => inline.get(k) ?? "",
  };
  vi.stubGlobal("document", {
    documentElement: { style, dataset: {} },
    head: { appendChild: vi.fn() },
    createElement: () => ({ dataset: {}, textContent: "" }),
  });
  return inline;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearOverlay();
  revertAll();
  dropRootVars("plugin-theme");
  dropRootVars("agent-overlay");
});

describe("aiStyleLayers", () => {
  it("两层各记各的账：面板要能分别报出 token 项数与样式层数", () => {
    stubDom();
    expect(aiStyleFootprint().clean).toBe(true);
    patchTokens({ "--radius-m": "12px", "--shadow": "0 2px 8px #000" });
    applyLayer("probe", ".tb-btn{border-radius:12px}");
    const f = aiStyleFootprint();
    expect(f.tokens).toBe(2);
    expect(f.tokenNames.sort()).toEqual(["--radius-m", "--shadow"]);
    expect(f.layers.map((l) => l.name)).toEqual(["probe"]);
    expect(f.clean).toBe(false);
  });

  it("清除 AI 的全部临时改动：两层归零，但插件主题层写在同名键上的值必须原样留着", () => {
    const inline = stubDom();
    // 插件主题层先写 --radius-m（模拟"装了个圆角主题"）
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--radius-m": "6px", "--bg": "#111" });
    patchTokens({ "--radius-m": "14px" });
    applyLayer("a", ".x{color:red}");
    applyLayer("b", ".y{color:blue}");
    expect(effectiveRootVars()["--radius-m"]).toBe("14px"); // AI 层压过插件层

    const r = clearAiStyleLayers();
    expect(r).toEqual({ tokens: 1, layers: 2 });
    expect(aiStyleFootprint().clean).toBe(true);
    // 核心断言：AI 层撤干净了，插件层那份不但还在 DOM 上，而且重新成为有效值
    expect(inline.get("--radius-m")).toBe("6px");
    expect(effectiveRootVars()).toEqual({ "--radius-m": "6px", "--bg": "#111" });
  });

  it("返回的数量是「清掉之前」的数——toast 要说用户刚撤了多少，不是撤完剩多少", () => {
    stubDom();
    patchTokens({ "--accent": "#123456" });
    expect(clearAiStyleLayers()).toEqual({ tokens: 1, layers: 0 });
    expect(clearAiStyleLayers()).toEqual({ tokens: 0, layers: 0 }); // 再点一次如实说"没东西"
  });

  it("订阅能收到两层的变更（面板靠它实时刷新，漏一层就会显示成「AI 没改过」）", () => {
    stubDom();
    let hits = 0;
    const off = subscribeAiStyle(() => hits++);
    patchTokens({ "--accent": "#123456" });
    const afterToken = hits;
    applyLayer("l", ".z{color:red}");
    expect(hits).toBeGreaterThan(afterToken);
    off();
    const settled = hits;
    revertAll();
    expect(hits).toBe(settled); // 退订后不再收
  });
});
