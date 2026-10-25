/**
 * 从插件主题 CSS 里抠出 `--*` 自定义属性。
 *
 * 插件主题只提供整段 CSS（`:root{--bg:…}` 自己写在里面），但选择器预览、明暗推导与
 * "给了几项/几项沿用兜底"都要一份 token 表。抄一套并行格式（让插件多写一份 vars）
 * 等于开第二真相，所以这里从 CSS 里读——只读 `:root` 风格的自定义属性声明，
 * 不解释层叠，够用且不会骗人。
 */

const DECL = /(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi;

export function varsFromThemeCss(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of String(css ?? "").matchAll(DECL)) {
    const key = m[1].trim();
    const value = m[2].trim();
    if (!value || key.startsWith("--z-") || key.startsWith("--fx-asset-")) continue;
    out[key] = value.length > 200 ? value.slice(0, 200) : value;
  }
  return out;
}
