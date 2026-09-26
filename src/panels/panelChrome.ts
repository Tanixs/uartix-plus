import { useEffect, useRef, useSyncExternalStore, type ComponentType } from "react";

/**
 * P104-B10 面板 chrome 登记表：面板把自己的动作交上来，页签条负责摆放。
 *
 * 单独一个非组件模块（和 `shell/railState.ts` 同理由）：组件文件混导出函数会让
 * Fast Refresh 放弃热更新，而这里既被 `.tsx` 组件用、也被壳层用。
 *
 * 为什么是"面板登记"而不是"页签组件按 id dispatch 一个字符串事件"：
 * 后者没有编译期任何东西能发现写错，症状是"点了没反应"——这仓库已经吃过三次这类账
 * （`data-tour` 锚点、`panel.window` 属性、`ux:focus-link`）。动作的实现留在面板里，
 * 页签只决定"哪几颗上一级、哪几颗折进 ⋯"。
 */

export interface ChromeAction {
  id: string;
  /** 短名，已 tx() 过 */
  label: string;
  /** 长说明：面板里原来那段 tooltip 原样搬过来 */
  title: string;
  Icon: ComponentType<{ size?: number }> | null;
  /** 开关型动作的激活态 */
  on?: boolean;
  disabled?: boolean;
  /** 破坏性 ⇒ 一律折进 `⋯`，不占一级位 */
  danger?: boolean;
  run: () => void;
  /**
   * 下拉型动作（B10 铺开时用户拍的：二级面板里允许放下拉）。
   * 给了它就不是按钮，渲染成一只紧凑 select；
   * **它同样占一级名额** —— 页签条的宽度是硬约束，不能因为它不是按钮就白占。
   * `run` 在这种动作上不用（值从 `onChange` 走）。
   */
  select?: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
  };
}

interface Entry {
  get: () => ChromeAction[];
  sig: string;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

/** 只数"看得见的差别"：闭包每次渲染都是新的，拿数组本身比会每次都判成变了 */
const sigOf = (items: ChromeAction[]) =>
  items
    .map(
      (a) =>
        `${a.id}:${a.on ? 1 : 0}:${a.disabled ? 1 : 0}:${a.danger ? 1 : 0}:${a.label}:${a.select?.value ?? ""}:${a.select?.options.length ?? 0}`,
    )
    .join("|");

function notify(): void {
  version++;
  listeners.forEach((f) => f());
}

/** 面板每渲染一次就调一遍；签名没变就不惊动订阅者（2D 曲线在数据流下 30fps 重渲染） */
function sync(id: string, items: ChromeAction[]): void {
  const sig = sigOf(items);
  const e = entries.get(id);
  if (e && e.sig === sig) return;
  if (e) e.sig = sig;
  else entries.set(id, { get: () => items, sig });
  // items 换了新闭包，getter 必须指向新的那份
  entries.get(id)!.get = () => items;
  notify();
}

export function getPanelChrome(id: string): ChromeAction[] {
  return entries.get(id)?.get() ?? [];
}

export function subscribePanelChrome(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** `useSyncExternalStore` 的快照：必须是原始值，返回数组会每帧判成"变了" */
export function panelChromeVersion(): number {
  return version;
}

export function unregisterPanelChrome(id: string): void {
  if (!entries.delete(id)) return;
  notify();
}

/**
 * 面板侧登记。两次 effect：
 *  - 挂载/换 id 时建立与注销条目；
 *  - **每次渲染后**同步一次（提交后跑，不在渲染期惊动订阅者）。
 */
export function usePanelChrome(id: string, items: ChromeAction[]): void {
  const ref = useRef(items);
  ref.current = items;
  useEffect(() => {
    sync(id, ref.current);
    return () => unregisterPanelChrome(id);
  }, [id]);
  useEffect(() => {
    sync(id, ref.current);
  });
}

/** 页签侧读取：跟着面板的重渲染走 */
export function usePanelChromeFor(id: string | undefined): ChromeAction[] {
  useSyncExternalStore(subscribePanelChrome, panelChromeVersion);
  return id ? getPanelChrome(id) : [];
}

/** 一级动作上限：超过就折进 `⋯`（合同 §8 B10 那条"一级动作 ≤5"） */
export const CHROME_PRIMARY_MAX = 5;

/**
 * 一级 / 溢出怎么分。
 *
 * 下拉**永远占一级**：一只 select 折进 `⋯` 菜单里既没法点选也看不出当前值，
 * 那不如留在面板里。所以先把 select 钉住，剩下的名额再按数组顺序给按钮 ——
 * 也就是说数组里 select 写得越靠前，能上一级的按钮就越少，这是有意的。
 */
export function splitChrome(items: ChromeAction[]): { primary: ChromeAction[]; overflow: ChromeAction[] } {
  const pinned = items.filter((a) => a.select);
  const rest = items.filter((a) => !a.select && !a.danger);
  const danger = items.filter((a) => a.danger && !a.select);
  const room = Math.max(0, CHROME_PRIMARY_MAX - pinned.length);
  return { primary: [...pinned, ...rest.slice(0, room)], overflow: [...rest.slice(room), ...danger] };
}
