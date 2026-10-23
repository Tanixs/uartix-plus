/**
 * P174-A10：主题键与"当前在画"的寄存器。
 *
 * 键要能反解：插件被卸载之后要靠它判断"设置里选的那枚还在不在"，判不出来就只能要么
 * 一直画一个不存在的主题、要么把用户的设置清掉——两种都不该。
 */

import { describe, expect, it } from "vitest";
import { getActiveExtTheme, parseThemeKey, setActiveExtTheme, themeKey } from "./activeTheme";

describe("themeKey", () => {
  it("拼出来能反解（插件 id 带点也不影响：只按第一个冒号切）", () => {
    const k = themeKey("uartix.hello", "seaglass");
    expect(k).toBe("plg:uartix.hello:seaglass");
    expect(parseThemeKey(k)).toEqual({ pluginId: "uartix.hello", themeId: "seaglass" });
  });

  it("不是这个前缀 / 缺一段 / 空段 ⇒ null", () => {
    for (const k of ["", "plg", "plg:", "plg:a.b", "plg::x", "plg:a.b:", "uartix.hello:seaglass"]) {
      expect(parseThemeKey(k), k).toBeNull();
    }
  });
});

describe("当前在画的插件主题（寄存器）", () => {
  it("设进去能读出来，清空后为 null", () => {
    setActiveExtTheme({ id: themeKey("a.b", "x"), name: "X", scheme: "dark", css: ":root{--bg:#000}", pluginId: "a.b" });
    expect(getActiveExtTheme()?.name).toBe("X");
    expect(getActiveExtTheme()?.css).toContain("--bg");
    setActiveExtTheme(null);
    expect(getActiveExtTheme()).toBeNull();
  });
});
