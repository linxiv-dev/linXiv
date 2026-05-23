import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "muted" | "danger" | "ghost" | "outline";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantStyles: Record<Variant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90 active:opacity-80",
  muted:
    "bg-[var(--color-panel)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
  danger:
    "bg-[var(--color-danger)] text-white hover:opacity-90 active:opacity-80",
  ghost:
    "bg-transparent text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-panel)]",
  outline:
    "bg-transparent text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs rounded",
  md: "px-3.5 py-1.5 text-sm rounded-md",
  lg: "px-5 py-2 text-base rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", className = "", ...props },
    ref
  ) {
    return (
      <button
        ref={ref}
        className={[
          "inline-flex items-center justify-center gap-1.5 font-medium transition-colors",
          "disabled:opacity-50 disabled:pointer-events-none",
          variantStyles[variant],
          sizeStyles[size],
          className,
        ].join(" ")}
        {...props}
      />
    );
  }
);
