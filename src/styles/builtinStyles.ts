/**
 * P131-D：内置主题的**组件层**装载表（与 `builtinThemes` 平级，但装的不是 token 而是规则）。
 *
 * 为什么单开一条通道而不是往 `theme.css` 里加：`themes/<id>.css` 是 token-only 的数据
 * （块外零规则，`check-theme-files` 钉着），组件规则塞进去等于把那份数据变成第二套宿主样式表；
 * 而塞进 `theme.css` 又会全局生效——"选流利蓝才有的那套控件样子"就没人管了。
 * 这条通道的规矩是**每条选择器必须带 `[data-theme="<id>"]` 前缀**（门 K 判），
 * 装载时又只跟在"在画那一枚"后面注入，所以两道都指不到别处。
 *
 * 为什么还留着 CSS 文件而不是内联成 TS 字符串：门 K 与 `marketContent` 的跨通路对账都要读字节，
 * 而 TS 模板字符串里的 CSS 既不过 stylelint 也不过 prettier——抄一份进 TS 就是让它没人管。
 */
import fluentCss from "./builtinStyles/fluent.css?raw";

/** 有组件层的内置主题 id。**加一枚就要在这里登记一行**，否则门 K 判红（文件没人装载＝安静地不生效） */
export const BUILTIN_STYLE_IDS: readonly string[] = ["fluent"];

const PARTS: Record<string, string> = {
  fluent: fluentCss,
};

/** 这枚内置主题的组件层 CSS（没有则空串） */
export function builtinStyleCss(themeId: string): string {
  return PARTS[themeId] ?? "";
}

export function hasBuiltinStyle(themeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PARTS, themeId);
}
