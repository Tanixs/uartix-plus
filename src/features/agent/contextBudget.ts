/**
 * P110-B2：上下文预算的**算术叶子**（零 import，因此结构上不可能参与循环 —— 图上已经
 * 挂着一个 22 节点的强连通分量，`check-import-cycles` 盯的就是这类事）。
 *
 * 为什么要单独立一份：这批开始，"还能发多少"同时被**两个**分母管着，而它们含义完全不同：
 *  1. **模型窗口**（`contextTokens`，用户在档案表里填的那个数）—— 决定什么时候该折叠历史；
 *  2. **传输保险丝**（宿主侧 2 MiB 的 76%）—— 决定请求会不会在网络上被撞断。
 * 旧实现只有第 2 条的一半（`context.ts` 的软顶）加一个跟模型无关的 12000 字符常量，
 * 于是出现过"仪表显示 1%、其实正在丢 36 条历史"那种谎（详设 §2.1）。
 *
 * 两个换算常数**都偏保守**，且各有分工，不合并成一个：
 *  - `CHARS_PER_TOKEN_EST`：字符→token（1 字符折算 0.5 token，即 2 字符/token。英文约 4 字符/token、
 *    中文约 1 字 ≈ 1 token；混排取 2 是往"少算容量"那侧靠 —— 宁可早折叠，也别撞上游硬截断）；
 *  - `BYTES_PER_CHAR_EST`：字符→UTF-8 字节（中文 3、ASCII 1，混排 1.6）。
 * 不引入 tokenizer：这条口径与 P95 那句"以字节/字符近似估算"是同一个决定。
 */

/** Rust 侧 2 MiB 是最终裁判；前端取 ~76% 作软顶，留协议外壳/转义/工具定义的估算误差 */
export const REQUEST_SOFT_LIMIT = 1_600_000;
/** 混排下一个字符折多少 UTF-8 字节 */
export const BYTES_PER_CHAR_EST = 1.6;
/** 混排下多少个字符折一个 token */
export const CHARS_PER_TOKEN_EST = 2;
/**
 * 自动压缩阈值：**占模型窗口的比例**。
 * 0.6 是用户 2026-09-27 点的名（对齐 Qoder 那类宿主的 60% 自动压缩）。
 * 对照事实：DeepSeek Harness 的官方 compaction 用的是
 * `floor(min(W×0.8, W−O−65536))`，即 **80%** —— 所以这里做成设置项
 * `aiCompactRatio`（0.4~0.9）而不是在代码里替用户选边站。
 */
export const CTX_FILL_RATIO_DEFAULT = 0.6;
export const CTX_FILL_RATIO_MIN = 0.4;
export const CTX_FILL_RATIO_MAX = 0.9;
/** 没配模型档案时的兜底预算：12000 字 ≈ 6k token，够一长段对话又不至于撞任何线 */
export const FALLBACK_HISTORY_CHAR_BUDGET = 12_000;
/** 手动压缩的下限：再小就只剩"本轮目标 + 最近一问一答"，不如让用户开新会话 */
export const MIN_HISTORY_BUDGET = 2_000;

/** 传输保险丝折算成的字符上限（两条线里更硬的那一条封顶用） */
export const TRANSPORT_CHAR_CAP = Math.floor(REQUEST_SOFT_LIMIT / BYTES_PER_CHAR_EST);

/** 模型窗口的字节容量（估算）：窗口 token × 每 token 字符数 × 每字符字节数 */
export function capacityBytes(contextTokens: number): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0;
  return contextTokens * CHARS_PER_TOKEN_EST * BYTES_PER_CHAR_EST;
}

/**
 * 会话历史的字符预算 = min(窗口 × 压缩比例 × 每 token 字符数, 传输保险丝)。
 * `contextTokens` 不合法（没配档案）时退回兜底值，**不返回 0**：
 * 预算 0 会让历史整段消失，那是比"没压缩"更坏的失败。
 */
export function historyCharBudget(
  contextTokens: number,
  ratio: number = CTX_FILL_RATIO_DEFAULT,
  hardCapChars: number = TRANSPORT_CHAR_CAP,
): number {
  const r = Number.isFinite(ratio) ? Math.min(CTX_FILL_RATIO_MAX, Math.max(CTX_FILL_RATIO_MIN, ratio)) : CTX_FILL_RATIO_DEFAULT;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return Math.max(MIN_HISTORY_BUDGET, Math.min(FALLBACK_HISTORY_CHAR_BUDGET, hardCapChars));
  }
  const byWindow = Math.floor(contextTokens * r * CHARS_PER_TOKEN_EST);
  return Math.max(MIN_HISTORY_BUDGET, Math.min(byWindow, hardCapChars, FALLBACK_HISTORY_CHAR_BUDGET * 40));
}

/**
 * 手动压缩：在当前预算上再收一档（减半、夹在下限之上）。
 * 到顶就原样返回 —— 调用方据此禁用按钮并说明原因，不许"点了没反应"。
 */
export function tightenHistoryBudget(current: number, floor: number = MIN_HISTORY_BUDGET): number {
  if (!Number.isFinite(current) || current <= floor) return floor;
  return Math.max(floor, Math.round(current / 2));
}

/** 128000 → "128k"；仪表里那点地方要短 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "?";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export type GaugeLevel = "ok" | "warn" | "danger";
/** 窗口用量阈值：与传输那条同一组比例（80% 黄、90% 红），只在一份文件里定义 */
export const WINDOW_WARN_RATIO = 0.8;
export const WINDOW_DANGER_RATIO = 0.9;

/**
 * 窗口那一路的仪表。**与 `ctxGauge`（传输）是两个数、两条含义，不许合成一个**。
 * 返回的 text 刻意不含中文：单位与百分比是数，标签由界面层用 `tx()` 说（i18n 扫描器
 * 吃 .ts 里的中文字面量，把话术塞进这层会顶破"预算只降不升"那道门）。
 */
export function windowGauge(
  bytes: number,
  contextTokens: number,
  fillRatio: number = CTX_FILL_RATIO_DEFAULT,
): { pct: number; text: string; level: GaugeLevel; toFill: boolean } {
  const cap = capacityBytes(contextTokens);
  const pct = cap > 0 ? Math.min(100, Math.round((bytes / cap) * 100)) : 0;
  const fillPct = Math.round(fillRatio * 100);
  return {
    pct,
    text: `${pct}% / ${fmtTokens(contextTokens)} · ${fillPct}%`,
    level: pct >= WINDOW_DANGER_RATIO * 100 ? "danger" : pct >= WINDOW_WARN_RATIO * 100 ? "warn" : "ok",
    // 到没到"该压缩"的线：这是"手动压缩"按钮该不该亮着的依据，不是颜色
    toFill: cap > 0 && bytes >= cap * fillRatio,
  };
}
