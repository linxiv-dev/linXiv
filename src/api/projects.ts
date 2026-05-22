import { apiFetch } from "./client";
import type { Project } from "../types/api";

export async function listProjects(
  status = "active"
): Promise<{ projects: Project[] }> {
  return apiFetch<{ projects: Project[] }>(`/api/projects?status=${status}`);
}

export async function getProject(id: number): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${id}`);
}

export interface ProjectCreateBody {
  name: string;
  description?: string;
  color_hex?: string | null;
  project_tags?: string[];
}

export async function createProject(
  body: ProjectCreateBody
): Promise<{ project: { id: number; name: string } }> {
  return apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ProjectUpdateBody {
  name?: string;
  description?: string;
  color_hex?: string | null;
  status?: string;
  project_tags?: string[];
}

export async function updateProject(
  id: number,
  body: ProjectUpdateBody
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteProject(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${id}`, { method: "DELETE" });
}

export async function archiveProject(id: number): Promise<{ ok: boolean }> {
  return updateProject(id, { status: "archived" });
}

export async function restoreProject(id: number): Promise<{ ok: boolean }> {
  return updateProject(id, { status: "active" });
}

export async function addPaperToProject(
  projectId: number,
  sourceId: string
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/projects/${projectId}/papers`, {
    method: "POST",
    body: JSON.stringify({ source_id: sourceId }),
  });
}

export async function removePaperFromProject(
  projectId: number,
  sourceId: string
): Promise<{ ok: boolean }> {
  return apiFetch(
    `/api/projects/${projectId}/papers/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" }
  );
}
