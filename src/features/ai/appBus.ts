/**
 * App Action 事件总线：脚本/小部件/自定义卡片请求操作主程序（打开面板、切预设等）。
 * dockview api 在 App.tsx 内部，故 openPanel/applyPreset 经此总线由 App 消费执行。
 */
export type AppBusMsg =
  | { kind: "openPanel"; panel: string }
  | { kind: "applyPreset"; preset: string }
  | { kind: "closePanel"; panel: string }
  /** 整屏换布局（P99a-D1b：插件库里的「工作区预设」产物）。dockview api 只在 App 里，
   *  所以这条也只能由 App 执行；`done` 是回执通道——总线是单向广播，没有它点完按钮什么都不发生 */
  | { kind: "applyLayout"; layout: unknown; done: (err: string | null) => void };

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

/** 请求关闭面板（P62 哨兵最小化到浮球用） */
export function requestClosePanel(panel: string) {
  emit({ kind: "closePanel", panel });
}

/**
 * 请求应用一份布局 JSON。`emit` 是同步的，所以"没人回执"这件事当场就能判定，
 * 不必留一个永远不响的 Promise（那种"按了没反应"我们在 P99a-C1 刚为它补过一次埋点）。
 */
export function requestApplyLayout(layout: unknown, done: (err: string | null) => void) {
  let settled = false;
  emit({
    kind: "applyLayout",
    layout,
    done: (err) => {
      settled = true;
      done(err);
    },
  });
  if (!settled) done("界面尚未就绪（工作台还没建好），请稍后再试");
}
