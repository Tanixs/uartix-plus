/** 空态：图标 + 标题 + 至多一行提示 + 动作按钮。
 *
 * P104-B4 加 `actions` 槽。这条改动是 B11 的前提，也是"默认页说明墙"的**根因修复**：
 * 这个组件此前只有 `{title, hint}`——**没有按钮位**。
 * 于是作者想让用户"点右上「＋滑条」"时，唯一能做的事就是写一句话去指认那个按钮，
 * 六个面板的默认页因此都出现了「左侧…」「右侧…」「右键卡片可…」这类空间导航句。
 * 说明墙不是粗心，是组件缺口的必然产物。给它按钮位，文字才真的可以删。
 *
 * 配套硬规矩（写进 P104-B2 详设 §3，B11 逐面板执行）：
 *  hint 上限 1 条；默认页不得出现指认其它控件位置的文字——要给，就把那个控件放进来。
 */
export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** 一屏只允许一颗 primary；空态的主行动默认走 primary */
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}

export function EmptyState({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: string[];
  actions?: EmptyStateAction[];
}) {
  return (
    <div className="empty-state">
      <svg
        width="42"
        height="42"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11" opacity="0.5" />
      </svg>
      <div className="empty-title">{title}</div>
      {hint?.map((h, i) => (
        <div key={i} className="empty-hint">
          {h}
        </div>
      ))}
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
    </div>
  );
}
