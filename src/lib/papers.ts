export function normalizeAuthors(authors: string | string[]): string[] {
  // Split on semicolons to avoid corrupting "Last, First" name format.
  const raw = Array.isArray(authors) ? authors : authors.split(";");
  return raw.map((a) => a.trim()).filter(Boolean);
}
