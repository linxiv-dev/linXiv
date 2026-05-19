import { apiFetch } from "./client";

export interface TrashedPaper {
  source_fk: number;
  source_id: string;
  title: string;
  authors: string[] | null;
  published: string | null;
  deleted_at: string | null;
  had_pdf: boolean;
}

export async function listTrash(): Promise<{ papers: TrashedPaper[] }> {
  return apiFetch("/api/trash");
}

export async function restorePaper(sourceId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/trash/${encodeURIComponent(sourceId)}/restore`, { method: "POST" });
}

export async function hardDeletePaper(sourceId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/trash/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
}
