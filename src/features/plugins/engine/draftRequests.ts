/**
 * P174-B1 收尾：**待确认的草稿转正请求**。
 *
 * 为什么单独一层：AI 可以准备草稿（`plugin_draft_save`），但"草稿变成已装插件"这一步
 * **必须由人点**。工具不能自己调 `promoteDraft` 落盘——那等于给"谁都能写进来的东西"
 * 开一条免批准转正的路。所以工具只把请求放进这张内存表，插件管理界面把它显出来，
 * 人点了之后才走 `promoteDraft`（权限面没批过时还要再过批准卡）。
 *
 * 三条刻意的边界：
 * 1. **不落盘**：请求是一次性的；关掉应用就没了（草稿还在，随时可以再请求）。
 *    "pending" 不该跨重启变成一个没人记得的幽灵。
 * 2. **同目录名只留一条**：AI 连刷三次不该出现三张一样的卡（P133-D 的老坑）。
 * 3. **纯内存、零 IO**：这张表要能在 vitest 里直接测，也能被任何 UI 订阅。
 */

export interface DraftPromotionRequest {
  /** 草稿目录名（唯一键）。 */
  name: string;
  id: string;
  title: string;
  version: string;
  /** 批准卡上会列的权限行。 */
  permissions: string[];
  /** 与信任库比出来的三态；`trusted` 也需要人点一下（这是"转正"本身的确认）。 */
  verdict: "trusted" | "needs-approval" | "changed";
  /** 已装的同 id 插件版本（空 = 没装过），卡片上用来提示"这是升级还是首次装"。 */
  installedVersion?: string;
  /** 请求者。今天只有 AI 会进来；留成字段是为了卡上能说清"谁要转正"。 */
  requestedBy: "ai";
  at: number;
  /** AI 自己给的一句理由（可选，卡片上会显示）。 */
  note?: string;
}

const requests = new Map<string, DraftPromotionRequest>();
const subs = new Set<() => void>();
let snapshot: readonly DraftPromotionRequest[] = [];

function refresh(): void {
  // 数组与元素一起冻结：快照会被 React 直接渲染，外部（或一次手滑）改到它等于
  // "界面显示的和表里的不是一回事"，而这种错不会报错。
  snapshot = Object.freeze(
    [...requests.values()].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map((r) => Object.freeze({ ...r })),
  );
  for (const f of subs) f();
}

export function subscribeDraftRequests(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 稳定引用：`useSyncExternalStore` 靠引用变化决定是否重渲染。 */
export function getDraftRequests(): readonly DraftPromotionRequest[] {
  return snapshot;
}

/** 放一条请求。同名覆盖（保留最早的时间，免得连刷把顺序搅乱）。 */
export function queueDraftPromotion(req: DraftPromotionRequest): void {
  const prev = requests.get(req.name);
  requests.set(req.name, { ...req, at: prev?.at ?? req.at });
  refresh();
}

export function dismissDraftPromotion(name: string): void {
  if (requests.delete(name)) refresh();
}

export function clearDraftPromotions(): void {
  if (!requests.size) return;
  requests.clear();
  refresh();
}
