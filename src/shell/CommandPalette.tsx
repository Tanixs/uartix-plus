import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { filterCommands, type PaletteCommand } from "./commandRegistry";
import { tx, useLocale } from "../i18n/strings";

/**
 * P104-B9：命令面板（`Ctrl+Shift+P`）。
 *
 * 键位为什么不是 ⌘K/Ctrl+K：那是 AI 面板的开关（`App.tsx:254`），用户 2026-09-25 判定保留。
 * 换 Ctrl+Shift+P 而不是硬抢，是因为"抢一个已在用的全局键"会让老肌肉记忆静默失效——
 * 那种改动必须单独提出来给人拍，不能藏在"新增一个面板"里顺带做掉。
 *
 * 定位与关闭的三条规矩沿用 `Flyout` / `ColumnTreeMenu`：portal 到 body（宿主容器可能
 * `overflow:hidden`，写在里面就会被裁）、Esc 关、点遮罩关、**滚轮也关**
 * （浮层跟着滚动内容飘走是最难解释的"看起来坏了"）。
 *
 * 本组件不读 store：条目由 App 用 `buildCommands()` 造好后传进来。
 * 这样它能被单独渲染测试，也不会因为引了 panels.tsx 把整个应用拖进来。
 */
export function CommandPalette(props: { commands: PaletteCommand[]; onClose: () => void }) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => filterCommands(props.commands, q), [props.commands, q]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // 换查询词就把光标拨回第一条，并保证它在可视区内（键盘连打时光标会停在屏幕外）
  useEffect(() => {
    setSel(0);
  }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.cmdk-item[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, q]);

  const run = (c: PaletteCommand | undefined) => {
    if (!c || c.disabled) return;
    props.onClose();
    c.run();
  };

  /* 键盘一律挂在 window 上，不挂 `<input onKeyDown>`。
     实测踩出来的：本组件 portal 到 `document.body`，在 React 根容器（`#root`）之外，
     而 React 的合成事件是按根容器收的 —— 结果 `onChange` 能通（我逐字过滤测过是好的）、
     点条目能通，**唯独 Esc 按下去没反应**（弹层关不掉）。
     与其赌"哪些事件能穿过 portal"，不如像 `ColumnTreeMenu` 那样直接听 window。 */
  useEffect(() => {
    const onWinKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((v) => Math.min(v + 1, Math.max(0, items.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((v) => Math.max(0, v - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(items[sel]);
      }
    };
    window.addEventListener("keydown", onWinKey, true);
    return () => window.removeEventListener("keydown", onWinKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sel]);

  // 按 group 分节，但保持 filterCommands 给的排序（组内按分、组间按最高分）
  const sections: { name: string; rows: { c: PaletteCommand; i: number }[] }[] = [];
  items.forEach((c, i) => {
    const last = sections[sections.length - 1];
    if (last && last.name === c.group) last.rows.push({ c, i });
    else sections.push({ name: c.group, rows: [{ c, i }] });
  });

  return createPortal(
    <div
      className="cmdk-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onWheel={props.onClose}
    >
      <div className="cmdk" data-elev="4" data-ctl="menu" role="dialog" aria-modal="true" aria-label={tx("命令面板", "Command palette")}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          placeholder={tx("输入命令、面板名或动作…", "Type a command, panel or action…")}
          aria-controls="cmdk-list"
          aria-expanded
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="cmdk-list" id="cmdk-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="cmdk-empty">{tx("没有匹配的命令", "No matching command")}</div>}
          {sections.map((sec) => (
            <div className="cmdk-section" key={sec.name}>
              <div className="cmdk-section-h">{sec.name}</div>
              {sec.rows.map(({ c, i }) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  disabled={c.disabled}
                  className={`cmdk-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span className="cmdk-t">{c.title}</span>
                  {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ {tx("选择", "navigate")}</span>
          <span>Enter {tx("执行", "run")}</span>
          <span>Esc {tx("关闭", "close")}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
