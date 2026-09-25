// Run: node --experimental-transform-types --test src/lib/graph/style.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ellipsize } from "./style.ts";

const width = (s: string) => s.length * 10; // 10px per character

test("a label that fits is left alone", () => {
  assert.equal(ellipsize("short", 100, width), "short");
});

test("a long label keeps the longest prefix that fits with the ellipsis", () => {
  // 100px holds 9 characters plus "…".
  assert.equal(ellipsize("abcdefghijklmnop", 100, width), "abcdefghi…");
});

test("a label exactly at the cap is cut, as cytoscape did", () => {
  assert.equal(ellipsize("abcdefghij", 100, width), "abcdefghi…");
});

test("a cap narrower than one character leaves just the ellipsis", () => {
  assert.equal(ellipsize("abc", 5, width), "…");
});
