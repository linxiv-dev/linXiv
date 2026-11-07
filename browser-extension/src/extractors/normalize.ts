const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const SIGNING_PARAM = /^(x-amz-|x-goog-|x-ms-|signature$|sig$|awsaccesskeyid$|googleaccessid$|token$|access_token$)/i;

/** True for a link carrying a temporary credential, such as an S3 signed URL. */
export function isSignedUrl(rawUrl: string): boolean {
  try {
    return [...new URL(rawUrl).searchParams.keys()].some((name) => SIGNING_PARAM.test(name));
  } catch {
    return false;
  }
}

/** Such a link must never be stored, so its whole query goes. Other queries stay. */
export function withoutSignature(rawUrl: string): string {
  return isSignedUrl(rawUrl) ? rawUrl.split("?")[0] : rawUrl;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Reads the date shapes pages use. `date` is set only for a complete, real
 * date, because linXiv turns anything less into January 1.
 */
export function normalizeDate(raw: string | undefined): { date?: string; year?: string } {
  const text = raw?.trim();

  if (!text) {
    return {};
  }

  const complete = (year: number, month: number, day: number) =>
    validDay(year, month, day)
      ? { date: `${year}-${pad(month)}-${pad(day)}`, year: String(year) }
      : { year: String(year) };

  const numeric = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (numeric) {
    return complete(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  }

  const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})\b/);
  if (dayFirst && MONTHS[dayFirst[2].slice(0, 3).toLowerCase()]) {
    return complete(Number(dayFirst[3]), MONTHS[dayFirst[2].slice(0, 3).toLowerCase()], Number(dayFirst[1]));
  }

  const monthFirst = text.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthFirst && MONTHS[monthFirst[1].slice(0, 3).toLowerCase()]) {
    return complete(Number(monthFirst[3]), MONTHS[monthFirst[1].slice(0, 3).toLowerCase()], Number(monthFirst[2]));
  }

  const year = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return year ? { year: year[1] } : {};
}

/** Collapse whitespace, and treat blank as missing. */
export function clean(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** Pulls text out of markup that registries put in abstracts (JATS and HTML). */
export function stripTags(value: string | undefined): string | undefined {
  return clean(value?.replace(/<[^>]+>/g, " "));
}

/** "Vaswani, Ashish" reads as "Ashish Vaswani". BibTeX keeps the original form. */
export function displayName(name: string): string {
  const parts = name.split(",").map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : name;
}

/** Drops a section label stuck to the front ("Summary Whether the..."). */
export function stripAbstractLabel(abstract: string): string {
  return abstract.replace(/^(?:Abstract|ABSTRACT|Summary|SUMMARY)\b[:.\s]*(?=[A-Z])/, "");
}

export function splitList(values: string[], separator: RegExp): string[] {
  const out: string[] = [];

  for (const value of values) {
    for (const part of value.split(separator)) {
      const text = clean(part);
      if (text && !out.includes(text)) {
        out.push(text);
      }
    }
  }

  return out;
}

export function pageRange(first?: string, last?: string): string | undefined {
  const start = clean(first);
  const end = clean(last);

  if (start && end && start !== end) {
    return `${start}-${end}`;
  }

  return start ?? end;
}
