// The desktop backend and the app's deep-link parser live on two sides of the
// linxiv-clip:// scheme. These tests keep them in step.
import { test } from "node:test";
import assert from "node:assert/strict";

import { clipPayloadFromDeepLink } from "../../../src/lib/clipDeepLink.ts";
import { buildBibtex } from "../bibtex.ts";
import { toPreview } from "../extractors/index.ts";
import type { ClipFields } from "../types";
import { desktopBackend } from "./desktop.ts";

const clip = (fields: ClipFields) => toPreview(fields, {}, "https://x.example/a?b=1&c=2", undefined);

async function opened(run: (open: (url: string) => Promise<unknown>) => Promise<unknown>) {
  const urls: string[] = [];
  await run(async (url) => urls.push(url));
  assert.equal(urls.length, 1);
  return urls[0];
}

test("desktop BibTeX link parses to the same entries in the app", async () => {
  const clips = [
    clip({ type: "article", doi: "10.5555/a/b", title: "Schrödinger & {braces} 100%", authors: ["Ana B", "C D"] }),
    clip({ type: "article", arxivId: "1706.03762", title: "Second", authors: ["E F"] }),
  ];

  const url = await opened((open) => desktopBackend(open).save(clips));

  assert.deepEqual(clipPayloadFromDeepLink(url), {
    kind: "bibtex",
    value: clips.map(buildBibtex).join("\n").trim(),
  });
});

test("desktop PDF link parses to the same URL in the app", async () => {
  const pdf = "https://x.example/files/a.pdf?download=1&name=a%20b";

  const url = await opened((open) => desktopBackend(open).savePdf({ url: pdf, filename: "a.pdf" }));

  assert.deepEqual(clipPayloadFromDeepLink(url), { kind: "input", value: pdf });
});
