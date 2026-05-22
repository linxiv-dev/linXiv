import { useId, useState } from "react";
import type { ReactNode } from "react";

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const contentId = useId();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="panel-glass rounded-lg border border-border mb-4">
      <h2>
        <button
          type="button"
          className="w-full flex items-center justify-between px-6 py-4 text-left cursor-pointer"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={contentId}
        >
          <span className="text-text font-semibold">{title}</span>
          <span
            aria-hidden="true"
            className="text-muted text-xs"
            style={{
              display: "inline-block",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 150ms",
            }}
          >
            ▶
          </span>
        </button>
      </h2>
      <div
        id={contentId}
        className={open ? "px-6 pb-6" : "hidden"}
      >
        {children}
      </div>
    </div>
  );
}
