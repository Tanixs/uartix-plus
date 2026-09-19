/**
 * P88b-3 §11：生成代码隔离。
 * - iframe CSP：默认禁网络/外部资源（connect-src 'none'），内联脚本/样式保留（沙箱桥依赖）；
 * - 消息校验：新插件 iframe 的所有 aiw:* 消息必须携带实例 nonce（桥注入时写入），
 *   并按包能力裁决 send/ask/app/快照订阅，越权即忽略并上报违规（累计隔离）；
 * - M1 存量旁路（2026-09-18 修复）：以上约束只作用于 P88b-3 之后新安装/新生成的插件；
 *   旧扩展迁移件（legacy）保持原行为（不强制 nonce/能力校验），附迁移提示与兼容诊断。
 */

/** 新插件 iframe 的 CSP meta 内容。img 允许 data:/blob:；一切远程获取全部禁用。 */
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

/** 消息类型 → 所需插件能力；未列出的类型（resize/menu/win/x2w 等）不需要能力。 */
export const MSG_CAP_REQUIREMENT: Record<string, string> = {
  "aiw:send": "serial.send",
  "aiw:ask": "ai.ask",
  "aiw:app": "ui.action",
  "aiw:menu-def": "ui.action",
};

/** 宿主主动推送的被动数据流：无 telemetry.read 能力的插件不接收。 */
export const PASSIVE_DATA_TYPES = new Set(["aiw:snap", "aiw:chat"]);

export interface PluginMsgCtx {
  caps: string[];
  nonce: string;
  legacy: boolean;
}

export type MsgVerdict = "allow" | "reject_nonce" | "reject_cap" | "bypass_legacy";

/**
 * 裁决一条来自插件 iframe 的 aiw:* 消息。
 * - legacy（旧扩展迁移件）：旁路，保持原行为（M1）；
 * - 非 legacy：先验 nonce（消息未带 n 或 n 不匹配即拒绝），再验能力；
 * - verdict 为 reject_* 时调用方必须忽略消息并上报 reportViolation。
 */
export function verdictPluginMessage(
  type: string,
  nonceInMsg: unknown,
  ctx: PluginMsgCtx,
): MsgVerdict {
  if (ctx.legacy) return "bypass_legacy";
  if (nonceInMsg !== ctx.nonce) return "reject_nonce";
  const cap = MSG_CAP_REQUIREMENT[type];
  if (cap && !ctx.caps.includes(cap)) return "reject_cap";
  return "allow";
}

/** 宿主 → iframe 的被动推送是否放行（无 telemetry.read 能力不接收快照/聊天流）。 */
export function verdictPassivePush(type: string, ctx: PluginMsgCtx): boolean {
  if (ctx.legacy) return true;
  if (!PASSIVE_DATA_TYPES.has(type)) return true;
  return ctx.caps.includes("telemetry.read");
}

/** 约束测试用：CSP 必须禁掉的一切远程获取通道都在 default/connect/frame 里。 */
export function cspBlocksNetwork(): boolean {
  return /default-src 'none'/.test(PLUGIN_IFRAME_CSP) && /connect-src 'none'/.test(PLUGIN_IFRAME_CSP);
}
