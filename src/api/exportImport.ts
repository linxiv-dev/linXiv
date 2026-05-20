// Shared base URL (mirrors client.ts logic)
const BASE_URL =
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
    ? "http://127.0.0.1:8000"
    : "";

export interface ImportPreview {
  project_name: string;
  description: string;
  paper_count: number;
  note_count: number;
  has_pdfs: boolean;
  format_version: number;
}

async function triggerDownload(res: Response, fallbackFilename: string): Promise<void> {
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportProject(
  projectId: number,
  includePdfs = false
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, include_pdfs: includePdfs }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Export failed (${res.status})`);
  }
  await triggerDownload(res, `project-${projectId}.lxproj`);
}

export async function previewImport(file: File): Promise<ImportPreview> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BASE_URL}/api/projects/import/preview`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Preview failed (${res.status})`);
  }
  return res.json() as Promise<ImportPreview>;
}

export async function commitImport(
  file: File,
  onConflict: "merge" | "overwrite" = "merge"
): Promise<{ project_id: number }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(
    `${BASE_URL}/api/projects/import/commit?on_conflict=${onConflict}`,
    { method: "POST", body: fd }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Import failed (${res.status})`);
  }
  return res.json() as Promise<{ project_id: number }>;
}

export async function exportBibtex(projectId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/bibtex`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `BibTeX export failed (${res.status})`);
  }
  await triggerDownload(res, `project-${projectId}.bib`);
}

export async function exportObsidian(projectId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/obsidian`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Obsidian export failed (${res.status})`);
  }
  await triggerDownload(res, `project-${projectId}.md`);
}

export async function importBibtex(
  file: File,
  projectId?: number
): Promise<{ saved_count: number; source_ids: string[] }> {
  const fd = new FormData();
  fd.append("file", file);
  const url = projectId
    ? `${BASE_URL}/api/papers/import/bibtex?project_id=${projectId}`
    : `${BASE_URL}/api/papers/import/bibtex`;
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `BibTeX import failed (${res.status})`);
  }
  return res.json() as Promise<{ saved_count: number; source_ids: string[] }>;
}

export async function importPdf(
  file: File,
  projectId?: number
): Promise<{ source_id: string; title: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const url = projectId
    ? `${BASE_URL}/api/papers/import/pdf?project_id=${projectId}`
    : `${BASE_URL}/api/papers/import/pdf`;
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `PDF import failed (${res.status})`);
  }
  return res.json() as Promise<{ source_id: string; title: string }>;
}
