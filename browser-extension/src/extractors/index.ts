import type {
  ClipCandidate,
  ClipFields,
  ClipPreview,
  ClipTarget,
  FieldSources,
  PageExtraction,
} from "../types";
import { extractArxiv } from "./arxiv.ts";
import { coinsItems, embeddedLayers, type Layer } from "./embedded.ts";
import {
  arxivFromText,
  doiFromUrl,
  isbnFromText,
  pageText,
  pmcidFromUrl,
  pmidFromUrl,
  weakDois,
} from "./identifiers.ts";
import { clean, stripAbstractLabel, withoutSignature } from "./normalize.ts";

const FIELD_NAMES: (keyof ClipFields)[] = [
  "type", "title", "authors", "abstract", "doi", "arxivId", "pmid", "pmcid", "isbn", "issn",
  "journal", "volume", "issue", "pages", "publisher", "language", "keywords", "date", "year",
  "url", "pdfUrl",
];

function isPresent(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
}

/** Earlier layers win, field by field. */
function mergeLayers(layers: Layer[]): { fields: ClipFields; sources: FieldSources } {
  const fields: Record<string, unknown> = {};
  const sources: FieldSources = {};

  for (const layer of layers) {
    for (const name of FIELD_NAMES) {
      const value = layer.fields[name];
      if (!isPresent(fields[name]) && isPresent(value)) {
        fields[name] = value;
        sources[name] = layer.name;
      }
    }
  }

  return { fields: fields as ClipFields, sources };
}

function hostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function stripFragment(rawUrl: string): string {
  return rawUrl.split("#")[0];
}

function isPdfUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function targetFor(fields: ClipFields, rawUrl: string, viewingPdf: boolean): ClipTarget {
  if (fields.arxivId) return { kind: "arxiv", value: fields.arxivId };
  if (fields.doi) return { kind: "doi", value: fields.doi };
  if (viewingPdf) return { kind: "pdf", value: rawUrl };
  return { kind: "url", value: withoutSignature(stripFragment(rawUrl)) };
}

/** Builds the final item. Title always ends up set, so anything can be saved. */
export function toPreview(
  fields: ClipFields,
  sources: FieldSources,
  rawUrl: string,
  fallbackTitle: string | undefined,
  viewingPdf = false
): ClipPreview {
  const pageUrl = withoutSignature(stripFragment(rawUrl));
  const title = fields.title ?? clean(fallbackTitle) ?? pageUrl;
  const filled: FieldSources = { ...sources };

  if (!fields.title) {
    filled.title = "page";
  }

  return {
    ...fields,
    abstract: fields.abstract && stripAbstractLabel(fields.abstract),
    site: hostname(rawUrl),
    type: fields.type ?? (fields.doi || fields.arxivId ? "article" : "webpage"),
    title,
    authors: fields.authors ?? [],
    canonicalUrl: fields.url ? withoutSignature(fields.url) : pageUrl,
    target: targetFor(fields, rawUrl, viewingPdf),
    sources: filled,
  };
}

function strongIdentifiers(rawUrl: string, text: string): ClipFields {
  return {
    doi: doiFromUrl(rawUrl),
    arxivId: arxivFromText(rawUrl),
    pmid: pmidFromUrl(rawUrl),
    pmcid: pmcidFromUrl(rawUrl),
    isbn: isbnFromText(text),
  };
}

/**
 * Works out metadata from any page. Never returns "unsupported": with nothing
 * else to go on, the result is the page's own title and URL.
 */
export function extractPage(document: Document, rawUrl: string): PageExtraction {
  const layers: Layer[] = [];
  const arxivHost = /^(www\.)?arxiv\.org$/.test(hostname(rawUrl));
  const arxiv = arxivHost ? extractArxiv(document, rawUrl) : null;

  if (arxiv) {
    layers.push({ name: "arxiv", scholarly: true, fields: arxiv });
  }

  layers.push(...embeddedLayers(document));

  const scholarly = layers.some((layer) => layer.scholarly);
  const text = pageText(document.body);

  layers.push({ name: "identifier-scan", scholarly: false, fields: strongIdentifiers(rawUrl, text) });

  const { fields, sources } = mergeLayers(layers);
  const preview = toPreview(fields, sources, rawUrl, document.title);

  // A page that identifies itself is about one item, whatever else it cites.
  if (scholarly || fields.doi || fields.arxivId || fields.pmid || fields.pmcid) {
    return { preview, candidates: [] };
  }

  const candidates: ClipCandidate[] = coinsItems(document)
    .filter(() => document.querySelectorAll("span.Z3988").length > 1)
    .map((item, i) => ({
      id: `coins-${i}`,
      label: item.title ?? item.doi ?? `Item ${i + 1}`,
      fields: item,
    }));

  const listed = new Set(candidates.map((candidate) => candidate.fields.doi));

  for (const doi of weakDois(document)) {
    if (!listed.has(doi)) {
      candidates.push({ id: `doi-${doi}`, label: doi, fields: { doi, type: "article" } });
    }
  }

  return { preview, candidates };
}

/**
 * For tabs no script can enter: the built-in PDF viewer and `about:` pages.
 * The URL and title are all there is to work from.
 */
export function extractFromTab(rawUrl: string, title: string | undefined): PageExtraction {
  const fields = strongIdentifiers(rawUrl, "");
  const viewingPdf = isPdfUrl(rawUrl);

  if (viewingPdf) {
    fields.pdfUrl = rawUrl;
  }

  const sources: FieldSources = {};
  for (const name of FIELD_NAMES) {
    if (isPresent(fields[name])) {
      sources[name] = "tab-url";
    }
  }

  // Strip the PDF.js suffix so the fallback title reads as a title.
  // Firefox also appends the file name: "A title - 1-s2.0-S26-main.pdf".
  const tabTitle = clean(title?.replace(/\s*[-–—]?\s*PDF\.js( viewer)?$/i, "").replace(/\s+[-–—]\s+\S+\.pdf$/i, ""));
  const fileName = viewingPdf ? rawUrl.split(/[?#]/)[0].split("/").pop() : undefined;

  return {
    preview: toPreview(fields, sources, rawUrl, tabTitle ?? fileName, viewingPdf),
    candidates: [],
  };
}
