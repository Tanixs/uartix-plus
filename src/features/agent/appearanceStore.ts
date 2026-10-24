/**
 * P88b-4 A：外观覆盖层（借鉴 DeepSeek Harness ui-theme「快照 + ctx.theme 别名覆盖」模型）。
 * - overrides 是唯一真源（token→值）；DOM 落地在 P98-M0 交给 `styles/rootVars` 合成器（本层只提交源，
 *   不再自己 removeProperty）。**旧注释写的"各层只管自己的键、层叠天然成立"是错的前提**——
 *   插件主题层与本层会写同一个 `--radius-md`，各自删自己的键就会互相抹掉；
 * - 白名单之外的 token 一律拒绝；部分覆盖合法，未覆盖键回退内置主题（Harness 无完整性校验语义）；
 * - 撤销/清层 = 本层提交更小的集合后由合成器重算，绝不触碰 8 个内置主题文件
 *   （Harness「移除第三方主题绝不覆盖内置持久偏好」）；
 * - data-theme 切换只改样式表、不清 inline，覆盖层天然存续（等效 Harness Theme Watchdog）；
 *   保存为主题扩展后清层，由扩展层接管——保存即持久化边界，此后撤销令牌失效。
 * - 值校验：长度上限 + 禁 CSS 结构字符（;{}）+ 单位类 token 白名单格式，防注入与误值。
 *
 * 依赖方向：本模块不 import 任何 ai/ 模块（extRuntime/widgetHub 均引 chatStore，静态引入会与
 * chatStore→agentRun→agentAdapter→本模块构成循环）；iframe 广播经 setOverlayChangeCb 由 widgetHub 注册。
 * `styles/rootVars` 是零 import 叶子，两侧都可静态引，不构成环（§8-33）。
 */
import { ROOT_LAYER, setRootVarsChangeCb, submitRootVars } from "../../styles/rootVars";
import {
  SURFACE_PROBE_KEYS,
  judgeSurfaceLadder,
  type Rgba,
  type SurfaceIssue,
  type SurfaceProbeKey,
} from "../../styles/themeCore";

/** 覆盖层在合成器里的身份（面板按这个 id 报告"谁改了外观"） */
export const OVERLAY_LAYER_ID = "agent-overlay";

/**
 * 覆盖层变更回调（widgetHub 注册 broadcastTheme；避免循环 import 的解耦点）。
 * P98-M1 改成监听器集合：外观来源面板也要订阅"AI 到底改了几项"，
 * 而单一槽位会被 widgetHub 占掉 ⇒ 谁后注册谁把前者挤掉，面板就再也不更新。
 */
const changeCbs = new Set<() => void>();
export function setOverlayChangeCb(cb: (() => void) | null) {
  changeCbs.clear();
  if (cb) changeCbs.add(cb);
}
/** 订阅覆盖层变更，返回退订（面板 useSyncExternalStore 用） */
export function subscribeOverlayChange(cb: () => void): () => void {
  changeCbs.add(cb);
  return () => changeCbs.delete(cb);
}

// 插件主题层变更也要广播给 iframe/小部件：合成器是唯一公共出口，把它的通知转发到本层回调上
setRootVarsChangeCb(() => changeCbs.forEach((f) => f()));

/**
 * P99b-N5：白名单本体搬到 `styles/themeCore`（零 import 叶子）。
 * 为什么要搬：这批开始"哪些键算合法"同时管着三件事——AI 覆盖层、插件主题产物、样式表引用；
 * 留在 features/agent 里，features/plugins/artifact.ts 校验一个主题包就得反向 import agent。
 */
export { APPEARANCE_TOKENS, type AppearanceToken } from "../../styles/themeCore";
import { APPEARANCE_TOKENS } from "../../styles/themeCore";

const TOKEN_SET = new Set<string>(APPEARANCE_TOKENS);

/** 单位类 token（字号/圆角/时长）值格式；--ease 另有曲线白名单 */
const UNIT_RE = /^\d+(\.\d+)?(ms|px)$/;
const EASE_RE = /^(cubic-bezier\([^;{}]{1,60}\)|linear|ease|ease-in|ease-out|ease-in-out)$/;

/**
 * P103：布局类 token 的**值域**（前缀 → 允许区间）。
 *
 * 为什么要收窄：`--ctl-h-2` 这类键落在白名单的"其余放宽"分支里，模型把面板头写成
 * `200px` 也照样通过——布局类旋钮一旦能写崩，"AI 能改布局"就等于不能用。
 * 这不是限制能力，是让能力可用（写崩的界面谁也改不回来）。
 * 证伪：`isValidTokenValue("--ctl-h-2","200px")` 必须为 false。
 */
const PX_RANGE_BY_PREFIX: [RegExp, number, number][] = [
  [/^--ctl-h-/, 18, 40],
  [/^--sp-/, 0, 48],
];
/** 行高无单位（1 ~ 2.4）；`26px` 这种必须被拒 */
const LH_RANGE: [number, number] = [1, 2.4];

/** 值合法性：拒绝 CSS 结构字符防注入；单位类 token 校验格式；布局类校验区间；其余放宽。 */
export function isValidTokenValue(name: string, value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 120 || /[;{}]/.test(v)) return false;
  if (/^--(fs-|radius-|dur-)/.test(name)) return UNIT_RE.test(v);
  if (name === "--ease") return EASE_RE.test(v);
  for (const [re, min, max] of PX_RANGE_BY_PREFIX) {
    if (!re.test(name)) continue;
    const m = /^(\d+(?:\.\d+)?)(px)$/.exec(v);
    if (!m) return false; // 必须带单位：无单位的 24 会让 `height: var(--ctl-h-2)` 变成非法值
    const n = Number(m[1]);
    return n >= min && n <= max;
  }
  if (/^--lh-/.test(name)) {
    const m = /^(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= LH_RANGE[0] && n <= LH_RANGE[1];
  }
  return true;
}

/** 当前会话覆盖层（token→值）。 */
const overrides = new Map<string, string>();

/** 撤销历史：undoToken → 受影响 token 的前值（null = 原本无 inline 覆盖）。仅本次运行内有效。 */
const undoHistory = new Map<string, Record<string, string | null>>();

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

/**
 * 唯一 DOM 出口：把本层整份提交给根变量合成器（P98-M0）。
 * 这里**不再自己 removeProperty**——清层＝提交更小的集合，由合成器重算，
 * 因此撤掉覆盖层不会连带抹掉插件主题层写在同名键上的值。
 * 广播也不在这里发：合成器只在"有效值真的变了"时通知（见文件顶部的 setRootVarsChangeCb），
 * 自己再补一次就是双重广播——P88b-4 C2 那条"每次变更恰好广播一次"的测试当场红给我看。
 */
function applyOverlay() {
  submitRootVars(OVERLAY_LAYER_ID, ROOT_LAYER.agentOverlay, Object.fromEntries(overrides));
}

/**
 * computed 值 → RGBA。真机实测（Edge/Chromium 141）一共三种形状：
 *  - `rgb(22, 26, 32)` / `rgba(22, 26, 32, 0.72)` / `rgb(22 26 32 / 72%)` —— 字面量与 var 指到的值；
 *  - `color(srgb 0.151529 0.166902 0.190118)` —— **`color-mix(in srgb, …)` 的结果就是这一种**，
 *    不是 `rgb(...)`。第一版只认 `rgb` 系，于是探针把派生档一律读成"读不到"，
 *    模型写 `--raise-1: color-mix(...)` 时守卫静默放行（真机验证抓出来的，测试里钉了那条原样串）。
 *  - 认不出的（`lab()` / `oklab()` / `color(display-p3 ...)`）返回 null：**不猜颜色**。
 */
export function parseComputedRgba(s: string): Rgba | null {
  const v = s.trim();
  let m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(v);
  if (m) {
    const chan = (x: string) => Math.max(0, Math.min(255, Number(x) * 255));
    return { r: chan(m[1]), g: chan(m[2]), b: chan(m[3]), a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))) };
  }
  m = /^rgba?\(\s*([\d.]+)(%?)[,\s]+([\d.]+)(%?)[,\s]+([\d.]+)(%?)(?:[,/\s]+([\d.]+)(%?))?\s*\)$/.exec(v);
  if (!m) return null;
  const chan = (val: string, pct: string) => (pct === "%" ? (Number(val) * 255) / 100 : Number(val));
  const [r, g, b] = [chan(m[1], m[2]), chan(m[3], m[4]), chan(m[5], m[6])];
  if ([r, g, b].some((x) => !Number.isFinite(x))) return null;
  let a = 1;
  if (m[7] !== undefined) a = m[8] === "%" ? Number(m[7]) / 100 : Number(m[7]);
  // `rgba(0, 0, 0, 0)` 是"这枚 var 根本没有值"的序列化形式（真机实测：theme.css 没加载时，
  // 探针读 `var(--bg-panel)` 得到的就是它）。它和"作者显式写了 transparent"**无法区分**，
  // 而把它当成读到的颜色去判，等于让守卫拿全零值算方向。取"读不到"这一侧：
  // 宁可放行一次，也不在环境没准备好的时候撤掉用户写的值。
  if (a === 0 && r === 0 && g === 0 && b === 0) return null;
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

/**
 * P110-A：把一组 token 键**施加后**的实际颜色读回来。
 *
 * 为什么要绕这一圈而不是解析字符串：`--raise-1` 的内置值是
 * `color-mix(in srgb, var(--bg-panel) 92%, var(--text) 8%)`，主题/覆盖层也能写成任何
 * 只有浏览器算得出的形式 —— 字符串层判"它比面板亮还是暗"必错（详设 §3′.1）。
 * 做法是挂一个 display:none 的探针元素，把 `background-color` 逐键指到那个 var 上，
 * 读回来的 computed 值就是解析完成的 RGBA（color-mix / var 链 / hsl 一视同仁）。
 */
export function probeSurfaceColors(
  keys: readonly SurfaceProbeKey[] = SURFACE_PROBE_KEYS,
): Partial<Record<SurfaceProbeKey, Rgba | null>> {
  const out: Partial<Record<SurfaceProbeKey, Rgba | null>> = {};
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return out;
  const host = document.body || document.documentElement;
  if (!host) return out;
  try {
    const el = document.createElement("div");
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
    host.appendChild(el);
    try {
      const cs = getComputedStyle(el);
      for (const k of keys) {
        el.style.backgroundColor = `var(${k})`;
        out[k] = parseComputedRgba(cs.backgroundColor || "");
      }
    } finally {
      el.remove();
    }
  } catch {
    // 探针抛错＝这个环境根本不提供 CSS 求值（假 DOM 的 `createElement` 是 undefined、
    // jsdom 不认 color-mix）。返回空表让守卫判"读不到＝不判"，
    // 绝不能把"读不到"当成"读出来不合格"——那等于在没有浏览器的地方撤用户的值。
    return {};
  }
  return out;
}

/** 这几枚键一改就可能把表面阶梯弄坏，值得跑一次探针；其余（字号/圆角/动效）不相关也不该付这个钱 */
const LADDER_WATCHED = new Set<string>(["--text", ...SURFACE_PROBE_KEYS]);

/** 撤掉"确实会弄坏界面"的那几项，其余原样生效。返回值进 PatchResult 的 dropped/warned。 */
function guardLadder(
  patchedKeys: string[],
  probe: () => Partial<Record<SurfaceProbeKey, Rgba | null>>,
): { dropped: SurfaceIssue[]; warned: SurfaceIssue[] } {
  if (!patchedKeys.some((k) => LADDER_WATCHED.has(k))) return { dropped: [], warned: [] };
  const colors = probe();
  // 一枚都没读回来 = 没有真 CSS 引擎（node 测试、探针环境缺 DOM）。
  // 这时候**不能**把"读不到"当成"读出来不合格"：那会让守卫在没有 DOM 的地方静默撤掉用户的值。
  if (!Object.values(colors).some((v) => v)) return { dropped: [], warned: [] };
  const issues = judgeSurfaceLadder(colors);
  const dropped: SurfaceIssue[] = [];
  const warned: SurfaceIssue[] = [];
  for (const i of issues) {
    // 只撤**本次写的**键。上一次 patch 留下的值因为这次改动而变得不合格，撤它等于凭空动用户没碰的东西——
    // 那种事必须说出来让他决定，不能顺手做掉。
    if (i.fatal && patchedKeys.includes(i.key)) {
      overrides.delete(i.key);
      dropped.push(i);
    } else {
      warned.push(i.fatal ? { ...i, reason: `${i.reason}（不是本次写的键，未自动撤回）` } : i);
    }
  }
  if (dropped.length) applyOverlay();
  return { dropped, warned };
}

export function overlayActive(): boolean {
  return overrides.size > 0;
}

export interface PatchResult {
  ok: boolean;
  err?: string;
  applied?: string[];
  undoToken?: string;
  /** P110-A：施加后读回 computed 才发现不合格、已被撤回的键（格式合法但会把界面弄坏） */
  dropped?: SurfaceIssue[];
  /** 照实说但**照常生效**的那类：档差太小、阶梯倒置、半透明基础面（内置玻璃配方就是这一类） */
  warned?: SurfaceIssue[];
}

/**
 * 应用一组 token 覆盖。
 *
 * 两层校验，各管一件事（详设 §3′.1）：
 *  - **写入前**（下面的白名单 + `isValidTokenValue`）：能不能写进 CSS —— 结构字符、单位、区间。
 *    这层不合格仍是**整批拒绝**（原子性不变，`unknown_token` / `invalid_value`）。
 *  - **施加后**（`guardLadder`）：写进去会不会把界面弄坏 —— 只能读回实际颜色才知道。
 *    这层是**逐键降级**：越界的键撤掉、其余照常生效、回执点名，因为"一枚值不合格"
 *    不该赔上另外十一枚已经改对的（用户 2026-09-27 裁决：别把能力限太死）。
 *
 * `probe` 是测试缝：node 环境里没有 CSS 引擎，`color-mix` 读回来是垃圾值，
 * 判据只能靠注入的假探针覆盖（见 appearanceStore 的 P110-A 那组用例）。
 */
export function patchTokens(
  tokens: Record<string, string>,
  probe: () => Partial<Record<SurfaceProbeKey, Rgba | null>> = probeSurfaceColors,
): PatchResult {
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
  const { dropped, warned } = guardLadder(entries.map(([n]) => n), probe);
  const applied = entries.map(([n]) => n).filter((n) => overrides.has(n));
  if (!applied.length && dropped.length) {
    // 一枚都没剩下：撤销快照仍把状态清回去，别留一个"成功但什么都没改"的回执
    for (const [name, prev] of Object.entries(before)) {
      if (prev === null) overrides.delete(name);
      else overrides.set(name, prev);
    }
    applyOverlay();
    return {
      ok: false,
      err: `rejected_by_surface_guard:${dropped.map((d) => d.key).join(",")}`,
      dropped,
      warned,
    };
  }
  const token = crypto.randomUUID();
  undoHistory.set(token, before);
  return {
    ok: true,
    applied,
    undoToken: token,
    ...(dropped.length ? { dropped } : {}),
    ...(warned.length ? { warned } : {}),
  };
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
