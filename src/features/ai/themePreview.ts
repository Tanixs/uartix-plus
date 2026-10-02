/**
 * P131-B3：主题**预览**的那一格状态（叶子，不落盘）。
 *
 * 存在的理由（详设 §A7）：想"看一眼另一枚主题" currently 只有两条路——
 * 装上（`save_theme_extension` 会装成真插件）或改设置（那是用户的决定，不该由 AI 代）。
 * 预览是第三条：**画在屏幕上，但什么都不写**。刷新即无，也不进插件库。
 *
 * 三条口径写在这里，因为它们各自都对应过真实的坑：
 *  1. **唯一的写者只有 `applyStyleExts()` 读**——预览不许自己去碰 `dataset.theme`。
 *     那会绕过合成器造出第二个"谁在画"的真相（P98-M0 拆掉的就是这类东西）；
 *  2. **到期时间存在记录里，不靠计时器准**。计时器只负责"到点叫醒重合成"；
 *     即使它被后台节流拖慢，`applyStyleExts()` 每次都会自己核对 `expiresAt`，
 *     所以屏幕上不可能留下一个已过期的预览（这一条在 node 里可直接断言）；
 *  3. **不持久化**：这里没有 store、没有 localStorage。刷新回到设置里那枚真主题，
 *     这是"预览"两个字的全部含义。
 */

export interface ThemePreview {
  /** 内置主题 id 或插件影子扩展 id */
  id: string;
  /** 绝对到期时刻（Date.now() 毫秒）；过期即视为没有预览 */
  expiresAt: number;
}

const MAX_PREVIEW_MS = 60_000;
export const DEFAULT_PREVIEW_MS = 12_000;
export const PREVIEW_MAX_MS = MAX_PREVIEW_MS;

let current: ThemePreview | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
/** 到期叫醒时要跑的那次重合成由宿主注入（叶子不认识 extRuntime，避免反向依赖） */
let onExpire: (() => void) | null = null;

export function setThemePreview(preview: ThemePreview, resync: () => void): void {
  current = { ...preview };
  onExpire = resync;
  if (wakeTimer !== null) clearTimeout(wakeTimer);
  const ms = Math.max(0, preview.expiresAt - Date.now());
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    current = null;
    onExpire?.();
  }, ms);
}

/** 过期的预览一律读作 null：判据与计时器无关 */
export function getThemePreview(): ThemePreview | null {
  if (!current) return null;
  if (current.expiresAt <= Date.now()) {
    current = null;
    return null;
  }
  return current;
}

export function clearThemePreview(): boolean {
  const had = current !== null;
  current = null;
  if (wakeTimer !== null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  return had;
}

/** 给界面/AI 看的剩余秒数（没有预览返回 null，不返回 0 冒充"还剩 0 秒"） */
export function previewSecondsLeft(): number | null {
  const p = getThemePreview();
  if (!p) return null;
  return Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
}

/** 归一化调用方给的秒数：越界就夹，非数就回落默认档（回执里会说实际用了多少） */
export function clampPreviewSeconds(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PREVIEW_MS / 1000;
  return Math.min(Math.max(Math.round(n), 2), MAX_PREVIEW_MS / 1000);
}
