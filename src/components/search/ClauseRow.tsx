import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Clause } from "../../types/api";

interface ClauseRowProps {
  clause: Clause;
  onChange: (clause: Clause) => void;
  onRemove: () => void;
  onSubmit: () => void;
  isFirst: boolean;
  showFieldSelector?: boolean;
  suggestions?: string[];
  onSuggestionQuery?: (prefix: string) => void;
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

export function ClauseRow({
  clause,
  onChange,
  onRemove,
  onSubmit,
  isFirst,
  showFieldSelector = true,
  suggestions = [],
  onSuggestionQuery,
}: ClauseRowProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleValueChange(value: string) {
    onChange({ ...clause, value });
    if (value.trim().length >= 1) {
      onSuggestionQuery?.(value);
      setDropdownOpen(true);
    } else {
      setDropdownOpen(false);
    }
  }

  function handleSuggestionClick(term: string) {
    onChange({ ...clause, value: term });
    setDropdownOpen(false);
    inputRef.current?.focus();
  }

  const showDropdown = dropdownOpen && suggestions.length > 0;

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

      {/* Field selector — only meaningful for arXiv; hidden for other sources */}
      <select
        className={selectBase}
        style={{ width: 120, visibility: showFieldSelector ? "visible" : "hidden" }}
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

      {/* Value input + autocomplete dropdown */}
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          className="w-full h-[30px] py-0"
          placeholder="Search term..."
          value={clause.value}
          onChange={(e) => handleValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { setDropdownOpen(false); onSubmit(); }
            if (e.key === "Escape") setDropdownOpen(false);
          }}
          // Delay close so onMouseDown on a suggestion item fires before blur removes the list.
          // This works only because suggestion items use onMouseDown + e.preventDefault().
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onFocus={() => {
            if (clause.value.trim().length >= 1 && suggestions.length > 0) {
              setDropdownOpen(true);
            }
          }}
        />
        {showDropdown && (
          <ul
            className="absolute z-50 left-0 right-0 mt-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] shadow-lg py-0.5 text-sm max-h-48 overflow-y-auto"
            role="listbox"
          >
            {suggestions.map((term) => (
              <li
                key={term}
                role="option"
                aria-selected={false}
                className="px-3 py-1.5 cursor-pointer hover:bg-[var(--color-accent)] hover:text-white truncate"
                onMouseDown={(e) => { e.preventDefault(); handleSuggestionClick(term); }}
              >
                {term}
              </li>
            ))}
          </ul>
        )}
      </div>

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
