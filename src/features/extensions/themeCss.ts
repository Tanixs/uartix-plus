/**
 * 插件主题 CSS 的入口判据。
 *
 * 抽出来的是一个**纯函数**，不是为了好看：读文件那步（`ext_fs_read`）在 `extStore.ts` 里要
 * 走 tauri invoke，测不动；而"这段 CSS 能不能上整张界面"这件事本身没有 IO。留在 IO 函数里
 * 的后果是——把 `guardStyleText` 改成直通，全套测试照样全绿，等于这条栏杆没有牙。
 *
 * 净化器用的是**和 AI 写主题同一条**（`guardStyleText`）：禁全局选择器、禁 `@import`、禁
 * `!important`。这条不能省——主题 CSS 是插件唯一能改**整张界面**的注入面，省掉它等于开了一个
 * 比"画自己面板"大得多的口子。
 *
 * `reservedVars` 传**空**是有意的：那枚参数锁的是"哪几枚 token 不许在 `:root` 里改"，
 * 而主题的本职就是改配色。锁上 `--bg` 会让插件主题退化成只能做装饰性微调。界线不是
 * "能不能改 token"，而是"改 token 还是改元素"——`:root{--bg:#000}` 放行，`body{…}` 不收。
 */
import { guardStyleText } from "../styles/styleSanitize";

/** 主题 CSS 的字节上限。与读盘那侧的 256 KiB 截断是两个数：那个管"文件多大"，这个管"渲染多重"。 */
export const THEME_CSS_MAX_BYTES = 200 * 1024;

export interface ThemeCssResult {
  /** 通过时给出**原文**（净化器只判不改，改写会让作者的 CSS 与生效的 CSS 对不上账）。 */
  css?: string;
  issue?: string;
}

export function guardThemeCss(text: string, entry: string): ThemeCssResult {
  const g = guardStyleText(text, THEME_CSS_MAX_BYTES, []);
  if (!g.ok) {
    // 只贴前三条：一条 CSS 能被同一条规则报几十次，全贴出来面板就没法看了
    return { issue: `主题 ${entry} 没过净化：${g.problems.slice(0, 3).join("；")}` };
  }
  return { css: text };
}
