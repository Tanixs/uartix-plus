/**
 * P97-J0：Agent 注入 CSS 的净化器（纯函数，零运行时依赖）。
 *
 * 为什么现在必须有它：`extRuntime.ts:43-63` 早就允许把 `e.css` 文本拼进 `<style data-ai-ext>`，
 * `save_theme_extension` 也收 `css` 参数——但那边**只校验长度**（`appearanceTools.ts:445`），
 * "no global selectors except :root" 只是写在工具描述里的**话术**。一条 `body{display:none}`
 * 就能把整个界面关掉。能力面要放开（I2 组件级样式），**安全闸必须先于能力落地**。
 *
 * 设计取向：**行为式白名单**而不是类名白名单。类名清单一旦写在这里就成了第二份真相
 * （theme.css 一改就漂，正是本仓反复拆的"平行清单"），所以这里只拦"结构性越权"，
 * 而"这条规则到底改到了谁"交给应用层用 `querySelectorAll` 实测并回命数（I2 的 zeroHit 回执）。
 *
 * P131-B2 起，层级判定不再自己写数：那张表（哪些档能引用、哪一档是保护区）只有
 * `styles/layerSlots.ts` 一份，本模块只按它判——两处各写各的 z 数就是两处真相。
 */
import { ALL_LAYERS, MAX_NAMEABLE_Z, NAMEABLE_SLOTS, slotFromZValue } from "../../styles/layerSlots";

/** 单条规则（结构化输入；不接受自由 CSS 文本，否则无法逐条校验/回执/撤销） */
export interface StyleRuleInput {
  selector: string;
  decls: Record<string, string>;
  /** 可选 @keyframes 体（只写花括号内的帧），名字必须 fx- 前缀 */
  keyframes?: { name: string; body: string };
}

export interface StyleReject {
  /** 第几条输入（0 基） */
  index: number;
  selector: string;
  reason: string;
}

export interface SanitizedRule {
  selector: string;
  decls: Record<string, string>;
  keyframes?: string;
  css: string;
}

export interface SanitizeResult {
  rules: SanitizedRule[];
  rejected: StyleReject[];
  bytes: number;
  /** 一次注入的规则数/字符数上限（回执里要如实带出，别让用户以为"没生效"） */
  caps: { maxRules: number; maxBytes: number; maxKeyframes: number };
}

export const STYLE_CAPS = { maxRules: 40, maxBytes: 16_000, maxKeyframes: 6, maxDeclsPerRule: 24 } as const;

/** 越权选择器：能一键关掉/遮蔽整个界面的那些。`:root` 也禁——变量有 `patchTokens` 这个唯一出口，
 *  两处写同一个变量就又回到 P91-D 的"两份真相"。 */
const BANNED_SELECTOR_HEAD = /^(html|body|#root|:root)\b|^\*/i;
/**
 * 选择器里的结构性越权。
 * P131-B2 放开了 `:has()`：它能做的是"聚焦的对话框里的输入框"这类正常表达，
 * 打不到"关掉整个界面"——那件事是 `body{…}` 这类**选择器头**干的，头那一条照禁。
 * 留下的三条各有各的理由：`[style` 能命中内联样式（绕过一切规则的定向打击）、
 * `::part()` 越组件边界（dockview 有"只用公共类名"的规矩）、后两条是老 IE 的脚本入口。
 */
const BANNED_SELECTOR_PATTERNS = [/\[style/i, /::part\(/i, /expression\s*\(/i, /javascript\s*:/i];
/** 值层面的越权：外链数据外带、旧 IE 行为、脚本 */
const BANNED_VALUE_PATTERNS = [/url\s*\(/i, /@import/i, /expression\s*\(/i, /javascript\s*:/i, /behavior\s*:/i, /-moz-binding/i];
/**
 * P131-B2：`position:fixed` 不再一刀切禁——改成"必须落在登记过的层槽上"（见 `checkLayerUse`）。
 * 一刀切的代价是整层正常能力（浮层/遮罩/贴边工具条/通知）被删；而真正要防的是"盖住撤销入口"，
 * 那件事现在由**没有比救援档更高的合法层**来保证。
 */
const MAX_Z_INDEX = MAX_NAMEABLE_Z;
const KEYFRAMES_NAME = /^fx-[a-z0-9-]{1,40}$/;

/**
 * 层级判定（两条通路共用）：返回拒绝理由，通过返回 null。
 *
 * 规则一句话：**局部堆叠自由，全屏层级必须走槽，槽里最高的档也高不过救援入口。**
 *  - `z-index` 数字 ≤ {@link MAX_NAMEABLE_Z} 放行（1~6 那种"谁压过兄弟"不必查表，
 *    而 2000 这一档本身就在菜单层，压不住撤销入口）；
 *  - `var(--z-<已知槽>)` 放行；`var(--z-toast/--z-tour)` 是保护区 → `protected_layer`；
 *    写得出但查无此档的 `var(--z-foo)` → `unknown_layer`（宁可拒也不"就当它是 0"）；
 *  - 数字超过 2000 → `z_index_too_high`（与放开前同一条码，语义从"太高"变成"太高且没落槽"）；
 *  - `position:fixed` 必须配一个可引用的槽：没有槽的 fixed 就是"随便盖住谁"；
 *  - 任何 `--z-*` 声明一律拒：能重定义槽，整张层槽表就作废了。
 */
function checkLayerUse(decls: Record<string, string>): string | null {
  for (const prop of Object.keys(decls)) {
    if (prop.startsWith("--z-")) return `layer_slot_is_host_only:${prop}`;
  }
  const z = decls["z-index"];
  if (z !== undefined) {
    const varName = /^\s*var\(\s*(--[\w-]+)\s*\)\s*$/.exec(z.trim());
    if (varName) {
      const name = varName[1].slice(2);
      if (!(name in ALL_LAYERS)) return `unknown_layer:${name}`;
      if (!(name in NAMEABLE_SLOTS)) return `protected_layer:${name}`;
    } else {
      const n = Number.parseInt(z, 10);
      if (Number.isFinite(n) && n > MAX_Z_INDEX) return "z_index_too_high";
    }
  }
  if (/^\s*fixed\s*$/i.test(decls["position"] ?? "")) {
    const slot = z !== undefined ? slotFromZValue(z) : null;
    if (!slot || !(slot in NAMEABLE_SLOTS)) return "fixed_needs_layer_slot";
  }
  return null;
}

/** 默认用浏览器自己的 CSS 解析器兜底语法（零依赖、不会漏新语法）；测环境里没有时退化为结构检查。 */
function browserCssAccepts(css: string): boolean {
  if (typeof CSSStyleSheet !== "function") return true; // 非 DOM 环境：交给下面的静态检查
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    // replaceSync 对非法规则是"静默丢弃"而不是抛错 ⇒ 用规则数反证
    return sheet.cssRules.length > 0;
  } catch {
    return false;
  }
}

function splitSelectors(selector: string): string[] {
  return selector.split(",").map((s) => s.trim()).filter(Boolean);
}

/** 选择器层判定：返回拒绝理由，通过返回 null */
function checkSelector(sel: string): string | null {
  if (!sel) return "empty_selector";
  if (sel.length > 200) return "selector_too_long";
  const parts = splitSelectors(sel);
  if (!parts.length) return "empty_selector";
  for (const p of parts) {
    if (BANNED_SELECTOR_HEAD.test(p)) return "global_selector";
    for (const re of BANNED_SELECTOR_PATTERNS) if (re.test(p)) return "banned_selector_syntax";
  }
  return null;
}

function checkDecls(decls: Record<string, string>): string | null {
  const keys = Object.keys(decls ?? {});
  if (!keys.length) return "empty_decls";
  if (keys.length > STYLE_CAPS.maxDeclsPerRule) return "too_many_declarations";
  for (const prop of keys) {
    if (!/^[a-z-]+$/.test(prop)) return `bad_property:${prop}`;
    const value = decls[prop];
    if (typeof value !== "string" || !value.trim()) return `empty_value:${prop}`;
    if (value.length > 400) return `value_too_long:${prop}`;
    for (const re of BANNED_VALUE_PATTERNS) if (re.test(value)) return `banned_value:${prop}`;
    if (/[;{}]/.test(value)) return `structural_char:${prop}`;
    if (prop === "z-index") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > MAX_Z_INDEX) return "z_index_too_high";
    }
  }
  return checkLayerUse(decls);
}

function checkKeyframes(kf: { name: string; body: string }): string | null {
  if (!KEYFRAMES_NAME.test(kf.name)) return "keyframes_name_must_start_with_fx";
  if (!kf.body || kf.body.length > 4000) return "keyframes_body_empty_or_long";
  // 帧体里允许 { }，但不许出现嵌套 @ 规则与外链
  for (const re of BANNED_VALUE_PATTERNS) if (re.test(kf.body)) return `banned_in_keyframes`;
  if (/@(import|media|supports)/i.test(kf.body)) return "nested_at_rule";
  return null;
}

/**
 * 入口：**逐条**判定，合法的照常生效、非法的单独退回（不是整批失败）——
 * 整批失败会让模型在一次大改动里因为一条笔误全部重来，白烧一轮。
 */
export function sanitizeStyleRules(
  input: unknown,
  accepts: (css: string) => boolean = browserCssAccepts,
): SanitizeResult {
  const rejected: StyleReject[] = [];
  const rules: SanitizedRule[] = [];
  const caps = STYLE_CAPS;
  const list = Array.isArray(input) ? input : null;
  if (!list) {
    return { rules, rejected: [{ index: 0, selector: "", reason: "rules_must_be_array" }], bytes: 0, caps };
  }
  if (list.length > caps.maxRules) {
    rejected.push({ index: caps.maxRules, selector: "", reason: `too_many_rules(max=${caps.maxRules})` });
  }
  let bytes = 0;
  let kfCount = 0;
  list.slice(0, caps.maxRules).forEach((raw, index) => {
    const r = (raw ?? {}) as Partial<StyleRuleInput>;
    const sel = typeof r.selector === "string" ? r.selector.trim() : "";
    const fail = (reason: string) => rejected.push({ index, selector: sel, reason });
    const selErr = checkSelector(sel);
    if (selErr) return fail(selErr);
    const declErr = checkDecls((r.decls ?? {}) as Record<string, string>);
    if (declErr) return fail(declErr);
    let kfBlock = "";
    if (r.keyframes) {
      if (kfCount >= caps.maxKeyframes) return fail("too_many_keyframes");
      const kErr = checkKeyframes(r.keyframes);
      if (kErr) return fail(kErr);
      kfCount++;
      kfBlock = `@keyframes ${r.keyframes.name}{${r.keyframes.body}}`;
    }
    const declCss = Object.entries(r.decls as Record<string, string>)
      .map(([p, v]) => `${p}:${v.trim()}`)
      .join(";");
    const css = `${sel}{${declCss}}`;
    if (!accepts(kfBlock ? `${kfBlock}${css}` : css)) return fail("css_parse_rejected");
    const full = kfBlock ? `${kfBlock}\n${css}` : css;
    if (bytes + full.length > caps.maxBytes) return fail("byte_budget_exceeded");
    bytes += full.length;
    rules.push({ selector: sel, decls: r.decls as Record<string, string>, ...(kfBlock ? { keyframes: kfBlock } : {}), css: full });
  });
  return { rules, rejected, bytes, caps };
}

/** 把通过净化后的规则集拼成一次性注入的样式文本（**单次**写 <style>，避免逐条触发样式重算） */
export function buildStyleText(rules: SanitizedRule[], label: string): string {
  return rules.map((r) => `/* ${label} */\n${r.css}`).join("\n\n");
}

export interface TextGuard {
  ok: boolean;
  problems: string[];
  bytes: number;
  ruleCount: number;
}

/** 逐条过同一套判定（选择器头 + 结构语法 + 值层面），返回问题清单 */
function checkPair(selector: string, cssText: string, push: (p: string) => void, reservedVars: string[]): void {
  const parts = splitSelectors(selector);
  /**
   * `:root` 特例：主题确实要定义新的自定义属性（`--fx-color` 这类配方旋钮），
   * 但**白名单 token 只能走 `theme_patch`**——两处写同一个变量就又回到 P91-D 的"两份真相"。
   * 所以这里放行"整条规则只声明 `--*` 且不碰白名单"的 `:root`，其余照拒。
   */
  if (parts.length && parts.every((p) => /^:root$/i.test(p))) {
    const body = cssText.slice(cssText.indexOf("{") + 1);
    const decls = body.split(";").map((d) => d.trim()).filter(Boolean);
    if (!decls.length) push("root_rule_must_only_define_custom_properties");
    for (const d of decls) {
      const prop = d.slice(0, d.indexOf(":")).trim();
      if (!prop.startsWith("--")) push(`root_rule_must_only_define_custom_properties:${prop}`);
      else if (prop.startsWith("--z-")) push(`layer_slot_is_host_only:${prop}`);
      else if (reservedVars.includes(prop)) push(`root_token_override_use_theme_patch:${prop}`);
    }
    return;
  }
  const selErr = checkSelector(selector);
  if (selErr) push(`${selErr}:${selector.slice(0, 60)}`);
  for (const re of BANNED_VALUE_PATTERNS) if (re.test(cssText)) push(`banned_value_in:${selector.slice(0, 40)}`);
  if (/^@/.test(selector.trim())) return; // @keyframes / @media 交给各自的分支，这里不套层级判定
  const layer = checkLayerUse(declsFromCss(cssText));
  if (layer) push(`${layer}:${selector.slice(0, 40)}`);
}

/** 从一条规则的 cssText 里取出声明表（`position:fixed` 这类判定要看整条，不能逐条判） */
function declsFromCss(cssText: string): Record<string, string> {
  const open = cssText.indexOf("{");
  const close = cssText.lastIndexOf("}");
  if (open < 0 || close <= open) return {};
  const out: Record<string, string> = {};
  for (const decl of cssText.slice(open + 1, close).split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

/**
 * 给"整段 CSS 文本"这条**既有通路**兜底（`save_theme_extension({css})` 以前只校验长度）。
 * 优先让浏览器解析出规则再逐条判定；非 DOM 环境（vitest）退化为结构扫描——两条路都必须能拦下
 * `body{display:none}`，否则"测试绿而生产裸奔"。
 * `reservedVars` 由调用方传入白名单 token（本模块保持零依赖，不 import appearanceStore）。
 */
export function guardStyleText(css: string, maxBytes = 8000, reservedVars: string[] = []): TextGuard {
  const problems: string[] = [];
  const bytes = css.length;
  if (bytes > maxBytes) problems.push(`css_too_long(max=${maxBytes})`);
  let ruleCount = 0;
  if (typeof CSSStyleSheet === "function") {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      ruleCount = sheet.cssRules.length;
      if (!ruleCount) problems.push("no_parsable_rules");
      for (let i = 0; i < sheet.cssRules.length; i++) {
        const r = sheet.cssRules[i] as CSSStyleRule;
        const sel = typeof r.selectorText === "string" ? r.selectorText : "";
        const text = typeof r.cssText === "string" ? r.cssText : "";
        if (r.type === CSSRule.KEYFRAMES_RULE) {
          const name = (r as unknown as { name?: string }).name ?? "";
          if (!KEYFRAMES_NAME.test(name)) problems.push(`keyframes_name_must_start_with_fx:${name}`);
          continue;
        }
        if (!sel) continue;
        checkPair(sel, text, (p) => problems.push(p), reservedVars);
      }
      return { ok: problems.length === 0, problems, bytes, ruleCount };
    } catch {
      problems.push("css_parse_failed");
      return { ok: false, problems, bytes, ruleCount };
    }
  }
  // 非 DOM 环境：按 `selector{decls}` 扫描（保守——宁可多报不误放）
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    ruleCount++;
    checkPair(m[1].trim(), m[0], (p) => problems.push(p), reservedVars);
  }
  if (!ruleCount) problems.push("no_parsable_rules");
  return { ok: problems.length === 0, problems, bytes, ruleCount };
}
