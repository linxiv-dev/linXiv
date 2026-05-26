import { apiFetch } from "./client";
import type { Paper, Project } from "../types/api";

export interface TagDetail {
  label: string;
  papers: Paper[];
  projects: Project[];
}

export async function getAllTags(): Promise<string[]> {
  return apiFetch<{ tags: string[] }>("/api/tags").then((r) => r.tags);
}

export async function getTagDetail(label: string): Promise<TagDetail> {
  return apiFetch<TagDetail>(`/api/tags/${encodeURIComponent(label)}`);
}
