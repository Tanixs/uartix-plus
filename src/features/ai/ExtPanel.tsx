import { useSyncExternalStore } from "react";
import * as extStore from "./extensionStore";
import { WidgetFrame } from "./WidgetFrame";

/** dockview 动态面板宿主：渲染 panel 类型的 AI 扩展（沙箱 iframe） */
export function ExtPanelHost({ extId }: { extId: string }) {
  const es = useSyncExternalStore(extStore.subscribe, extStore.getSnapshot);
  const ext = es.exts.find((e) => e.id === extId);
  if (!ext) {
    return (
      <div className="ext-panel-host ext-panel-miss">
        该 AI 扩展已被卸载，可移除此面板。
      </div>
    );
  }
  if (!ext.enabled) {
    return (
      <div className="ext-panel-host ext-panel-miss">
        扩展「{ext.name}」当前已停用，可在 AI 助手的扩展管理中启用。
      </div>
    );
  }
  return (
    <div className="ext-panel-host">
      <WidgetFrame widget={{ id: ext.id, name: ext.name, html: ext.html ?? "" }} isDesktop={false} />
    </div>
  );
}
