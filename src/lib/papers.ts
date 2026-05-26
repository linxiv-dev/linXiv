export function normalizeAuthors(authors: string | string[]): string[] {
  // Split on semicolons to avoid corrupting "Last, First" name format.
  const raw = Array.isArray(authors) ? authors : authors.split(";");
  return raw.map((a) => a.trim()).filter(Boolean);
}

// Covers modern arXiv IDs (YYMM.NNNNN) and legacy IDs (cs/0612047, math.GT/0309136, cond-mat.mes-hall/0309136).
// Extends formats/markdown.py _ARXIV_ID_RE to handle dotted-category prefixes.
const _ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$|^[a-z][a-z-]+(\.[a-z][a-z-]*)?\/\d{7}(v\d+)?$/;

export function isArxivId(sourceId: string): boolean {
  return _ARXIV_ID_RE.test(sourceId);
}
