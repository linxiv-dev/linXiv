import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "inset" | "translucent";
}

const VARIANT_BG = {
  default: "bg-panel",
  inset: "bg-surface2",
  translucent: "bg-panel-translucent",
} as const;

export function Card({ variant = "default", className = "", style, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "border border-border shadow-card",
        VARIANT_BG[variant],
        className,
      )}
      style={{ borderRadius: "var(--card-radius)", padding: "var(--card-pad)", ...style }}
      {...props}
    />
  );
}

interface MonoLabelProps extends HTMLAttributes<HTMLElement> {
  as?: "span" | HeadingTag;
}

export function MonoLabel({ as: Tag = "span", className = "", ...props }: MonoLabelProps) {
  return (
    <Tag
      className={cn(
        "font-mono uppercase text-ink3 text-[10.5px] tracking-[0.08em]",
        className,
      )}
      {...props}
    />
  );
}

interface SectionTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  as?: HeadingTag;
}

export function SectionTitle({ as: Tag = "h2", className = "", ...props }: SectionTitleProps) {
  return (
    <Tag
      className={cn("font-display text-text", className)}
      {...props}
    />
  );
}
