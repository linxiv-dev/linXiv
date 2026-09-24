import type { ReactNode } from "react";

interface SelectionBarProps {
  count: number;
  onClear: () => void;
  /** Page-specific actions, rendered before Done. */
  children: ReactNode;
}

export function SelectionBar({ count, onClear, children }: SelectionBarProps) {
  if (count === 0) return null;

  return (
    <div
      className="lx-rise-pill fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-[40px] px-5 py-2.5"
      style={{
        backgroundColor: "#16161f",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 24px 70px rgba(0,0,0,0.45)",
        color: "#ffffff",
      }}
    >
      <span className="whitespace-nowrap text-sm font-medium">
        {count} selected
      </span>
      <span aria-hidden className="h-4 w-px" style={{ backgroundColor: "rgba(255,255,255,0.15)" }} />
      <div className="flex items-center gap-1">
        {children}
        <SelectionBarButton onClick={onClear} color="rgba(255,255,255,0.65)">
          Done
        </SelectionBarButton>
      </div>
    </div>
  );
}

interface SelectionBarButtonProps {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  color?: string;
  children: ReactNode;
}

export function SelectionBarButton({ onClick, disabled, danger, color, children }: SelectionBarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/10 disabled:opacity-40"
      style={{ color: color ?? (danger ? "var(--color-danger)" : "#ffffff") }}
    >
      {children}
    </button>
  );
}
