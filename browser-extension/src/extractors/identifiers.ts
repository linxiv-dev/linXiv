const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>]+/gi;
const ARXIV_NEW = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;
const ARXIV_OLD = String.raw`[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?`;
const ARXIV_URL = new RegExp(String.raw`arxiv\.org\/(?:abs|pdf)\/(${ARXIV_NEW}|${ARXIV_OLD})`, "i");
const ARXIV_TEXT = new RegExp(String.raw`\barxiv:\s*(${ARXIV_NEW}|${ARXIV_OLD})`, "i");

// Path endings publishers add after a DOI in their URLs.
const DOI_URL_SUFFIX = /\/(?:abstract|full|fulltext|pdf|epdf|pdfdirect|meta|html|references|summary|figures)$/i;

/** Drops punctuation that followed a DOI in prose, keeping balanced brackets. */
function trimDoi(raw: string): string {
  let doi = raw.replace(/[.,;:!?]+$/, "");

  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (doi.endsWith(close) && doi.split(open).length < doi.split(close).length) {
      doi = doi.slice(0, -1).replace(/[.,;:!?]+$/, "");
    }
  }

  return doi;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function findDois(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(DOI_PATTERN)) {
    found.add(trimDoi(match[0]));
  }

  return [...found];
}

/** A DOI from a bare value such as `doi:10.1/x` or `https://doi.org/10.1/x`. */
export function parseDoi(value: string | undefined): string | undefined {
  return value ? findDois(safeDecode(value))[0] : undefined;
}

export function doiFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    const doi = findDois(safeDecode(url.pathname))[0];
    return doi?.replace(DOI_URL_SUFFIX, "").replace(/\.pdf$/i, "");
  } catch {
    return undefined;
  }
}

export function arxivFromText(text: string): string | undefined {
  return text.match(ARXIV_URL)?.[1] ?? text.match(ARXIV_TEXT)?.[1];
}

export function pmidFromUrl(rawUrl: string): string | undefined {
  return rawUrl.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1];
}

export function pmcidFromUrl(rawUrl: string): string | undefined {
  return rawUrl.match(/\/(?:pmc\/articles\/|articles\/)(PMC\d+)/i)?.[1]?.toUpperCase();
}

function isbn13Valid(digits: string): boolean {
  const sum = [...digits].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return sum % 10 === 0;
}

function isbn10Valid(digits: string): boolean {
  const sum = [...digits].reduce(
    (total, digit, i) => total + (digit.toUpperCase() === "X" ? 10 : Number(digit)) * (10 - i),
    0
  );
  return sum % 11 === 0;
}

export function parseIsbn(value: string | undefined): string | undefined {
  const digits = value?.replace(/[\s-]/g, "");

  if (digits && /^\d{13}$/.test(digits) && isbn13Valid(digits)) {
    return digits;
  }

  return digits && /^\d{9}[\dXx]$/.test(digits) && isbn10Valid(digits) ? digits.toUpperCase() : undefined;
}

export function isbnFromText(text: string): string | undefined {
  const match = text.match(/\bISBN(?:-1[03])?:?\s*([\dXx][\dXx\s-]{8,16}[\dXx])/i);
  return parseIsbn(match?.[1]);
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
const MAX_TEXT = 200_000;

/** Visible-ish page text. `textContent` alone would include script bodies. */
export function pageText(root: Node | null | undefined): string {
  const parts: string[] = [];
  let length = 0;

  const walk = (node: Node) => {
    if (length >= MAX_TEXT) {
      return;
    }

    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      parts.push(text);
      length += text.length;
      return;
    }

    if (node.nodeType === 1 && SKIPPED_TAGS.has((node as Element).tagName.toUpperCase())) {
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  };

  if (root) {
    walk(root);
  }

  return parts.join(" ");
}

/** DOIs a page links to or mentions. Weak: they may be citations, not the page. */
export function weakDois(document: Document): string[] {
  const hrefs = Array.from(document.querySelectorAll("a[href]"), (a) => a.getAttribute("href") ?? "");
  const found = new Set<string>();

  for (const href of hrefs) {
    if (/doi\.org\//i.test(href)) {
      const doi = parseDoi(href);
      if (doi) {
        found.add(doi);
      }
    }
  }

  for (const doi of findDois(pageText(document.body))) {
    found.add(doi);
  }

  return [...found];
}
