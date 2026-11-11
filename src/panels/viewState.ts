/**
 * 面板视图态契约：停靠 ↔ 内嵌切换时「卸载 + 挂载」但保住用户看到的视野。
 *
 * 数据订阅在全局 store 上，不随面板实例增减；真正会丢的是组件内视图态
 * （uPlot 的 x/y 区间、Hex 的滚动位置、3D 相机位姿）。这里只做两件事：
 * 1. 组件挂载时注册 adapter；
 * 2. 切换前 capture 到 pending，目标实例注册时立刻消费（同一提交内完成，一帧内恢复）。
 *
 * 不新增订阅、不轮询：pending 是一次性的，消费即删。
 */
import type {
  EmbedId,
  EmbedPanelId,
  EmbedPanelViewState,
} from "../features/controls/embedPanels";

export interface EmbedPanelViewAdapter {
  /** 返回 null = 当前没有可迁移状态（例如图还没数据），调用方应保持目标默认视野。 */
  capture: () => EmbedPanelViewState | null;
  restore: (state: EmbedPanelViewState) => void;
}

const adapters = new Map<string, EmbedPanelViewAdapter>();
const pending = new Map<string, EmbedPanelViewState>();

/**
 * 注册当前挂载实例的 adapter，并立即消费上一次 capture 留下的状态。
 * 返回注销函数：只注销自己那一份（切换过程中新旧实例可能短暂并存）。
 */
export function registerPanelView(
  panelId: EmbedPanelId,
  adapter: EmbedPanelViewAdapter,
): () => void {
  adapters.set(panelId, adapter);
  const stashed = pending.get(panelId);
  if (stashed) {
    pending.delete(panelId);
    try {
      adapter.restore(stashed);
    } catch {
      // 恢复失败不能把面板挂死：退回默认视野即可（数据仍在 store 里）。
    }
  }
  return () => {
    if (adapters.get(panelId) === adapter) adapters.delete(panelId);
  };
}

/** 切换前调用：把当前实例的视图态暂存给下一个挂载点。返回同一份状态供写入卡片。 */
export function capturePanelView(panelId: EmbedPanelId): EmbedPanelViewState | null {
  const state = adapters.get(panelId)?.capture() ?? null;
  if (state) pending.set(panelId, state);
  return state;
}

/** 切换被取消（例如目标位置非法）时丢弃暂存，避免下次无关重挂载吃到旧视野。 */
export function discardPanelView(panelId: EmbedPanelId) {
  pending.delete(panelId);
}

/**
 * 用卡片里持久化的视野预置下一次挂载。
 *
 * 只在没有 pending 时生效：停靠→内嵌是"刚 capture 的实时视野"，
 * 优先级必须高于"上次存盘时的旧视野"，否则切换看起来像跳回历史。
 */
export function primePanelView(
  panelId: EmbedId,
  state: EmbedPanelViewState | null | undefined,
): void {
  if (!state || pending.has(panelId)) return;
  pending.set(panelId, state);
}

export function hasPanelViewAdapter(panelId: EmbedPanelId): boolean {
  return adapters.has(panelId);
}
