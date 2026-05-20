import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface Clause {
  operator: "AND" | "OR" | "AND NOT";
  field: "all" | "ti" | "au" | "abs";
  value: string;
}

interface ClauseRowProps {
  clause: Clause;
  onChange: (clause: Clause) => void;
  onRemove: () => void;
  onSubmit: () => void;
  isFirst: boolean;
}

const OPERATORS: Clause["operator"][] = ["AND", "OR", "AND NOT"];
const FIELDS: { value: Clause["field"]; label: string }[] = [
  { value: "all", label: "All fields" },
  { value: "ti", label: "Title" },
  { value: "au", label: "Author" },
  { value: "abs", label: "Abstract" },
];

const selectBase = [
  "h-[30px] rounded-md px-2 text-sm transition-colors cursor-pointer",
  "bg-[var(--color-bg)] text-[var(--color-text)]",
  "border border-[var(--color-border)]",
  "focus:outline-none focus:border-[var(--color-accent)]",
].join(" ");

export function ClauseRow({ clause, onChange, onRemove, onSubmit, isFirst }: ClauseRowProps) {
  return (
    <div className="flex items-center gap-2">
      {/* Operator — hidden for first row but keeps layout stable via visibility */}
      <select
        className={selectBase}
        style={{ width: 96, visibility: isFirst ? "hidden" : "visible" }}
        value={clause.operator}
        onChange={(e) =>
          onChange({ ...clause, operator: e.target.value as Clause["operator"] })
        }
        aria-label="Boolean operator"
      >
        {OPERATORS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>

      {/* Field selector */}
      <select
        className={selectBase}
        style={{ width: 120 }}
        value={clause.field}
        onChange={(e) =>
          onChange({ ...clause, field: e.target.value as Clause["field"] })
        }
        aria-label="Search field"
      >
        {FIELDS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      {/* Value input */}
      <Input
        className="flex-1 h-[30px] py-0"
        placeholder="Search term..."
        value={clause.value}
        onChange={(e) => onChange({ ...clause, value: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
      />

      {/* Remove button — invisible (but keeps space) for first row */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-2 text-lg leading-none"
        style={{ visibility: isFirst ? "hidden" : "visible" }}
        onClick={onRemove}
        aria-label="Remove clause"
      >
        ×
      </Button>
    </div>
  );
}
