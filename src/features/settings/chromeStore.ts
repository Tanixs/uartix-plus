/**
 * P103 批2：顶部工具栏三段（connect 接口参数 / session 会话 / layout 面板与布局）的排序与显隐。
 * 这是 `chrome_set` 工具与 App 工具栏渲染之间唯一的事实源；持久化到 localStorage（vs.chrome）。
 * 两条防线全在 normalizeChrome 里：段名白名单 + 缺段按默认序补齐（永不丢段）；不许三段全藏
 * （工具栏整排空掉就没有任何入口摸得回来）。node 测试环境没有 localStorage：读写全程 try/catch（P33 求值期纪律）。
 */
import { useSyncExternalStore } from "react";

export type ChromeSegId = "connect" | "session" | "layout";

/** 段的法定名单与默认顺序；将来加新段只动这里，旧存档由 normalize 自动补齐 */
export const CHROME_SEGS: readonly ChromeSegId[] = ["connect", "session", "layout"];

export interface ChromeState {
  order: ChromeSegId[];
  hidden: ChromeSegId[];
}

const KEY = "vs.chrome";
const DEFAULT_STATE: ChromeState = { order: [...CHROME_SEGS], hidden: [] };

const isSeg = (v: unknown): v is ChromeSegId =>
  typeof v === "string" && (CHROME_SEGS as readonly string[]).includes(v);

/** 归一化：非法/重复段名剔除、缺失段按默认序补尾（永不丢段）、三段全藏回落为全显 */
export function normalizeChrome(raw: unknown): ChromeState {
  const o = (raw && typeof raw === "object" ? raw : {}) as { order?: unknown; hidden?: unknown };
  const seen = new Set<ChromeSegId>();
  const order: ChromeSegId[] = [];
  if (Array.isArray(o.order)) {
    for (const v of o.order) {
      if (isSeg(v) && !seen.has(v)) {
        seen.add(v);
        order.push(v);
      }
    }
  }
  for (const s of CHROME_SEGS) if (!seen.has(s)) order.push(s);
  let hidden = Array.isArray(o.hidden) ? o.hidden.filter(isSeg) : [];
  if (order.every((s) => hidden.includes(s))) hidden = [];
  return { order, hidden };
}

function load(): ChromeState {
  try {
    return normalizeChrome(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_STATE;
  }
}

// 与 layoutsStore 同款：无条件 load()，坏环境（无 localStorage/脏 JSON）由 try/catch 回落默认
let snapshot: ChromeState = load();
const listeners = new Set<() => void>();

function emit() {
  snapshot = { ...snapshot };
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* 无 localStorage 的环境（node 测试）：状态照样在内存里生效 */
  }
  listeners.forEach((l) => l());
}

export function subscribeChrome(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getChrome(): ChromeState {
  return snapshot;
}

export function useChrome(): ChromeState {
  return useSyncExternalStore(subscribeChrome, getChrome);
}

/** 部分更新：order/hidden 各自可省；写完即归一化（非法值与「全藏」在这一步被拦住） */
export function patchChrome(p: { order?: ChromeSegId[]; hidden?: ChromeSegId[] }) {
  snapshot = normalizeChrome({
    order: p.order ?? snapshot.order,
    hidden: p.hidden ?? snapshot.hidden,
  });
  emit();
}

export function resetChrome() {
  snapshot = DEFAULT_STATE;
  emit();
}
