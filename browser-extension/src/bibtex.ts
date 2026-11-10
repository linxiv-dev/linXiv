import type { ClipPreview, ItemType } from "./types";

const ENTRY_TYPES: Record<ItemType, string> = {
  article: "article",
  book: "book",
  chapter: "incollection",
  conference: "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  dataset: "misc",
  webpage: "misc",
};

function normalizeBibtexText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** For prose fields: braces and TeX specials are escaped. */
function bibtexValue(value: string): string {
  const normalized = normalizeBibtexText(value).replace(/[{}_%#&$]/g, (special) => `\\${special}`);
  return `{${normalized}}`;
}

/** For identifiers and URLs, which the parser reads verbatim. */
function bibtexVerbatim(value: string): string {
  return `{${normalizeBibtexText(value).replace(/[{}]/g, "")}}`;
}

/** Not cryptographic. Just stable, so re-clipping a page finds the same record. */
function hashUrl(url: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * The key decides identity in linXiv. Only an `arxiv:` key lets an arXiv id beat
 * a DOI, so a DOI-bearing preprint keeps one record (formats.rs `identity`).
 */
function bibtexKey(preview: ClipPreview): string {
  if (preview.arxivId) {
    const root = preview.arxivId.replace(/v\d+$/, "");
    return `arxiv:${root.replace(/[./]/g, "_")}`;
  }

  if (preview.doi) {
    return `doi_${preview.doi.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  }

  // Same book on two sites, one record.
  if (preview.isbn) {
    return `isbn_${preview.isbn}`;
  }

  return `web_${hashUrl(preview.canonicalUrl)}`;
}

function yearFromArxivId(arxivId: string): string | undefined {
  const newStyle = arxivId.match(/^(\d{2})\d{2}\.\d{4,5}(?:v\d+)?$/);

  if (newStyle) {
    return String(2000 + Number(newStyle[1]));
  }

  const oldStyle = arxivId.match(/^[a-z-]+(?:\.[A-Z]{2})?\/(\d{2})\d{5}(?:v\d+)?$/);

  if (!oldStyle) {
    return undefined;
  }

  const shortYear = Number(oldStyle[1]);
  return String(shortYear >= 91 ? 1900 + shortYear : 2000 + shortYear);
}

export function buildBibtex(preview: ClipPreview): string {
  const fields: string[] = [`  title = ${bibtexValue(preview.title)}`];
  const text = (name: string, value: string | undefined) => {
    if (value) fields.push(`  ${name} = ${bibtexValue(value)}`);
  };
  const verbatim = (name: string, value: string | undefined) => {
    if (value) fields.push(`  ${name} = ${bibtexVerbatim(value)}`);
  };

  if (preview.authors.length > 0) {
    fields.push(`  author = ${bibtexValue(preview.authors.join(" and "))}`);
  }

  const year = preview.year ?? (preview.arxivId ? yearFromArxivId(preview.arxivId) : undefined);

  // Keep the year numeric instead of wrapping it in braces. The backend's
  // BibTeX parser first attempts to decode this field as an integer.
  if (year) {
    fields.push(`  year = ${year}`);
  }

  // Dates are complete by construction, see normalizeDate.
  verbatim("date", preview.date);
  text("abstract", preview.abstract);
  verbatim("doi", preview.doi);

  const container = preview.type === "chapter" || preview.type === "conference" ? "booktitle" : "journal";
  text(container, preview.journal);
  text("volume", preview.volume);
  text("number", preview.issue);
  text("pages", preview.pages);
  text("publisher", preview.publisher);
  verbatim("issn", preview.issn);
  verbatim("isbn", preview.isbn);
  text("language", preview.language);

  if (preview.keywords?.length) {
    text("keywords", preview.keywords.join(", "));
  }

  verbatim("pmid", preview.pmid);
  verbatim("pmcid", preview.pmcid);
  verbatim("url", preview.canonicalUrl);

  if (preview.arxivId) {
    verbatim("eprint", preview.arxivId);
    fields.push("  archivePrefix = {arXiv}");
  }

  return `@${ENTRY_TYPES[preview.type]}{${bibtexKey(preview)},\n${fields.join(",\n")}\n}\n`;
}
