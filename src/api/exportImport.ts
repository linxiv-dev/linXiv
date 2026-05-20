import { save, open } from "@tauri-apps/plugin-dialog";

// Shared base URL (mirrors client.ts logic)
const BASE_URL =
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
    ? "http://127.0.0.1:8000"
    : "";

const isTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

export interface ImportPreview {
  project_name: string;
  description: string;
  paper_count: number;
  note_count: number;
  has_pdfs: boolean;
  format_version: number;
}



export async function exportProject(
  projectId: number,
  includePdfs = false,
  projectName?: string
): Promise<void> {
  const slug = projectName ? projectName.replace(/\s+/g, "_").toLowerCase() : `project-${projectId}`;
  if (isTauri) {
    const destPath = await save({
      defaultPath: `${slug}.lxproj`,
      filters: [{ name: "linXiv Project", extensions: ["lxproj"] }],
    });
    if (!destPath) return;
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, include_pdfs: includePdfs, dest_path: destPath }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(body.detail ?? `Export failed (${res.status})`);
    }
    return;
  }
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, include_pdfs: includePdfs }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Export failed (${res.status})`);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? `${slug}.lxproj`;
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
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

export async function exportBibtex(projectId: number, projectName?: string): Promise<void> {
  const slug = projectName ? projectName.replace(/\s+/g, "_").toLowerCase() : `project-${projectId}`;
  if (isTauri) {
    const destPath = await save({
      defaultPath: `${slug}.bib`,
      filters: [{ name: "BibTeX", extensions: ["bib"] }],
    });
    if (!destPath) return;
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/bibtex?dest_path=${encodeURIComponent(destPath)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(body.detail ?? `BibTeX export failed (${res.status})`);
    }
    return;
  }
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/bibtex`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `BibTeX export failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: `${slug}.bib` }).click();
  URL.revokeObjectURL(url);
}

export async function exportObsidian(projectId: number, projectName?: string): Promise<void> {
  const slug = projectName ? projectName.replace(/\s+/g, "_").toLowerCase() : `project-${projectId}`;
  if (isTauri) {
    const destDir = await open({ directory: true, title: "Select Obsidian vault folder" });
    if (!destDir) return;
    const destPath = `${destDir}/${slug}.md`;
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/obsidian?dest_path=${encodeURIComponent(destPath)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(body.detail ?? `Obsidian export failed (${res.status})`);
    }
    return;
  }
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export/obsidian`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Obsidian export failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: `${slug}.md` }).click();
  URL.revokeObjectURL(url);
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
