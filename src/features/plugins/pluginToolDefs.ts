/**
 * P99a-B2：**已登记插件工具定义**的存放处（plugins 层，不含 Agent 的 entry 形状）。
 *
 * 为什么插件层只存"定义"而不直接造 `AgentToolEntry`：entry 上带着 `effect/domain/assess/审批`
 * 这些**宿主侧权力**，它们的判定归 agent 层（`agent/pluginTools.ts`）。这一层只管"哪些包报了
 * 哪些名字、还在不在"，方向是 plugins ← agent，不反过来（反了就成环）。
 *
 * 上限来自详设 §5.4，且只在 `pluginLimits.ts` 写一次。
 */
import { PLUGIN_TOOLS_MAX_GLOBAL, PLUGIN_TOOLS_MAX_PER_PKG } from "./pluginLimits";

export interface PluginToolDef {
  pkgId: string;
  pkgName: string;
  version: string;
  /** 插件自报的裸名（前缀化在 agent 层做，这里不碰权力相关的东西） */
  baseName: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 登记那一刻包声明的 caps 快照：agent 层据此派生 effect/mayTouchDevice（权力不来自插件自报） */
  caps: string[];
}

let store = new Map<string, PluginToolDef[]>();
const listeners = new Set<() => void>();

function emit(): void {
  store = new Map(store);
  for (const fn of listeners) fn();
}

/** 订阅"工具面变了"（插件库徽标用；Agent 不订阅——它每 run 取一次快照）。 */
export function subscribePluginToolDefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 当前全部在册定义（run 起点快照一次，run 内不扩权）。 */
export function allPluginToolDefs(): PluginToolDef[] {
  return [...store.values()].flat();
}

export function pluginToolDefsOf(pkgId: string): PluginToolDef[] {
  return store.get(pkgId) ?? [];
}

export interface RegisterResult {
  ok: boolean;
  added: string[];
  rejected: { name: string; reason: string }[];
  msg: string;
}

/**
 * 整包替换式登记：包重新声明它的工具集时，旧那批一起撤。
 * 增量登记会堆出"改了代码就多一支同名工具"的僵尸面，注销不掉。
 */
export function replacePluginToolDefs(pkgId: string, defs: PluginToolDef[]): RegisterResult {
  const others = allPluginToolDefs().filter((d) => d.pkgId !== pkgId);
  const added: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const seen = new Set(others.map((d) => `${d.pkgId}\u0000${d.baseName}`));
  for (const d of defs) {
    if (added.length >= PLUGIN_TOOLS_MAX_PER_PKG) {
      rejected.push({ name: d.baseName, reason: `每个插件最多 ${PLUGIN_TOOLS_MAX_PER_PKG} 支工具` });
      continue;
    }
    if (others.length + added.length >= PLUGIN_TOOLS_MAX_GLOBAL) {
      rejected.push({ name: d.baseName, reason: `全局动态工具已达上限 ${PLUGIN_TOOLS_MAX_GLOBAL} 支` });
      continue;
    }
    const key = `${d.pkgId}\u0000${d.baseName}`;
    if (seen.has(key)) {
      rejected.push({ name: d.baseName, reason: "同包同名工具重复登记" });
      continue;
    }
    seen.add(key);
    added.push(d.baseName);
  }
  if (added.length) {
    store.set(pkgId, defs.filter((d) => added.includes(d.baseName)));
    emit();
  } else {
    // 一支都没收下：这个包的工具面清空（不留"上次登记的那批还在"的悬挂状态）
    if (store.delete(pkgId)) emit();
  }
  return {
    ok: added.length > 0 && rejected.length === 0,
    added,
    rejected,
    msg: rejected.length
      ? `登记 ${added.length} 支，拒绝 ${rejected.length} 支：${rejected.map((r) => `${r.name}（${r.reason}）`).join("；")}`
      : `已登记 ${added.length} 支工具`,
  };
}

/**
 * 逐支登记（插件侧 `uartix.tools.register()` 一次报一支）：同名就地覆盖，其余保留。
 * 上限判定复用 `replacePluginToolDefs`，不在这里再抄一份算术。
 */
export function addPluginToolDefs(defs: PluginToolDef[]): RegisterResult {
  if (!defs.length) return { ok: true, added: [], rejected: [], msg: "没有需要登记的工具" };
  const pkgId = defs[0].pkgId;
  const keep = pluginToolDefsOf(pkgId).filter((d) => !defs.some((n) => n.baseName === d.baseName));
  return replacePluginToolDefs(pkgId, [...keep, ...defs]);
}

/** 注销一个包的若干工具（裸名）；整包停用/卸载走 clearPluginTools。 */
export function removePluginTools(pkgId: string, names: string[]): void {
  const cur = store.get(pkgId);
  if (!cur) return;
  const keep = cur.filter((d) => !names.includes(d.baseName));
  if (keep.length === cur.length) return;
  if (keep.length) store.set(pkgId, keep);
  else store.delete(pkgId);
  emit();
}

export function clearPluginTools(pkgId: string): void {
  if (store.delete(pkgId)) emit();
}

/** 全清（测试与"关掉整个插件逻辑面"的应急出口用）。 */
export function clearAllPluginTools(): void {
  if (store.size) {
    store = new Map();
    emit();
  }
}
