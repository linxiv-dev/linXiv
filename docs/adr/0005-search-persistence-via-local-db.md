# ADR 0005: Search state persisted in local database, not keep-alive component

## Status

Accepted

## Context

The Search page was initially kept alive via CSS hide/show (component never unmounts) to preserve in-flight mutations and results across navigation. This works but ties up memory and doesn't survive app restarts.

The user's workflow often involves large batch searches (100+ results) against rate-limited APIs (arXiv, OpenAlex). Re-running those searches on every session is impractical.

## Decision

Search state is persisted in two local SQLite tables:

- **`search_history`**: a log of past searches (clauses, source, maxResults, timestamp). Surfaced as autocomplete suggestions in the clause input field after typing one character.
- **`search_results`**: the current working set of results, which can be a mix accumulated from multiple searches (deduplicated by source ID). Persists across restarts. Cleared explicitly by the user.

The Search page restores from `search_results` on mount — it no longer needs to be keep-alive. The Graph page remains keep-alive (iframe reload is unavoidable).

A plain **Search** button replaces the current working set. A **+** button adjacent to it appends new results to the existing set.

Users can configure how many result batches to retain in advanced settings (default: 1).

## Consequences

### Positive
- Large searches run once; results survive restarts without re-hitting rate limits.
- Enables cross-source mixing (arXiv + OpenAlex results in one working set).
- Enables future features: sort/filter on the full cached result set without a network call.
- Removes the keep-alive complexity for the Search component.

### Negative / limits
- Requires a local db migration to add the two tables.
- Result set can grow stale (paper may have been updated since it was fetched); users must be aware results are cached.

## References

- `CONTEXT.md` — Search History, Search Results definitions
- `storage/db.py` — where the new tables will live
- `src/pages/SearchPage.tsx` — consumer
