import { test } from "node:test";
import assert from "node:assert/strict";
import { applyClick } from "./selection.ts";

const order = ["a", "b", "c", "d", "e"];

test("applyClick toggles, sets the anchor, and Shift adds the range", () => {
  let s = applyClick(new Set(), null, "b", {}, order);
  assert.deepEqual([...s.selectedIds], ["b"]);
  assert.equal(s.anchor, "b");

  // Range works in either direction and keeps the anchor.
  s = applyClick(s.selectedIds, s.anchor, "d", { shift: true }, order);
  assert.deepEqual([...s.selectedIds].sort(), ["b", "c", "d"]);
  assert.equal(s.anchor, "b");
  s = applyClick(new Set(), "d", "a", { shift: true }, order);
  assert.deepEqual([...s.selectedIds].sort(), ["a", "b", "c", "d"]);

  // Ctrl toggles off; Shift with no visible anchor falls back to a toggle.
  s = applyClick(s.selectedIds, s.anchor, "c", { ctrl: true }, order);
  assert.deepEqual([...s.selectedIds].sort(), ["a", "b", "d"]);
  s = applyClick(new Set(), "gone", "e", { shift: true }, order);
  assert.deepEqual([...s.selectedIds], ["e"]);
  assert.equal(s.anchor, "e");
});
