import type { ClipCandidate, ClipFields, ClipPreview, ItemType } from "../types";
import { parseDoi } from "./identifiers.ts";
import { clean, normalizeDate, stripTags } from "./normalize.ts";

type Fetcher = typeof fetch;
type Json = Record<string, any>;

const TIMEOUT_MS = 8000;

const CROSSREF_TYPES: Record<string, ItemType> = {
  "journal-article": "article",
  "posted-content": "article",
  "proceedings-article": "conference",
  "book": "book",
  "monograph": "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "dissertation": "thesis",
  "report": "report",
  "dataset": "dataset",
};

async function getJson(url: string, fetcher: Fetcher): Promise<Json | null> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return response.ok ? ((await response.json()) as Json) : null;
}

function isoFromParts(parts: number[] | undefined): string | undefined {
  if (!parts?.length) {
    return undefined;
  }

  return parts.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, "0"))).join("-");
}

export function parseCrossref(body: Json): ClipFields {
  const work = body.message ?? {};
  const issued = work.published ?? work.issued ?? work["published-print"] ?? work["published-online"];

  return {
    type: CROSSREF_TYPES[work.type],
    title: clean(work.title?.[0]),
    authors: (work.author ?? [])
      .map((a: Json) => clean(a.name) ?? clean(`${a.given ?? ""} ${a.family ?? ""}`))
      .filter(Boolean),
    abstract: stripTags(work.abstract),
    doi: clean(work.DOI),
    journal: clean(work["container-title"]?.[0]),
    volume: clean(work.volume),
    issue: clean(work.issue),
    pages: clean(work.page),
    publisher: clean(work.publisher),
    issn: clean(work.ISSN?.[0]),
    isbn: clean(work.ISBN?.[0])?.replace(/-/g, ""),
    language: clean(work.language),
    url: clean(work.URL),
    ...normalizeDate(isoFromParts(issued?.["date-parts"]?.[0])),
  };
}

export function parseDataCite(body: Json): ClipFields {
  const work = body.data?.attributes ?? {};
  const issued = (work.dates ?? []).find((d: Json) => d.dateType === "Issued")?.date;
  const abstract = (work.descriptions ?? []).find((d: Json) => d.descriptionType === "Abstract")?.description;
  const general = String(work.types?.resourceTypeGeneral ?? "").toLowerCase();
  const types: Record<string, ItemType> = {
    dataset: "dataset",
    book: "book",
    bookchapter: "chapter",
    dissertation: "thesis",
    report: "report",
    conferencepaper: "conference",
  };

  return {
    type: types[general],
    title: clean(work.titles?.[0]?.title),
    authors: (work.creators ?? []).map((c: Json) => clean(c.name)).filter(Boolean),
    abstract: stripTags(abstract),
    doi: clean(work.doi),
    publisher: clean(typeof work.publisher === "object" ? work.publisher?.name : work.publisher),
    language: clean(work.language),
    keywords: (work.subjects ?? []).map((s: Json) => clean(s.subject)).filter(Boolean),
    url: clean(work.url),
    ...normalizeDate(clean(issued) ?? clean(work.publicationYear)),
  };
}

export function parseArxivAtom(xml: string): ClipFields {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];

  if (!entry) {
    return {};
  }

  const decode = (value: string | undefined) =>
    clean(value?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
  const tag = (name: string) => decode(entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]);
  const id = tag("id")?.match(/abs\/(.+)$/)?.[1];

  return {
    type: "article",
    title: tag("title"),
    authors: Array.from(entry.matchAll(/<name>([\s\S]*?)<\/name>/g), (m) => decode(m[1])).filter(
      (name): name is string => Boolean(name)
    ),
    abstract: tag("summary"),
    doi: tag("arxiv:doi"),
    arxivId: id,
    journal: tag("arxiv:journal_ref"),
    url: id ? `https://arxiv.org/abs/${id}` : undefined,
    pdfUrl: id ? `https://arxiv.org/pdf/${id}` : undefined,
    ...normalizeDate(tag("published")),
  };
}

export function parseEsummary(body: Json, id: string): ClipFields {
  const record = body.result?.[id];

  if (!record || record.error) {
    return {};
  }

  const articleId = (type: string) =>
    (record.articleids ?? []).find((item: Json) => item.idtype === type)?.value as string | undefined;

  return {
    type: "article",
    title: clean(record.title)?.replace(/\.$/, ""),
    authors: (record.authors ?? []).map((a: Json) => clean(a.name)).filter(Boolean),
    journal: clean(record.fulljournalname),
    volume: clean(record.volume),
    issue: clean(record.issue),
    pages: clean(record.pages),
    issn: clean(record.issn),
    doi: parseDoi(articleId("doi")),
    pmid: articleId("pubmed") ?? articleId("pmid"),
    pmcid: articleId("pmc") ?? articleId("pmcid"),
    ...normalizeDate(clean(record.sortpubdate) ?? clean(record.pubdate)),
  };
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

/** Asks the registry for the identifier. A failed lookup just adds nothing. */
export async function lookupFields(
  ids: Pick<ClipFields, "doi" | "arxivId" | "pmid" | "pmcid">,
  fetcher: Fetcher = fetch
): Promise<{ fields: ClipFields; source: string } | null> {
  const attempts: [string, () => Promise<ClipFields | null>][] = [];

  if (ids.doi) {
    const doi = encodeURIComponent(ids.doi);
    attempts.push(["crossref", async () => {
      const body = await getJson(`https://api.crossref.org/works/${doi}`, fetcher);
      return body && parseCrossref(body);
    }]);
    attempts.push(["datacite", async () => {
      const body = await getJson(`https://api.datacite.org/dois/${doi}`, fetcher);
      return body && parseDataCite(body);
    }]);
  }

  if (ids.arxivId) {
    attempts.push(["arxiv-api", async () => {
      const response = await fetcher(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.arxivId as string)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      );
      return response.ok ? parseArxivAtom(await response.text()) : null;
    }]);
  }

  if (ids.pmid) {
    const pmid = ids.pmid;
    attempts.push(["pubmed", async () => {
      const body = await getJson(`${EUTILS}?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}`, fetcher);
      return body && parseEsummary(body, pmid);
    }]);
  }

  if (ids.pmcid) {
    const numeric = ids.pmcid.replace(/^PMC/i, "");
    attempts.push(["pubmed-central", async () => {
      const body = await getJson(`${EUTILS}?db=pmc&retmode=json&id=${encodeURIComponent(numeric)}`, fetcher);
      return body && parseEsummary(body, numeric);
    }]);
  }

  for (const [source, attempt] of attempts) {
    try {
      const fields = await attempt();
      if (fields?.title) {
        return { fields, source };
      }
    } catch {
      // Offline or rate limited: try the next registry, or keep what the page gave.
    }
  }

  return null;
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const MAX_IDENTITY_CHECKS = 3;
const MIN_TITLE_LENGTH = 12;

/**
 * A DOI in a page's text might be a citation, or the page's own. If the registry
 * gives it the page's title, it's the page's own (IEEE shows it only in the body).
 * Skipped with several COinS items or many DOIs, which mean a list of references.
 */
export async function identifyPage(
  preview: ClipPreview,
  candidates: ClipCandidate[],
  fetcher: Fetcher = fetch
): Promise<ClipPreview | null> {
  const isDoiOnly = candidates.every((candidate) => candidate.id.startsWith("doi-"));

  if (candidates.length === 0 || candidates.length > MAX_IDENTITY_CHECKS || !isDoiOnly) {
    return null;
  }

  const pageTitle = titleKey(preview.title);

  for (const candidate of candidates) {
    const found = await lookupFields({ doi: candidate.fields.doi }, fetcher);
    const key = found?.fields.title ? titleKey(found.fields.title) : "";

    if (found && key.length >= MIN_TITLE_LENGTH && pageTitle.includes(key)) {
      const identified: ClipPreview = {
        ...preview,
        doi: candidate.fields.doi,
        sources: { ...preview.sources, doi: "page-text" },
      };
      return fillBlanks(identified, found.fields, found.source);
    }
  }

  return null;
}

function hasValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
}

/** Page values stand. The registry only fills what's blank. */
export function fillBlanks(preview: ClipPreview, fields: ClipFields, source: string): ClipPreview {
  const next: ClipPreview = { ...preview, sources: { ...preview.sources } };
  const record = next as unknown as Record<string, unknown>;
  // A title that fell back to the page's own title is no match for a registry's.
  const replaceable = new Set(next.sources.title === "page" ? ["title"] : []);

  for (const [name, value] of Object.entries(fields)) {
    if (hasValue(value) && (!hasValue(record[name]) || replaceable.has(name))) {
      record[name] = value;
      next.sources[name as keyof ClipFields] = source;
    }
  }

  // Pages rarely state a type, so ours is mostly a guess. The registry knows.
  if (fields.type) {
    next.type = fields.type;
    next.sources.type = source;
  }

  // Some sites (bioRxiv) publish January 1 as a placeholder for "this year".
  if (
    preview.date?.endsWith("-01-01") &&
    fields.date &&
    fields.date.slice(0, 4) === preview.date.slice(0, 4)
  ) {
    next.date = fields.date;
    next.sources.date = source;
  }

  // The API names the latest version. A bare id would become v1 in linXiv.
  if (fields.arxivId?.startsWith(`${next.arxivId}v`)) {
    next.arxivId = fields.arxivId;
    next.sources.arxivId = source;
  }

  if (next.arxivId) {
    next.target = { kind: "arxiv", value: next.arxivId };
  } else if (next.doi) {
    next.target = { kind: "doi", value: next.doi };
  }

  return next;
}
