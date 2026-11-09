import { type InputHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

const inputBase = [
  "w-full rounded-md px-3 py-1.5 text-sm transition-colors",
  "bg-bg text-text",
  "border border-border",
  "placeholder:text-muted",
  "focus:outline-none focus:border-accent",
  "disabled:opacity-50 disabled:cursor-not-allowed",
].join(" ");

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(inputBase, className)}
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
      className={cn(inputBase, "resize-y min-h-[80px]", className)}
      {...props}
    />
  );
});
