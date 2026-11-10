/**
 * 停靠区桥：控制画布要把面板「移回停靠」，但 dockview 的 api 只活在 App 组件里。
 *
 * 单独一个非组件模块（和 `panels/panelChrome.ts` 同理由）：面板层不该 import App，
 * 否则 `App → ControlCanvas → App` 直接成环。这里只存一个 api 与一个"打开或聚焦"
 * 的函数，App 在 onReady 注入，控制画布按需取用。
 */
import type { DockviewApi } from "dockview";

let api: DockviewApi | null = null;
let opener: ((id: string) => void) | null = null;

/** App 在 dockview onReady 时注入。`open` 复用 App 的 addOrFocusPanel（含最近使用与退役面板改派）。 */
export function registerDockApi(next: DockviewApi, open: (id: string) => void): void {
  api = next;
  opener = open;
}

/** 只注销自己那一份：热更新/重挂载时晚到的旧实例不能把新 api 清掉。 */
export function unregisterDockApi(next: DockviewApi | null): void {
  if (!next || api !== next) return;
  api = null;
  opener = null;
}

export function isDockReady(): boolean {
  return !!api && !!opener;
}

/** 已存在则聚焦，返回 true；否则交给 App 打开并确认真的出现了。 */
export function openDockPanel(id: string): boolean {
  if (!api || !opener) return false;
  const exist = api.getPanel(id);
  if (exist) {
    exist.api.setActive();
    return true;
  }
  opener(id);
  return !!api.getPanel(id);
}

/** 关闭停靠实例；本来就不在停靠区返回 false（调用方据此提示，而不是假装成功）。 */
export function closeDockPanel(id: string): boolean {
  const p = api?.getPanel(id);
  if (!p) return false;
  p.api.close();
  return true;
}
