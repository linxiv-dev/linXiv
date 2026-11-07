import type { ClipFields, ItemType } from "../types";
import { parseDoi, parseIsbn } from "./identifiers.ts";
import { clean, normalizeDate, pageRange, splitList, stripTags } from "./normalize.ts";

/** One layer's findings. `scholarly` means it describes one citable item. */
export interface Layer {
  name: string;
  scholarly: boolean;
  fields: ClipFields;
}

type Meta = Map<string, string[]>;

/** All meta tags by lower-cased name, since case varies (`DC.Title`, `dc.title`). */
export function readMeta(document: Document): Meta {
  const meta: Meta = new Map();

  for (const element of Array.from(document.querySelectorAll("meta"))) {
    const name = element.getAttribute("name") ?? element.getAttribute("property");
    const content = clean(element.getAttribute("content"));

    if (name && content) {
      const key = name.toLowerCase();
      meta.set(key, [...(meta.get(key) ?? []), content]);
    }
  }

  return meta;
}

function first(meta: Meta, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = meta.get(name)?.[0];
    if (value) {
      return value;
    }
  }

  return undefined;
}

function all(meta: Meta, ...names: string[]): string[] {
  return names.flatMap((name) => meta.get(name) ?? []);
}

function withDate(fields: ClipFields, raw: string | undefined): ClipFields {
  return { ...fields, ...normalizeDate(raw) };
}

/** Highwire Press tags, and bepress, which is the same set under a prefix. */
function citationLayer(meta: Meta, prefix: string, name: string): Layer | null {
  const get = (...keys: string[]) => first(meta, ...keys.map((key) => prefix + key));
  const title = get("title");

  if (!title) {
    return null;
  }

  const conference = get("conference_title", "conference");
  const bookTitle = get("book_title");
  const inBook = get("inbook_title");
  const thesisSchool = get("dissertation_institution");
  const reportInstitution = get("technical_report_institution");
  const journal = get("journal_title", "journal_abbrev");
  const isbn = parseIsbn(get("isbn"));

  let type: ItemType = "article";
  if (thesisSchool) type = "thesis";
  else if (reportInstitution) type = "report";
  else if (conference) type = "conference";
  else if (inBook) type = "chapter";
  else if (!journal && (bookTitle || isbn)) type = "book";

  return {
    name,
    scholarly: true,
    fields: withDate(
      {
        type,
        title,
        authors: splitList(all(meta, `${prefix}author`, `${prefix}authors`), /;/),
        abstract: stripTags(get("abstract")),
        doi: parseDoi(get("doi")),
        arxivId: get("arxiv_id")?.replace(/^arxiv:/i, ""),
        pmid: get("pmid"),
        isbn,
        issn: get("issn", "eissn"),
        journal: journal ?? conference ?? inBook ?? bookTitle,
        volume: get("volume"),
        issue: get("issue"),
        pages: pageRange(get("firstpage"), get("lastpage")),
        publisher: get("publisher") ?? thesisSchool ?? reportInstitution,
        language: get("language"),
        keywords: splitList(all(meta, `${prefix}keywords`, `${prefix}keyword`), /;/),
        pdfUrl: get("pdf_url"),
        url: get("public_url", "abstract_html_url", "fulltext_html_url"),
      },
      get("publication_date", "date", "online_date", "cover_date", "year")
    ),
  };
}

function eprintsLayer(meta: Meta): Layer | null {
  const title = first(meta, "eprints.title");

  if (!title) {
    return null;
  }

  return {
    name: "eprints",
    scholarly: true,
    fields: withDate(
      {
        type: first(meta, "eprints.type") === "thesis" ? "thesis" : "article",
        title,
        authors: all(meta, "eprints.creators_name"),
        abstract: first(meta, "eprints.abstract"),
        doi: parseDoi(first(meta, "eprints.doi", "eprints.id_number")),
        journal: first(meta, "eprints.publication"),
        volume: first(meta, "eprints.volume"),
        issue: first(meta, "eprints.number"),
        pages: first(meta, "eprints.pagerange"),
        publisher: first(meta, "eprints.publisher"),
        issn: first(meta, "eprints.issn"),
        isbn: parseIsbn(first(meta, "eprints.isbn")),
        pdfUrl: first(meta, "eprints.document_url"),
        url: first(meta, "eprints.official_url"),
      },
      first(meta, "eprints.date")
    ),
  };
}

function dublinCoreLayer(meta: Meta): Layer | null {
  const title = first(meta, "dc.title", "dcterms.title");

  if (!title) {
    return null;
  }

  const identifiers = all(meta, "dc.identifier", "dcterms.identifier", "dc.identifier.doi", "dc.identifier.uri");
  const doi = identifiers.map(parseDoi).find(Boolean);
  const journal = first(meta, "dc.source", "dcterms.ispartof", "dc.relation.ispartof", "dc.relation.ispartofseries");

  return {
    name: "dublin-core",
    // Plenty of ordinary sites set DC.title, so a title alone proves little.
    scholarly: Boolean(doi || journal),
    fields: withDate(
      {
        title,
        authors: all(meta, "dc.creator", "dcterms.creator", "dc.contributor.author", "dc.creator.personalname"),
        abstract: first(meta, "dc.description.abstract", "dcterms.abstract", "dc.description", "dcterms.description"),
        doi,
        isbn: identifiers.map(parseIsbn).find(Boolean),
        journal,
        publisher: first(meta, "dc.publisher", "dcterms.publisher"),
        language: first(meta, "dc.language", "dcterms.language"),
        keywords: splitList(all(meta, "dc.subject", "dcterms.subject"), /;/),
      },
      first(meta, "dc.date.issued", "dcterms.issued", "dc.date", "dcterms.date", "dcterms.created")
    ),
  };
}

function prismLayer(meta: Meta): Layer | null {
  const doi = parseDoi(first(meta, "prism.doi"));
  const journal = first(meta, "prism.publicationname");

  if (!doi && !journal) {
    return null;
  }

  return {
    name: "prism",
    scholarly: true,
    fields: withDate(
      {
        doi,
        journal,
        volume: first(meta, "prism.volume"),
        issue: first(meta, "prism.number"),
        pages: first(meta, "prism.pagerange") ?? pageRange(first(meta, "prism.startingpage"), first(meta, "prism.endingpage")),
        issn: first(meta, "prism.issn", "prism.eissn"),
        isbn: parseIsbn(first(meta, "prism.isbn")),
        url: first(meta, "prism.url"),
      },
      first(meta, "prism.publicationdate", "prism.coverdate")
    ),
  };
}

// --- schema.org ---------------------------------------------------------

const SCHOLARLY_TYPES: Record<string, ItemType> = {
  scholarlyarticle: "article",
  medicalscholarlyarticle: "article",
  book: "book",
  chapter: "chapter",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
};

const GENERAL_TYPES = new Set(["article", "newsarticle", "blogposting", "techarticle", "webpage", "reportagenewsarticle"]);

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function nodeTypes(node: Json): string[] {
  return asArray(node["@type"]).map((type) => String(type).toLowerCase());
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return clean(value);
  }

  if (value && typeof value === "object") {
    const node = value as Json;
    const joined = [node.givenName, node.familyName].map(clean).filter(Boolean).join(" ");
    return clean(node.name) ?? (joined || undefined);
  }

  return undefined;
}

function flattenNodes(value: unknown, out: Json[] = []): Json[] {
  for (const item of asArray(value)) {
    if (item && typeof item === "object") {
      const node = item as Json;
      out.push(node);
      flattenNodes(node["@graph"], out);
    }
  }

  return out;
}

function periodicalName(node: Json): string | undefined {
  let current = node.isPartOf;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const part = asArray(current)[0] as Json | undefined;
    if (!part || typeof part !== "object") {
      return clean(part);
    }

    if (part.isPartOf) {
      current = part.isPartOf;
    } else {
      return nameOf(part);
    }
  }

  return undefined;
}

function nestedPartValue(node: Json, key: string): string | undefined {
  let current: unknown = node;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const part = asArray(current)[0] as Json | undefined;
    if (!part || typeof part !== "object") {
      return undefined;
    }

    const value = clean(part[key]);
    if (value) {
      return value;
    }

    current = part.isPartOf;
  }

  return undefined;
}

function identifierValues(node: Json): string[] {
  return [...asArray(node.identifier), ...asArray(node.sameAs), ...asArray(node.url)]
    .map((value) => (value && typeof value === "object" ? clean((value as Json).value) ?? clean((value as Json)["@id"]) : clean(value)))
    .filter((value): value is string => Boolean(value));
}

/** Some sites (Wikipedia) put a description in `headline`. Trust the one the page title agrees with. */
function jsonLdTitle(node: Json, pageTitle: string): string | undefined {
  const headline = clean(node.headline);
  const name = nameOf(node);

  if (headline && name && headline !== name && pageTitle.includes(name) && !pageTitle.includes(headline)) {
    return name;
  }

  return headline ?? name;
}

function jsonLdFields(node: Json, scholarlyType: ItemType | undefined, pageTitle: string): ClipFields {
  const keywords = asArray(node.keywords).flatMap((value) => (typeof value === "string" ? [value] : []));
  const pdf = asArray(node.encoding)
    .map((value) => value as Json)
    .find((value) => value && String(value.encodingFormat ?? "").includes("pdf"));

  return withDate(
    {
      type: scholarlyType ?? "webpage",
      title: jsonLdTitle(node, pageTitle),
      authors: asArray(node.author ?? node.creator).map(nameOf).filter((name): name is string => Boolean(name)),
      abstract: stripTags(clean(node.abstract) ?? clean(node.description)),
      doi: parseDoi(clean(node.doi)) ?? identifierValues(node).map(parseDoi).find(Boolean),
      isbn: parseIsbn(clean(node.isbn)),
      issn: clean(node.issn) ?? nestedPartValue(node, "issn"),
      journal: periodicalName(node),
      volume: clean(node.volumeNumber) ?? nestedPartValue(node, "volumeNumber"),
      issue: clean(node.issueNumber) ?? nestedPartValue(node, "issueNumber"),
      pages: clean(node.pagination) ?? pageRange(clean(node.pageStart), clean(node.pageEnd)),
      publisher: nameOf(node.publisher),
      language: clean(node.inLanguage),
      keywords: splitList(keywords, /[;,]/),
      pdfUrl: pdf ? clean(pdf.contentUrl) : undefined,
      url: clean(node.url),
    },
    clean(node.datePublished) ?? clean(node.dateCreated)
  );
}

function jsonLdLayer(document: Document): Layer | null {
  const nodes: Json[] = [];

  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      flattenNodes(JSON.parse(script.textContent ?? ""), nodes);
    } catch {
      // Broken JSON-LD on a page says nothing about the rest of the page.
    }
  }

  for (const node of nodes) {
    const scholarly = nodeTypes(node).map((type) => SCHOLARLY_TYPES[type]).find(Boolean);
    if (scholarly) {
      return { name: "json-ld", scholarly: true, fields: jsonLdFields(node, scholarly, document.title ?? "") };
    }
  }

  const general = nodes.find((node) => nodeTypes(node).some((type) => GENERAL_TYPES.has(type)));
  return general ? { name: "json-ld", scholarly: false, fields: jsonLdFields(general, undefined, document.title ?? "") } : null;
}

function microdataValue(element: Element | null): string | undefined {
  return clean(
    element?.getAttribute("content") ??
      element?.getAttribute("datetime") ??
      element?.getAttribute("href") ??
      element?.textContent
  );
}

function microdataLayer(document: Document): Layer | null {
  for (const scope of Array.from(document.querySelectorAll("[itemscope][itemtype]"))) {
    const typeName = (scope.getAttribute("itemtype") ?? "").split("/").pop()?.toLowerCase() ?? "";
    const scholarlyType = SCHOLARLY_TYPES[typeName];

    if (!scholarlyType && !GENERAL_TYPES.has(typeName)) {
      continue;
    }

    const prop = (name: string) => microdataValue(scope.querySelector(`[itemprop="${name}"]`));
    const title = prop("headline") ?? prop("name");

    if (!title) {
      continue;
    }

    const authors = Array.from(scope.querySelectorAll('[itemprop="author"], [itemprop="creator"]'))
      .map((element) => microdataValue(element.querySelector('[itemprop="name"]') ?? element))
      .filter((name): name is string => Boolean(name));

    return {
      name: "microdata",
      scholarly: Boolean(scholarlyType),
      fields: withDate(
        {
          type: scholarlyType ?? "webpage",
          title,
          authors,
          abstract: prop("abstract") ?? prop("description"),
          doi: parseDoi(prop("doi") ?? prop("identifier")),
          isbn: parseIsbn(prop("isbn")),
          journal: microdataValue(scope.querySelector('[itemprop="isPartOf"] [itemprop="name"]')),
          volume: prop("volumeNumber"),
          issue: prop("issueNumber"),
          pages: prop("pagination") ?? pageRange(prop("pageStart"), prop("pageEnd")),
          publisher: microdataValue(scope.querySelector('[itemprop="publisher"] [itemprop="name"]')) ?? prop("publisher"),
        },
        prop("datePublished") ?? prop("dateCreated")
      ),
    };
  }

  return null;
}

// --- COinS ---------------------------------------------------------------

const COINS_GENRES: Record<string, ItemType> = {
  article: "article",
  journal: "article",
  book: "book",
  bookitem: "chapter",
  conference: "conference",
  proceeding: "conference",
  report: "report",
  dissertation: "thesis",
};

export function coinsItems(document: Document): ClipFields[] {
  const items: ClipFields[] = [];

  for (const span of Array.from(document.querySelectorAll("span.Z3988"))) {
    const params = new URLSearchParams(span.getAttribute("title") ?? "");
    const get = (key: string) => clean(params.get(`rft.${key}`));
    const title = get("atitle") ?? get("title") ?? get("btitle");
    const ids = params.getAll("rft_id");
    const doi = ids.map((id) => (/doi/i.test(id) ? parseDoi(id) : undefined)).find(Boolean);

    if (!title && !doi) {
      continue;
    }

    const named = [clean(`${params.get("rft.aufirst") ?? ""} ${params.get("rft.aulast") ?? ""}`)];
    const authors = params.getAll("rft.au").map(clean);

    items.push(
      withDate(
        {
          type: COINS_GENRES[(get("genre") ?? "").toLowerCase()] ?? "article",
          title,
          authors: (authors.length > 0 ? authors : named).filter((name): name is string => Boolean(name)),
          doi,
          pmid: ids.find((id) => id.startsWith("info:pmid/"))?.slice("info:pmid/".length),
          isbn: parseIsbn(get("isbn")),
          issn: get("issn"),
          journal: get("jtitle"),
          volume: get("volume"),
          issue: get("issue"),
          pages: get("pages") ?? pageRange(get("spage"), get("epage")),
          publisher: get("pub"),
        },
        get("date")
      )
    );
  }

  return items;
}

// --- general web metadata --------------------------------------------------

function generalLayer(meta: Meta): Layer | null {
  const title = first(meta, "og:title", "twitter:title");
  const description = first(meta, "og:description", "description", "twitter:description");
  const authors = all(meta, "author", "article:author", "twitter:creator").filter((name) => !/^https?:/.test(name));
  const date = first(meta, "article:published_time", "date", "pubdate", "publishdate", "sailthru.date");
  const siteName = first(meta, "og:site_name");

  if (!title && !description && authors.length === 0 && !date) {
    return null;
  }

  return {
    name: "web-metadata",
    scholarly: false,
    fields: withDate(
      {
        type: "webpage",
        title,
        authors,
        abstract: description,
        publisher: siteName,
        keywords: splitList(all(meta, "keywords", "article:tag"), /[;,]/),
        url: first(meta, "og:url"),
      },
      date
    ),
  };
}

/** All embedded metadata, in the order later merging trusts it. */
export function embeddedLayers(document: Document): Layer[] {
  const meta = readMeta(document);
  const coins = coinsItems(document);

  const layers: (Layer | null)[] = [
    citationLayer(meta, "citation_", "highwire"),
    citationLayer(meta, "bepress_citation_", "bepress"),
    eprintsLayer(meta),
    jsonLdLayer(document),
    microdataLayer(document),
    // Several COinS means a list page, handled as candidates instead.
    coins.length === 1 ? { name: "coins", scholarly: true, fields: coins[0] } : null,
    prismLayer(meta),
    dublinCoreLayer(meta),
    generalLayer(meta),
  ];

  return layers.filter((layer): layer is Layer => layer !== null);
}
