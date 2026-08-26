import { useState } from "react";

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
        <span className="modal-section-arrow">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="modal-section-body">{children}</div>}
    </div>
  );
}
