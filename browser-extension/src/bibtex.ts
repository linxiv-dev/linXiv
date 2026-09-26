import type { ClipPreview } from "./types";

function normalizeBibtexText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bibtexValue(value: string): string {
  const normalized = normalizeBibtexText(value).replace(/[{}]/g, (brace) => `\\${brace}`);
  return `{${normalized}}`;
}

function bibtexKey(preview: ClipPreview): string {
  const raw = `${preview.target.kind}_${preview.target.value}`;
  return raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "linxiv_clip";
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
  const fields: string[] = [
    `  title = ${bibtexValue(preview.title)}`,
  ];

  if (preview.authors.length > 0) {
    fields.push(
      `  author = ${bibtexValue(preview.authors.join(" and "))}`
    );
  }

  const year =
    preview.year ??
    (preview.target.kind === "arxiv"
      ? yearFromArxivId(preview.target.value)
      : undefined);

  // Keep the year numeric instead of wrapping it in braces. The backend's
  // BibTeX parser first attempts to decode this field as an integer.
  if (year) {
    fields.push(`  year = ${year}`);
  }

  if (preview.abstract) {
    fields.push(`  abstract = ${bibtexValue(preview.abstract)}`);
  }

  if (preview.doi) {
    fields.push(`  doi = ${bibtexValue(preview.doi)}`);
  }

  fields.push(`  url = ${bibtexValue(preview.canonicalUrl)}`);

  if (preview.target.kind === "arxiv") {
    fields.push(`  eprint = ${bibtexValue(preview.target.value)}`);
    fields.push("  archivePrefix = {arXiv}");
  }

  return `@article{${bibtexKey(preview)},\n${fields.join(",\n")}\n}\n`;
}
