import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { ClauseRow, type Clause } from "../components/search/ClauseRow";
import { ResultRow } from "../components/search/ResultRow";
import { searchArxiv, fetchArxiv, searchOpenAlex, saveOpenAlex } from "../api/search";
import { getSearchHistory, getSearchState, saveSearchState } from "../api/searchState";
import { getSettings } from "../api/settings";
import { listPapers } from "../api/papers";
import type { SearchResult, Paper } from "../types/api";

// ── helpers ──────────────────────────────────────────────────────────────────

function buildArxivQuery(clauses: Clause[]): string {
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

function paperMatchesQuery(paper: Paper, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  const title = paper.title.toLowerCase();
  const summary = (paper.summary ?? "").toLowerCase();
  const authorsRaw = paper.authors;
  const authors = (
    Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw]
  )
    .join(" ")
    .toLowerCase();
  return title.includes(q) || summary.includes(q) || authors.includes(q);
}

function paperToSearchResult(paper: Paper): SearchResult {
  const authorsRaw = paper.authors;
  const authors = Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw];
  return {
    source_id: paper.source_id,
    version: paper.version,
    title: paper.title,
    summary: paper.summary ?? "",
    authors,
    published: paper.published ?? "",
    pdf_url: paper.url ?? "",
    primary_category: paper.category ?? "",
    entry_id: paper.source_id,
  };
}

// ── default clause ────────────────────────────────────────────────────────────

function makeClause(): Clause {
  return { operator: "AND", field: "all", value: "" };
}

// ── component ────────────────────────────────────────────────────────────────

type Source = "arxiv" | "openalex" | "local";

const MAX_RESULT_OPTIONS = [10, 25, 50, 100] as const;

export default function SearchPage() {
  const [clauses, setClauses] = useState<Clause[]>([makeClause()]);
  const [source, setSource] = useState<Source>("arxiv");
  const [maxResults, setMaxResults] = useState<number>(25);

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  // per-clause autocomplete suggestions (index → suggestion list)
  const [suggestions, setSuggestions] = useState<Record<number, string[]>>({});
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const historyEnabled = settings ? (settings as Record<string, unknown>).search_history_enabled !== false : true;

  // Restore search state from db on first mount.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    getSearchState().then((state) => {
      if (state) {
        setClauses(state.clauses.length > 0 ? state.clauses : [makeClause()]);
        setSource(state.source as Source);
        setMaxResults(state.max_results);
        setResults(state.results);
        setSavedIds(new Set(state.saved_ids));
      }
    }).finally(() => setRestored(true));
  }, []);

  // arXiv search mutation
  const arxivSearch = useMutation({
    mutationFn: (query: string) => searchArxiv(query, maxResults, false),
    onSuccess: (data) => {
      setResults(data.results);
      setSavedIds(new Set(data.saved_source_ids));
    },
  });

  // OpenAlex search mutation
  const openAlexSearch = useMutation({
    mutationFn: (query: string) => searchOpenAlex(query, maxResults),
    onSuccess: (data) => {
      setResults(data.results);
      setSavedIds(new Set());
    },
  });

  // Local search mutation
  const localSearch = useMutation({
    mutationFn: async (query: string) => {
      const { papers } = await listPapers(500);
      const matched = papers
        .filter((p) => paperMatchesQuery(p, query))
        .map(paperToSearchResult);
      return matched;
    },
    onSuccess: (data) => {
      setResults(data);
      setSavedIds(new Set(data.map((r) => r.source_id)));
    },
  });

  const isLoading = arxivSearch.isPending || openAlexSearch.isPending || localSearch.isPending;
  const error =
    (arxivSearch.error as Error | null)?.message ??
    (openAlexSearch.error as Error | null)?.message ??
    (localSearch.error as Error | null)?.message ??
    null;

  // Persist state after every successful search.
  function persistState(newResults: SearchResult[], newSavedIds: Set<string>) {
    saveSearchState(clauses, source, maxResults, newResults, [...newSavedIds]).catch(() => {});
  }

  const handleSearch = useCallback(() => {
    const query = buildArxivQuery(clauses);
    if (!query) return;
    setResults(null);
    setSuggestions({});
    if (source === "arxiv") {
      arxivSearch.mutate(query, {
        onSuccess: (data) => persistState(data.results, new Set(data.saved_source_ids)),
      });
    } else if (source === "openalex") {
      openAlexSearch.mutate(query, {
        onSuccess: (data) => persistState(data.results, new Set()),
      });
    } else {
      localSearch.mutate(query, {
        onSuccess: (data) => persistState(data, new Set(data.map((r) => r.source_id))),
      });
    }
  }, [clauses, source, maxResults, arxivSearch, openAlexSearch, localSearch]);

  const handleSavePaper = useCallback(async (sourceId: string) => {
    if (sourceId.startsWith("openalex:")) {
      await saveOpenAlex(sourceId);
    } else {
      await fetchArxiv(sourceId, true);
    }
    setSavedIds((prev) => new Set([...prev, sourceId]));
  }, []);

  function addClause() {
    setClauses((prev) => [...prev, makeClause()]);
  }

  function updateClause(index: number, clause: Clause) {
    setClauses((prev) => prev.map((c, i) => (i === index ? clause : c)));
  }

  function removeClause(index: number) {
    setClauses((prev) => prev.filter((_, i) => i !== index));
    setSuggestions((prev) => {
      const next: Record<number, string[]> = {};
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k);
        if (ki < index) next[ki] = v;
        else if (ki > index) next[ki - 1] = v;
      });
      return next;
    });
  }

  function handleSuggestionQuery(index: number, prefix: string) {
    if (!historyEnabled) return;
    getSearchHistory(prefix).then((s) => {
      setSuggestions((prev) => ({ ...prev, [index]: s }));
    }).catch(() => {});
  }

  if (!restored) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-[var(--color-muted)]">
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Fixed header + controls ─────────────────────────────────────────── */}
      <div
        className="shrink-0 px-6 pt-6 pb-4 border-b border-[var(--color-border)]"
        style={{ background: "var(--color-bg)" }}
      >
        <h1 className="text-lg font-semibold text-[var(--color-text)] mb-4">
          Search Papers
        </h1>

        {/* Clause builder */}
        <div className="flex flex-col gap-2 mb-3">
          {clauses.map((clause, i) => (
            <ClauseRow
              key={i}
              clause={clause}
              isFirst={i === 0}
              onChange={(c) => updateClause(i, c)}
              onRemove={() => removeClause(i)}
              onSubmit={handleSearch}
              suggestions={suggestions[i] ?? []}
              onSuggestionQuery={(prefix) => handleSuggestionQuery(i, prefix)}
            />
          ))}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={addClause}
          className="mb-4"
        >
          + Add clause
        </Button>

        {/* Source + options + search row */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Source segmented control */}
          <div
            className="flex rounded-md border border-border overflow-hidden text-sm shrink-0"
          >
            {(["arxiv", "openalex", "local"] as Source[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={[
                  "px-3 py-1.5 transition-colors",
                  source === s
                    ? "bg-accent text-white font-medium"
                    : "bg-panel text-muted hover:text-text",
                ].join(" ")}
              >
                {s === "arxiv" ? "arXiv" : s === "openalex" ? "OpenAlex" : "Local"}
              </button>
            ))}
          </div>

          {/* Max results — only relevant for arXiv and OpenAlex */}
          {source !== "local" && (
            <div className="flex items-center gap-1.5 text-sm text-[var(--color-muted)]">
              <span>Max</span>
              <select
                className="h-[30px] rounded-md px-2 text-sm bg-[var(--color-bg)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)]"
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
                aria-label="Maximum results"
              >
                {MAX_RESULT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>results</span>
            </div>
          )}

          <div className="flex-1" />

          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleSearch}
            disabled={isLoading || clauses.every((c) => !c.value.trim())}
          >
            {isLoading && <Spinner size={14} />}
            {isLoading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>

      {/* ── Scrollable results area ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Error */}
        {error && (
          <p className="px-6 py-4 text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--color-muted)]">
            <Spinner size={28} />
            <span className="text-sm">Searching…</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && results !== null && results.length === 0 && (
          <p className="px-6 py-8 text-sm text-[var(--color-muted)] text-center">
            No results found.
          </p>
        )}

        {/* Results */}
        {!isLoading && results && results.length > 0 && (
          <div>
            <p className="px-6 py-2 text-xs text-[var(--color-muted)] border-b border-[var(--color-border)]">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </p>
            {results.map((result) => (
              <ResultRow
                key={result.source_id}
                result={result}
                saved={savedIds.has(result.source_id)}
                onSave={handleSavePaper}
              />
            ))}
          </div>
        )}

        {/* Idle prompt */}
        {!isLoading && results === null && !error && (
          <p className="px-6 py-8 text-sm text-[var(--color-muted)] text-center">
            Enter search terms above and press Search.
          </p>
        )}
      </div>
    </div>
  );
}
