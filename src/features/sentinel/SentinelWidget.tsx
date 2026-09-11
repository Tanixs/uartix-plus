import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { widgetReq, widgetSubscribe, WIDGET_POS_KEY, type WidgetState } from "./sentinelHub";

/**
 * 哨兵桌面挂件（P62-S2）：独立 WebviewWindow 根（#/sentinel-widget），
 * 不加载主界面。数据经 sentinelHub 的 1Hz 广播；主窗离线 3s 显示灰态。
 * 主题跟随：主窗广播 snt:theme（变量集 + data-theme），即开即取一次。
 */

function fmtHms(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function SentinelWidget() {
  const [st, setSt] = useState<WidgetState | null>(null);
  const [offline, setOffline] = useState(true);
  const lastTs = useRef(0);

  useEffect(() => {
    const unsub = widgetSubscribe(
      (s) => {
        lastTs.current = Date.now();
        setSt(s);
        setOffline(false);
      },
      ({ vars, theme }) => {
        const el = document.documentElement;
        el.dataset.theme = theme;
        for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
      },
    );
    const t = window.setInterval(() => {
      setOffline(Date.now() - lastTs.current > 3000);
    }, 1000);
    // 位置持久化：拖动结束（onMoved 有节流语义，直接存）；逻辑像素存储
    let unMoved: (() => void) | undefined;
    const win = getCurrentWindow();
    void win
      .onMoved(({ payload }) => {
        void win.scaleFactor().then((sf) => {
          try {
            localStorage.setItem(WIDGET_POS_KEY, JSON.stringify({ x: payload.x / (sf || 1), y: payload.y / (sf || 1) }));
          } catch {
            /* 存储满：位置不持久化 */
          }
        });
      })
      .then((f) => {
        unMoved = f;
      })
      .catch(() => undefined);
    return () => {
      unsub();
      window.clearInterval(t);
      unMoved?.();
    };
  }, []);

  const close = () => {
    void getCurrentWindow().close().catch(() => window.close());
  };

  const health = st?.health ?? 100;
  const color = health >= 80 ? "var(--ok)" : health >= 50 ? "var(--warn)" : "var(--danger)";
  const crit = !offline && (st?.activeCrit ?? 0) > 0 && st?.enabled;

  return (
    <div className={`sw${offline ? " off" : ""}${crit ? " crit" : ""}`}>
      <div
        className="sw-head"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          void getCurrentWindow().startDragging();
        }}
      >
        <span className="sw-title">
          {offline ? "哨兵 · 主窗离线" : st?.enabled ? "哨兵监测中" : "哨兵已停用"}
        </span>
        <button type="button" className="sw-x" onClick={close} title="关闭挂件" aria-label="关闭挂件">
          ×
        </button>
      </div>
      <div className="sw-main">
        <div
          className="sw-ring"
          style={{ background: `conic-gradient(${offline ? "var(--text-dim)" : color} 0 ${offline ? 100 : health}%, var(--bg-inset) ${offline ? 100 : health}% 100%)` }}
        >
          <span className="sw-num">{offline ? "–" : health}</span>
        </div>
        <div className="sw-meta">
          <span className={st && st.activeCrit > 0 && !offline ? "sw-b crit" : "sw-b"}>
            严重 {offline ? "–" : st?.activeCrit ?? 0}
          </span>
          <span className={st && st.activeWarn > 0 && !offline ? "sw-b warn" : "sw-b"}>
            警告 {offline ? "–" : st?.activeWarn ?? 0}
          </span>
          {st && st.unack > 0 && !offline && <span className="sw-b unack">{st.unack} 未确认</span>}
        </div>
      </div>
      <div className="sw-alerts" role="log" aria-label="最近报警">
        {st && st.alerts.length > 0 && !offline ? (
          st.alerts.map((a) => (
            <div key={a.key + a.ts} className={`sw-alert ${a.level}`}>
              <span className={`sw-dot ${a.level}`} />
              <span className="sw-msg" title={`${fmtHms(a.ts)} ${a.msg}`}>
                {a.msg}
              </span>
              {a.level !== "info" && (
                <button
                  type="button"
                  className="sw-mute"
                  onClick={() => widgetReq({ mute: a.key })}
                  title="静音此类报警"
                >
                  静
                </button>
              )}
            </div>
          ))
        ) : (
          <div className="sw-none">{offline ? "等待主窗数据…" : "一切正常"}</div>
        )}
      </div>
      <div className="sw-foot">
        <button type="button" className="btn sm" onClick={() => widgetReq("open")}>
          打开面板
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => widgetReq("ackAll")}
          disabled={!st || st.unack === 0 || offline}
        >
          全部确认
        </button>
      </div>
    </div>
  );
}
