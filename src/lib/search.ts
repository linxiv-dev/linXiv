import type { Clause } from "../types/api";

export function buildArxivQuery(clauses: Clause[]): string {
  return clauses
    .filter((c) => c.value.trim() !== "")
    .map((c, i) => {
      const term = c.field === "all" ? c.value.trim() : `${c.field}:${c.value.trim()}`;
      if (i === 0) return term;
      const op = c.operator === "AND NOT" ? "ANDNOT" : c.operator;
      return `${op} ${term}`;
    })
    .join(" ");
}
