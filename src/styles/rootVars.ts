/**
 * P98-M0：根变量（`--*`）合成器 —— **单一写入者**。
 *
 * 为什么要有它（真机反馈："AI 改了按钮圆角/尺寸/阴影，停用和卸载插件都撤不回去"）：
 * 插件主题层（`extRuntime.applyStyleExts`）与 Agent 覆盖层（`appearanceStore.applyOverlay`）
 * **都往 `documentElement.style` 写同名变量**，而且各自记着"我写过哪些键"、各自 `removeProperty`。
 * 于是两件事同时成立：
 *   ① 谁后动手谁赢（不是设计出来的优先级，是调用顺序的巧合）；
 *   ② 清一层会**把另一层的值一起抹掉**——`save_theme_extension` 里 `setEnabled()` 刚把
 *      `--radius-md` 由插件写进 inline，紧接着 `clearOverlay()` 就按自己那份 `appliedKeys`
 *      把同一个键 remove 掉，而 `overrides` 已清空、之后再没人重放 ⇒ 存完主题当场失效，重启才回来。
 * 旧注释里"各层只管自己的键，层叠天然成立"这句前提是**错的**：两层会写同一个键。
 *
 * 所以修法不是"把调用顺序排小心点"，而是**取消多个写入者**：每层只提交自己的源，
 * 合成器重算整张表再写一次。"撤掉一层"于是等价于"重算"，**结构上不可能伤到另一层**。
 *
 * 依赖纪律：本模块**零 import**（叶子），`agent/` 与 `ai/` 两侧都可以静态引，不会闭环（§8-33）。
 * DOM 缺席（node/测试）时只更新内部状态，不抛错 ⇒ 合成规则可单测。
 */

/** 层的固定优先级：**数值大的赢**。新增层只准在这里加，不准靠调用顺序抢赢。 */
export const ROOT_LAYER = {
  pluginTheme: 10,
  agentOverlay: 20,
} as const;

export interface RootVarSource {
  id: string;
  order: number;
  vars: Record<string, string>;
}

/**
 * 纯函数：按 order 升序合成，后写的赢。
 * 同 order 时按 id 字典序定序 —— 否则结果会随 `Map` 插入顺序漂移，那种 bug 只在真机出现。
 */
export function composeRootVars(sources: readonly RootVarSource[]): Map<string, string> {
  const out = new Map<string, string>();
  const ordered = [...sources].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const s of ordered) {
    for (const [k, v] of Object.entries(s.vars)) out.set(k, v);
  }
  return out;
}

const sameMap = (a: Map<string, string>, b: Map<string, string>) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};

const sources = new Map<string, RootVarSource>();
let effective = new Map<string, string>();
let writtenKeys = new Set<string>();
let changeCb: (() => void) | null = null;

/** 变更广播出口（iframe/小部件的主题同步由 appearanceStore 转发 widgetHub 注册的回调） */
export function setRootVarsChangeCb(cb: (() => void) | null): void {
  changeCb = cb;
}

function apply(): void {
  const next = composeRootVars([...sources.values()]);
  // 值没变就一次 DOM 都不碰：避免多余重算，也让"广播"只在真的换装时发生
  if (sameMap(effective, next)) return;
  effective = next;
  // DOM 缺席（node/测试）只跳过落地：**"有效值变了"这件事与有没有 DOM 无关**，
  // 广播必须照发，否则主题桥在测试里等于没被覆盖过（第一版就把回调写在 return 之后了）。
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    for (const k of writtenKeys) if (!next.has(k)) root.style.removeProperty(k);
    for (const [k, v] of next) root.style.setProperty(k, v);
    writtenKeys = new Set(next.keys());
  }
  changeCb?.();
}

/** 提交/整量替换某一层的内容（层内键由调用方自己决定，合成器不看白名单） */
export function submitRootVars(id: string, order: number, vars: Record<string, string>): void {
  sources.set(id, { id, order, vars: { ...vars } });
  apply();
}

/** 撤掉整层。撤完由剩余层重算——这就是"逐层可撤且互不伤害"的实现点（证伪过：改成"删掉本层的键"必红） */
export function dropRootVars(id: string): void {
  if (!sources.delete(id)) return;
  apply();
}

/** 当前有效值（已按优先级合成）。测试与"外观来源面板"共用这一个口径 */
export function effectiveRootVars(): Record<string, string> {
  return Object.fromEntries(effective);
}

/** 哪些层正在供值（面板要显示"谁改了外观"） */
export function rootVarLayers(): { id: string; order: number; count: number }[] {
  return [...sources.values()]
    .map((s) => ({ id: s.id, order: s.order, count: Object.keys(s.vars).length }))
    .sort((a, b) => a.order - b.order);
}
