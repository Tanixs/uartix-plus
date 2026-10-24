/**
 * P174-A18③：AI 产物（小部件 / 桌宠 / 扩展面板）iframe 的 **CSP 基线**。
 *
 * 从 `plugins/pluginIsolation.ts` 搬出来。它不属于旧插件系统：只要 AI 还能造 UI，
 * 这条 CSP 就是"它造的东西不许上网、不许嵌套、不许发请求"的唯一一处声明。
 *
 * 一条都不能松：`img-src data: blob:` 是产物内嵌图片的白名单，`connect-src 'none'`
 * 意味着 AI 造出来的界面**不可能把用户的数据发出去**；`frame-src 'none'` 防止它再套一层。
 */
export const PLUGIN_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
