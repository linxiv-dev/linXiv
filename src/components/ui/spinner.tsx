import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: number;
}

export function Spinner({ size = 18, className = "", style, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block animate-spin rounded-full border-2 border-transparent", className)}
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
