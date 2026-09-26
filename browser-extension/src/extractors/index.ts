import type { ClipPreview } from "../types";
import { extractArxiv } from "./arxiv";

export function extractClipPreview(
  document: Document,
  rawUrl: string
): ClipPreview | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.hostname === "arxiv.org" || url.hostname === "www.arxiv.org") {
    return extractArxiv(document, rawUrl);
  }

  return null;
}