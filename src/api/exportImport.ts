import { save, open } from "@tauri-apps/plugin-dialog";
import { join as pathJoin } from "@tauri-apps/api/path";
import { BASE_URL, bytesToBase64, isTauri } from "./client.ts";
import { libraryFetch } from "../stores/backend.ts";
import type {
  BibtexImportReceipt,
  ImportBibtexBody,
  ImportCommitBody,
  ImportPdfBody,
  ImportPdfUrlBody,
  ImportPreviewBody,
  ImportPreviewResponse,
  ImportedProject,
  OkReceipt,
  PaperImportResult,
  ProjectExportBody,
  RecognizeBody,
  RecognizedInput,
} from "../types/api";

export type { ImportPreviewResponse };

async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

function pickerCancelled(): Error {
  return Object.assign(new Error("Cancelled"), { name: "AbortError" });
}

async function fetchBlob(url: string, init?: RequestInit): Promise<{ blob: Blob; filename?: string }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename[^;=\n]*=(?:(['"])(.+?)\1|([^;\n]+))/);
  const filename = match ? (match[2] ?? match[3])?.trim() : undefined;
  return { blob: await res.blob(), filename };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function slugify(name?: string, id?: number, ext = ""): string {
  const stripped = name ? name.replace(/[:/\\*?"<>|]/g, "").replace(/\s+/g, "_").toLowerCase() : "";
  const base = stripped || `project-${id ?? "unknown"}`;
  return `${base}${ext}`;
}

export async function exportProject(
  projectId: number,
  includePdfs = false,
  projectName?: string
): Promise<void> {
  const slug = slugify(projectName, projectId, ".lxproj");
  if (isTauri) {
    const destPath = await save({
      defaultPath: slug,
      filters: [{ name: "linXiv Project", extensions: ["lxproj"] }],
    });
    if (!destPath) throw pickerCancelled();
    const body: ProjectExportBody = { include_pdfs: includePdfs, dest_path: destPath };
    await libraryFetch<OkReceipt>(`/api/projects/${projectId}/export`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return;
  }
  const body: ProjectExportBody = { include_pdfs: includePdfs };
  const { blob, filename } = await fetchBlob(`${BASE_URL}/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  triggerDownload(blob, filename ?? slug);
}

export async function previewImport(file: File): Promise<ImportPreviewResponse> {
  const body: ImportPreviewBody = { file_b64: await fileToBase64(file) };
  return libraryFetch<ImportPreviewResponse>("/api/projects/import/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function commitImport(
  file: File,
  onConflict: "merge" | "overwrite" = "merge"
): Promise<ImportedProject> {
  const body: ImportCommitBody = {
    file_b64: await fileToBase64(file),
    on_conflict: onConflict,
  };
  return libraryFetch<ImportedProject>("/api/projects/import/commit", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function exportBibtex(projectId: number, projectName?: string): Promise<void> {
  const slug = slugify(projectName, projectId, ".bib");
  if (isTauri) {
    const destPath = await save({
      defaultPath: slug,
      filters: [{ name: "BibTeX", extensions: ["bib"] }],
    });
    if (!destPath) throw pickerCancelled();
    await libraryFetch<OkReceipt>(`/api/projects/${projectId}/export/bibtex?dest_path=${encodeURIComponent(destPath)}`);
    return;
  }
  const { blob } = await fetchBlob(`${BASE_URL}/api/projects/${projectId}/export/bibtex`);
  triggerDownload(blob, slug);
}

export async function exportZotero(projectId: number, projectName?: string): Promise<void> {
  const slug = slugify(projectName, projectId, ".json");
  if (isTauri) {
    const destPath = await save({
      defaultPath: slug,
      filters: [{ name: "CSL JSON", extensions: ["json"] }],
    });
    if (!destPath) throw pickerCancelled();
    await libraryFetch<OkReceipt>(`/api/projects/${projectId}/export/zotero?dest_path=${encodeURIComponent(destPath)}`);
    return;
  }
  const { blob } = await fetchBlob(`${BASE_URL}/api/projects/${projectId}/export/zotero`);
  triggerDownload(blob, slug);
}

export async function exportObsidian(projectId: number, projectName?: string): Promise<void> {
  const slug = slugify(projectName, projectId, ".md");
  if (isTauri) {
    const picked = await open({ directory: true, title: "Select Obsidian vault folder" });
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    if (!destDir) throw pickerCancelled();
    const destPath = await pathJoin(destDir, slug);
    await libraryFetch<OkReceipt>(`/api/projects/${projectId}/export/obsidian?dest_path=${encodeURIComponent(destPath)}`);
    return;
  }
  const { blob } = await fetchBlob(`${BASE_URL}/api/projects/${projectId}/export/obsidian`);
  triggerDownload(blob, slug);
}

/** Classify a pasted string (arXiv link/id, DOI, direct PDF URL). Pure, no network on the backend. */
export async function recognizePaperInput(input: string): Promise<RecognizedInput> {
  const body: RecognizeBody = { input };
  return libraryFetch<RecognizedInput>("/api/papers/import/recognize", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Fetch a direct PDF URL server-side (SSRF/size guarded) and import it. */
export async function importPdfUrl(
  url: string,
  projectId?: number
): Promise<PaperImportResult> {
  const body: ImportPdfUrlBody = projectId
    ? { url, project_id: projectId }
    : { url };
  return libraryFetch<PaperImportResult>("/api/papers/import/pdf-url", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function importBibtex(
  file: File,
  projectId?: number
): Promise<BibtexImportReceipt> {
  const file_b64 = await fileToBase64(file);
  const body: ImportBibtexBody = projectId
    ? { file_b64, project_id: projectId }
    : { file_b64 };
  return libraryFetch<BibtexImportReceipt>("/api/papers/import/bibtex", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function importPdf(
  file: File,
  projectId?: number
): Promise<PaperImportResult> {
  const path = projectId
    ? `/api/papers/import/pdf?project_id=${projectId}`
    : "/api/papers/import/pdf";
  const body: ImportPdfBody = {
    file_b64: await fileToBase64(file),
    filename: file.name,
  };
  return libraryFetch<PaperImportResult>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
