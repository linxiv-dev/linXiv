// Run: node --experimental-transform-types --test src/api/papers.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPaper,
  getPaperBySfk,
  getSavedSourceIds,
  listPapers,
  listProjectPapers,
  PAPER_LIMIT_MAX,
  searchLibrary,
} from "./papers.ts";

let calls: { url: string; init?: RequestInit }[] = [];
let body: unknown = {};
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  return Response.json(body);
}) as typeof fetch;

beforeEach(() => {
  calls = [];
  body = {};
});

test("listPapers splits the sort key into sort and dir", async () => {
  await listPapers();
  await listPapers(10, 20, "added_asc");
  await listPapers(10, 0, "title_desc", 3);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "/api/papers?limit=200&offset=0",
      "/api/papers?limit=10&offset=20&sort=added&dir=asc",
      "/api/papers?limit=10&offset=0&sort=title&dir=desc&project=3",
    ]
  );
});

test("listProjectPapers fetches the whole project up to the server cap", async () => {
  await listProjectPapers(0);
  assert.equal(calls[0].url, `/api/papers?limit=${PAPER_LIMIT_MAX}&offset=0&project=0`);
});

test("getSavedSourceIds skips the request for an empty list", async () => {
  assert.deepEqual(await getSavedSourceIds([]), []);
  assert.equal(calls.length, 0);
  body = { saved_source_ids: ["arxiv:1"] };
  assert.deepEqual(await getSavedSourceIds(["arxiv:1", "arxiv:2"]), ["arxiv:1"]);
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    source_ids: ["arxiv:1", "arxiv:2"],
  });
});

test("ids and queries are URL-encoded", async () => {
  await getPaper("doi:10.1/a b");
  await searchLibrary("a&b c");
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/papers/doi%3A10.1%2Fa%20b", "/api/papers/search?q=a%26b%20c&limit=50"]
  );
});

test("getPaperBySfk only adds ?version when one is given", async () => {
  await getPaperBySfk(8);
  await getPaperBySfk(8, 0);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/papers/sfk/8", "/api/papers/sfk/8?version=0"]
  );
});
