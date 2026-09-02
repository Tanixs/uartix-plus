import { useEffect, useRef, useState } from "react";
import type { AiWidget } from "./widgetStore";
import { getChannelName, requestSendViaHub, buildSnap, type WidgetSnap } from "./widgetHub";
import { getSnapshot as getSettings } from "../settings/settingsStore";

interface Props {
  widget: AiWidget;
  isDesktop: boolean;
  onHeight?: (h: number) => void;
}

export function WidgetFrame({ widget, isDesktop, onHeight }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const lastSnap = useRef<WidgetSnap | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const sendAllowed = getSettings().aiWidgetSend;
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string } & Record<string, unknown>;
      if (!d || typeof d.type !== "string" || !d.type.startsWith("aiw:")) return;
      const target = frame.contentWindow;
      switch (d.type) {
        case "aiw:ready": {
          readyRef.current = true;
          target?.postMessage({ type: "aiw:init", perms: { send: sendAllowed } }, "*");
          const snap = lastSnap.current ?? buildSnap();
          target?.postMessage({ type: "aiw:snap", snap }, "*");
          break;
        }
        case "aiw:resize": {
          const h = Number(d.height);
          if (Number.isFinite(h) && h > 0 && h <= 2000) onHeight?.(Math.round(h));
          break;
        }
        case "aiw:getSnap": {
          target?.postMessage({ type: "aiw:snap", snap: lastSnap.current ?? buildSnap() }, "*");
          break;
        }
        case "aiw:send": {
          const mode = d.mode === "hex" ? "hex" : "ascii";
          const text = String(d.text ?? "");
          if (!sendAllowed) {
            target?.postMessage({ type: "aiw:send-res", ok: false, err: "小部件发送权限未开启" }, "*");
            break;
          }
          const run = isDesktop
            ? requestSendViaHub(mode, text)
            : import("../serial/serialStore").then((m) => m.sendData(mode, text));
          void run
            .then(() => target?.postMessage({ type: "aiw:send-res", ok: true }, "*"))
            .catch((err) =>
              target?.postMessage(
                { type: "aiw:send-res", ok: false, err: String(err).slice(0, 120) },
                "*",
              ),
            );
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isDesktop, onHeight, widget.id]);

  useEffect(() => {
    if (!isDesktop) return;
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(getChannelName());
    } catch {
      return;
    }
    const chan = ch;
    chan.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; snap?: WidgetSnap };
      if (d?.type !== "aiw:snap" || !d.snap) return;
      lastSnap.current = d.snap;
      frameRef.current?.contentWindow?.postMessage({ type: "aiw:snap", snap: d.snap }, "*");
    };
    return () => {
      chan.onmessage = null;
      chan.close();
    };
  }, [isDesktop, widget.id]);

  return (
    <>
      {error && <div className="ai-error">{error}</div>}
      <iframe
        ref={frameRef}
        className="aiw-frame"
        style={{ height: "100%" }}
        sandbox="allow-scripts"
        srcDoc={widget.html}
        title={widget.name}
        onError={() => setError("小部件加载失败")}
      />
    </>
  );
}
