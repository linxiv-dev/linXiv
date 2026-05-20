import { apiFetch } from "./client";
import type { Note } from "../types/api";

export async function getNotes(
  sourceId: string,
  projectId?: number | null,
  allProjects?: boolean
): Promise<{ notes: Note[] }> {
  const params = new URLSearchParams({ source_id: sourceId });
  if (projectId !== undefined && projectId !== null) {
    params.set("project_id", String(projectId));
  }
  if (allProjects) {
    params.set("all_projects", "true");
  }
  return apiFetch<{ notes: Note[] }>(`/api/notes?${params.toString()}`);
}

export interface NoteCreateBody {
  source_id: string;
  project_id?: number | null;
  title?: string;
  content?: string;
}

export async function createNote(
  body: NoteCreateBody
): Promise<{ id: number }> {
  return apiFetch("/api/notes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface NoteUpdateBody {
  title?: string;
  content?: string;
}

export async function updateNote(
  id: number,
  body: NoteUpdateBody
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteNote(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/notes/${id}`, { method: "DELETE" });
}
