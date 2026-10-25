/**
 * App Action 事件总线：脚本/小部件/自定义卡片请求操作主程序（打开面板、切预设等）。
 * dockview api 在 App.tsx 内部，故 openPanel/applyPreset 经此总线由 App 消费执行。
 */
export type AppBusMsg =
  | { kind: "openPanel"; panel: string }
  | { kind: "applyPreset"; preset: string }
  | { kind: "closePanel"; panel: string }
  /** 打开设置并切到某一页（AI 造完东西后把用户带到"该点哪一下"的地方）。`tab` 由 App 白名单校验。 */
  | { kind: "openSettings"; tab: string }
  /** 打开插件市场。渲染点**只有 App 一处**（两颗入口按钮都发这条），
   *  否则同一支弹窗有两个实例，Esc/滚动/收藏状态会各说一套。 */
  | { kind: "openMarket" }
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

/** 请求打开插件市场（插件库按钮与标题栏按钮都走这里，弹窗本身只在 App 渲染一次） */
/** 请求打开设置页（tab 是设置页的键；App 侧白名单校验，不认的键就当"通用"）。 */
export function requestOpenSettings(tab: string) {
  emit({ kind: "openSettings", tab });
}

export function requestOpenMarket() {
  emit({ kind: "openMarket" });
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
