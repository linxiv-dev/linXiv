export type ClipDeepLinkPayload =
  | { kind: "bibtex"; value: string }
  | { kind: "input"; value: string };

export function clipPayloadFromDeepLink(
  rawUrl: string
): ClipDeepLinkPayload | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "linxiv-clip:" || url.hostname !== "add") {
    return null;
  }

  const bibtex = url.searchParams.get("bibtex")?.trim();
  if (bibtex) {
    return { kind: "bibtex", value: bibtex };
  }

  const input = url.searchParams.get("input")?.trim();
  if (input) {
    return { kind: "input", value: input };
  }

  return null;
}

export function clipInputFromDeepLink(rawUrl: string): string | null {
  const payload = clipPayloadFromDeepLink(rawUrl);
  return payload?.kind === "input" ? payload.value : null;
}
