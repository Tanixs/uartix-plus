/**
 * P88b-3 §11：生成代码隔离。
 * - iframe CSP：默认禁网络/外部资源（connect-src 'none'），内联脚本/样式保留（沙箱桥依赖）；
 * - 消息校验：新插件 iframe 的所有 aiw:* 消息必须携带实例 nonce（桥注入时写入），
 *   并按包能力裁决 send/ask/app/快照订阅，越权即忽略并上报违规（累计隔离）；
 * - M1 存量旁路已于 P99a-B1a **整条删除**（用户裁决：软件未发布、无外部用户，旧形态不适配）：
 *   曾经只要记录带 `legacy` 就跳过 nonce/能力/类型三重验，而全仓**没有任何活代码写入该字段**——
 *   它能做的唯一一件事，是从 localStorage 塞一条记录进来就免检用桥。
 */
import type { PluginCap } from "./pluginManifest";

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

/**
 * iframe → 宿主的**全部**入站消息类型。新增一支就必须在这里加一行，
 * 否则 `verdictPluginMessage` 直接判 `reject_unknown`（P99a-A4 反 fail-open）。
 *
 * P99a-B1a 补上此前漏登记的两支：`aiw:getSnap`（向宿主索取一次数据快照）、
 * `aiw:x2w`（挂件间广播中继）。它们在 `WidgetFrame` 里有 `case` 分支却不在表里，
 * 于是**插件库里的挂件一用就是 reject_unknown + 一次违规，三次即隔离**——
 * 而我上一批写的那条"两边集合相等"的守卫当时仍然绿，因为它的正则是
 * `case "(aiw:[a-z-]+)"`：不匹配数字（`x2w`）、不匹配驼峰（`getSnap`）。
 * 教训进 §8-36②：守卫自己的正则也是探针，探针漏看的字符集就是它永远查不到的缺陷。
 *
 * P99a-D1c 又反着走了一遍：`aiw:getSnap` 整支删掉（宿主侧有 handler，桥侧 `uartix.snap()`
 * 却只读缓存、从不发这支消息）。**"登记在表上却没人发"和"有人发却没登记"是同一种病的两面**——
 * 都让这张表与真实消息面不一致；判死删掉之后，两边才是真的严格相等。
 */
export type AiwInboundType =
  | "aiw:ready"
  | "aiw:send"
  | "aiw:ask"
  | "aiw:app"
  | "aiw:menu-def"
  | "aiw:resize"
  | "aiw:cursor"
  | "aiw:win"
  | "aiw:x2w";

/**
 * 消息类型 → 所需插件能力；`null` 是**显式裁决**"这一支不需要能力"，不是"忘了写"。
 *
 * 旧表是 `Record<string, string>` 且查不到就放行，注释自己写着「未列出的类型不需要能力」——
 * 那是"默认开"的门：谁新增一支特权消息而忘了进表，它就自动免检。P99a-B 要加
 * `aiw:tool-def`（插件注册 Agent 工具），正好会踩在这条缝上，所以先把门反成"默认关"：
 * 未登记即拒绝并计一次违规。
 *
 * `aiw:win` 在这里是 `null`，**不代表整支免检**：它是"一条消息多个动词"的形态，
 * 粒度在动作上，见下面的 `WIN_ACTION_CAP`。
 */
export const MSG_CAP_REQUIREMENT: Record<AiwInboundType, PluginCap | null> = {
  "aiw:ready": null,
  "aiw:send": "serial.send",
  "aiw:ask": "ai.ask",
  "aiw:app": "ui.action",
  "aiw:menu-def": "ui.action",
  "aiw:resize": null,
  "aiw:cursor": null,
  "aiw:win": null,
  /** 只中继发送方自己给的 data 给其它沙箱组件，不经宿主数据、60KB 上限在桥侧 */
  "aiw:x2w": null,
};

/**
 * `aiw:win` 的**动作级**裁决（详设 §13.2，用户选"分级收紧"而不是整支挂 `ui.action`）。
 *
 * 一条 `aiw:win` 消息带 11 种 action，风险差得很远：挪动/缩放自己的框是挂件存在的
 * 前提，置顶 + 点击穿透组合起来却是"盖在真实界面上、点击落到底下真控件"的形态。
 * 所以整支挂一支 `ui.action`（点按钮的权力）既过粗又漏判。
 *
 * `close` 刻意留在免检侧：它只关**自己**那一块，误关了一下就能再打开，是破坏不是特权；
 * 反过来 `popOut` 要能力，因为它把"界面里的一小块"升级成"系统窗口"——那是形态升级。
 * （实施时比我先前给用户的口径收窄了一格，理由记在这里，不藏。）
 *
 * `win.control` **不进 `PURE_UI_CAPS`**：进了就意味着 Agent 能生成一个"置顶+穿透"的
 * 挂件并**自我启用**它，等于把点击劫持的形态放进自动放行侧（§8-38①）。
 */
export type WinAction =
  | "move"
  | "moveBy"
  | "dragDelta"
  | "dragEnd"
  | "size"
  | "get"
  | "menu"
  | "close"
  | "alwaysOnTop"
  | "ignoreCursorEvents"
  | "popOut";

export const WIN_ACTION_CAP: Record<WinAction, PluginCap | null> = {
  move: null,
  moveBy: null,
  dragDelta: null,
  dragEnd: null,
  size: null,
  get: null,
  menu: null,
  close: null,
  alwaysOnTop: "win.control",
  ignoreCursorEvents: "win.control",
  popOut: "win.control",
};

/**
 * 裁决一条 `aiw:win` 的具体动作。**未知动作同样默认关**：与入站类型同一手法，
 * 新增一个 action 而忘记进表 ⇒ 拒 + 计违规，而不是免检。
 */
export function verdictWinAction(action: string, caps: readonly string[]): MsgVerdict {
  if (!Object.prototype.hasOwnProperty.call(WIN_ACTION_CAP, action)) return "reject_unknown";
  const cap = WIN_ACTION_CAP[action as WinAction];
  if (cap && !caps.includes(cap)) return "reject_cap";
  return "allow";
}

/** 宿主主动推送的被动数据流：无 telemetry.read 能力的插件不接收。 */
export const PASSIVE_DATA_TYPES = new Set(["aiw:snap", "aiw:chat"]);

export interface PluginMsgCtx {
  caps: string[];
  nonce: string;
}

export type MsgVerdict = "allow" | "reject_nonce" | "reject_cap" | "reject_unknown";

/**
 * 专用 Worker（`module` 产物，P99a-B1/B2）→ 宿主的入站消息。
 *
 * 与 iframe 共用同一个 `verdictPluginMessage`：**多一个宿主不多一份门禁表**（详设 §5.2）。
 * 表按通道拆两张是因为两个通道处理的分支本就不同（一张表会逼 `WidgetFrame` 的源码对账卡
 * 把 worker 消息也算成 iframe 分支）；两张表在测试里钉"键集合不得相交"，
 * 合并查找由 `CAP_BY_TYPE` 单点做。
 */
export type WorkerInboundType =
  | "aiw:mod-probe"
  | "aiw:mod-error"
  | "aiw:mod-ready"
  | "aiw:tool-def"
  | "aiw:tool-undef"
  | "aiw:tool-ack";

export const WORKER_MSG_CAP: Record<WorkerInboundType, PluginCap | null> = {
  "aiw:mod-probe": null,
  "aiw:mod-error": null,
  "aiw:mod-ready": null,
  "aiw:tool-def": "agent.tool",
  "aiw:tool-undef": "agent.tool",
  // 回执不需要能力：nonce + "宿主确实在等这个 callId"就是它的授权
  "aiw:tool-ack": null,
};

const CAP_BY_TYPE = new Map<string, PluginCap | null>();
for (const [k, v] of Object.entries(MSG_CAP_REQUIREMENT)) CAP_BY_TYPE.set(k, v);
for (const [k, v] of Object.entries(WORKER_MSG_CAP)) CAP_BY_TYPE.set(k, v);

/** 裁决一条来自插件 iframe 的 aiw:* 消息。**没有旁路**（P99a-B1a 删了 legacy 分支）：
 * - **先验未知类型**（不在表里＝没人裁决过它的风险，直接拒），
 * - 再验 nonce（消息未带 n 或不匹配即拒绝），最后验能力；
 * - verdict 为 reject_* 时调用方必须忽略消息并上报 reportViolation。
 * Worker 通道走同一个函数（见 `WORKER_MSG_CAP`）。
 */
export function verdictPluginMessage(
  type: string,
  nonceInMsg: unknown,
  ctx: PluginMsgCtx,
): MsgVerdict {
  if (!CAP_BY_TYPE.has(type)) return "reject_unknown";
  if (nonceInMsg !== ctx.nonce) return "reject_nonce";
  const cap = CAP_BY_TYPE.get(type);
  if (cap && !ctx.caps.includes(cap)) return "reject_cap";
  return "allow";
}

/** 宿主 → iframe 的被动推送是否放行（无 telemetry.read 能力不接收快照/聊天流）。 */
export function verdictPassivePush(type: string, ctx: PluginMsgCtx): boolean {
  if (!PASSIVE_DATA_TYPES.has(type)) return true;
  return ctx.caps.includes("telemetry.read");
}

/** 约束测试用：CSP 必须禁掉的一切远程获取通道都在 default/connect/frame 里。 */
export function cspBlocksNetwork(): boolean {
  return /default-src 'none'/.test(PLUGIN_IFRAME_CSP) && /connect-src 'none'/.test(PLUGIN_IFRAME_CSP);
}
