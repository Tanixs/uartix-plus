import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { setOpen } from "./extensionStore";

/**
 * 小部件宿主公共层：
 * - popWidgetToDesktop：把应用内浮窗弹出为独立桌面小窗（无边框形态走透明窗）
 * - WidgetMenu：自绘弹出菜单——支持分隔线/勾选/禁用/子菜单（children），
 *   既承载系统菜单，也承载小部件通过 uartix.menu 注册的自定义菜单
 */

export function popWidgetToDesktop(ext: {
  id: string;
  name: string;
  chrome?: "none";
}) {
  void (async () => {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `aiwidget-${ext.id.slice(0, 8)}`;
    setOpen(ext.id, false);
    const bare = ext.chrome === "none";
    // 已存在同名窗口：直接唤回，避免创建报错
    const exist = await WebviewWindow.getByLabel(label).catch(() => null);
    if (exist) {
      await exist.unminimize().catch(() => undefined);
      await exist.show().catch(() => undefined);
      await exist.setFocusable(true).catch(() => undefined);
      await exist.setFocus().catch(() => undefined);
      return;
    }
    new WebviewWindow(label, {
      url: `${location.origin}${location.pathname}#/aiwidget-desktop/${ext.id}`,
      title: ext.name,
      width: bare ? 220 : 280,
      height: bare ? 260 : 240,
      minWidth: 120,
      minHeight: 80,
      alwaysOnTop: true,
      decorations: false,
      transparent: bare,
      shadow: !bare,
      resizable: true,
    });
  })();
}

export interface WidgetMenuItem {
  label: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** 分隔线（label 忽略） */
  sep?: boolean;
  /** 子菜单 */
  children?: WidgetMenuItem[];
  onClick?: () => void;
}

const MENU_W = 158;
const ITEM_H = 26;

/** 自绘弹出菜单：视口内自动翻转定位，点击外部/Esc 关闭，children 悬停展开子菜单 */
export function WidgetMenu({
  x,
  y,
  items,
  onClose,
  nested,
  closeAll,
}: {
  x: number;
  y: number;
  items: WidgetMenuItem[];
  onClose: () => void;
  /** 子菜单模式：绝对定位于父菜单内，不走 portal */
  nested?: boolean;
  /** 子菜单内点击叶子项时连带关闭父菜单 */
  closeAll?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState(-1);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    if (!nested) window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, nested]);

  // 防溢出：靠近右/下边缘时翻转
  const rows = items.filter((i) => !i.sep).length;
  const H = rows * ITEM_H + items.filter((i) => i.sep).length * 9 + 8;
  const px = nested ? x : x + MENU_W > window.innerWidth ? Math.max(4, x - MENU_W) : x;
  const py = nested ? y : y + H > window.innerHeight ? Math.max(4, y - H) : y;

  const body = (
    <div ref={ref} className={`aiw-menu${nested ? " nested" : ""}`} style={{ left: px, top: py }}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="aiw-menu-sep" />
        ) : (
          <div
            key={i}
            role="menuitem"
            className={`aiw-menu-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
            onMouseEnter={() => setOpenSub(it.children?.length ? i : -1)}
            onClick={() => {
              if (it.disabled || it.children?.length) return;
              onClose();
              closeAll?.();
              it.onClick?.();
            }}
          >
            {it.checked !== undefined && (
              <span className="aiw-menu-check">{it.checked ? "✓" : ""}</span>
            )}
            <span className="aiw-menu-label">{it.label}</span>
            {it.children?.length ? <span className="aiw-menu-arrow">▸</span> : null}
            {openSub === i && it.children?.length ? (
              <WidgetMenu
                nested
                x={MENU_W - 8}
                y={-5 + i * ITEM_H}
                items={it.children}
                onClose={() => setOpenSub(-1)}
                closeAll={onClose}
              />
            ) : null}
          </div>
        ),
      )}
    </div>
  );

  return nested ? body : createPortal(body, document.body);
}
