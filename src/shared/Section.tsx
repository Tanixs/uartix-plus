import { useState } from "react";
import { tx, useLocale } from "../i18n/strings";
import { IconChevron } from "./icons";
import { HelpHint } from "./HelpHint";

export function Section({
  title,
  tip,
  defaultOpen = true,
  children,
}: {
  title: string;
  tip?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="modal-section">
      <button
        className="modal-section-head"
        onClick={() => setOpen(!open)}
        title={open ? tx("折叠", "Collapse") : tx("展开", "Expand")}
      >
        <span className="modal-section-arrow">
          <IconChevron size={13} dir={open ? "down" : "right"} />
        </span>
        {title}
        {tip && (
          <span
            className="modal-section-tip"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HelpHint text={tip} />
          </span>
        )}
      </button>
      {open && <div className="modal-section-body">{children}</div>}
    </div>
  );
}
