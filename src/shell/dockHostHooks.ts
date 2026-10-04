/**
 * P143-B：第三方停靠框架的 DOM → 宿主词汇的**唯一一处**翻译。
 *
 * 为什么要有这张表：dockview 自己画页签条与分隔条，类名（`.dv-tab` / `.dv-sash`）是它的私有财产。
 * 以前样式表直接指着这些类名写规则，于是"第三方改个类名"就等于**主题层当场静默失效**
 * ——§8-58 那次一个升级让三处一起死，就是这条路的账。
 * 现在只在这里认识 `.dv-*`：宿主往外说的是 `data-ctl`，主题层也只锁 `data-ctl`。
 * 升级时坏点从"N 个样式表 × M 条规则"收成"这张表里的一行"，而且
 * `dockHostHooks.test.ts` 会拿装好的 dockview 样式表核对每个源类名还在不在——
 * 改名在测试里红，不在用户脸上红。
 */
import type { CtlHook } from "../styles/hostHooks";

/** 源类名 → 宿主角色。只允许 `.dv-*` 出现在这张表里（有测试钉这条）。 */
export const DOCK_HOOK_MAP: readonly { source: string; ctl: CtlHook }[] = [
  { source: ".dv-tab", ctl: "tab" },
  { source: ".dv-tabs-and-actions-container", ctl: "tablist" },
  { source: ".dv-sash", ctl: "sash" },
];

/**
 * 就地补钩子：给表里每个源选择器命中的元素挂上 `data-ctl`。
 * 幂等——已经挂过的跳过，所以 MutationObserver 反复调它没有副作用。
 * 返回本次**新挂**的元素数（测试与排查用它，不返回 DOM 细节）。
 */
export function applyDockHooks(root: ParentNode): number {
  let added = 0;
  for (const { source, ctl } of DOCK_HOOK_MAP) {
    for (const el of root.querySelectorAll(source)) {
      if (el.getAttribute("data-ctl") === ctl) continue;
      el.setAttribute("data-ctl", ctl);
      added++;
    }
  }
  return added;
}

/**
 * 跟着停靠框架的 DOM 变化持续补（页签会增删、会重排）。
 * 只监听 `class` 属性与子树结构：我们自己写的 `data-ctl` 不在监听范围里，
 * 所以这条不会自激（上一批同类实现就是栽在观察自己写的属性上，回头就是一个死循环）。
 */
export function watchDockHooks(root: ParentNode): () => void {
  applyDockHooks(root);
  if (typeof MutationObserver === "undefined") return () => {};
  const mo = new MutationObserver(() => applyDockHooks(root));
  mo.observe(root as Node, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });
  return () => mo.disconnect();
}
