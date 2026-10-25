/**
 * P174-R7③：**待确认的目录绑定**（插件面板里点的，落不落在盘上由用户在宿主这边点头）。
 *
 * 为什么要这张表，而不是"面板里选了目录就写进去"：
 * 绑定表是**进程笼子的来源**——`--allow-fs-write` 是启动那一刻按它定死的。
 * 如果插件在自己的面板里放一个按钮、点完就把 `$WS` 改掉，那"权限只在批准卡上给过"这句话
 * 就作废了：清单里没写的目录，也能经一次点击变成写目录。
 * 所以这里停下来等宿主确认：**用户在系统对话框里选的那个目录，要再由用户本人在宿主这边认一次**。
 * 两次点击不是繁琐，是"授权"这件事本来的形状。
 *
 * 这一层没有 IO，也没有 Tauri：只有表与订阅，所以判据能被单测逐条钉住。
 */

export interface RootBindRequest {
  pluginId: string;
  /** 插件名（确认条要写得清"是谁在要"）。 */
  pluginName: string;
  /** 路径变量整形：`$WS` 或 `$EXT:<key>`。 */
  spec: string;
  /** 用户刚在系统对话框里选中的目录（绝对路径）。 */
  path: string;
  /** 这个目录对该插件是**写**声明还是只读声明（确认条上的话不一样）。 */
  forWrite: boolean;
  at: number;
}

let pending: RootBindRequest[] = [];
const subs = new Set<() => void>();

function emit(): void {
  // 引用必须换：`useSyncExternalStore` 认的就是引用，原地 push 等于"点了没反应"
  pending = pending.slice();
  for (const f of subs) f();
}

export function subscribeRootBinds(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function pendingRootBinds(): readonly RootBindRequest[] {
  return pending;
}

/**
 * 登记一条待确认。同一个插件 + 同一条变量只留最新一次：
 * 用户在同一个面板里连点两次「选目录」，不该出现两条确认条（第二次的选择才是他想要的）。
 */
export function requestRootBind(req: RootBindRequest): void {
  const rest = pending.filter((p) => !(p.pluginId === req.pluginId && p.spec === req.spec));
  pending = [...rest, req];
  emit();
}

/** 取走并清掉（批准与取消都走这里；面板被关掉时也要清，否则条子留在别的面板上）。 */
export function takeRootBind(pluginId: string, spec: string): RootBindRequest | null {
  const hit = pending.find((p) => p.pluginId === pluginId && p.spec === spec) ?? null;
  if (!hit) return null;
  pending = pending.filter((p) => p !== hit);
  emit();
  return hit;
}

export function clearRootBindsOf(pluginId: string): void {
  const before = pending.length;
  pending = pending.filter((p) => p.pluginId !== pluginId);
  if (pending.length !== before) emit();
}
