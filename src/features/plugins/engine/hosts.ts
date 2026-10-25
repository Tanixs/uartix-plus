/**
 * P174：新市场通道的**唯一放行域表**。
 *
 * 旧市场的 `marketIndex.ts` 随旧系统一起删除；这张表是它留下的唯一还在使用的东西
 * （`market_fetch` 的白名单）。加域仍是一次信任面变更，只许改这一处。
 */
export const MARKET_ALLOW_HOSTS = [
  "raw.githubusercontent.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
] as const;

/** 从同一张表派生的两个入口，避免各模块各写一遍 `find`。 */
export const MARKET_API_HOST = MARKET_ALLOW_HOSTS.find((h) => h.startsWith("api.")) ?? "";
export const MARKET_RAW_HOST = MARKET_ALLOW_HOSTS.find((h) => h.startsWith("raw.")) ?? "";
