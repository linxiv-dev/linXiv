import type { HTMLAttributes } from "react";

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: number;
}

export function Spinner({ size = 18, className = "", style, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={["inline-block animate-spin rounded-full border-2 border-transparent", className].join(" ")}
      style={{
        width: size,
        height: size,
        borderTopColor: "var(--color-accent)",
        borderRightColor: "var(--color-accent)",
        ...style,
      }}
      {...props}
    />
  );
}
