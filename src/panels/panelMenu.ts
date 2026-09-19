import type { PanelId } from "../ipc/types";
import { getLocale } from "../i18n/strings";

/** 「+ 面板」下拉的分组定义（B6）。
 *  一条分组 = 一个 `<optgroup>`；`ids` 为组内面板顺序，保持与面板清单一一对应。
 *  新增面板时必须补进某个分组，「完整性」由 panelMenu.test.ts 守护。 */
export interface PanelGroup {
  key: string;
  zh: string;
  en: string;
  ids: readonly PanelId[];
}

export const PANEL_GROUPS = [
  { key: "ingest", zh: "数据接入", en: "Data input", ids: ["hexview", "console", "video", "modbus", "vdev"] },
  { key: "parse", zh: "解析与画布", en: "Parse & canvas", ids: ["templates", "properties", "controls", "framecanvas"] },
  { key: "visual", zh: "可视化", en: "Visualization", ids: ["table", "plot2d", "spectrum", "view3d", "plot3d", "metrics"] },
  { key: "auto", zh: "测试与自动化", en: "Test & automation", ids: ["sequencer", "sentinel", "orchestrator"] },
  { key: "ai", zh: "AI 与探索", en: "AI & discovery", ids: ["ai", "xray"] },
] as const satisfies readonly PanelGroup[];

type GroupedPanelId = (typeof PANEL_GROUPS)[number]["ids"][number];

/** 编译期完整性守卫（B6）：新增面板却忘了放进分组 → 这里的类型约束立刻报错。
 *  `never` 约束即「必须为空集」；刻意导出以免被 noUnusedLocals 误伤。 */
export type _AllPanelsGrouped = Exclude<PanelId, GroupedPanelId> extends never ? true : never;

/** 分组显示名（语言感知） */
export function panelGroupLabel(g: PanelGroup): string {
  return getLocale() === "en" ? g.en : g.zh;
}

/** 分组键 → 面板 id 集合，用于「最近使用」去重 */
export function panelGroupOf(id: string): PanelGroup | undefined {
  return PANEL_GROUPS.find((g) => (g.ids as readonly PanelId[]).includes(id as PanelId));
}

// ---------------------------------------------------------------- 最近使用

const RECENT_KEY = "vs.panels.recent";
const RECENT_MAX = 3;

/** 读取最近使用面板（越靠前越新）；过滤掉已不存在的 id，容错解析失败 */
export function getRecentPanels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const known = new Set<string>(PANEL_GROUPS.flatMap((g) => g.ids as readonly string[]));
    return arr
      .filter((v): v is string => typeof v === "string" && known.has(v))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记录一次使用并返回新列表（最近在前、去重、上限 3） */
export function pushRecentPanel(id: string): string[] {
  const next = [id, ...getRecentPanels().filter((x) => x !== id)].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 配额满：忽略，仅本次会话生效 */
  }
  return next;
}
