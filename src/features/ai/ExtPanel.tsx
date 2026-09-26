import { useSyncExternalStore } from "react";
import { tx, useLocale } from "../../i18n/strings";
import * as extStore from "./extensionStore";
import { WidgetFrame } from "./WidgetFrame";
import { pluginCtxForExt } from "../plugins/pluginStore";

/** dockview 动态面板宿主：渲染 panel 类型的 AI 扩展（沙箱 iframe） */
export function ExtPanelHost({ extId }: { extId: string }) {
  useLocale();
  const es = useSyncExternalStore(extStore.subscribe, extStore.getSnapshot);
  const ext = es.exts.find((e) => e.id === extId);
  if (!ext) {
    return (
      <div className="ext-panel-host ext-panel-miss">
        {tx("该 AI 扩展已被卸载，可移除此面板。", "This AI extension has been uninstalled — you can remove this panel.")}
      </div>
    );
  }
  if (!ext.enabled) {
    return (
      <div className="ext-panel-host ext-panel-miss">
        {tx(`扩展「${ext.name}」当前已停用，可在 设置 → 插件管理 中启用其来源插件。`,
          `Extension “${ext.name}” is currently disabled — enable its plugin under Settings → Plugin library.`)}
      </div>
    );
  }
  return (
    <div className="ext-panel-host">
      <WidgetFrame
        widget={{ id: ext.id, name: ext.name, html: ext.html ?? "" }}
        isDesktop={false}
        pluginCtx={pluginCtxForExt(ext.pluginRef)}
      />
    </div>
  );
}
