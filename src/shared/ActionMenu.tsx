import { useRef, useState, type ReactNode } from "react";
import { Dropdown } from "./Dropdown";
import { IconMore } from "./icons";
import { tx, useLocale } from "../i18n/strings";

/** 面板工具条的统一溢出菜单（P179-UI03）。
 *
 * 同一类"低频/危险动作"此前在每个面板各写一遍下拉或直接平铺在一级位，
 * 一级动作因此长到 9~13 颗。这里只做一件事：把超过一级名额的动作收进 `⋯`，
 * 破坏性动作永远走 `danger` 分隔区，不再与主行动同权重。 */
export interface ActionMenuItem {
  id: string;
  label: string;
  title?: string;
  Icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionMenu({
  items,
  label,
  align = "end",
  className,
}: {
  items: ActionMenuItem[];
  /** 无障碍名，默认「更多操作」 */
  label?: string;
  align?: "start" | "end";
  className?: string;
}) {
  useLocale(); // 面板工具条会跟着语言切换重渲染（strings.ts 头注口径）
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const more = label ?? tx("更多操作", "More actions");
  if (!items.length) return null;
  const normal = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  return (
    <div className={`tb-actions${className ? ` ${className}` : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="tb-btn"
        aria-label={more}
        aria-haspopup="menu"
        aria-expanded={open}
        title={more}
        onClick={() => setOpen((v) => !v)}
      >
        <IconMore />
      </button>
      <Dropdown anchor={btnRef.current} open={open} onClose={() => setOpen(false)} align={align} className="action-menu">
        {normal.map((i) => (
          <button
            key={i.id}
            type="button"
            role="menuitem"
            className="tb-menu-item"
            title={i.title}
            disabled={i.disabled}
            onClick={() => {
              setOpen(false);
              btnRef.current?.focus();
              i.onSelect();
            }}
          >
            {i.Icon}
            <span>{i.label}</span>
          </button>
        ))}
        {danger.length > 0 && (
          <>
            {normal.length > 0 && <div className="tb-menu-sep" role="separator" />}
            {danger.map((i) => (
              <button
                key={i.id}
                type="button"
                role="menuitem"
                className="tb-menu-item danger"
                title={i.title}
                disabled={i.disabled}
                onClick={() => {
                  setOpen(false);
                  btnRef.current?.focus();
                  i.onSelect();
                }}
              >
                {i.Icon}
                <span>{i.label}</span>
              </button>
            ))}
          </>
        )}
      </Dropdown>
    </div>
  );
}

