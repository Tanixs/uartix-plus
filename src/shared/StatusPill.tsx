/** 只读状态胶囊：一个 6px 状态点 + 一行短字（P179-UI02）。
 *
 * 与按钮的区别是**不可点**：此前链路摘要用描边盒子长得像输入框，连接按钮又是同权重的
 * 中性描边，用户分不出"能点的"和"只读的"。这里统一成无底、无边框的状态文字。 */
export type StatusTone = "idle" | "busy" | "ok" | "warn" | "danger";

export function StatusPill({
  tone = "idle",
  children,
  title,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`status-pill tone-${tone}`} title={title}>
      <i aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

