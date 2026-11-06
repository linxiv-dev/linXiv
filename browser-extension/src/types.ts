export type ClipTarget =
  | { kind: "arxiv"; value: string }
  | { kind: "doi"; value: string }
  | { kind: "pdf"; value: string }
  | { kind: "url"; value: string };

export type ItemType =
  | "article"
  | "book"
  | "chapter"
  | "conference"
  | "thesis"
  | "report"
  | "dataset"
  | "webpage";

/** What one extraction layer can say about a page. */
export interface ClipFields {
  type?: ItemType;
  title?: string;
  authors?: string[];
  abstract?: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  language?: string;
  keywords?: string[];
  /** Complete ISO date only (YYYY-MM-DD). Anything less goes in `year`. */
  date?: string;
  year?: string;
  url?: string;
  pdfUrl?: string;
}

/** Which layer supplied each field. */
export type FieldSources = Partial<Record<keyof ClipFields, string>>;

export interface ClipPreview extends ClipFields {
  /** Hostname of the page, for display. */
  site: string;
  type: ItemType;
  target: ClipTarget;
  title: string;
  authors: string[];
  canonicalUrl: string;
  sources: FieldSources;
}

/** One more thing on the page the user may want instead of the page itself. */
export interface ClipCandidate {
  id: string;
  label: string;
  fields: ClipFields;
}

export interface PageExtraction {
  preview: ClipPreview;
  /** Empty when the page is plainly about one item. */
  candidates: ClipCandidate[];
  /** Why the page itself couldn't be read, when the result came from the tab alone. */
  readError?: string;
  /** Firefox refused the script, as it does in its PDF viewer. */
  blocked?: boolean;
}
