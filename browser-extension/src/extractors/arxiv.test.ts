import { test } from "node:test";
import assert from "node:assert/strict";

import { extractArxivIdFromUrl } from "./arxiv.ts";

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