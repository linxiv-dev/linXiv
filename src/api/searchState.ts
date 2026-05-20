import { apiFetch } from "./client";
import type { Clause, SearchResult, SearchState } from "../types/api";

export type { SearchState };

export async function getSearchHistory(prefix: string, limit = 10): Promise<string[]> {
  const params = new URLSearchParams({ prefix, limit: String(limit) });
  const data = await apiFetch<{ suggestions: string[] }>(`/api/search/history?${params}`);
  return data.suggestions;
}

export async function getSearchState(): Promise<SearchState | null> {
  const data = await apiFetch<{ state: SearchState | null }>("/api/search/state");
  return data.state;
}

export async function saveSearchState(
  clauses: Clause[],
  source: string,
  maxResults: number,
  results: SearchResult[],
  savedIds: string[],
): Promise<void> {
  await apiFetch("/api/search/state", {
    method: "POST",
    body: JSON.stringify({
      clauses,
      source,
      max_results: maxResults,
      results,
      saved_ids: savedIds,
    }),
  });
}
