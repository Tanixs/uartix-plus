/**
 * P97-J0：样式净化器。这组测试是"能力放开之前先有的那道闸"的回归钉——
 * 每一条都断言"越权写法必须被拒 + 拒的原因是哪个"，而不是只看"合法写法能过"。
 */
import { describe, expect, it } from "vitest";
import { STYLE_CAPS, buildStyleText, guardStyleText, sanitizeStyleRules } from "./styleSanitize";

const ok = (): boolean => true; // 测试里把"浏览器解析"注入成恒通过，专测我们的规则层
const rule = (selector: string, decls: Record<string, string>, keyframes?: { name: string; body: string }) =>
  [{ selector, decls, ...(keyframes ? { keyframes } : {}) }];

describe("sanitizeStyleRules", () => {
  it("组件级规则照常通过，并拼出可注入文本", () => {
    const r = sanitizeStyleRules(rule(".p3d-gdlg .fc-btn", { "border-radius": "10px", background: "#1b2430" }), ok);
    expect(r.rejected).toEqual([]);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].css).toContain(".p3d-gdlg .fc-btn{border-radius:10px;background:#1b2430}");
    expect(buildStyleText(r.rules, "style_patch")).toContain("/* style_patch */");
  });

  it("全局选择器一律拒（body{display:none} 能把整个界面关掉）", () => {
    for (const sel of ["body", "html", "*", "#root", ":root", ".ok, body"]) {
      const r = sanitizeStyleRules(rule(sel, { display: "none" }), ok);
      expect(r.rules, sel).toHaveLength(0);
      expect(r.rejected[0]?.reason, sel).toMatch(/global_selector|empty_selector/);
    }
  });

  it("结构性选择器语法拒（:has 全量反选、[style 命中内联、::part 越边界）", () => {
    for (const sel of [".a:has(.b)", "[style]", ".x::part(inner)"]) {
      expect(sanitizeStyleRules(rule(sel, { color: "red" }), ok).rejected[0]?.reason, sel).toBe("banned_selector_syntax");
    }
  });

  it("position:fixed 拒、absolute 放行；z-index 超上限拒", () => {
    expect(sanitizeStyleRules(rule(".a", { position: "fixed" }), ok).rejected[0]?.reason).toBe("banned_position_fixed");
    expect(sanitizeStyleRules(rule(".a", { position: "absolute" }), ok).rules).toHaveLength(1);
    expect(sanitizeStyleRules(rule(".a", { "z-index": "99999" }), ok).rejected[0]?.reason).toBe("z_index_too_high");
    expect(sanitizeStyleRules(rule(".a", { "z-index": "10" }), ok).rules).toHaveLength(1);
  });

  it("值里的外链/脚本/结构字符拒（数据外带与逃逸入口）", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ background: "url(https://evil/x.png)" }, "banned_value:background"],
      [{ background: "red; color: blue" }, "structural_char:background"],
      [{ content: "@import 'x.css'" }, "banned_value:content"],
      [{ "behavior": "url(#default#xyz)" }, "banned_value:behavior"],
    ];
    for (const [decls, want] of cases) {
      expect(sanitizeStyleRules(rule(".a", decls), ok).rejected[0]?.reason, JSON.stringify(decls)).toBe(want);
    }
  });

  it("keyframes 必须 fx- 前缀（防覆盖内置动画名），帧体不许夹 @ 规则", () => {
    expect(sanitizeStyleRules(rule(".a", { animation: "fx-glow 2s" }, { name: "fx-glow", body: "0%{opacity:.4}100%{opacity:1}" }), ok).rules[0].keyframes)
      .toContain("@keyframes fx-glow{");
    expect(sanitizeStyleRules(rule(".a", { animation: "glow 2s" }, { name: "glow", body: "0%{opacity:.4}" }), ok).rejected[0]?.reason)
      .toBe("keyframes_name_must_start_with_fx");
    expect(sanitizeStyleRules(rule(".a", { animation: "fx-a 1s" }, { name: "fx-a", body: "@media print{0%{opacity:0}}" }), ok).rejected[0]?.reason)
      .toBe("nested_at_rule");
  });

  it("逐条退回而不是整批失败：一条越权 + 一条合法 ⇒ 合法的照常生效", () => {
    const r = sanitizeStyleRules([
      { selector: "body", decls: { display: "none" } },
      { selector: ".tb-btn", decls: { "border-radius": "6px" } },
    ], ok);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.index).toBe(0);
    expect(r.rules.map((x) => x.selector)).toEqual([".tb-btn"]);
  });

  it("限额：规则数、字节预算、keyframes 数都如实回 cap（回执要能解释「为什么少了」）", () => {
    const many = Array.from({ length: STYLE_CAPS.maxRules + 5 }, (_, i) => ({ selector: `.c${i}`, decls: { color: "red" } }));
    const r = sanitizeStyleRules(many, ok);
    expect(r.rules).toHaveLength(STYLE_CAPS.maxRules);
    expect(r.rejected.some((x) => x.reason.startsWith("too_many_rules"))).toBe(true);
    expect(r.caps.maxRules).toBe(STYLE_CAPS.maxRules);
    // 单值都在 400 字以内（不被 value_too_long 抢先），但整批超 16 KB ⇒ 必须走字节预算这条退回
    const fat = Array.from({ length: STYLE_CAPS.maxRules }, () => ({
      selector: ".d",
      decls: { "box-shadow": "0 0 9px #abc".repeat(28), "text-shadow": "1px 1px 2px #000".repeat(24) },
    }));
    const r2 = sanitizeStyleRules(fat, ok);
    expect(r2.rules.length).toBeLessThan(fat.length);
    expect(r2.rejected.some((x) => x.reason === "byte_budget_exceeded")).toBe(true);
    expect(r2.rejected.every((x) => x.reason === "byte_budget_exceeded" || x.reason.startsWith("too_many"))).toBe(true);
  });

  it("浏览器解析器说非法 ⇒ 该条退回（我们不自己重写 CSS 语法判断）", () => {
    const r = sanitizeStyleRules([{ selector: ".a", decls: { color: "red" } }], () => false);
    expect(r.rules).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("css_parse_rejected");
  });

  it("入参形状不对要说清（不是静默返回空）", () => {
    expect(sanitizeStyleRules("nope", ok).rejected[0]?.reason).toBe("rules_must_be_array");
    expect(sanitizeStyleRules([{ selector: ".a", decls: {} }], ok).rejected[0]?.reason).toBe("empty_decls");
    expect(sanitizeStyleRules([{ selector: "   ", decls: { color: "red" } }], ok).rejected[0]?.reason).toBe("empty_selector");
  });
});

/**
 * 整段 CSS 文本这条**既有通路**（save_theme_extension 的 css 参数）以前只校验长度。
 * 浏览器解析路径与 node 退化路径必须给出同一批理由前缀，否则就是"测试绿而生产裸奔"。
 */
describe("guardStyleText", () => {
  const check = (css: string) => guardStyleText(css);

  it("合法的组件级 CSS 文本照常放行并报规则数", () => {
    const g = check(".tb-btn{border-radius:6px}\n.p3d-gdlg{padding:8px}");
    expect(g.ok, JSON.stringify(g.problems)).toBe(true);
    expect(g.ruleCount).toBe(2);
  });

  it("body{display:none} 被拒（旧实现能一路装成插件把界面关掉）", () => {
    const g = check("body{display:none}");
    expect(g.ok).toBe(false);
    expect(g.problems.some((p) => p.startsWith("global_selector"))).toBe(true);
  });

  it("position:fixed / z-index 越界 / url() 外带各自有明确理由", () => {
    expect(check(".a{position:fixed}").problems.some((p) => p.startsWith("banned_position_fixed"))).toBe(true);
    expect(check(".a{z-index:99999}").problems.some((p) => p.startsWith("z_index_too_high"))).toBe(true);
    expect(check(".a{background:url(https://evil/x.png)}").problems.some((p) => p.startsWith("banned_value_in"))).toBe(true);
    expect(check("#root{display:none}").problems.some((p) => p.startsWith("global_selector"))).toBe(true);
  });

  it("超长要报预算，不静默截断", () => {
    const g = guardStyleText(`.a{color:${"r".repeat(9000)}}`, 8000);
    expect(g.ok).toBe(false);
    expect(g.problems.some((p) => p.startsWith("css_too_long"))).toBe(true);
  });

  it(":root 只放行「定义新变量」，覆盖白名单 token 或非变量都拒", () => {
    expect(check(":root{--fx-color:#0ff}").ok).toBe(true);
    const g1 = guardStyleText(":root{--accent:#111}", 8000, ["--accent"]);
    expect(g1.problems.some((p) => p.startsWith("root_token_override_use_theme_patch"))).toBe(true);
    expect(check(":root{background:red}").problems.some((p) => p.startsWith("root_rule_must_only_define_custom_properties"))).toBe(true);
    // :root 与越权选择器并列时整条都按越权处理（不能借逗号分段夹带）
    expect(check(":root, body{color:red}").problems.some((p) => p.startsWith("global_selector"))).toBe(true);
  });
});
