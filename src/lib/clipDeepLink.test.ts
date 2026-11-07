// Run: node --experimental-transform-types --test src/lib/clipDeepLink.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipInputFromDeepLink, clipPayloadFromDeepLink } from "./clipDeepLink.ts";

const BIBTEX = "@article{a,\n  title = {Schrödinger & co},\n}";

test("bibtex payload is decoded and trimmed", () => {
  const url = `linxiv-clip://add?bibtex=${encodeURIComponent(`  ${BIBTEX}\n`)}`;
  assert.deepEqual(clipPayloadFromDeepLink(url), { kind: "bibtex", value: BIBTEX });
});

test("input payload carries a PDF URL with its own query", () => {
  const pdf = "https://x.example/a.pdf?token=1&v=2";
  const url = `linxiv-clip://add?input=${encodeURIComponent(pdf)}`;
  assert.deepEqual(clipPayloadFromDeepLink(url), { kind: "input", value: pdf });
  assert.equal(clipInputFromDeepLink(url), pdf);
});

test("bibtex wins when both are present", () => {
  const url = `linxiv-clip://add?input=x&bibtex=${encodeURIComponent(BIBTEX)}`;
  assert.equal(clipPayloadFromDeepLink(url)?.kind, "bibtex");
  assert.equal(clipInputFromDeepLink(url), null);
});

test("other schemes, hosts, empty or malformed links are refused", () => {
  for (const url of [
    "linxiv://add?bibtex=x",
    "https://add?bibtex=x",
    "linxiv-clip://open?bibtex=x",
    "linxiv-clip://add",
    "linxiv-clip://add?bibtex=%20%20",
    "linxiv-clip://add?other=x",
    "not a url",
  ]) {
    assert.equal(clipPayloadFromDeepLink(url), null, url);
  }
});
