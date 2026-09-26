import type { ClipPreview } from "../types";

function metaContent(document: Document, name: string): string | undefined {
  const value = document
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.content.trim();

  return value || undefined;
}

function allMetaContent(document: Document, name: string): string[] {
  return Array.from(
    document.querySelectorAll<HTMLMetaElement>(`meta[name="${name}"]`)
  )
    .map((element) => element.content.trim())
    .filter(Boolean);
}

export function extractArxivIdFromUrl(rawUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.hostname !== "arxiv.org" && url.hostname !== "www.arxiv.org") {
    return null;
  }

  const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/);

  if (!match) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

export function extractArxivYearFromId(arxivId: string): string | undefined {
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

export function extractArxiv(
  document: Document,
  rawUrl: string
): ClipPreview | null {
  const metaArxivId = metaContent(document, "citation_arxiv_id")
    ?.replace(/^arXiv:/i, "")
    .trim();

  const arxivId = metaArxivId || extractArxivIdFromUrl(rawUrl);

  if (!arxivId) {
    return null;
  }

  const title =
    metaContent(document, "citation_title") ??
    document.querySelector<HTMLElement>("h1.title")?.textContent
      ?.replace(/^Title:\s*/i, "")
      .trim() ??
    arxivId;

  let authors = allMetaContent(document, "citation_author");

  if (authors.length === 0) {
    authors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("div.authors a")
    )
      .map((author) => author.textContent?.trim() ?? "")
      .filter(Boolean);
  }

  const abstract =
    metaContent(document, "citation_abstract") ??
    document.querySelector<HTMLElement>("blockquote.abstract")?.textContent
      ?.replace(/^Abstract:\s*/i, "")
      .trim();

  const doi = metaContent(document, "citation_doi");

  const publicationDate =
    metaContent(document, "citation_date") ??
    metaContent(document, "citation_publication_date") ??
    metaContent(document, "citation_online_date");

  const dateline = document.querySelector<HTMLElement>(".dateline")?.textContent;

  const year =
    publicationDate?.match(/\b(?:19|20)\d{2}\b/)?.[0] ??
    dateline?.match(/\b(?:19|20)\d{2}\b/)?.[0] ??
    extractArxivYearFromId(arxivId);

  const pdfUrl =
    metaContent(document, "citation_pdf_url") ??
    `https://arxiv.org/pdf/${arxivId}`;

  return {
    site: "arxiv",

    target: {
      kind: "arxiv",
      value: arxivId,
    },

    title,
    authors,
    abstract,
    doi,
    year,
    pdfUrl,
    canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
  };
}
