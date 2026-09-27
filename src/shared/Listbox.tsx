/**
 * P110-E：共享的**展开菜单**基元（Listbox）。
 *
 * 为什么要它（用户 2026-09-27 的四问之四："好多地方是那种预设模板的灰白底方形下拉，
 * 请全部改成跟串口设置那部分一样，该有滚动条的要有滚动条"）：
 *  1. 原生 `<select>` 的弹层在 P110-D 之前是系统画的灰白方角菜单，主题进不去；
 *     P110-D 用 `appearance: base-select` 把**已有**的那批换了皮，但行内容一富
 *     （名字 + 停用态 + 计数）或长度不设上限时，原生弹层就没法再管样式与滚动；
 *  2. 更实际的问题是"同一个动作各写一遍"：波特率那张菜单、右键菜单、导轨里几张弹出面板
 *     都是"一个定层 + 一组可聚焦行 + 键盘上下 + Esc 关"，之前是五份近似实现。
 *
 * 三条硬约定（都是这个仓库的门禁要求，不是风格偏好）：
 *  - **portal 到 `document.body`**：弹层留在祖先的 `overflow`/`transform`/`z-index` 上下文里
 *    就会被裁切或被压住（那批"看着没反应"的下拉的成因）；
 *  - 样式复用既有的菜单同类（`.ctx-menu` 那张脸：`--bg-panel` 底 + `--border` 描边 +
 *    `--radius-l` + 双层影），**不带自己的 border 声明**——G 门数着全仓边框条数、只降不升，
 *    新基元若各写一份描边，就是把那条门往上抬；
 *  - 键盘与读屏语义齐全（`role=listbox` / `aria-selected` / `aria-active-descendant`），
 *    不只是"能用鼠标点"。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface ListboxOption {
  value: string;
  /** 行里的短标签（右侧注记之外的主文字） */
  label: string;
  /** 可选的次要说明（版本、状态、条数……） */
  note?: string;
  disabled?: boolean;
}

export interface ListboxProps<T extends HTMLElement = HTMLElement> {
  options: ListboxOption[];
  /** 当前选中值；不在候选里也允许（此时不高亮任何一行） */
  value: string | null;
  open: boolean;
  /** 定位锚点：菜单贴在它下沿，宽度至少与它同宽 */
  anchorRef: RefObject<T | null>;
  onSelect: (value: string) => void;
  onClose: () => void;
  ariaLabel: string;
  /** 最多显示多少行后开始滚（不给就按 CSS 的 max-height 自然滚） */
  visibleRows?: number;
}

/**
 * 展开菜单本体。用前要知道的两件事：
 *  - 调用方负责 `open` 状态与锚点 ref（这样同一份键盘/定位逻辑不会被抄第二遍）；
 *  - 关闭只由"选中 / Esc / 点外面"三种触发，**不**在失焦时自动关：
 *    焦点在行间移动时 blur 会连着误关，那正是"菜单一点就闪没"的成因。
 */
export function Listbox<T extends HTMLElement = HTMLElement>({
  options,
  value,
  open,
  anchorRef,
  onSelect,
  onClose,
  ariaLabel,
  visibleRows,
}: ListboxProps<T>) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const enabledIdx = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );

  /* 打开时定位一次 + 跟随滚动/缩放更新。用锚点的 rect 而不是 CSS 的 100%：
     弹层已经在 body 上了，再谈"父元素宽高"就没有父元素可言。 */
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, minWidth: r.width });
    };
    place();
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    setActive(options[idx]?.disabled ? Math.max(0, enabledIdx[0] ?? 0) : idx);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // options/enabledIdx 变化时不该重开定位，故只跟 open 与锚点走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    // pointerdown 而不是 click：拖拽选中输入框文字时松手也会派发 click，
    // 那会让"选完一段波特率数字"顺手把菜单关掉
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  const step = (dir: 1 | -1) => {
    if (!enabledIdx.length) return;
    const at = enabledIdx.indexOf(active);
    const next = at < 0 ? enabledIdx[0] : enabledIdx[(at + dir + enabledIdx.length) % enabledIdx.length];
    setActive(next);
    boxRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    } else if (e.key === "ArrowDown") e.preventDefault(), step(1);
    else if (e.key === "ArrowUp") e.preventDefault(), step(-1);
    else if (e.key === "Home") e.preventDefault(), setActive(enabledIdx[0] ?? 0);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o && !o.disabled) onSelect(o.value);
    } else if (e.key === "Tab") onClose();
  };

  const maxH = visibleRows ? `${visibleRows * 26 + 12}px` : undefined;
  return createPortal(
    <div
      ref={boxRef}
      className="ctx-menu lbx"
      // maxHeight 只在调用方指定"看得见几行"时接管；否则交给 .ctx-menu 的 70vh
      style={pos ? { top: pos.top, left: pos.left, minWidth: pos.minWidth, ...(maxH ? { maxHeight: maxH } : {}) } : undefined}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={`lbx-${active}`}
      onKeyDown={onKey}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          id={`lbx-${i}`}
          data-idx={i}
          className={`lbx-row${o.value === value ? " on" : ""}`}
          role="option"
          aria-selected={o.value === value}
          disabled={o.disabled}
          title={o.note}
          onFocus={() => setActive(i)}
          onClick={() => {
            if (o.disabled) return;
            onSelect(o.value);
            onClose();
          }}
        >
          <span className="lbx-label">{o.label}</span>
          {o.note && <span className="lbx-note">{o.note}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
