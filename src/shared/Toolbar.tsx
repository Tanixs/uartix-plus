import type { ReactNode } from "react";

/** 面板工具条的三段式骨架（P179-UI03）。
 *
 * 左=数据范围/状态，中=视图，右=工具；一级动作 ≤5，其余交给 `ActionMenu`。
 * 这里只提供布局与语义槽位，不接管各面板自己的按钮实现——
 * 面板仍能保留既有 handler，改动面因此只落在 JSX 结构上，不引入新订阅或重渲染。 */
export function Toolbar({
  left,
  center,
  right,
  className,
}: {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel-toolbar${className ? ` ${className}` : ""}`} role="toolbar">
      <div className="pt-left">{left}</div>
      <div className="pt-center">{center}</div>
      <div className="pt-right">{right}</div>
    </div>
  );
}

