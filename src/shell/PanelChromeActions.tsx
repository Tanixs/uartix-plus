import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { splitChrome, usePanelChromeFor } from "../panels/panelChrome";
import { IconMore } from "../shared/icons";
import { zoomFactor } from "../shared/zoom";
import { tx, useLocale } from "../i18n/strings";

/**
 * P104-B10 组级页签动作。
 *
 * 一个组件管 20 个面板：读 `activePanel.id` 的登记动作，前 5 颗直接进页签条，
 * 其余（含所有破坏性）折进一颗 `⋯`。合同原写的 `rightGroupActionsBuilder` 在
 * dockview 8.2 里不存在（B4 探针实测），真入口是 `rightHeaderActionsComponent`。
 *
 * 没登记的面板这里什么都不画 —— 所以铺开可以一个一个来，
 * 而回退只要不传这个组件，一行 JSX 的事。
 */
export function PanelChromeActions(props: IDockviewHeaderActionsProps) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const id = props.activePanel?.id;
  const items = usePanelChromeFor(id);
  const { primary, overflow } = splitChrome(items);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !moreRef.current || !menuRef.current) return;
    const zf = zoomFactor();
    const a = moreRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    // 视觉 px ÷ zoom 才是逻辑 px（B1 那笔账；浮层写的是逻辑 px）
    const left = Math.max(8 / zf, Math.min(a.left / zf, window.innerWidth / zf - m.width / zf - 8 / zf));
    let top = a.bottom / zf + 4;
    if (top + m.height / zf > window.innerHeight / zf - 8) top = Math.max(8 / zf, a.top / zf - m.height / zf - 4);
    setPos({ left, top });
  }, [menuOpen, overflow.length]);

  if (!id || items.length === 0) return null;

  return (
    <div className="pca" data-panel={id}>
      {primary.map((a) =>
        a.select ? (
          <select
            key={a.id}
            className="pca-sel"
            value={a.select.value}
            disabled={a.disabled}
            title={a.title}
            aria-label={a.label}
            onChange={(e) => a.select!.onChange(e.target.value)}
          >
            {a.select.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <button
            key={a.id}
            type="button"
            className={`pca-btn${a.on ? " on" : ""}`}
            disabled={a.disabled}
            title={a.title}
            aria-label={a.label}
            aria-pressed={a.on}
            onClick={() => a.run()}
          >
            {a.Icon ? <a.Icon /> : <span className="pca-word">{a.label}</span>}
          </button>
        ),
      )}
      {overflow.length > 0 && (
        <>
          <button
            ref={moreRef}
            type="button"
            className={`pca-btn${menuOpen ? " on" : ""}`}
            title={tx("更多操作", "More actions")}
            aria-label={tx("更多操作", "More actions")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconMore />
          </button>
          {menuOpen &&
            createPortal(
              <div
                ref={menuRef}
                className="pca-menu"
                data-elev="4"
                data-ctl="menu"
                role="menu"
                style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
              >
                {overflow.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="menuitem"
                    className={`pca-menu-item${a.on ? " on" : ""}${a.danger ? " danger" : ""}`}
                    disabled={a.disabled}
                    title={a.title}
                    onClick={() => {
                      setMenuOpen(false);
                      a.run();
                    }}
                  >
                    {a.Icon ? <a.Icon /> : null}
                    <span>{a.label}</span>
                    {a.on ? <em className="pca-dot">●</em> : null}
                  </button>
                ))}
              </div>,
              document.body,
            )}
        </>
      )}
    </div>
  );
}
