import * as templateStore from "../protocol/templateStore";
import type { FrameTemplate } from "../../ipc/types";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import * as settingsStore from "./settingsStore";

export const FULL_KIND = "uartix-full";

export interface FullBackup {
  templates: { templates: FrameTemplate[]; groups: Record<string, templateStore.GroupMeta> };
  controls: controlsStore.ControlPage[];
  commands: commandStore.CommandGroup[];
  settings: settingsStore.Settings;
}

/** 全量配置备份：协议 + 控制画布 + 命令库 + 界面设置 */
export function exportFullBackup(): FullBackup {
  return {
    templates: templateStore.exportTemplatesWithMeta(),
    controls: controlsStore.exportPages(),
    commands: commandStore.exportGroups(),
    settings: settingsStore.getSnapshot(),
  };
}

/** 按 kind 分发导入，返回用户可读的结果描述 */
export async function importDispatch(kind: string, data: unknown): Promise<string> {
  switch (kind) {
    case "uartix-templates": {
      const d = data as {
        templates?: Parameters<typeof templateStore.importTemplates>[0];
        groups?: Record<string, { name: string }>;
      };
      if (!d.templates?.length) throw new Error("文件中没有协议模板数据");
      if (d.groups) templateStore.importGroupsMeta(d.groups);
      templateStore.importTemplates(d.templates);
      return `已导入 ${d.templates.length} 个协议模板（副本）`;
    }
    case "uartix-controls": {
      const arr = Array.isArray(data) ? data[0] : data;
      const page = arr as {
        name?: string;
        cols?: number;
        rows?: number;
        cards?: Record<string, unknown>[];
      };
      controlsStore.importPage(page);
      return `已导入为新控制页（${(page.cards ?? []).length} 卡片）`;
    }
    case "uartix-commands": {
      const groups = data as Parameters<typeof commandStore.importGroupsMerge>[0];
      if (!Array.isArray(groups) || groups.length === 0) throw new Error("文件中没有命令库数据");
      commandStore.importGroupsMerge(groups);
      return "命令库已合并导入";
    }
    case FULL_KIND: {
      const d = data as Partial<FullBackup>;
      let n = 0;
      if (d.templates?.templates?.length) {
        if (d.templates.groups) templateStore.importGroupsMeta(d.templates.groups);
        templateStore.importTemplates(d.templates.templates);
        n += d.templates.templates.length;
      }
      if (Array.isArray(d.controls)) {
        for (const p of d.controls) {
          controlsStore.importPage(p as unknown as { name?: string; cards?: Record<string, unknown>[] });
        }
        n += d.controls.length;
      }
      if (Array.isArray(d.commands) && d.commands.length) {
        commandStore.importGroupsMerge(d.commands);
        n += d.commands.length;
      }
      if (d.settings) settingsStore.patch(d.settings);
      return `全部配置已恢复（${n} 项）`;
    }
    default:
      throw new Error(`未知文件类型：${kind}`);
  }
}
