/**
 * App Action 事件总线：脚本/小部件/自定义卡片请求操作主程序（打开面板、切预设等）。
 * dockview api 在 App.tsx 内部，故 openPanel/applyPreset 经此总线由 App 消费执行。
 */
export type AppBusMsg =
  | { kind: "openPanel"; panel: string }
  | { kind: "applyPreset"; preset: string };

type Handler = (msg: AppBusMsg) => void;

const listeners = new Set<Handler>();

export function subscribeAppBus(h: Handler): () => void {
  listeners.add(h);
  return () => {
    listeners.delete(h);
  };
}

function emit(msg: AppBusMsg) {
  listeners.forEach((l) => l(msg));
}

export function requestOpenPanel(panel: string) {
  emit({ kind: "openPanel", panel });
}

export function requestApplyPreset(preset: string) {
  emit({ kind: "applyPreset", preset });
}
