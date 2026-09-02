import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSnapshot, type AiWidget } from "./widgetStore";
import { WidgetFrame } from "./WidgetFrame";

export function WidgetDesktop() {
  const [widget, setWidget] = useState<AiWidget | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    const id = location.hash.replace("#/aiwidget-desktop/", "");
    const find = () => {
      const w = getSnapshot().widgets.find((x) => x.id === id) ?? null;
      setWidget(w);
      setMiss(!w);
    };
    find();
    const t = window.setInterval(find, 2000);
    return () => window.clearInterval(t);
  }, []);

  const close = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  return (
    <div className="aiw-desktop">
      <div className="aiw-desktop-head" data-tauri-drag-region>
        <span className="aiw-float-title">{widget?.name ?? "AI 挂件"}</span>
        <button className="ai-float-btn" title="关闭" onClick={() => void close()}>
          <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
      </div>
      <div className="aiw-desktop-body">
        {widget ? (
          <WidgetFrame widget={widget} isDesktop />
        ) : miss ? (
          <div className="aiw-desktop-miss">
            小部件不存在或已被删除，可关闭本窗口。
          </div>
        ) : (
          <div className="aiw-desktop-miss">加载中…</div>
        )}
      </div>
    </div>
  );
}
