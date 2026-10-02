/**
 * P131-C 资产通道判据层的守卫。
 *
 * 这一层是"能力放开"那一侧唯一的地基：净化器放行 `url(var(--fx-asset-*))` 的前提是
 * **资产真身只能从这条链进来**，而这条链的强度全在下面的判据里。
 * 所以测试的重点不是"合法的要放过"，而是**每一种撒谎的形态都要被抓住**：
 * 声明 png 实为 svg、SVG 里藏脚本、id 写成大写、base64 少一位、体积顶到上限外面。
 */
import { describe, expect, it } from "vitest";
import {
  ASSET_MAX_BYTES,
  assetReferences,
  base64FromUtf8,
  checkCssUrlArg,
  danglingAssetRefs,
  decodeBase64,
  mimeMatchesBytes,
  svgScriptProblems,
  validateAsset,
  validateAssetList,
} from "./assetGuard";

/** 一枚真 1×1 PNG（前 8 字节就是签名） */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** 测试文件里没有 node 类型，用 btoa 造 base64（夹具全是 ASCII，够用） */
const svgB64 = (svg: string): string => btoa(svg);
const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#808080" opacity=".05"/></svg>';

describe("P131-C · base64 解码：认不出即 null，不猜", () => {
  it("正常串与 padding 两种都解得开，字节数对得上", () => {
    const b = decodeBase64(PNG_B64);
    expect(b).not.toBeNull();
    expect(b!.length).toBe(70);
    expect(decodeBase64("YWJjZA==")).toEqual(new Uint8Array([97, 98, 99, 100]));
  });

  it("坏字符 / 长度不是 4 的倍数 / 空串 ⇒ null", () => {
    expect(decodeBase64("####")).toBeNull();
    expect(decodeBase64("YWJjZ")).toBeNull();
    expect(decodeBase64("")).toBeNull();
    expect(decodeBase64("ab=def")).toBeNull();
  });
});

describe("P131-C · 魔数核对：声明的 mime 必须与字节真身一致", () => {
  it("png 签名通过；把 svg 声明成 png 不通过", () => {
    const png = decodeBase64(PNG_B64)!;
    expect(mimeMatchesBytes("image/png", png)).toBe(true);
    expect(mimeMatchesBytes("image/svg+xml", png)).toBe(false);
    const svg = decodeBase64(svgB64(GOOD_SVG))!;
    expect(mimeMatchesBytes("image/svg+xml", svg)).toBe(true);
    expect(mimeMatchesBytes("image/png", svg)).toBe(false);
    // 带 XML 声明与注释的 SVG 也算（不能因为开头不是 <svg 就冤枉它）
    expect(mimeMatchesBytes("image/svg+xml", decodeBase64(svgB64('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))!)).toBe(true);
  });

  it("gif / webp / jpeg 各自的签名", () => {
    expect(mimeMatchesBytes("image/gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true);
    const webp = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
    expect(mimeMatchesBytes("image/webp", webp)).toBe(true);
    expect(mimeMatchesBytes("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(mimeMatchesBytes("image/hei", new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("P131-C · SVG 脚本面：能带脚本的图片就不是图片", () => {
  it("干净的一贴通过", () => {
    expect(svgScriptProblems(GOOD_SVG)).toEqual([]);
  });

  /** 每一种危险形态单独钉一条：漏一种就是"主题能执行脚本"那条边界作废 */
  it.each([
    ["<script>alert(1)</script>", "svg_has_script"],
    ['<svg onload="alert(1)"/>', "svg_has_event_handler"],
    ['<a href="javascript:alert(1)">x</a>', "svg_javascript_url"],
    ["<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]>", "svg_entity_declaration"],
    ["<foreignObject><div xmlns=\"http://www.w3.org/1999/xhtml\">hi</div></foreignObject>", "svg_foreign_object"],
    ['<image href="https://evil/track.gif?ip=">', "svg_external_reference"],
    ["<rect style=\"fill:url(http://evil/p#p)\"/>", "svg_external_url"],
    ["<style>@import url(x.css);</style>", "svg_css_import"],
  ])("危险形态 #%# 必须被抓住", (svg, code) => {
    expect(svgScriptProblems(svg)).toContain(code);
  });
});

describe("P131-C · 一枚资产的校验", () => {
  it("合法的一贴：只有 id/mime/data 三件事", () => {
    expect(validateAsset({ id: "acrylic-noise", mime: "image/png", data: PNG_B64 })).toEqual([]);
  });

  it("id 必须是小写 kebab（大写、下划线、空都不行）", () => {
    expect(validateAsset({ id: "Noise", mime: "image/png", data: PNG_B64 })).toContain("asset_id_must_match_fx_asset_lowercase");
    expect(validateAsset({ id: "a_b", mime: "image/png", data: PNG_B64 })).toContain("asset_id_must_match_fx_asset_lowercase");
    expect(validateAsset({ id: "", mime: "image/png", data: PNG_B64 })).toContain("asset_id_must_match_fx_asset_lowercase");
  });

  it("mime 白名单外的（含字体）一律拒；data: 前缀不许混进来", () => {
    expect(validateAsset({ id: "a-b", mime: "image/heic", data: PNG_B64 })).toContain("asset_mime_not_allowed:image/heic");
    expect(validateAsset({ id: "f-1", mime: "font/woff2", data: PNG_B64 })).toContain("asset_mime_not_allowed:font/woff2");
    expect(validateAsset({ id: "a-b", mime: "image/png", data: `data:image/png;base64,${PNG_B64}` })).toContain("asset_data_must_not_include_data_uri_prefix");
  });

  it("体积顶到外面：单枚 512 KiB", () => {
    const big = "A".repeat(Math.ceil(((ASSET_MAX_BYTES + 10) * 4) / 3));
    expect(validateAsset({ id: "a-b", mime: "image/png", data: big }).some((p) => p.startsWith("asset_too_large"))).toBe(true);
  });

  it("撒谎的 mime 进不来（声明 png、字节是 svg）", () => {
    expect(validateAsset({ id: "a-b", mime: "image/png", data: svgB64(GOOD_SVG) })).toContain("asset_bytes_do_not_match_mime");
  });

  it("SVG 里藏脚本 ⇒ 整枚拒，理由带 id", () => {
    const bad = svgScriptProblems("<svg><script>alert(1)</script></svg>");
    expect(bad.length).toBeGreaterThan(0);
    expect(validateAsset({ id: "nope", mime: "image/svg+xml", data: svgB64("<svg><script>alert(1)</script></svg>") })).toContain("svg_has_script:nope");
  });
});

describe("P131-C · 一组资产：数量、总量、id 撞车", () => {
  it("缺省（不带资产）合法——旧包不该被新判据判红", () => {
    expect(validateAssetList(undefined)).toEqual([]);
    expect(validateAssetList([])).toEqual([]);
  });

  it("id 重复要报（两张贴图撞同一个变量名，后一张会静默盖掉前一张）", () => {
    const one = { id: "noise", mime: "image/png", data: PNG_B64 };
    expect(validateAssetList([one, one])).toContain("duplicate_asset_id:noise");
  });

  it("超过 8 枚要报", () => {
    const list = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, mime: "image/png", data: PNG_B64 }));
    expect(validateAssetList(list).some((p) => p.startsWith("too_many_assets"))).toBe(true);
  });

  it("不是数组要报，不静默当空", () => {
    expect(validateAssetList({ id: "noise" })).toEqual(["assets_must_be_array"]);
  });
});

describe("P131-C · CSS 里那一处 url() 的形态判定", () => {
  it("放行：小体积栅格 data:", () => {
    expect(checkCssUrlArg(`"data:image/png;base64,${PNG_B64}"`)).toBeNull();
  });

  /**
   * 这一条是 1421 实测换来的：`url(var(--fx-asset-x))` 看着是"引用资产"的正确写法，
   * 浏览器根本不认（变量替换发生在 url 记号解析之后），材质从来没贴上去过。
   * 所以它必须被**明确拒**并指向正确写法，而不是被绿灯放过。
   */
  it("拒：url 里套 var（哪怕指的是资产变量）——正确写法是直接 var(--fx-asset-x)", () => {
    expect(checkCssUrlArg("var(--fx-asset-noise)")).toBe("url_var_inside_url_token_use_the_var_directly");
    expect(checkCssUrlArg('"var(--fx-asset-noise)"')).toBe("url_var_inside_url_token_use_the_var_directly");
    expect(checkCssUrlArg("var(--fx-asset-noise, none)")).toBe("url_var_inside_url_token_use_the_var_directly");
  });

  it("拒：外链、协议相对、file、相对路径、非资产 var", () => {
    expect(checkCssUrlArg("https://evil/x.png")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("//evil/x.png")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("file:///etc/passwd")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("/assets/x.png")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("var(--accent)")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("var(--fx-asset-BAD)")).toBe("url_not_on_asset_channel");
    expect(checkCssUrlArg("")).toBe("url_empty");
  });

  it("内联 SVG 与 html 的 data: 各给各的理由（前者要走资产通道才有脚本面检查）", () => {
    expect(checkCssUrlArg("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe("url_svg_must_go_through_asset_channel");
    expect(checkCssUrlArg("data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=")).toBe("url_data_form_not_allowed");
  });
});

/**
 * P131-D2：引用侧的三支纯函数。它们是"三通路共用一条闭合判据"的那条判据——
 * 包产物、内置 style 包、AI 固化都调这里，所以这里判错一次，三处一起错。
 */
describe("P131-D2 · 资产引用的抽取与闭合", () => {
  it("base64FromUtf8：与解码器往返一致，中文注释也不会炸（btoa 在这种输入上会抛）", () => {
    const text = '<svg><!-- 噪声纹理，别当成空图 --><rect fill="#808080"/></svg>\n';
    const b64 = base64FromUtf8(text);
    const bytes = decodeBase64(b64);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(text);
    expect(base64FromUtf8("")).toBe("");
  });

  it("assetReferences：两种出现形态都算引用，去重排序；非资产变量不算", () => {
    expect(assetReferences(".a{background-image:var(--fx-asset-noise)}")).toEqual(["noise"]);
    /** 真实写法是 `background: var(--fx-asset-a1), var(--fx-asset-b2)`；**空格分隔的两条 var 不是合法 CSS**，抽取器按"看见名字就算引用"判，宁多抓不漏抓 */
    expect(assetReferences(".a{background:var(--fx-asset-b1) , var(--fx-asset-a2);color:var(--accent)}")).toEqual(["a2", "b1"]);
    expect(assetReferences(".a{background:url(var(--fx-asset-noise))}")).toEqual(["noise"]);
    /** 资产 id 最短两位（`ASSET_ID_PATTERN`），所以单串的 `--fx-asset-x` 本来就不是合法名字，抽取器跟着同一条形状 */
    expect(assetReferences('.a{--fx-asset-xx:url("y")\nbackground:var(--fx-asset-xx)}')).toEqual(["xx"]);
    expect(assetReferences(".a{background-image:var(--texture)}")).toEqual([]);
  });

  it("danglingAssetRefs：清单里没给的那几枚点名出来，给了的不报", () => {
    const assets = [{ id: "noise", mime: "image/png", data: PNG_B64 }];
    expect(danglingAssetRefs(".a{background:var(--fx-asset-noise)}", assets)).toEqual([]);
    expect(danglingAssetRefs(".a{background:var(--fx-asset-noise) var(--fx-asset-grid)}", assets)).toEqual(["grid"]);
    /** 非资产变量不是"缺失的引用"，是"根本没引用"——这条判据不替它操心 */
    expect(danglingAssetRefs(".a{color:var(--accent)}", [])).toEqual([]);
  });
});
