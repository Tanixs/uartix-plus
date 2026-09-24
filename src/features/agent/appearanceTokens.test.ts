/**
 * P103 批 1：布局类 token 的**值域**（`appearanceStore.isValidTokenValue` / `patchTokens`）。
 *
 * 为什么单独钉：白名单这批扩了 12 项，模型第一次能改"控件高三档 / 间距 / 行高"。它们落不进
 * 原来那两个格式分支（`--fs-|radius-|dur-` 与 `--ease`），走的是"其余放宽"⇒ 面板头写成
 * `200px` 也会通过。而"AI 能改布局"要能用，前提是**改不崩**。
 *
 * 两个方向都要有（只测一边等于没测，§8-52）：合法值必须过、越界/畸形值必须拒。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPEARANCE_TOKENS, clearOverlay, isValidTokenValue, patchTokens, readAllTokens, readToken } from "./appearanceStore";

describe("P103 · 布局类 token 的值域", () => {
  it("控件高三档：18~40px 放行，越界/无单位/表达式一律拒", () => {
    const cases: [string, boolean][] = [
      ["18px", true],
      ["24px", true],
      ["28px", true],
      ["40px", true],
      ["17px", false],
      ["41px", false],
      ["200px", false],
      ["24", false],
      ["-4px", false],
      ["calc(1px + 1px)", false],
      ["24px;color:red", false],
    ];
    for (const [v, ok] of cases) expect(isValidTokenValue("--ctl-h-2", v), `--ctl-h-2=${v}`).toBe(ok);
  });

  it("间距：0~48px 放行，64px 拒", () => {
    const cases: [string, boolean][] = [
      ["0px", true],
      ["6px", true],
      ["32px", true],
      ["48px", true],
      ["49px", false],
      ["64px", false],
      ["8", false],
    ];
    for (const [v, ok] of cases) expect(isValidTokenValue("--sp-1h", v), `--sp-1h=${v}`).toBe(ok);
  });

  it("行高：无单位 1~2.4 放行，带单位/超界拒", () => {
    const cases: [string, boolean][] = [
      ["1", true],
      ["1.2", true],
      ["1.75", true],
      ["2.4", true],
      ["0.9", false],
      ["2.5", false],
      ["9", false],
      ["26px", false],
    ];
    for (const [v, ok] of cases) expect(isValidTokenValue("--lh-read", v), `--lh-read=${v}`).toBe(ok);
  });

  it("新令牌确实在白名单里（不在白名单 = AI 写了也被静默压住，§8-37② 那族）", () => {
    for (const k of ["--raise-1", "--raise-2", "--line-strong", "--scrim", "--ring", "--ctl-h-1", "--ctl-h-2", "--ctl-h-3", "--sp-0", "--sp-1h", "--sp-6", "--lh-ui", "--lh-read"]) {
      expect(APPEARANCE_TOKENS, `${k} 没进白名单`).toContain(k);
    }
  });

  it("patchTokens 端到端：越界值整批拒绝，且带可读原因", () => {
    const bad = patchTokens({ "--ctl-h-2": "200px" });
    expect(bad.ok).toBe(false);
    expect(String(bad.err)).toContain("invalid_value:--ctl-h-2");
    const good = patchTokens({ "--ctl-h-2": "28px", "--sp-1h": "6px" });
    expect(good.ok).toBe(true);
    expect(good.applied).toEqual(["--ctl-h-2", "--sp-1h"]);
  });
});

/**
 * theme_patch → :root → theme_read 的端到端（代替 CDP 单测位）。
 *
 * 为什么用假 DOM 而不是引 jsdom：这条链只用 `documentElement.style.setProperty/removeProperty`
 * 和 `getComputedStyle().getPropertyValue` 两个面，为它们拉一整份 DOM 实现进依赖，
 * 是把测试的"快"换成"像"。真实浏览器验证留给批 1 视觉验收（CDP）。
 */
describe("P103 · theme_patch/theme_read 端到端（假 DOM）", () => {
  const g = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown };
  const props = new Map<string, string>();
  let savedDoc: unknown;
  let savedGcs: unknown;

  beforeEach(() => {
    props.clear();
    savedDoc = g.document;
    savedGcs = g.getComputedStyle;
    g.document = {
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => void props.set(k, v),
          removeProperty: (k: string) => void props.delete(k),
        },
      },
    };
    g.getComputedStyle = () => ({ getPropertyValue: (k: string) => props.get(k) ?? "" });
    clearOverlay(); // 覆盖层是模块级单例：不先清，上一个用例的值会渗进这一个
  });
  afterEach(() => {
    clearOverlay();
    if (savedDoc === undefined) delete g.document;
    else g.document = savedDoc;
    if (savedGcs === undefined) delete g.getComputedStyle;
    else g.getComputedStyle = savedGcs;
  });

  it("patchTokens 写白名单 token ⇒ :root 与 theme_read 口径同步变化", () => {
    const r = patchTokens({ "--ctl-h-2": "28px", "--ring": "rgba(255 0 0 / .4)" });
    expect(r.ok).toBe(true);
    expect(props.get("--ctl-h-2")).toBe("28px");
    expect(readToken("--ctl-h-2")).toBe("28px");
    expect(readAllTokens().find((t) => t.name === "--ctl-h-2")).toMatchObject({ value: "28px", overridden: true });
    expect(readAllTokens().find((t) => t.name === "--accent")).toMatchObject({ overridden: false });
  });

  it("clearOverlay 后键被 removeProperty（撤层不留尸体，§P98-M0 的结构性保证）", () => {
    patchTokens({ "--ctl-h-2": "28px" });
    expect(props.has("--ctl-h-2")).toBe(true);
    clearOverlay();
    expect(props.has("--ctl-h-2")).toBe(false);
  });
});
