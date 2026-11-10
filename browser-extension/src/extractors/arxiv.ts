import type { ClipFields } from "../types";

function metaContent(document: Document, name: string): string | undefined {
  const value = document
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();

  return value || undefined;
}

function allMetaContent(document: Document, name: string): string[] {
  return Array.from(
    document.querySelectorAll<HTMLMetaElement>(`meta[name="${name}"]`)
  )
    .map((element) => element.getAttribute("content")?.trim() ?? "")
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "[Submitted on 12 Jun 2017 (v1), ...]" -> "2017-06-12"; accepts 2- or 4-digit years.
export function parseArxivDateline(dateline: string): string | undefined {
  const match = dateline.match(/Submitted on (\d{1,2}) ([A-Z][a-z]{2}) (\d{4}|\d{2})\b/);
  const month = match ? MONTHS.indexOf(match[2]) + 1 : 0;

  if (!match || month === 0) {
    return undefined;
  }

  const shortYear = Number(match[3]);
  const year =
    match[3].length === 4 ? shortYear : shortYear >= 91 ? 1900 + shortYear : 2000 + shortYear;

  return `${year}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

/** Unversioned ids become v1 in linXiv, so find the version the page shows. */
function versionedId(document: Document, id: string, rawUrl: string): string {
  if (/v\d+$/.test(id)) {
    return id;
  }

  const fromUrl = extractArxivIdFromUrl(rawUrl);

  if (fromUrl?.startsWith(`${id}v`)) {
    return fromUrl;
  }

  const history = document.querySelector(".submission-history")?.textContent ?? "";
  const versions = Array.from(history.matchAll(/\[v(\d+)\]/g), (m) => Number(m[1]));

  return versions.length > 0 ? `${id}v${Math.max(...versions)}` : id;
}

export function extractArxiv(document: Document, rawUrl: string): ClipFields | null {
  const metaArxivId = metaContent(document, "citation_arxiv_id")
    ?.replace(/^arXiv:/i, "")
    .trim();

  const bareId = metaArxivId || extractArxivIdFromUrl(rawUrl);

  if (!bareId) {
    return null;
  }

  const arxivId = versionedId(document, bareId, rawUrl);

  const title =
    metaContent(document, "citation_title") ??
    document.querySelector("h1.title")?.textContent?.replace(/^Title:\s*/i, "").trim();

  let authors = allMetaContent(document, "citation_author");

  if (authors.length === 0) {
    authors = Array.from(document.querySelectorAll("div.authors a"))
      .map((author) => author.textContent?.trim() ?? "")
      .filter(Boolean);
  }

  const abstract =
    metaContent(document, "citation_abstract") ??
    document.querySelector("blockquote.abstract")?.textContent
      ?.replace(/^Abstract:\s*/i, "")
      .trim();

  const publicationDate =
    metaContent(document, "citation_date") ??
    metaContent(document, "citation_publication_date") ??
    metaContent(document, "citation_online_date");

  const dateline = document.querySelector("#abs .dateline")?.textContent;
  const date = dateline ? parseArxivDateline(dateline) : undefined;

  const year =
    publicationDate?.match(/\b(?:19|20)\d{2}\b/)?.[0] ??
    date?.slice(0, 4) ??
    extractArxivYearFromId(arxivId);

  return {
    type: "article",
    arxivId,
    title,
    authors,
    abstract,
    doi: metaContent(document, "citation_doi"),
    year,
    date,
    pdfUrl: metaContent(document, "citation_pdf_url") ?? `https://arxiv.org/pdf/${arxivId}`,
    url: `https://arxiv.org/abs/${arxivId}`,
  };
}
