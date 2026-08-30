import { useState } from "react";
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
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="modal-section">
      <button
        className="modal-section-head"
        onClick={() => setOpen(!open)}
        title={open ? "折叠" : "展开"}
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
