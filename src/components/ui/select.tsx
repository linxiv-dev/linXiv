import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type SelectSize = "sm" | "md";

/** Inline density. "sm" sits next to text-xs labels without dwarfing them;
 *  "md" (default) is the standalone form-control size. */
const sizeStyles: Record<SelectSize, string> = {
  sm: "px-1.5 py-0.5 text-xs",
  // Matches the Input/Textarea metrics (px-3 py-1.5 text-sm) so a select reads
  // as a peer of adjacent text fields and their content aligns.
  md: "px-3 py-1.5 text-sm",
};

// Native <select> has a numeric `size` (visible rows); omit it so we can reuse
// the conventional `size` prop name for density, matching Button/Badge.
interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: SelectSize;
}

/** Styled wrapper around a native <select>, matching the Input/Textarea/Badge
 *  primitives. Callers pass <option> children. Use `size` for inline density;
 *  `className` is merged, so a conflicting utility overrides the default. */
export function Select({
  size = "md",
  className = "",
  ...props
}: SelectProps) {
  return (
    <select
      className={cn(
        "rounded-md border border-border bg-panel",
        "text-text cursor-pointer",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  );
}

interface OptionSelectOption<T extends string> {
  value: T;
  label: string;
}

interface OptionSelectBaseProps<T extends string> {
  options: OptionSelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: SelectSize;
  className?: string;
  /** Props are destructured by name below, so any attribute meant to reach the
   *  <select> has to be listed here — including hyphenated ARIA ones, which
   *  JSX otherwise accepts and silently drops. */
  "aria-describedby"?: string;
}

type OptionSelectProps<T extends string> = OptionSelectBaseProps<T> &
  (
    | { id: string; "aria-label"?: string }
    | { id?: string; "aria-label": string }
  );

export function OptionSelect<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  size = "md",
  className = "",
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: OptionSelectProps<T>) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        "min-w-[180px] rounded-md border border-border bg-panel",
        "text-text cursor-pointer",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        sizeStyles[size],
        className,
      )}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
