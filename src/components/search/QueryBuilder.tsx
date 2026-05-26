import { useState } from "react";
import { Button } from "../ui/button";
import { ClauseRow } from "./ClauseRow";
import { getSearchHistory } from "../../api/searchState";
import { buildArxivQuery } from "../../lib/search";
import type { Clause } from "../../types/api";

export function makeClause(): Clause {
  return { operator: "AND", field: "all", value: "", uid: crypto.randomUUID() };
}

interface QueryBuilderProps {
  clauses: Clause[];
  onChange: (clauses: Clause[]) => void;
  onInsert: (query: string) => void;
  historyEnabled?: boolean;
}

export function QueryBuilder({
  clauses,
  onChange,
  onInsert,
  historyEnabled = true,
}: QueryBuilderProps) {
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});

  function addClause() {
    onChange([...clauses, makeClause()]);
  }

  function updateClause(index: number, clause: Clause) {
    onChange(clauses.map((c, i) => (i === index ? clause : c)));
  }

  function removeClause(index: number) {
    const uid = clauses[index].uid;
    if (clauses.length <= 1) {
      onChange([makeClause()]);
      setSuggestions({});
      return;
    }
    onChange(clauses.filter((_, i) => i !== index));
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  }

  function handleSuggestionQuery(uid: string, prefix: string) {
    if (!historyEnabled) return;
    getSearchHistory(prefix)
      .then((s) => setSuggestions((prev) => ({ ...prev, [uid]: s })))
      .catch((err) => console.warn("Search history fetch failed:", err));
  }

  const preview = buildArxivQuery(clauses);

  return (
    <div className="flex flex-col gap-2">
      {clauses.map((clause, i) => (
        <ClauseRow
          key={clause.uid}
          clause={clause}
          isFirst={i === 0}
          showFieldSelector={true}
          onChange={(c) => updateClause(i, c)}
          onRemove={() => removeClause(i)}
          onSubmit={() => onInsert(buildArxivQuery(clauses))}
          suggestions={suggestions[clause.uid] ?? []}
          onSuggestionQuery={(prefix) => handleSuggestionQuery(clause.uid, prefix)}
        />
      ))}

      <div className="flex items-center gap-2 mt-1">
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={addClause}>
          + Add clause
        </Button>
        <div className="flex-1" />
        {preview ? (
          <span
            className="min-w-0 truncate font-mono text-xs opacity-60 max-w-[40%]"
            style={{ color: "var(--color-text)" }}
            title={preview}
          >
            {preview}
          </span>
        ) : (
          <span className="text-xs italic text-[var(--color-muted)]">(empty)</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 py-0.5 text-xs shrink-0"
          onClick={() => onChange([makeClause()])}
        >
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          className="shrink-0 text-xs"
          disabled={!preview}
          onClick={() => onInsert(preview)}
        >
          Insert Query →
        </Button>
      </div>
    </div>
  );
}
