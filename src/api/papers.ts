import { BASE_URL, bytesToBase64, isTauri } from "./client.ts";
import { libraryFetch } from "../stores/backend.ts";
import type {
  Paper,
  PaperRepairBody,
  PapersListing,
  PaperVersionsResponse,
  DoiCandidates,
  DoiVersionCandidate,
  FullTextPending,
  FullTextReceipt,
  MergeReceipt,
  OkReceipt,
  PaperMergeBody,
  PaperSavedBody,
  SavedSourceIds,
  DeletedPaperReceipt,
  RemovedFromProjects,
  UploadPdfBody,
} from "../types/api";

// The in-process app serves PDF bytes over the `linxiv://` custom scheme (the
// invoke() transport can't stream binary). The host form is platform-dependent:
// linxiv://localhost on Linux/macOS, http://linxiv.localhost on Windows. Browser
// dev has no custom scheme, so callers keep the HTTP URL for the Vite proxy.
function linxivUrl(path: string): string {
  const isWindows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const base = isWindows ? "http://linxiv.localhost" : "linxiv://localhost";
  return `${base}/${path}`;
}

// `{metric}_{dir}`; the server sorts (and indexes) by metric, so the ordering
// holds across the whole library, not just the fetched window.
export type PaperSort =
  | "published_desc"
  | "published_asc"
  | "added_desc"
  | "added_asc"
  | "title_asc"
  | "title_desc";

export async function listPapers(
  limit = 200,
  offset = 0,
  sort?: PaperSort,
  project?: number
): Promise<PapersListing> {
  const order = sort ? `&sort=${sort.split("_")[0]}&dir=${sort.split("_")[1]}` : "";
  const proj = project !== undefined ? `&project=${project}` : "";
  return libraryFetch<PapersListing>(
    `/api/papers?limit=${limit}&offset=${offset}${order}${proj}`
  );
}

// Server-side cap on GET /api/papers?limit=; project-scoped fetches use it so
// membership, not a 200-paper window, decides what a page shows.
// ponytail: a single project >5000 papers is still windowed; page with offset=
// if that ever becomes real.
export const PAPER_LIMIT_MAX = 5000;

/** All papers linked to a project, filtered server-side (no client window). */
export function listProjectPapers(projectId: number): Promise<PapersListing> {
  return listPapers(PAPER_LIMIT_MAX, 0, undefined, projectId);
}

/** Which of the given stored ids (`entry_id`s, e.g. "arxiv:2204.12985") the
 *  library holds active, echoed back verbatim — trashed/unknown ids are absent.
 *  Backs the search page's saved indicator. */
export async function getSavedSourceIds(entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const body: PaperSavedBody = { source_ids: entryIds };
  const data = await libraryFetch<SavedSourceIds>(
    "/api/papers/saved",
    { method: "POST", body: JSON.stringify(body) }
  );
  return data.saved_source_ids;
}

export async function getPaper(sourceId: string): Promise<Paper> {
  return libraryFetch<Paper>(`/api/papers/${encodeURIComponent(sourceId)}`);
}

export async function getPaperBySfk(sfk: number, version?: number): Promise<Paper> {
  const query = version !== undefined ? `?version=${version}` : "";
  return libraryFetch<Paper>(`/api/papers/sfk/${sfk}${query}`);
}

export async function getPaperVersions(sfk: number): Promise<PaperVersionsResponse> {
  return libraryFetch<PaperVersionsResponse>(`/api/papers/sfk/${sfk}/versions`);
}

export async function getDoiVersionCandidates(sfk: number): Promise<DoiVersionCandidate[]> {
  const data = await libraryFetch<DoiCandidates>(
    `/api/papers/sfk/${sfk}/doi-candidates`
  );
  return data.candidates;
}

// Merge a duplicate paper root INTO `winnerSfk`: the winner's metadata stays
// canonical; the duplicate's notes, annotations, memberships, tags, missing
// versions and PDFs move over, then it's deleted. 409s on self/trashed/
// share-linked duplicates.
export async function mergePapers(
  winnerSfk: number,
  loserSfk: number
): Promise<MergeReceipt> {
  const body: PaperMergeBody = { loser_source_fk: loserSfk };
  return libraryFetch<MergeReceipt>(`/api/papers/sfk/${winnerSfk}/merge`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deletePaper(sourceId: string): Promise<DeletedPaperReceipt> {
  return libraryFetch<DeletedPaperReceipt>(
    `/api/papers/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" }
  );
}

/** Store PDF bytes as the saved paper's managed PDF. */
export async function uploadPdf(sourceId: string, bytes: Uint8Array): Promise<OkReceipt> {
  const body: UploadPdfBody = { file_b64: bytesToBase64(bytes) };
  return libraryFetch<OkReceipt>(`/api/papers/${encodeURIComponent(sourceId)}/pdf`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export type { PaperRepairBody };

export async function removeFromAllProjects(sfk: number): Promise<RemovedFromProjects> {
  return libraryFetch(`/api/papers/sfk/${sfk}/projects`, { method: "DELETE" });
}

export async function repairPaper(sfk: number, body: PaperRepairBody): Promise<Paper> {
  return libraryFetch<Paper>(`/api/papers/sfk/${sfk}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function searchLibrary(
  q: string,
  limit = 50
): Promise<PapersListing> {
  return libraryFetch<PapersListing>(
    `/api/papers/search?q=${encodeURIComponent(q)}&limit=${limit}`
  );
}

/** Core's `FullTextReceipt`. */
export type { FullTextReceipt as FullTextResult } from "../types/api";

/** Downloads a paper's arXiv TeX source and indexes it, so `searchLibrary` can
 *  match the body and not just the metadata. Already-indexed papers are skipped
 *  unless `force`. */
export async function fetchFullText(
  sourceId: string,
  force = false
): Promise<FullTextReceipt> {
  return libraryFetch<FullTextReceipt>(
    `/api/papers/${encodeURIComponent(sourceId)}/full-text${force ? "?force=true" : ""}`,
    { method: "POST" }
  );
}

/** How many stored arXiv papers still have no indexed TeX source — the backlog
 *  the background full-text worker chews through. */
export async function fullTextPending(): Promise<FullTextPending> {
  return libraryFetch<FullTextPending>("/api/papers/full-text-pending");
}

/** URL that streams a paper's PDF. */
export function getPaperPdfUrl(sourceId: string, version?: number): string {
  const id = encodeURIComponent(sourceId);
  // Tauri: id travels as a query param (a slash-bearing old-style id stays one
  // token). Browser dev: the HTTP path Vite proxies to the dev server.
  if (isTauri) {
    const v = version !== undefined ? `&version=${version}` : "";
    return linxivUrl(`pdf?id=${id}${v}`);
  }
  const query = version !== undefined ? `?version=${version}` : "";
  return `${BASE_URL}/api/papers/${id}/pdf${query}`;
}

/** URL that streams an external (arXiv) PDF through the host-allowlisted proxy —
 *  the preview pages' CORS fallback. linxiv:// in the app, HTTP in dev. */
export function getPdfProxyUrl(remoteUrl: string): string {
  const url = encodeURIComponent(remoteUrl);
  if (isTauri) return linxivUrl(`pdf-proxy?url=${url}`);
  return `${BASE_URL}/api/pdf/proxy?url=${url}`;
}
