/**
 * P174-G1：插件贡献的命令 → 命令面板条目（纯派生，一行 IO 都没有）。
 *
 * 与 `collectPluginPanels` 同一条硬规矩：**条目从清单派生**，不另立一张命令表。
 * 两处（面板与命令）共用同一个门：`enabled` 这个字段由调用方用 `panelEnabled()` 算好，
 * 所以"停用/权限没批"的插件，它的面板和命令会**一起消失**——不会出现
 * "面板进不去但命令还能调"的后门。
 *
 * 为什么命令 id 要带 pluginId：两个插件可以各声明一个 `yolo.train`。清单校验只保证
 * **同一个包内**不重复；跨包的裸 id 在命令面板里会撞成一条，后注册的静默顶掉前一个。
 */

import type { PluginManifest } from "./manifest";

/** 命令面板里插件命令的 id 前缀。`ext:<pluginId>:<commandId>`。 */
export const COMMAND_PALETTE_PREFIX = "plugin:";

export interface PluginCommandItem {
  pluginId: string;
  /** 清单里的命令 id（如 `yolo.train`）。 */
  commandId: string;
  title: string;
  /** 插件名：两个插件有同名命令时，命令面板右侧要能分清是谁的。 */
  pluginTitle: string;
  /** 命令面板里的唯一 id（跨插件同名不会撞）。 */
  paletteId: string;
}

/** 只取这里需要的字段，避免为了类型把 IO 层（pluginEngine）拖进来。 */
export interface CommandSource {
  id: string;
  name: string;
  manifest: Pick<PluginManifest, "contributes">;
  /** = 已启用**且**已批准（判据在 `repo.panelEnabled`）。必填，不给默认值。 */
  enabled: boolean;
}

export function collectPluginCommands(sources: readonly CommandSource[]): PluginCommandItem[] {
  const out: PluginCommandItem[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s.enabled) continue;
    for (const c of s.manifest.contributes.commands ?? []) {
      const paletteId = `${COMMAND_PALETTE_PREFIX}${s.id}:${c.id}`;
      if (seen.has(paletteId)) continue;
      seen.add(paletteId);
      out.push({ pluginId: s.id, commandId: c.id, title: c.title, pluginTitle: s.name, paletteId });
    }
  }
  out.sort((a, b) => a.paletteId.localeCompare(b.paletteId));
  return out;
}
