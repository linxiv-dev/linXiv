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

export function buildBibtex(preview: ClipPreview): string {
  const fields: string[] = [
    `  title = ${bibtexValue(preview.title)}`,
  ];

  if (preview.authors.length > 0) {
    fields.push(
      `  author = ${bibtexValue(preview.authors.join(" and "))}`
    );
  }

  if (preview.year) {
    fields.push(`  year = ${bibtexValue(preview.year)}`);
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
