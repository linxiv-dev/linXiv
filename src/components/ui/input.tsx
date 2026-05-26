import { type InputHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from "react";

const inputBase = [
  "w-full rounded-md px-3 py-1.5 text-sm transition-colors",
  "bg-[var(--color-bg)] text-[var(--color-text)]",
  "border border-[var(--color-border)]",
  "placeholder:text-[var(--color-muted)]",
  "focus:outline-none focus:border-[var(--color-accent)]",
  "disabled:opacity-50 disabled:cursor-not-allowed",
].join(" ");

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={[inputBase, className].join(" ")}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={[inputBase, "resize-y min-h-[80px]", className].join(" ")}
      {...props}
    />
  );
});
