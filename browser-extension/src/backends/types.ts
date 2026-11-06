import type { ClipPreview } from "../types";

export type BackendKind = "desktop" | "headless";

export interface Settings {
  kind: BackendKind;
  /** Server address, for headless. */
  baseUrl: string;
  token: string;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  version?: string;
}

export interface SaveResult {
  /** "sent" means handed off with no way to know the outcome. */
  status: "sent" | "saved";
  ids: string[];
  /** Replaces the default message when the backend says more about the outcome. */
  note?: string;
}

/** The PDF open in a tab. `bytes` is absent for a backend that takes the URL. */
export interface PdfFile {
  url: string;
  filename: string;
  bytes?: Uint8Array;
}

export interface SavedPdf {
  status: "sent" | "saved";
  id?: string;
  title?: string;
  /** Replaces the default message when the backend says more about the outcome. */
  note?: string;
}

export interface Backend {
  /** "bytes": the addon fetches the file. "url": the backend fetches it itself. */
  pdfTransport: "bytes" | "url";
  probe(): Promise<ProbeResult>;
  /** Metadata for a page. PDFs from article pages are attached by hand in linXiv. */
  save(clips: ClipPreview[]): Promise<SaveResult>;
  /** A full-page PDF. The backend reads and checks the metadata from the file. */
  savePdf(pdf: PdfFile): Promise<SavedPdf>;
}

/** A failure worth showing to the user as written. */
export class BackendError extends Error {}
