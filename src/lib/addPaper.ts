import type { RecognizedInput } from "../types/api";

/** Recognize outcome: a DOI goes to the preview flow; other kinds are already saved. */
export type AddOutcome = { doi: string; pdfUrl?: string } | { savedTitle: string };

export const UNRECOGNIZED_REFERENCE =
  "Not a recognized paper reference. Paste an arXiv link or ID, a DOI, or a direct PDF link.";

/** The api calls Add Paper dispatches to, injected so the mapping is testable. */
export interface AddPaperApi {
  recognize: (raw: string) => Promise<RecognizedInput>;
  fetchArxiv: (id: string, save: boolean) => Promise<{ paper: { title: string } }>;
  importPdfUrl: (url: string) => Promise<{ title: string }>;
}

/** Recognize a pasted reference and save it, or hand a DOI back for preview. */
export async function addPaper(raw: string, api: AddPaperApi): Promise<AddOutcome> {
  const rec = await api.recognize(raw);
  switch (rec.kind) {
    case "doi":
      return { doi: rec.value };
    case "doi_with_pdf":
      return { doi: rec.value.doi, pdfUrl: rec.value.pdf_url };
    case "arxiv_id": {
      const r = await api.fetchArxiv(rec.value, true);
      return { savedTitle: r.paper.title };
    }
    case "direct_pdf_url": {
      const r = await api.importPdfUrl(rec.value);
      return { savedTitle: r.title };
    }
    default:
      throw new Error(UNRECOGNIZED_REFERENCE);
  }
}
