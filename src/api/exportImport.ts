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
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? `project-${projectId}.lxproj`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
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
