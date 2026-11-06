/** 空态：图标 + 标题 + 至多一条提示 + 动作按钮（P179-UI04）。
 *
 * 三种形态来自同一组件，避免"同一个无数据状态四种皮肤"：
 *  - `card`（默认）：面板中央，图标 + 标题 + 说明 + 最多 1 主 1 次；
 *  - `inline`：表格/日志里的一行说明，不占大块面积；
 *  - `overlay`：画布上的可关闭浮卡，宽度 ≤360，不遮挡画布超过 30%。
 *
 * P104-B4 起有 `actions` 槽：默认页不再靠"左侧…「＋滑条」…"这类空间导航句指认控件，
 * 要给就把控件放进来。硬规矩：hint 上限 1 条；空态只允许一颗 primary。
 */
import { IconClose } from "./icons";
import { tx, useLocale } from "../i18n/strings";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** 一屏只允许一颗 primary；空态的主行动默认走 primary */
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}

export type EmptyStateVariant = "card" | "inline" | "overlay";

export function EmptyState({
  title,
  hint,
  actions,
  extra,
  variant = "card",
  onClose,
}: {
  title: string;
  hint?: string[];
  actions?: EmptyStateAction[];
  /** 说明行之后的附加节点（例如 HelpHint）——空态仍由本组件统一排版 */
  extra?: React.ReactNode;
  variant?: EmptyStateVariant;
  /** 仅 overlay：给了就显示关闭按钮 */
  onClose?: () => void;
}) {
  useLocale(); // overlay 的关闭按钮说明要跟着语言切换
  const closeLabel = tx("关闭说明", "Close note");
  const body = (
    <>
      {variant !== "inline" && (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11" opacity="0.5" />
        </svg>
      )}
      <div className="empty-title">{title}</div>
      {hint?.length ? (
        <div className="empty-hint">
          {hint.map((h, i) => (
            <div key={i}>{h}</div>
          ))}
        </div>
      ) : null}
      {extra}
      {actions && actions.length > 0 && (
        <div className="empty-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`btn sm${a.primary ? " primary" : ""}`}
              disabled={a.disabled}
              title={a.title}
              onClick={() => a.onClick()}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );

  if (variant === "inline") {
    return (
      <div className="empty-inline">
        <span>{title}</span>
        {actions?.length ? (
          <div className="empty-inline-actions">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className={`btn sm${a.primary ? " primary" : ""}`}
                disabled={a.disabled}
                title={a.title}
                onClick={() => a.onClick()}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === "overlay") {
    return (
      <div className="empty-overlay" role="note">
        {onClose && (
          <button
            type="button"
            className="empty-close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <IconClose />
          </button>
        )}
        {body}
      </div>
    );
  }

  return <div className="empty-state">{body}</div>;
}

