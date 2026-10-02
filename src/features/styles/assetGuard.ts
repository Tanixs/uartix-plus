/**
 * P131-C 资产通道的判据层（无 DOM、无依赖的叶子模块）。
 *
 * 为什么要单独一个模块：一刀切禁 `url()` 的代价是把"材质"整层能力删了（贴图 / 噪声 / 纹理 /
 * 图标集），而放开 `url()` 又会同时打开两件事——**外链在离线插包时必然裂图**，以及
 * **一条把用户 IP / 在线状态外发的通道**。这两条都不是审美问题，所以放开的边界必须写成
 * 可判定的代码，而不是文档里的一句"请只放本地资产"。
 *
 * 三条边界（每条都对应下面一个函数）：
 *  1. **资产本体走结构化字段**（主题产物的 `assets`），由 {@link validateAsset} 收：
 *     mime 白名单 + 魔数核对 + 单枚 512 KiB + 每主题 8 枚 + 总量 2 MiB，SVG 还要过脚本面检查。
 *     装包时校验一次，运行时把 base64 变成 `blob:` URL 注入 `--fx-asset-<id>`。
 *  2. **CSS 里只许引用**：`url(var(--fx-asset-<id>))`，或**栅格图**的 `data:` URI（≤32 KB）。
 *     SVG 不许内联——内联的那份绕过了第 1 条里对脚本面的检查，只能从资产通道进。
 *  3. **仍然全拒**：`url(http…)` / `url(//…)` / `url(file…)` / `url(data:text/html…)` /
 *     `url(相对路径)`（相对路径在 Tauri 下会解析到应用自己的资源，那不是主题该碰的地方）。
 *
 * 字体（`font/woff2`）**这一批没做**：`@font-face { src: … }` 里用不了 `var()`，
 * 所以资产通道对字体不成立，硬做只能给 `@font-face` 开特例——那要单独一次设计，不顺手塞。
 */

export const ASSET_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const ASSET_VAR_PREFIX = "--fx-asset-";
export const ASSET_MAX_BYTES = 512 * 1024;
export const ASSET_MAX_PER_THEME = 8;
export const ASSET_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** 内联 `data:` 的字符上限（不是字节：净化器看到的是 CSS 文本） */
export const ASSET_INLINE_MAX_CHARS = 32_000;

export type AssetMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/svg+xml";
export const ASSET_MIMES: readonly AssetMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

/** 形状住在零 import 的 `styles/themeCore`（`ThemeSource.assets` 与产物校验器都要认它） */
export type { ThemeAsset } from "../../styles/themeCore";

export const assetVarName = (id: string): string => `${ASSET_VAR_PREFIX}${id}`;
export const isAssetVar = (name: string): boolean => name.startsWith(ASSET_VAR_PREFIX);

/** 严格 base64 解码：字符集、长度、padding 位置任一不对就返回 null（**不猜**，认不出即拒） */
export function decodeBase64(s: string): Uint8Array | null {
  const b64 = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length === 0 || b64.length % 4 !== 0) return null;
  const digits = (c: string): number => {
    if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 65;
    if (c >= "a" && c <= "z") return c.charCodeAt(0) - 71;
    if (c >= "0" && c <= "9") return c.charCodeAt(0) + 4; // '0'→52 … '9'→61
    if (c === "+") return 62;
    if (c === "/") return 63;
    return -1;
  };
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const vals = [b64[i], b64[i + 1], b64[i + 2], b64[i + 3]].map((c) => (c === "=" ? -1 : digits(c)));
    if (vals[0] < 0 || vals[1] < 0) return null;
    // `=` 只许出现在一组的末尾连续位置：`ab=d` 这种中间断档是坏串，不是"当 0 处理"
    if (vals[2] < 0 && vals[3] >= 0) return null;
    const missing = (vals[2] < 0 ? 1 : 0) + (vals[3] < 0 ? 1 : 0);
    const n = 3 - missing;
    const v = vals.map((x) => (x < 0 ? 0 : x));
    out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (n >= 2) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (n >= 3) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return o === out.length ? out : null;
}

/** UTF-8 解码（只用标准 API，测试环境没有 TextDecoder 时退回逐字节——不猜：解不出即 null） */
function utf8(bytes: Uint8Array): string | null {
  if (typeof TextDecoder !== "undefined") {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      /* 落到下面的手写解码 */
    }
  }
  let s = "";
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else return null; // 手写解码只覆盖 ASCII：SVG 的脚本面检查是 ASCII 关键字，够
  }
  return s;
}

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...Array.from(b.subarray(at, at + n)));

/** 魔数核对：声明的 mime 必须与字节真身一致（"声明 png 实为 svg" 是要防的） */
export function mimeMatchesBytes(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") return ascii(bytes, 0, 4) === "GIF8";
  if (mime === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (mime === "image/svg+xml") {
    const text = utf8(bytes.subarray(0, Math.min(bytes.length, 2048))) ?? "";
    return /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);
  }
  return false;
}

/**
 * SVG 的脚本面。SVG 是"能带脚本的图片"，所以它是这条通道里唯一需要**读内容**的 mime：
 * 一个 `<script>` 或 `onload=` 就等于把"主题只能改外观"这条边界作废。
 * 拒的是模式而不是解析结果——SVG 的合法子集很大，这里只列**明确危险**的形态，
 * 认不准的一律拒（宁可让投稿人换个写法，也不放一条可能带脚本的进去）。
 */
export function svgScriptProblems(text: string): string[] {
  const out: string[] = [];
  const hit = (re: RegExp, why: string) => {
    if (re.test(text)) out.push(why);
  };
  hit(/<script/i, "svg_has_script");
  hit(/\son[a-z]+\s*=/i, "svg_has_event_handler");
  hit(/javascript\s*:/i, "svg_javascript_url");
  hit(/<!ENTITY/i, "svg_entity_declaration");
  hit(/<!DOCTYPE/i, "svg_doctype");
  hit(/<foreignObject/i, "svg_foreign_object");
  hit(/(?:xlink:)?href\s*=\s*["']?\s*(?:https?:|\/\/)/i, "svg_external_reference");
  hit(/url\s*\(\s*["']?\s*(?:https?:|\/\/)/i, "svg_external_url");
  hit(/@import/i, "svg_css_import");
  return out;
}

/** base64 串对应的字节数（算上 padding；认不出返回 0，让上层按"不合法"处理） */
export function base64ByteLength(data: string): number {
  const b64 = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** 一枚资产的校验：合不合法（返回问题清单，空数组＝合法） */
export function validateAsset(a: unknown): string[] {
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["asset_must_be_object"];
  const rec = a as Record<string, unknown>;
  const out: string[] = [];
  const id = rec.id;
  if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) out.push("asset_id_must_match_fx_asset_lowercase");
  const mime = rec.mime;
  if (typeof mime !== "string" || !(ASSET_MIMES as readonly string[]).includes(mime)) {
    out.push(`asset_mime_not_allowed:${String(mime).slice(0, 32)}`);
  }
  const data = rec.data;
  if (typeof data !== "string" || !data) {
    out.push("asset_data_must_be_base64");
    return out;
  }
  if (data.startsWith("data:")) out.push("asset_data_must_not_include_data_uri_prefix");
  const bytes = decodeBase64(data);
  if (!bytes) out.push("asset_data_not_valid_base64");
  else {
    if (bytes.length > ASSET_MAX_BYTES) out.push(`asset_too_large:${bytes.length}>${ASSET_MAX_BYTES}`);
    else if (typeof mime === "string" && !out.some((p) => p.startsWith("asset_mime_not_allowed")) && !mimeMatchesBytes(mime, bytes)) {
      out.push("asset_bytes_do_not_match_mime");
    } else if (mime === "image/svg+xml") {
      const text = utf8(bytes);
      if (text === null) out.push("asset_svg_not_decodable");
      else out.push(...svgScriptProblems(text).map((p) => `${p}:${id}`));
    }
  }
  return out;
}

/** 一组资产（一枚主题带的）：数量与总量上限 + id 不许重复 */
export function validateAssetList(assets: unknown): string[] {
  if (assets === undefined) return [];
  if (!Array.isArray(assets)) return ["assets_must_be_array"];
  const out: string[] = [];
  if (assets.length > ASSET_MAX_PER_THEME) out.push(`too_many_assets:${assets.length}>${ASSET_MAX_PER_THEME}`);
  const seen = new Set<string>();
  let total = 0;
  for (const a of assets) {
    const problems = validateAsset(a);
    out.push(...problems);
    const rec = a as { id?: unknown; data?: unknown } | null;
    if (rec && typeof rec.id === "string") {
      if (seen.has(rec.id)) out.push(`duplicate_asset_id:${rec.id}`);
      seen.add(rec.id);
    }
    if (rec && typeof rec.data === "string") total += base64ByteLength(rec.data);
  }
  if (total > ASSET_MAX_TOTAL_BYTES) out.push(`assets_total_too_large:${total}>${ASSET_MAX_TOTAL_BYTES}`);
  return out;
}

const ASSET_REF = /^--fx-asset-[a-z][a-z0-9-]{1,39}$/;
const INLINE_RASTER = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * CSS 里一处 `url(...)` 的实参合不合法。返回拒绝理由，合法返回 null。
 * 这是净化器唯一认 `url()` 的地方——`BANNED_VALUE_PATTERNS` 里那条一刀切已换成它。
 *
 * 特别注意 `url(var(--fx-asset-x))` 这一种：它**看着对**，但 CSS 的变量替换发生在
 * 记号解析之后，`url()` 里面不允许替换（1421 实测：这样写的材质从来没贴上去过，
 * 而净化器当时还给它开了绿灯）。资产变量的值本来就是一整个 `url("blob:…")`，
 * 所以正确写法是 `background-image: var(--fx-asset-x)`——这里明确拒，并把它指向正确写法。
 */
export function checkCssUrlArg(raw: string): string | null {
  const arg = raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  if (!arg) return "url_empty";
  const varRef = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(arg);
  if (varRef) return ASSET_REF.test(varRef[1]) ? "url_var_inside_url_token_use_the_var_directly" : "url_not_on_asset_channel";
  if (/^data:/i.test(arg)) {
    if (/^data:image\/svg/i.test(arg)) return "url_svg_must_go_through_asset_channel";
    if (!INLINE_RASTER.test(arg)) return "url_data_form_not_allowed";
    if (arg.length > ASSET_INLINE_MAX_CHARS) return `url_data_too_large:${arg.length}>${ASSET_INLINE_MAX_CHARS}`;
    return null;
  }
  return "url_not_on_asset_channel";
}

/**
 * 扫一段 CSS 文本里所有 `url(` 调用（括号配平，认 `url(var(--x))` 这种嵌套）。
 * 返回每条的拒绝理由——净化器两条通路（DOM 与 node 兜底）共用这一个出口。
 */
export function urlProblems(cssText: string): string[] {
  const out: string[] = [];
  const re = /url\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let cur = "";
    let quote = "";
    for (; i < cssText.length && depth > 0; i++) {
      const ch = cssText[i];
      if (quote) {
        if (ch === quote) quote = "";
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      cur += ch;
    }
    if (depth !== 0) {
      out.push("url_paren_unbalanced");
      break;
    }
    const why = checkCssUrlArg(cur);
    if (why) out.push(why);
    re.lastIndex = i;
  }
  return out;
}
