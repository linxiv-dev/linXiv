import { apiFetch } from "./client";
import type { Paper } from "../types/api";

export async function listPapers(
  limit = 200,
  offset = 0
): Promise<{ papers: Paper[] }> {
  return apiFetch<{ papers: Paper[] }>(
    `/api/papers?limit=${limit}&offset=${offset}`
  );
}

export async function getPaper(sourceId: string): Promise<Paper> {
  return apiFetch<Paper>(`/api/papers/${encodeURIComponent(sourceId)}`);
}

export async function getPaperBySfk(sfk: number): Promise<Paper> {
  return apiFetch<Paper>(`/api/papers/sfk/${sfk}`);
}

export async function deletePaper(sourceId: string): Promise<{ deleted: string }> {
  return apiFetch<{ deleted: string }>(
    `/api/papers/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" }
  );
}

/**
 * Returns the URL to stream/download the PDF for a paper. In Tauri this hits
 * the backend directly; in browser dev it goes through the Vite proxy.
 */
export function getPaperPdfUrl(sourceId: string, version?: number): string {
  const base =
    typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
      ? "http://127.0.0.1:8000"
      : "";
  const query = version !== undefined ? `?version=${version}` : "";
  return `${base}/api/papers/${encodeURIComponent(sourceId)}/pdf${query}`;
}
