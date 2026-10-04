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

  /**
   * P131-B2 改口：`:has()` 从"结构性越权"里放出来了。
   * 它做的是"聚焦的对话框里的输入框"这类正常表达，打不到"关掉整个界面"——
   * 那件事是 `body{}` 这类**选择器头**干的，头那一条照禁（上一条测试钉着）。
   * `[style` 与 `::part(` 一条没放：前者能定向命中内联样式，后者越组件边界（dockview 只许公共类名）。
   */
  it("选择器语法：[style 与 ::part 仍拒，:has() 已放行", () => {
    for (const sel of ["[style]", ".x::part(inner)"]) {
      expect(sanitizeStyleRules(rule(sel, { color: "red" }), ok).rejected[0]?.reason, sel).toBe("banned_selector_syntax");
    }
    expect(sanitizeStyleRules(rule(".dlg:focus-within .input", { color: "red" }), ok).rules).toHaveLength(1);
    expect(sanitizeStyleRules(rule(".row:has(.badge)", { color: "red" }), ok).rules).toHaveLength(1);
  });

  /**
   * P131-B2 改口（不是放宽判据，是换一种判法）：`position:fixed` 不再一刀切禁，
   * 改成"必须落在登记过的层槽上"。要防的一直是"盖住撤销入口"，而层槽表里
   * **没有任何合法档高过保护区**（toast 4000 / 引导 5000 都不出槽），所以那条保证比
   * 一刀切更硬：一刀切只挡 fixed，挡不住 `position:absolute` + 巨大数值的同类效果。
   */
  it("层级：局部数字自由，fixed 必须落槽，保护区与未知槽都拒", () => {
    const reason = (decls: Record<string, string>) =>
      sanitizeStyleRules(rule(".a", decls), ok).rejected[0]?.reason;
    expect(reason({ position: "fixed" })).toBe("fixed_needs_layer_slot");
    // 数字 3000 先撞上"超出可引用档"这条（它既没落槽也高出表顶，报哪个都对，但只能报一个）
    expect(reason({ position: "fixed", "z-index": "3000" })).toBe("z_index_too_high");
    expect(reason({ position: "fixed", "z-index": "1500" })).toBe("fixed_needs_layer_slot");
    expect(reason({ position: "fixed", "z-index": "var(--z-toast)" })).toBe("protected_layer:z-toast");
    expect(reason({ position: "fixed", "z-index": "var(--z-foo)" })).toBe("unknown_layer:z-foo");
    expect(sanitizeStyleRules(rule(".a", { position: "fixed", "z-index": "var(--z-menu)" }), ok).rules).toHaveLength(1);
    expect(sanitizeStyleRules(rule(".a", { position: "absolute" }), ok).rules).toHaveLength(1);
    expect(sanitizeStyleRules(rule(".a", { "z-index": "var(--z-float)" }), ok).rules).toHaveLength(1);
    expect(reason({ "z-index": "99999" })).toBe("z_index_too_high");
    expect(sanitizeStyleRules(rule(".a", { "z-index": "10" }), ok).rules).toHaveLength(1);
    // 能重定义槽 = 整张表作废。这条是层槽机制成立的前提，不是附带检查
    expect(reason({ "--z-menu": "99999", "z-index": "var(--z-menu)" })).toBe("layer_slot_is_host_only:--z-menu");
  });

  it("值里的外链/脚本/结构字符拒（数据外带与逃逸入口）", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ background: "url(https://evil/x.png)" }, "url_not_on_asset_channel:background"],
      [{ background: "red; color: blue" }, "structural_char:background"],
      [{ content: "@import 'x.css'" }, "banned_value:content"],
      [{ "behavior": "url(#default#xyz)" }, "banned_property:behavior"],
    ];
    for (const [decls, want] of cases) {
      expect(sanitizeStyleRules(rule(".a", decls), ok).rejected[0]?.reason, JSON.stringify(decls)).toBe(want);
    }
  });

  it("P148：!important 三条入口一律拒（注入层一旦能 important，宿主降级基线与层槽表都作废）", () => {
    // 特异性判据看不见 !important：它不走特异性，所以一条就能压掉 html.no-motion *
    expect(sanitizeStyleRules(rule(".a", { transition: "none !important" }), ok).rejected[0]?.reason).toBe("banned_value:transition");
    expect(sanitizeStyleRules(rule(".a", { "z-index": "9999 !important" }), ok).rejected[0]?.reason).toBe("banned_value:z-index");
    expect(sanitizeStyleRules(rule(".a", { animation: "fx-a 1s" }, { name: "fx-a", body: "0%{opacity:0 !important}" }), ok).rejected[0]?.reason)
      .toBe("banned_in_keyframes");
    // 反向：不带 important 的照常通过（拒的是那一个词，不是这类写法）
    expect(sanitizeStyleRules(rule(".a", { transition: "background-color .2s ease" }), ok).rules).toHaveLength(1);
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

  /** 同上一条改口：整段 CSS 这条通路走的是**同一套**层级判定（两条通路两套规则是本仓的老病） */
  it("fixed 未落槽 / z-index 越界 / url() 外带各自有明确理由", () => {
    expect(check(".a{position:fixed}").problems.some((p) => p.startsWith("fixed_needs_layer_slot"))).toBe(true);
    expect(check(".a{position:fixed;z-index:var(--z-menu)}").ok).toBe(true);
    expect(check(".a{position:fixed;z-index:var(--z-tour)}").problems.some((p) => p.startsWith("protected_layer"))).toBe(true);
    expect(check(".a{z-index:99999}").problems.some((p) => p.startsWith("z_index_too_high"))).toBe(true);
    expect(check(".a{background:url(https://evil/x.png)}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    expect(check("#root{display:none}").problems.some((p) => p.startsWith("global_selector"))).toBe(true);
  });

  /**
   * P131-C 资产通道：`url()` 从"一刀切禁"换成"只认一种形态 + 一条画不出来的写法要拦"。
   * 这条测试的重点不是"放开了什么"，而是**边界精确到哪一格**：
   * 外链、协议相对、file、相对路径、内联 SVG 全部仍然拒，而且各给各的理由。
   */
  it("url() 只认小体积栅格 data:；url 里套 var 这种画不出来的写法也拒", () => {
    // 正确写法：资产变量的值本来就是一整个 url("blob:…")，直接引用，不再套一层 url()
    expect(check(".a{background-image:var(--fx-asset-acrylic-noise)}").ok).toBe(true);
    // 1421 实测：下面这种"看着对"的写法浏览器根本不认（材质从来没贴上去），所以必须明确拒
    expect(check(".a{background:url(var(--fx-asset-acrylic-noise))}").problems.some((p) => p.startsWith("url_var_inside_url_token"))).toBe(true);
    expect(check('.a{background:url("var(--fx-asset-x1)")}').problems.some((p) => p.startsWith("url_var_inside_url_token"))).toBe(true);
    expect(check(".a{background:url(var(--fx-asset-NOPE))}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    expect(check(".a{background:url(var(--accent))}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    // 小体积栅格 data: 放行（400 字符的声明上限在 DOM 通路那侧另有一道，这里测的是形态）
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(check(`.a{background:url("${tinyPng}")}`).ok).toBe(true);
    // 内联 SVG 必须走资产通道（那里的校验器会读内容找脚本面）
    expect(check(".a{background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)}").problems.some((p) => p.startsWith("url_svg_must_go_through_asset_channel"))).toBe(true);
    expect(check(".a{background:url(data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=)}").problems.some((p) => p.startsWith("url_data_form_not_allowed"))).toBe(true);
    expect(check(".a{background:url(//evil/x.png)}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    expect(check(".a{background:url(file:///etc/passwd)}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    expect(check(".a{background:url(/local-asset.png)}").problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    // 括号不配平不许"看不下去就当没有"
    expect(check(".a{background:url(var(--fx-asset-x}").problems.some((p) => p.startsWith("url_paren_unbalanced"))).toBe(true);
    // @keyframes 帧体里同一条判据（两条通路一套规则）：原文形态的 @keyframes 走规则文本那条，
    // 理由串是 url 的形态名；结构化的 keyframes 字段才报 banned_in_keyframes（见 sanitizeStyleRules 那组）
    expect(guardStyleText("@keyframes fx-a{from{background:url(https://evil/x)}}", 8000).problems.some((p) => p.startsWith("url_not_on_asset_channel"))).toBe(true);
    expect(sanitizeStyleRules([{ selector: ".a", decls: { color: "red" }, keyframes: { name: "fx-a", body: "from{background:url(https://evil/x)}" } }], ok).rejected[0]?.reason).toBe("banned_in_keyframes");
    // 属性名那一侧也补上了：`behavior: none` 以前能过（值里没有 url() 就没人管它）
    expect(sanitizeStyleRules(rule(".a", { behavior: "none" }), ok).rejected[0]?.reason).toBe("banned_property:behavior");
  });

  it("超长要报预算，不静默截断", () => {
    const g = guardStyleText(`.a{color:${"r".repeat(9000)}}`, 8000);
    expect(g.ok).toBe(false);
    expect(g.problems.some((p) => p.startsWith("css_too_long"))).toBe(true);
  });

  /**
   * P132-A 装 Fluent 组件层时踩到的两个真故障（都因为"两条通路两套判据"）：
   *  ① `:root` 里写注释、或按惯例给末条加分号 ⇒ 浏览器路径把规则序列化成
   *     `:root { --a: 1; --b: 2; }`，"取 { 之后全部"多带一个 `}` 尾巴，
   *     于是回一个**属性名为空**的理由，作者无从下手；
   *  ② 非 DOM 通路（node 里跑的市场校验）不剥注释 ⇒ 文件开头那段说明性注释
   *     被当成"第一条规则的选择器"，直接 `selector_too_long:/* …` 拒掉一整份合法 CSS。
   * 现在两条路都先剥注释；字节账仍按原样算（注释真的占体积）。
   */
  it(":root 块里写注释不算越权（合法 CSS 不能被判定器冤枉）", () => {
    expect(check(":root{ /* 本包内部旋钮 */ --fx-a: 1px }").ok).toBe(true);
    expect(check(":root{\n  /* 多行\n     说明 */\n  --fx-b: 2px;\n  --fx-c: 3px\n}").ok).toBe(true);
    /**
     * 浏览器路径的真凶：Chrome 把规则序列化成 `:root { --a: 1; --b: 2; }`——
     * **最后一条后面带分号**，于是"取 { 之后全部"会多出一个 `}` 尾巴，
     * 被判成一条属性名为空的声明。插件主题与 style_append 只要按惯例写分号就必踩。
     */
    expect(check(":root{--fx-a: 1px;--fx-b: 2px;}").ok).toBe(true);
    expect(guardStyleText(":root { --fx-a: 1px; --fx-b: 2px; }", 8000, ["--accent"]).ok).toBe(true);
    // 剥注释只影响解析，不影响判据：白名单键藏在注释后面照样抓
    expect(guardStyleText(":root{ /* 说明 */ --accent: #111 }", 8000, ["--accent"]).problems.some((x) => x.startsWith("root_token_override_use_theme_patch"))).toBe(true);
    expect(check(":root{ /* 说明 */ position: fixed }").problems.some((x) => x.startsWith("root_rule_must_only_define_custom_properties"))).toBe(true);
  });

  /** ② 的那一条：文件以注释开头（几乎每份手写 CSS 都这样）不该被当成一条越权选择器 */
  it("整段 CSS 以注释开头：非 DOM 通路也不许把注释当选择器", () => {
    const src = [
      "/* 流利蓝 组件层",
      "   第二行说明",
      "*/",
      ".btn{background:var(--bg-panel)}",
      "/* 另一段 */",
      ".input{border:1px solid var(--border)}",
    ].join("\n");
    const g = check(src);
    expect(g.problems, JSON.stringify(g.problems)).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.ruleCount).toBe(2);
    expect(g.bytes).toBe(src.length);
    // 剥完注释仍要拦得住真越权：注释里藏 body{} 不算，写在规则里的才算
    expect(check(["/* body{display:none} */", ".x{color:red}"].join("\n")).ok).toBe(true);
    expect(check(["/* 说明 */", "body{display:none}"].join("\n")).problems.some((x) => x.startsWith("global_selector"))).toBe(true);
  });

  it(":root 只放行「定义新变量」，覆盖白名单 token 或非变量都拒", () => {
    expect(check(":root{--fx-color:#0ff}").ok).toBe(true);
    const g1 = guardStyleText(":root{--accent:#111}", 8000, ["--accent"]);
    expect(g1.problems.some((p) => p.startsWith("root_token_override_use_theme_patch"))).toBe(true);
    expect(check(":root{background:red}").problems.some((p) => p.startsWith("root_rule_must_only_define_custom_properties"))).toBe(true);
    // :root 与越权选择器并列时整条都按越权处理（不能借逗号分段夹带）
    expect(check(":root, body{color:red}").problems.some((p) => p.startsWith("global_selector"))).toBe(true);
  });

  it("P153-1：声明数上限两条入口同判——但 :root 的旋钮表不套用（那是变量表借了 CSS 的门）", () => {
    const many = Array.from({ length: STYLE_CAPS.maxDeclsPerRule + 1 }, (_, i) => `color: #0${i}${i}`).join("; ");
    const g = guardStyleText(`.a{${many}}`);
    expect(g.problems.some((p) => p.startsWith("too_many_declarations"))).toBe(true);
    const rootTable = `:root{${Array.from({ length: STYLE_CAPS.maxDeclsPerRule + 6 }, (_, i) => `--fb-k${i}: ${i}px`).join("; ")}}`;
    expect(guardStyleText(rootTable).problems, "内置 fluent 那份 46 条旋钮的 :root 块不能被这条判死").toEqual([]);
    // 反向：结构化那条一直就在判，两条现在给同一个答案
    const PROPS = ["color", "background", "border", "margin", "padding", "width", "height", "opacity",
      "display", "position", "top", "left", "right", "bottom", "font", "line-height", "letter-spacing",
      "text-align", "overflow", "cursor", "flex", "grid", "gap", "inset", "visibility"];
    expect(PROPS.length).toBeGreaterThan(STYLE_CAPS.maxDeclsPerRule);
    expect(sanitizeStyleRules(
      [{ selector: ".a", decls: Object.fromEntries(PROPS.map((p) => [p, "1px"])) }],
      ok,
    ).rejected[0]?.reason).toContain("too_many_declarations");
  });

  it("P148：自由文本与 :root 块里的 !important 也拒（:root 那条在值判据之前就 return，别留成漏口）", () => {
    expect(guardStyleText(".a{color:red !important}").problems.some((p) => p.startsWith("banned_value_in"))).toBe(true);
    expect(guardStyleText(":root{--ctl-press:scale(.97) !important}").problems.some((p) => p.startsWith("banned_value_in_root"))).toBe(true);
    // 反向且是 P147 §4 的那条事实：签名槽**不在**白名单里，所以 :root 填槽本来就是合法通路——
    // 禁 important 不该顺手把这条通路也堵掉。
    expect(guardStyleText(":root{--ctl-press:scale(.97)}", 8000, ["--accent", "--bg"]).ok).toBe(true);
  });
});
