export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string[];
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
    </div>
  );
}
