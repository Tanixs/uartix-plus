/**
 * P99a-D1b：把一份 dockview 布局 JSON 真正装到界面上——**唯一一处**说清这件事。
 *
 * 之前这段动作有两份抄本（设置页命名槽 `applyLayoutSlot`、Operator 载入分支各抄一遍
 * `clear() + fromJSON() + 收尾`），而插件库的「工作区预设」产物**没有第三个消费点**：
 * 那个 kind 从 P88b-3 起一直"能存能导出、装了啥也不发生"（详设 §7.1 要清的就是这个）。
 * 现在命名槽与插件布局同食这一个函数；Operator 分支**故意不并进来**——它的语义是
 * "装不上就保持现状"，而这里失败时界面已经被 clear() 清空，两者不能共用一条路径。
 *
 * 本模块是叶子：只接一个"够用就行"的 api 面（`clear`/`fromJSON`），不 import store、不碰 React，
 * 所以插件库与 App 都能安全引用（§8-33 求值期纪律）。
 */

/** 这段动作真正用到的 api 面（比 `DockviewApi` 窄，测试里喂个假对象就行）。 */
export interface LayoutApi {
  clear(): void;
  fromJSON(json: unknown): void;
}

/**
 * 应用一份布局 JSON；返回错误消息（成功为 `null`）。**不抛**：调用方都是 UI 事件回调，
 * 抛出去就成了一条没人看见的控制台红字（而"点了没反应"是最难归因的那种反馈）。
 *
 * `before`/`after` 由调用方给（App 侧是"快照当前布局"与"重挂标题 + 同步 panelActivity"）。
 * 失败时 `after` 照样执行——此刻界面已经被 `clear()` 清空，收尾不做反而更糟。
 */
export function applyLayoutJson(
  api: LayoutApi | null,
  layout: unknown,
  hooks: { before?: () => void; after?: () => void } = {},
): string | null {
  if (!api) return "工作台尚未就绪（dockview 还没建好），请稍后再试";
  if (!layout || typeof layout !== "object") return "布局内容不是对象，无法应用";
  hooks.before?.();
  try {
    api.clear();
    api.fromJSON(layout);
  } catch (err) {
    hooks.after?.();
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    // clear() 已生效＝此刻是空屏，必须把"怎么回来"一起说，不能只留一句"应用失败"
    return `应用布局失败（当前工作台可能已被清空，可在 设置 → 工作区 里挑一个布局槽位恢复）：${msg}`;
  }
  hooks.after?.();
  return null;
}

/**
 * 一份插件产物里的布局是否"看着像布局"。
 *
 * 这里**故意不做深校验**：dockview 的 JSON 结构是它的私有格式，抄一份校验器就是给自己
 * 埋一个"dockview 升级 → 我们的校验先红"的第二真相（§8-36①）。真正的判定是
 * `fromJSON()` 会不会抛，那由上面的错误回传兜住；这一层只挡明显不是布局的东西，
 * 免得把 `null`、字符串、数组喂进去之后只得到一个看不懂的 dockview 异常。
 */
export function looksLikeLayoutJson(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  // dockview 序列化结果必有 panels/groups 之一（root 是它的内部结构，不同版本形态不同，不作为必要条件）
  return "panels" in o || "groups" in o || "grid" in o;
}
