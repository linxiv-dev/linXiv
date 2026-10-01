import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractArxivIdFromUrl,
  extractArxivYearFromId,
  parseArxivDateline,
} from "./arxiv.ts";

test("extracts arXiv id from abstract URL", () => {
  assert.equal(
    extractArxivIdFromUrl("https://arxiv.org/abs/1706.03762"),
    "1706.03762"
  );
});

test("extracts arXiv id from PDF URL", () => {
  assert.equal(
    extractArxivIdFromUrl("https://arxiv.org/pdf/1706.03762"),
    "1706.03762"
  );
});

test("extracts arXiv id from PDF URL ending in .pdf", () => {
  assert.equal(
    extractArxivIdFromUrl("https://arxiv.org/pdf/1706.03762.pdf"),
    "1706.03762"
  );
});

test("supports versioned arXiv ids", () => {
  assert.equal(
    extractArxivIdFromUrl("https://arxiv.org/abs/1706.03762v7"),
    "1706.03762v7"
  );
});

test("rejects non-arXiv URLs", () => {
  assert.equal(
    extractArxivIdFromUrl("https://example.com/abs/1706.03762"),
    null
  );
});

test("rejects unrelated arXiv paths", () => {
  assert.equal(
    extractArxivIdFromUrl("https://arxiv.org/search/?query=transformer"),
    null
  );
});

test("rejects malformed URLs", () => {
  assert.equal(
    extractArxivIdFromUrl("not-a-url"),
    null
  );
});

test("derives year from new-style arXiv id", () => {
  assert.equal(extractArxivYearFromId("2301.08243"), "2023");
  assert.equal(extractArxivYearFromId("1706.03762v7"), "2017");
});

test("derives year from old-style arXiv id", () => {
  assert.equal(extractArxivYearFromId("hep-th/9901001"), "1999");
  assert.equal(extractArxivYearFromId("math.NT/0301001v2"), "2003");
});

test("returns undefined for unknown arXiv id shape", () => {
  assert.equal(extractArxivYearFromId("not-an-arxiv-id"), undefined);
});

test("parses submitted date from arXiv dateline", () => {
  assert.equal(
    parseArxivDateline("[Submitted on 12 Jun 2017 (v1), last revised 2 Aug 2023 (this version, v7)]"),
    "2017-06-12"
  );
  assert.equal(parseArxivDateline("[Submitted on 3 Jan 99]"), "1999-01-03");
  assert.equal(parseArxivDateline("[Submitted on 3 Foo 2020]"), undefined);
  assert.equal(parseArxivDateline("no date here"), undefined);
});
