export function clipInputFromDeepLink(rawUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "linxiv-clip:") {
    return null;
  }

  if (url.hostname !== "add") {
    return null;
  }

  const input = url.searchParams.get("input")?.trim();

  return input || null;
}