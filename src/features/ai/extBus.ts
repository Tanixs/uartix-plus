type Cb = (extId: string) => void;
const listeners = new Set<Cb>();

/** AiChat 请求把 panel 扩展加入工作区（App 订阅后调用 dockview addPanel） */
export function onRequestOpenExtPanel(cb: Cb): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function openExtPanel(extId: string) {
  listeners.forEach((l) => l(extId));
}
