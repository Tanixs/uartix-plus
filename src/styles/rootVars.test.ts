/**
 * P98-M0：根变量合成器单测。
 *
 * 这批要钉住的是一件真出过的事：插件主题层与 Agent 覆盖层**都往 `documentElement.style`
 * 写同名变量**，各自记自己的键、各自 `removeProperty`。于是 `save_theme_extension`
 * 里 `setEnabled()` 刚把 `--radius-md` 由插件写进去，紧接着 `clearOverlay()` 就把它删了——
 * **存完主题当场失效，要等重启才回来**（用户报的"停用/卸载都撤不回去"的同一条链）。
 * 合成器的合同是"撤掉一层＝重算"，所以本文件的第 2 条是这批的核心。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROOT_LAYER, composeRootVars, dropRootVars, effectiveRootVars, rootVarLayers, setRootVarsChangeCb, submitRootVars } from "./rootVars";

describe("composeRootVars（纯函数）", () => {
  it("层序高的赢，与提交顺序无关", () => {
    const low = { id: "a", order: ROOT_LAYER.pluginTheme, vars: { "--x": "low" } };
    const high = { id: "b", order: ROOT_LAYER.agentOverlay, vars: { "--x": "high" } };
    expect(composeRootVars([low, high]).get("--x")).toBe("high");
    expect(composeRootVars([high, low]).get("--x")).toBe("high"); // 反过来传也一样
  });

  it("同层序时按 id 定序：结果不能随 Map 插入顺序漂移", () => {
    const r1 = composeRootVars([{ id: "z", order: 5, vars: { "--k": "z" } }, { id: "a", order: 5, vars: { "--k": "a" } }]);
    const r2 = composeRootVars([{ id: "a", order: 5, vars: { "--k": "a" } }, { id: "z", order: 5, vars: { "--k": "z" } }]);
    expect(r1.get("--k")).toBe(r2.get("--k"));
  });

  it("不改动入参，也不丢没冲突的键", () => {
    const src = [{ id: "a", order: 1, vars: { "--p": "1", "--q": "2" } }];
    const out = composeRootVars(src);
    expect([...out.keys()].sort()).toEqual(["--p", "--q"]);
    expect(src[0].vars).toEqual({ "--p": "1", "--q": "2" });
  });
});

describe("submitRootVars / dropRootVars（状态与广播）", () => {
  beforeEach(() => {
    dropRootVars("plugin-theme");
    dropRootVars("agent-overlay");
    setRootVarsChangeCb(null);
  });

  /** 本测试跑在 node 环境（无 document）：合成器只更新内部状态，不碰 DOM 也不抛错 */
  it("撤掉高层，低层的同名值必须原样回来——旧实现就是在这里把它抹掉的", () => {
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--radius-md": "6px", "--bg": "#111" });
    submitRootVars("agent-overlay", ROOT_LAYER.agentOverlay, { "--radius-md": "14px" });
    expect(effectiveRootVars()["--radius-md"]).toBe("14px");

    dropRootVars("agent-overlay");
    // 关键断言：不是 ""、不是 undefined，而是插件层那份**没被碰过**的值
    expect(effectiveRootVars()["--radius-md"]).toBe("6px");
    expect(effectiveRootVars()["--bg"]).toBe("#111");
  });

  it("整量替换层内容时，本层不再声明的键退出有效值，但别的层不受影响", () => {
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--a": "p-a", "--b": "p-b" });
    submitRootVars("agent-overlay", ROOT_LAYER.agentOverlay, { "--a": "o-a", "--c": "o-c" });
    expect(effectiveRootVars()).toEqual({ "--a": "o-a", "--b": "p-b", "--c": "o-c" });
    // 覆盖层"缩小到只剩 --a"＝撤掉 --c，不该顺手带走 --b（那是插件层的）
    submitRootVars("agent-overlay", ROOT_LAYER.agentOverlay, { "--a": "o-a" });
    expect(effectiveRootVars()).toEqual({ "--a": "o-a", "--b": "p-b" });
  });

  it("有效值没变就不广播：广播＝真的换装了，而不是「有人调了一下」", () => {
    const cb = vi.fn();
    setRootVarsChangeCb(cb);
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--bg": "#111" });
    expect(cb).toHaveBeenCalledTimes(1);
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--bg": "#111" }); // 同值重提
    expect(cb).toHaveBeenCalledTimes(1);
    dropRootVars("no-such-layer"); // 不存在的层：无事发生
    expect(cb).toHaveBeenCalledTimes(1);
    dropRootVars("plugin-theme");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("rootVarLayers 按优先级升序报出在供值的层（外观来源面板用它）", () => {
    submitRootVars("agent-overlay", ROOT_LAYER.agentOverlay, { "--x": "1" });
    submitRootVars("plugin-theme", ROOT_LAYER.pluginTheme, { "--y": "2", "--z": "3" });
    expect(rootVarLayers()).toEqual([
      { id: "plugin-theme", order: ROOT_LAYER.pluginTheme, count: 2 },
      { id: "agent-overlay", order: ROOT_LAYER.agentOverlay, count: 1 },
    ]);
  });
});
