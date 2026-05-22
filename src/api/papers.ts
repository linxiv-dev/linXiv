import { apiFetch, BASE_URL } from "./client";
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

export interface PaperRepairBody {
  title: string;
  authors: string[];
  published: string;
  summary: string;
  category?: string | null;
  doi?: string | null;
  url?: string | null;
  tags?: string[] | null;
}

export async function removeFromAllProjects(sfk: number): Promise<{ ok: boolean; removed_from: number[] }> {
  return apiFetch(`/api/papers/sfk/${sfk}/projects`, { method: "DELETE" });
}

export async function repairPaper(sfk: number, body: PaperRepairBody): Promise<Paper> {
  return apiFetch<Paper>(`/api/papers/sfk/${sfk}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * Returns the URL to stream/download the PDF for a paper. In Tauri this hits
 * the backend directly; in browser dev it goes through the Vite proxy.
 */
export function getPaperPdfUrl(sourceId: string, version?: number): string {
  const query = version !== undefined ? `?version=${version}` : "";
  return `${BASE_URL}/api/papers/${encodeURIComponent(sourceId)}/pdf${query}`;
}
