/**
 * P88b-4 A：外观覆盖层（借鉴 DeepSeek Harness ui-theme「快照 + ctx.theme 别名覆盖」模型）。
 * - overrides 是唯一真源（token→值）；applyOverlay 是唯一 DOM 出口（documentElement inline 变量），
 *   与 extRuntime 主题扩展同模式、各层只管自己的键，层叠天然成立：内置主题 css < 覆盖层 inline；
 * - 白名单之外的 token 一律拒绝；部分覆盖合法，未覆盖键回退内置主题（Harness 无完整性校验语义）；
 * - 撤销/清层 = 移除本层键后按剩余覆盖重放，绝不触碰 8 个内置主题文件
 *   （Harness「移除第三方主题绝不覆盖内置持久偏好」）；
 * - data-theme 切换只改样式表、不清 inline，覆盖层天然存续（等效 Harness Theme Watchdog）；
 *   保存为主题扩展后清层，由扩展层接管——保存即持久化边界，此后撤销令牌失效。
 * - 值校验：长度上限 + 禁 CSS 结构字符（;{}）+ 单位类 token 白名单格式，防注入与误值。
 *
 * 依赖方向：本模块不 import 任何 ai/ 模块（extRuntime/widgetHub 均引 chatStore，静态引入会与
 * chatStore→agentRun→agentAdapter→本模块构成循环）；iframe 广播经 setOverlayChangeCb 由 widgetHub 注册。
 */

/** 覆盖层变更回调（widgetHub 注册 broadcastTheme；避免循环 import 的解耦点）。 */
let changeCb: (() => void) | null = null;
export function setOverlayChangeCb(cb: (() => void) | null) {
  changeCb = cb;
}

/** 可覆盖 token 白名单：色板（8 主题共有）+ 语义色 + 字号/圆角/动效（theme.css :root P55 token）。间距不开放（布局安全）。 */
export const APPEARANCE_TOKENS = [
  "--bg",
  "--bg-panel",
  "--bg-inset",
  "--bg-titlebar",
  "--border",
  "--border-soft",
  "--text",
  "--text-dim",
  "--accent",
  "--on-accent",
  "--accent-soft",
  "--danger",
  "--warn",
  "--ok",
  "--shadow",
  "--scrollbar",
  "--scrollbar-hover",
  "--warn-fg",
  "--k-send",
  "--k-wait",
  "--k-frame",
  "--k-assert",
  "--k-note",
  "--k-logic",
  "--k-group",
  "--k-warn-line",
  "--fs-xs",
  "--fs-body",
  "--fs-sm",
  "--fs-md",
  "--fs-lg",
  "--radius-s",
  "--radius-m",
  "--radius-l",
  "--radius-xl",
  "--dur-snap",
  "--dur-fast",
  "--dur-base",
  "--ease",
] as const;

export type AppearanceToken = (typeof APPEARANCE_TOKENS)[number];
const TOKEN_SET = new Set<string>(APPEARANCE_TOKENS);

/** 单位类 token（字号/圆角/时长）值格式；--ease 另有曲线白名单 */
const UNIT_RE = /^\d+(\.\d+)?(ms|px)$/;
const EASE_RE = /^(cubic-bezier\([^;{}]{1,60}\)|linear|ease|ease-in|ease-out|ease-in-out)$/;

/** 值合法性：拒绝 CSS 结构字符防注入；单位类 token 校验格式；其余放宽（颜色/阴影/颜色函数均合法）。 */
export function isValidTokenValue(name: string, value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 120 || /[;{}]/.test(v)) return false;
  if (/^--(fs-|radius-|dur-)/.test(name)) return UNIT_RE.test(v);
  if (name === "--ease") return EASE_RE.test(v);
  return true;
}

/** 当前会话覆盖层（token→值）。 */
const overrides = new Map<string, string>();

/** 撤销历史：undoToken → 受影响 token 的前值（null = 原本无 inline 覆盖）。仅本次运行内有效。 */
const undoHistory = new Map<string, Record<string, string | null>>();

/** 本层实际写在 inline 上的键集——applyOverlay 只清这些键，绝不越权清除扩展主题层的同名覆盖。 */
const appliedKeys = new Set<string>();
let applied = false;

/** 读取某 token 当前计算值（含覆盖层效果后的最终呈现值）。 */
export function readToken(name: string): string {
  if (typeof document === "undefined") return "";
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.slice(0, 200);
}

/** 全量白名单 token 现值（theme_read 数据源）。 */
export function readAllTokens(): { name: string; value: string; overridden: boolean }[] {
  return APPEARANCE_TOKENS.map((name) => ({
    name,
    value: readToken(name),
    overridden: overrides.has(name),
  }));
}

export function getOverrides(): Record<string, string> {
  return Object.fromEntries(overrides);
}

/** 唯一 DOM 出口：按 overrides 重放覆盖层（先清本层失效键，再写全集）。 */
function applyOverlay() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of [...appliedKeys]) {
    if (!overrides.has(k)) {
      root.style.removeProperty(k);
      appliedKeys.delete(k);
    }
  }
  for (const [k, v] of overrides) {
    root.style.setProperty(k, v);
    appliedKeys.add(k);
  }
  applied = appliedKeys.size > 0;
  changeCb?.(); // widgetHub 注册的广播（rAF 去抖：样式落地后采集并同步全部 iframe/小部件）
}

export function overlayActive(): boolean {
  return applied;
}

export interface PatchResult {
  ok: boolean;
  err?: string;
  applied?: string[];
  undoToken?: string;
}

/** 应用一组 token 覆盖；整体原子（任一非法则整批拒绝，与 settings_apply 同语义）。 */
export function patchTokens(tokens: Record<string, string>): PatchResult {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { ok: false, err: "invalid_patch_shape" };
  }
  const entries = Object.entries(tokens);
  if (!entries.length) return { ok: false, err: "empty_patch" };
  for (const [name, value] of entries) {
    if (!TOKEN_SET.has(name)) return { ok: false, err: `unknown_token:${name}` };
    if (typeof value !== "string" || !isValidTokenValue(name, value)) {
      return { ok: false, err: `invalid_value:${name}` };
    }
  }
  // 撤销快照：记录每个受影响 token 的前值（含「原本无覆盖」）
  const before: Record<string, string | null> = {};
  for (const [name] of entries) before[name] = overrides.get(name) ?? null;
  for (const [name, value] of entries) overrides.set(name, value.trim());
  try {
    applyOverlay();
  } catch (e) {
    // Harness「被拒写入 reload 持久值」语义：apply 异常即整批回滚到 patch 前
    for (const [name, prev] of Object.entries(before)) {
      if (prev === null) overrides.delete(name);
      else overrides.set(name, prev);
    }
    applyOverlay();
    return { ok: false, err: `apply_failed:${String(e).slice(0, 120)}` };
  }
  const token = crypto.randomUUID();
  undoHistory.set(token, before);
  return { ok: true, applied: entries.map(([n]) => n), undoToken: token };
}

export type OverlayUndoResult = "undone" | "token_expired";

/** 撤销一次 patch（恢复受影响 token 的前值；原先无覆盖的键移除）。 */
export function undoOverlayDetailed(token: string): OverlayUndoResult {
  const before = undoHistory.get(token);
  if (!before) return "token_expired";
  for (const [name, prev] of Object.entries(before)) {
    if (prev === null) overrides.delete(name);
    else overrides.set(name, prev);
  }
  undoHistory.delete(token);
  applyOverlay();
  return "undone";
}

export function undoOverlay(token: string): boolean {
  return undoOverlayDetailed(token) === "undone";
}

/** 清空覆盖层（保存为主题扩展后由扩展层接管；撤销历史随之作废）。 */
export function clearOverlay() {
  overrides.clear();
  undoHistory.clear();
  applyOverlay();
}
