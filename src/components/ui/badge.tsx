import type { HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  color?: string;
}

export function Badge({ color, className = "", style, children, ...props }: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
        "border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text)]",
        className,
      ].join(" ")}
      style={
        color
          ? { borderColor: color, color, backgroundColor: `${color}22`, ...style }
          : style
      }
      {...props}
    >
      {children}
    </span>
  );
}
