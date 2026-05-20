import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { ClauseRow } from "../components/search/ClauseRow";
import { ResultRow } from "../components/search/ResultRow";
import { searchArxiv, fetchArxiv, searchOpenAlex, saveOpenAlex } from "../api/search";
import { getSearchHistory, getSearchState, saveSearchState } from "../api/searchState";
import { getSettings } from "../api/settings";
import { listPapers } from "../api/papers";
import type { Clause, SearchResult, Paper } from "../types/api";

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

// Plain text query for local search — joins clause values without arXiv field prefixes.
function buildLocalQuery(clauses: Clause[]): string {
  return clauses
    .filter((c) => c.value.trim() !== "")
    .map((c) => c.value.trim())
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

function mergeResults(existing: SearchResult[] | null, incoming: SearchResult[]): SearchResult[] {
  const seen = new Set((existing ?? []).map((r) => r.source_id));
  return [...(existing ?? []), ...incoming.filter((r) => !seen.has(r.source_id))];
}

// ── default clause ────────────────────────────────────────────────────────────

function makeClause(): Clause {
  return { operator: "AND", field: "all", value: "" };
}

// Local paper search reads up to this many papers from the library.
// Increase if library scale grows beyond this; ideally replace with server-side FTS.
const LOCAL_SEARCH_PAPER_LIMIT = 500;

// ── component ────────────────────────────────────────────────────────────────

type Source = "arxiv" | "openalex" | "local";

const MAX_RESULT_OPTIONS = [10, 25, 50, 100] as const;

export default function SearchPage() {
  const [clauses, setClauses] = useState<Clause[]>([makeClause()]);
  const [source, setSource] = useState<Source>("arxiv");
  const [maxResults, setMaxResults] = useState<number>(25);

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [isAppending, setIsAppending] = useState(false);

  // per-clause autocomplete suggestions (index → suggestion list)
  const [suggestions, setSuggestions] = useState<Record<number, string[]>>({});
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const historyEnabled = settings?.search_history_enabled !== false;

  // Restore search state from db on first mount.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    getSearchState().then((state) => {
      if (state) {
        setClauses(state.clauses.length > 0 ? state.clauses : [makeClause()]);
        const validSources: Source[] = ["arxiv", "openalex", "local"];
        if (validSources.includes(state.source as Source)) setSource(state.source as Source);
        setMaxResults(state.max_results);
        setResults(state.results);
        setSavedIds(new Set(state.saved_ids));
      }
    }).finally(() => setRestored(true));
  }, []);

  // arXiv search mutation
  const arxivSearch = useMutation({
    mutationFn: (query: string) => searchArxiv(query, maxResults, false),
  });

  // OpenAlex search mutation
  const openAlexSearch = useMutation({
    mutationFn: (query: string) => searchOpenAlex(query, maxResults),
  });

  // Local search mutation
  const localSearch = useMutation({
    mutationFn: async (query: string) => {
      const { papers } = await listPapers(LOCAL_SEARCH_PAPER_LIMIT);
      return papers
        .filter((p) => paperMatchesQuery(p, query))
        .map(paperToSearchResult);
    },
  });

  const isLoading = arxivSearch.isPending || openAlexSearch.isPending || localSearch.isPending;
  const isReplacing = isLoading && !isAppending;
  const error =
    (arxivSearch.error as Error | null)?.message ??
    (openAlexSearch.error as Error | null)?.message ??
    (localSearch.error as Error | null)?.message ??
    null;

  // Unified search handler for both replace (fresh search) and append (merge) modes.
  function runSearch(mode: "replace" | "append") {
    const query = buildArxivQuery(clauses);
    if (!query) return;
    setSuggestions({});
    if (mode === "replace") {
      setResults(null);
      setIsAppending(false);
    } else {
      setIsAppending(true);
    }

    // Snapshot state at call time. Source/select are disabled during loading so
    // concurrent mutations cannot occur and these values are stable for the async duration.
    const base = results ?? [];
    const baseSaved = savedIds;

    if (source === "arxiv") {
      arxivSearch.mutate(query, {
        onSuccess: (data) => {
          const merged = mode === "append" ? mergeResults(base, data.results) : data.results;
          const mergedSaved = mode === "append"
            ? new Set([...baseSaved, ...data.saved_source_ids])
            : new Set(data.saved_source_ids);
          setResults(merged);
          setSavedIds(mergedSaved);
          saveSearchState(clauses, source, maxResults, merged, [...mergedSaved]).catch(() => {});
        },
        onSettled: () => { if (mode === "append") setIsAppending(false); },
      });
    } else if (source === "openalex") {
      openAlexSearch.mutate(query, {
        onSuccess: (data) => {
          const merged = mode === "append" ? mergeResults(base, data.results) : data.results;
          // OpenAlex returns no saved_source_ids. Preserve existing saved state for append;
          // for replace, retain only IDs that reappear in the new results.
          const newIds = new Set(data.results.map((r) => r.source_id));
          const mergedSaved = mode === "append"
            ? new Set([...baseSaved])
            : new Set([...baseSaved].filter((id) => newIds.has(id)));
          setResults(merged);
          setSavedIds(mergedSaved);
          saveSearchState(clauses, source, maxResults, merged, [...mergedSaved]).catch(() => {});
        },
        onSettled: () => { if (mode === "append") setIsAppending(false); },
      });
    } else {
      const localQuery = buildLocalQuery(clauses);
      localSearch.mutate(localQuery, {
        onSuccess: (data) => {
          const merged = mode === "append" ? mergeResults(base, data) : data;
          const mergedSaved = mode === "append"
            ? new Set([...baseSaved, ...data.map((r) => r.source_id)])
            : new Set(data.map((r) => r.source_id));
          setResults(merged);
          setSavedIds(mergedSaved);
          saveSearchState(clauses, source, maxResults, merged, [...mergedSaved]).catch(() => {});
        },
        onSettled: () => { if (mode === "append") setIsAppending(false); },
      });
    }
  }

  const handleSearch = () => runSearch("replace");
  const handleAppend = () => runSearch("append");

  function handleClear() {
    setResults(null);
    setSavedIds(new Set());
    setIsAppending(false);
  }

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
                disabled={isLoading}
                className={[
                  "px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
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
                className="h-[30px] rounded-md px-2 text-sm bg-[var(--color-bg)] text-[var(--color-text)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
                disabled={isLoading}
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

          <div className="flex rounded-md overflow-hidden shrink-0 border border-[var(--color-border)]">
            <button
              type="button"
              onClick={handleAppend}
              disabled={isLoading || results === null || clauses.every((c) => !c.value.trim())}
              title="Append to current results"
              className="flex items-center justify-center w-7 py-1 text-xs font-bold transition-opacity hover:opacity-80 active:opacity-70 disabled:opacity-30 disabled:pointer-events-none"
              style={{ background: "var(--color-success)", color: "var(--color-bg)" }}
            >
              {isAppending ? <Spinner size={11} /> : "+"}
            </button>
            <button
              type="button"
              onClick={handleSearch}
              disabled={isLoading || clauses.every((c) => !c.value.trim())}
              className="flex items-center justify-center gap-1 px-4 py-1 text-xs font-semibold tracking-wide transition-opacity hover:opacity-80 active:opacity-70 disabled:opacity-30 disabled:pointer-events-none border-x border-black/20"
              style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
            >
              {isReplacing && <Spinner size={11} />}
              {isReplacing ? "Searching…" : "Search"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={isLoading || results === null}
              title="Clear results"
              className="flex items-center justify-center w-7 py-1 text-xs font-bold transition-opacity hover:opacity-80 active:opacity-70 disabled:opacity-30 disabled:pointer-events-none"
              style={{ background: "var(--color-danger)", color: "white" }}
            >
              −
            </button>
          </div>
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

        {/* Full-replace loading */}
        {isReplacing && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--color-muted)]">
            <Spinner size={28} />
            <span className="text-sm">Searching…</span>
          </div>
        )}

        {/* Empty state */}
        {!isReplacing && results !== null && results.length === 0 && (
          <p className="px-6 py-8 text-sm text-[var(--color-muted)] text-center">
            No results found.
          </p>
        )}

        {/* Results */}
        {!isReplacing && results && results.length > 0 && (
          <div>
            <p className="px-6 py-2 text-xs text-[var(--color-muted)] border-b border-[var(--color-border)]">
              {results.length} result{results.length !== 1 ? "s" : ""}
              {isAppending && <span className="ml-2 text-[var(--color-accent)]">appending…</span>}
            </p>
            {results.map((result) => (
              <ResultRow
                key={result.source_id}
                result={result}
                saved={savedIds.has(result.source_id)}
                onSave={handleSavePaper}
              />
            ))}
            {isAppending && (
              <div className="flex items-center gap-2 px-6 py-3 text-xs border-t border-[var(--color-border)]" style={{ color: "var(--color-muted)" }}>
                <Spinner size={12} />
                <span>Fetching more…</span>
              </div>
            )}
          </div>
        )}

        {/* Idle prompt */}
        {!isReplacing && results === null && !error && (
          <p className="px-6 py-8 text-sm text-[var(--color-muted)] text-center">
            Enter search terms above and press Search.
          </p>
        )}
      </div>
    </div>
  );
}