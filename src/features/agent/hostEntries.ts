/**
 * P99a-A5：宿主工具清单的**唯一装配点**。
 *
 * 谁需要它：
 *  - `agentAdapter`：每个 run 建注册表（外加插件注册进来的工具）；
 *  - `toolDisplay`：中文名与参数摘要从 entry 派生，不再维护 `TOOL_LABEL` 那张
 *    `Record<string,string>`（它不是穷举类型，漏配只会静默显示 snake_case）；
 *  - `agentRun`：撤销路由从这里查（旧版是手抄五行表）。
 * 三个消费方共一份，才是"加一支工具只写一条 entry"成立的前提。
 *
 * ⚠ 派生表**一律惰性求值**（本文件不能有模块求值期的展开/投影）。
 * 依赖链是 hostEntries→localEntries→pluginStore→extRuntime→chatStore→agentRun→agentAdapter→hostEntries，
 * 两头同处一环：在模块体里读 `settingsToolEntries` 这类跨环绑定，取到的是"尚未初始化"的 undefined
 * ——第一版我就在这里写了 `const HOST_TOOL_ENTRIES = [...]` 与 `Object.fromEntries(...)`，
 * 结果 helpCoverage 直接 `Cannot read properties of undefined (reading 'filter')`（§8-33 的同一课）。
 */
import { settingsToolEntries } from "./settingsTools";
import { generalToolEntries } from "./generalTools";
import { appearanceToolEntries } from "./appearanceTools";
import { uiToolEntries } from "./uiTools";
import { localToolEntries } from "./localEntries";
import { marketToolEntries } from "./marketTools";
import { PLUGIN_TOOL_PREFIX, type AgentToolEntry } from "./toolRegistry";
import type { UndoResult } from "./settingsTools";

/** 惰性求一次（工具面在运行期不变，缓存无失效路径） */
let cached: readonly AgentToolEntry[] | null = null;

/** 六组宿主工具：设置 / 通用 / 外观 / 界面 / 本机数据与插件 / 市场提名（P99c-C2）。 */
export function hostToolEntries(): readonly AgentToolEntry[] {
  if (!cached) {
    cached = Object.freeze([
      ...settingsToolEntries,
      ...generalToolEntries,
      ...appearanceToolEntries,
      ...uiToolEntries,
      ...localToolEntries,
      ...marketToolEntries,
    ]);
  }
  return cached;
}

let byName: Record<string, AgentToolEntry> | null = null;

/** 名字 → entry。显示层与撤销路由按它查（未登记＝这支工具没有 entry，属于装配缺陷，要出声）。 */
export function hostEntryByName(name: string): AgentToolEntry | undefined {
  if (!byName) {
    byName = {};
    for (const e of hostToolEntries()) byName[e.name] = e;
  }
  return byName[name];
}

/** 当前宿主工具面（自省与帮助覆盖门禁都读这一个清单） */
export function hostEntryNames(): string[] {
  return hostToolEntries().map((e) => e.name);
}

/** 撤销路由查表：没登记 undoRoute 的工具回 undefined，由调用方落 `unrouted_tool` 如实出声。 */
export function undoRouteOf(tool: string): ((token: string) => UndoResult) | undefined {
  return hostEntryByName(tool)?.undoRoute;
}

/** 未登记工具名的可读兜底：snake_case → 空格分词（时间线里不再出现裸常量） */
export function readableToolName(name: string): string {
  return name.replace(/_/g, " ").trim();
}

/**
 * 宿主工具中文名。查不到 entry 时**在控制台出声**：
 * 台账里的历史工具可能已随版本移除，兜底可读化是为了不显示裸常量，
 * 但"当前工具面里没有它"是真缺陷（派发不出去或名字写错），不能静默。
 * 插件注册的工具（P99a-B）走它自己的注册表查询，不在这张宿主表里。
 */
export function hostToolLabel(name: string): string {
  const hit = hostEntryByName(name);
  if (hit) return hit.labelZh;
  // 插件工具：B 批接上插件注册表查询，这里先按可读化兜底，不报警（它本来就不在宿主表里）
  if (name.startsWith(PLUGIN_TOOL_PREFIX)) return readableToolName(name);
  console.warn(`[toolDisplay] 工具「${name}」没有对应的 entry（显示名兜底成可读串，实为装配缺失）`);
  return readableToolName(name);
}
