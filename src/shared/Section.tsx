import { useState } from "react";
import { IconChevron } from "./icons";

export function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
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
      </button>
      {open && <div className="modal-section-body">{children}</div>}
    </div>
  );
}
